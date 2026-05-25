/**
 * LinkedIn/Google-recruiter-style boolean query parser.
 *
 * Pure function. No throws. Designed so server-side handlers can:
 *  - Build SQL WHERE clauses (library / local search), and
 *  - Pass `raw` straight through to SerpAPI / Google which understand the
 *    same boolean syntax natively.
 *
 * Supported syntax (one level of parens, no wildcards / fields / regex):
 *   tech lead              → AND of "tech" + "lead"
 *   "tech lead"            → single phrase
 *   "X" OR "Y"             → one OR group
 *   "X" AND "Y"            → two AND terms
 *   "X" NOT "Y"            → mustHave X, mustNot Y
 *   -"intern"              → mustNot
 *   ("X" OR "Y") AND "Z"   → anyOf [[x,y]], mustHave [z]
 *   Implicit AND between adjacent terms.
 *
 * Operators are case-insensitive. Term content is lowercased on output.
 */

export interface ParsedQuery {
  /** Raw original query, preserved for passthrough to APIs that handle
   *  boolean syntax natively (SerpAPI / Google). */
  raw: string;
  /** Terms that MUST appear (AND-joined). Quoted phrases preserved as
   *  single-element strings. */
  mustHave: string[];
  /** Groups of terms where AT LEAST ONE must appear (OR groups).
   *  Each element is an OR group. Example query:
   *  `"X" AND ("Y" OR "Z")` → mustHave: ["x"], anyOf: [["y", "z"]] */
  anyOf: string[][];
  /** Terms that must NOT appear. */
  mustNot: string[];
  /** Whether the parser hit anything weird (unbalanced quotes,
   *  dangling operator, etc.). Caller can warn the user or fall back. */
  hasErrors: boolean;
  /** Human-readable list of issues for debugging / surfacing to UI. */
  errors: string[];
}

// ───────────────────────── tokenizer ─────────────────────────

type TokenKind =
  | "TERM" // word or quoted phrase, already normalised
  | "AND"
  | "OR"
  | "NOT"
  | "MINUS" // unary, sticks to the next term
  | "LPAREN"
  | "RPAREN";

interface Token {
  kind: TokenKind;
  value: string; // for TERM, the (lowercased) content
}

