/**
 * Per-backend emitters that translate a ParsedQuery into the search syntax
 * each downstream system expects.
 *
 *   tsqueryFromParsed   → Postgres to_tsquery() input
 *   seekKeywordsFromParsed   → SEEK Talent Search "keywords" field
 *   linkedinKeywordsFromParsed → linkedin.com / Recruiter "keywords" field
 *
 * The parser intentionally normalises terms to lowercase, so these
 * functions only care about ESCAPING per backend (each one has its own
 * reserved-character set) and re-rendering the AND/OR/NOT structure in
 * the right operator style.
 */

import type { ParsedQuery } from "../boolean-query";

// ─── Postgres to_tsquery ───────────────────────────────────────────────────
//
// to_tsquery operators: & (AND), | (OR), ! (NOT), <-> (followed-by/phrase),
// ( ) (grouping), :* (prefix match). Anything else is a lexeme and gets
// tsearch-tokenised. The hazard is user input that contains reserved chars —
// a single `:` slips through and to_tsquery 500s the whole query.

const TSQUERY_RESERVED = /[&|!():*<>]/g;

/** One ParsedQuery term → a tsquery atom. A multi-word phrase becomes
 *  `word1 <-> word2` (followed-by) so ts_rank rewards proximity. */
function termToTsqueryAtom(term: string): string {
  const cleaned = term.replace(TSQUERY_RESERVED, " ").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/);
  if (words.length === 1) return words[0];
  return `(${words.join(" <-> ")})`;
}

/**
 * Convert a ParsedQuery to a to_tsquery-compatible string.
 *
 * Returns null when there's nothing to query — the caller should then
 * skip the FTS predicate entirely (don't pass an empty string to
 * to_tsquery, it errors).
 */
export function tsqueryFromParsed(q: ParsedQuery): string | null {
  const parts: string[] = [];

  for (const term of q.mustHave) {
    const atom = termToTsqueryAtom(term);
    if (atom) parts.push(atom);
  }

  for (const group of q.anyOf) {
    const atoms = group.map(termToTsqueryAtom).filter(Boolean);
    if (atoms.length === 0) continue;
    if (atoms.length === 1) parts.push(atoms[0]);
    else parts.push(`(${atoms.join(" | ")})`);
  }

  // A negation-only query (`!intern` with no positive atoms) is poison for
  // to_tsquery: a lone `!x` matches the COMPLEMENT of the corpus, so it scans
  // ~every row and ranks them near-randomly. Bail to null when there are no
  // positive atoms so the caller falls back to the recency path; only attach
  // negations to constrain an already-positive query.
  if (parts.length === 0) return null;

  for (const term of q.mustNot) {
    const atom = termToTsqueryAtom(term);
    if (atom) parts.push(`!${atom}`);
  }

  return parts.join(" & ");
}

// ─── SEEK Talent Search keywords field ─────────────────────────────────────
//
// SEEK accepts uppercase AND, OR, NOT plus parens and "quoted phrases" in
// the search-by-keywords box. Multi-word terms are quoted; OR groups are
// parenthesised so they bind tighter than the surrounding AND.

function quoteIfPhrase(term: string): string {
  return /\s/.test(term) ? `"${term}"` : term;
}

export function seekKeywordsFromParsed(q: ParsedQuery): string {
  const parts: string[] = [];
  for (const term of q.mustHave) parts.push(quoteIfPhrase(term));
  for (const group of q.anyOf) {
    if (group.length === 0) continue;
    if (group.length === 1) parts.push(quoteIfPhrase(group[0]));
    else parts.push(`(${group.map(quoteIfPhrase).join(" OR ")})`);
  }
  for (const term of q.mustNot) parts.push(`NOT ${quoteIfPhrase(term)}`);
  return parts.join(" AND ");
}

// ─── LinkedIn keywords field ───────────────────────────────────────────────
//
// linkedin.com and Recruiter accept the same uppercase AND/OR/NOT/(),
// "phrases" syntax as SEEK. Two extra rules:
//   - LinkedIn ignores the wildcard `*` — strip it so the user doesn't
//     wonder why their `senior*` returns nothing.
//   - Stop words (a/and/or/the/of/at/by/to/for/with/in/not/but/from/after)
//     are silently dropped inside groups. We DON'T strip them here — that's
//     the parser's job if it cares; the linkedin builder in
//     talent-search/linkedin.ts already does its own cleanup for that path
//     and remains the canonical LinkedIn URL builder.

const LINKEDIN_STRIP = /\*/g;

function linkedinClean(term: string): string {
  return term.replace(LINKEDIN_STRIP, "").trim();
}

export function linkedinKeywordsFromParsed(q: ParsedQuery): string {
  const parts: string[] = [];
  for (const term of q.mustHave) {
    const t = linkedinClean(term);
    if (t) parts.push(quoteIfPhrase(t));
  }
  for (const group of q.anyOf) {
    const cleaned = group.map(linkedinClean).filter(Boolean);
    if (cleaned.length === 0) continue;
    if (cleaned.length === 1) parts.push(quoteIfPhrase(cleaned[0]));
    else parts.push(`(${cleaned.map(quoteIfPhrase).join(" OR ")})`);
  }
  for (const term of q.mustNot) {
    const t = linkedinClean(term);
    if (t) parts.push(`NOT ${quoteIfPhrase(t)}`);
  }
  return parts.join(" AND ");
}