function tokenize(
  input: string,
  errors: string[],
): { tokens: Token[]; hadError: boolean } {
  const tokens: Token[] = [];
  let hadError = false;
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    // whitespace (incl. newlines)
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // parens
    if (ch === "(") {
      tokens.push({ kind: "LPAREN", value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "RPAREN", value: ")" });
      i++;
      continue;
    }

    // minus shorthand: a NOT-prefix when it directly precedes a term —
    // i.e. it's at start-of-input or preceded by whitespace/'(', AND it's
    // followed by a non-empty atom starter ('"' or a word char). This is
    // how LinkedIn / Google treat `-`: `-intern` negates, but `full-stack`
    // is one word.
    if (ch === "-") {
      const prevCh = i > 0 ? input[i - 1] : "";
      const nextCh = i + 1 < n ? input[i + 1] : "";
      const atStartOfAtom = i === 0 || /[\s(]/.test(prevCh);
      const followedByTerm = nextCh === '"' || /[^\s()"-]/.test(nextCh);
      if (atStartOfAtom && followedByTerm) {
        tokens.push({ kind: "MINUS", value: "-" });
        i++;
        continue;
      }
      // otherwise fall through and treat '-' as part of a bareword
    }

    // quoted phrase
    if (ch === '"') {
      const start = i;
      i++; // consume opening quote
      let buf = "";
      while (i < n && input[i] !== '"') {
        buf += input[i];
        i++;
      }
      if (i >= n) {
        errors.push(`Unbalanced quote at position ${start}`);
        hadError = true;
        // close it virtually and emit whatever we collected
      } else {
        i++; // consume closing quote
      }
      const phrase = buf.trim().toLowerCase();
      if (phrase.length === 0) {
        errors.push(`Empty quoted phrase at position ${start}`);
        hadError = true;
      } else {
        tokens.push({ kind: "TERM", value: phrase });
      }
      continue;
    }

    // bareword: run of non-whitespace, non-paren, non-quote chars
    if (/[^\s()"]/.test(ch)) {
      let buf = "";
      while (i < n && /[^\s()"]/.test(input[i])) {
        buf += input[i];
        i++;
      }
      const word = buf.toLowerCase();
      if (word === "and") tokens.push({ kind: "AND", value: "and" });
      else if (word === "or") tokens.push({ kind: "OR", value: "or" });
      else if (word === "not") tokens.push({ kind: "NOT", value: "not" });
      else if (word.length > 0) tokens.push({ kind: "TERM", value: word });
      continue;
    }

    // unreachable safety net
    i++;
  }

  return { tokens, hadError };
}

// ───────────────────────── parser ─────────────────────────
//
// Grammar (effectively):
//   query     := andSeq
//   andSeq    := atom ( (AND | <implicit>) atom )*
//   atom      := (NOT | MINUS) atom
//              | LPAREN orSeq RPAREN
//              | TERM
//   orSeq     := atomNoNeg ( OR atomNoNeg )*
//
// Inside parens we collect an OR group (single level — no nested parens).
// Outside parens, OR between two atoms still forms an OR group on the fly.

interface Parsed {
  mustHave: string[];
  anyOf: string[][];
  mustNot: string[];
}

function parseTokens(tokens: Token[], errors: string[]): Parsed {
  const mustHave: string[] = [];
  const anyOf: string[][] = [];
  const mustNot: string[] = [];

  let i = 0;

  // Read one atom and return { term, negated } or null if nothing readable.
  // Consumes leading NOT / MINUS prefixes.
  function readSimpleAtom(): { term: string | null; negated: boolean } {
    let negated = false;
    while (i < tokens.length && (tokens[i].kind === "NOT" || tokens[i].kind === "MINUS")) {
      negated = !negated; // double negation cancels — cheap and sensible
      i++;
    }
    if (i >= tokens.length) {
      if (negated) {
        errors.push("Dangling NOT/- with no term");
      }
      return { term: null, negated };
    }
    const tok = tokens[i];
    if (tok.kind === "TERM") {
      i++;
      return { term: tok.value, negated };
    }
    // Caller handles LPAREN / operators
    return { term: null, negated };
  }

  // Returns: list of terms (the OR group), and whether the WHOLE group
  // was negated (NOT applied before the LPAREN).
  function readParenGroup(): string[] {
    // consume LPAREN
    i++;
    const group: string[] = [];
    let expectTerm = true;

    while (i < tokens.length && tokens[i].kind !== "RPAREN") {
      const tok = tokens[i];
      if (tok.kind === "LPAREN") {
        // nested parens not supported — flatten by skipping the inner '('
        errors.push("Nested parentheses not supported; flattening");
        i++;
        continue;
      }
      if (tok.kind === "OR" || tok.kind === "AND") {
        // Inside a paren group we treat both as separators between OR items.
        // (Mixed AND/OR inside parens isn't really LinkedIn-style; we keep
        // it lenient.)
        if (expectTerm) {
          errors.push(`Unexpected operator "${tok.value}" inside group`);
        }
        i++;
        expectTerm = true;
        continue;
      }
      if (tok.kind === "NOT" || tok.kind === "MINUS") {
        // Negation inside a paren group is weird — record and skip the
        // negated term so it doesn't poison the OR group.
        errors.push("Negation inside ( ) group is unsupported; term skipped");
        const { term } = readSimpleAtom();
        if (term !== null) {
          // dropped intentionally
        }
        expectTerm = false;
        continue;
      }
      if (tok.kind === "TERM") {
        group.push(tok.value);
        i++;
        expectTerm = false;
        continue;
      }
      // RPAREN handled by loop condition; nothing else expected
      i++;
    }

    if (i >= tokens.length) {
      errors.push("Unbalanced parenthesis");
    } else {
      // consume RPAREN
      i++;
    }

    if (expectTerm && group.length > 0) {
      errors.push("Dangling operator inside ( ) group");
    }
    return group;
  }

  while (i < tokens.length) {
    const tok = tokens[i];

    // Skip stray operators at top level (AND/OR with no left operand)
    if (tok.kind === "AND" || tok.kind === "OR") {
      // Is there a previous emitted term and a following atom? If neither,
      // it's a dangling operator. We always skip the operator token itself
      // and let the next iteration handle whatever follows.
      const hasPrev =
        mustHave.length > 0 || anyOf.length > 0 || mustNot.length > 0;
      const hasNext = i + 1 < tokens.length;
      if (!hasPrev || !hasNext) {
        errors.push(`Dangling operator "${tok.value}"`);
      }

      // Special-case OR: if there's a previous mustHave term and a next
      // atom, lift the previous mustHave into a new anyOf group with the
      // next atom.
      if (tok.kind === "OR" && hasPrev && hasNext) {
        i++; // consume OR
        // Read the right-hand side: paren group, or simple atom.
        if (tokens[i] && tokens[i].kind === "LPAREN") {
          const group = readParenGroup();
          const left = mustHave.pop();
          if (left !== undefined && group.length > 0) {
            anyOf.push([left, ...group]);
          } else if (group.length > 0) {
            anyOf.push(group);
          }
        } else {
          const { term, negated } = readSimpleAtom();
          if (term !== null && !negated) {
            const left = mustHave.pop();
            if (left !== undefined) anyOf.push([left, term]);
            else anyOf.push([term]);
          } else if (term !== null && negated) {
            // "X OR NOT Y" — odd; honour the negation, drop the OR
            mustNot.push(term);
          } else {
            errors.push("Dangling OR with no right-hand term");
          }
        }
        continue;
      }

      // AND or stray OR: just consume the operator
      i++;
      continue;
    }

    if (tok.kind === "LPAREN") {
      const group = readParenGroup();
      if (group.length === 1) {
        mustHave.push(group[0]);
      } else if (group.length > 1) {
        anyOf.push(group);
      }
      continue;
    }

    if (tok.kind === "RPAREN") {
      errors.push("Unexpected ')'");
      i++;
      continue;
    }

    // TERM or NOT/MINUS-prefixed atom
    const { term, negated } = readSimpleAtom();
    if (term === null) continue;
    if (negated) mustNot.push(term);
    else mustHave.push(term);
  }

  return { mustHave, anyOf, mustNot };
}

// ───────────────────────── public API ─────────────────────────

const MAX_QUERY_LEN = 4000; // generous cap; pure-fn safety belt

export function parseBooleanQuery(query: string): ParsedQuery {
  const raw = typeof query === "string" ? query : "";
  const errors: string[] = [];

  if (raw.length === 0) {
    return { raw, mustHave: [], anyOf: [], mustNot: [], hasErrors: false, errors };
  }

  const safe = raw.length > MAX_QUERY_LEN ? raw.slice(0, MAX_QUERY_LEN) : raw;
  if (safe.length !== raw.length) {
    errors.push(`Query truncated to ${MAX_QUERY_LEN} chars`);
  }

  const { tokens, hadError: tokErr } = tokenize(safe, errors);
  const parsed = parseTokens(tokens, errors);

  const hasContent =
    parsed.mustHave.length > 0 ||
    parsed.anyOf.length > 0 ||
    parsed.mustNot.length > 0;

  if (!hasContent && tokens.length > 0) {
    // We had tokens but produced nothing usable (e.g. only an operator).
    errors.push("Query contains no searchable terms");
  }

  return {
    raw,
    mustHave: parsed.mustHave,
    anyOf: parsed.anyOf,
    mustNot: parsed.mustNot,
    hasErrors: tokErr || errors.length > 0,
    errors,
  };
}
