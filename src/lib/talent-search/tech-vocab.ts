/**
 * Postgres's `english` text-search configuration destroys the tokens that matter most
 * in technical recruiting. Measured against the production database:
 *
 *     .net        → 'net'          (collides with "net profit", "net margin")
 *     c#          → 'c'
 *     c++         → 'c'            ← C# and C++ are the SAME TOKEN
 *     f#          → 'f'
 *     objective-c → 'objective-c' + 'c'   (pollutes every C# search)
 *
 * On the real library that made a `C#` search 38% noise (5,481 rows returned,
 * 3,383 actually mentioning C#) and a `.NET` search 16% noise.
 *
 * The fix is a sentinel vocabulary: text containing `c#` also contributes the
 * token `csharpx`, which nothing else can produce. Queries for C# ask for
 * `csharpx` and stop matching C++. Verified in Postgres: all six sentinels
 * survive the english stemmer unchanged, and a `simple`-config vector entry
 * matches an `english`-config query for the same sentinel.
 *
 * These sentinels are ALSO emitted by the SQL function `recruitme_tech_tokens`
 * in the migration that builds `Candidate.searchTsv`. The two must agree or
 * queries silently return nothing.
 */

/**
 * The vocabulary. ONE source of truth — both exported functions read it, so
 * adding a technical token is a single entry here plus the matching CASE in
 * `recruitme_tech_tokens()` in the searchTsv migration.
 *
 * ORDER IS SIGNIFICANT. Each pattern is consumed (replaced with a space) before
 * the next is tested, so a longer token that CONTAINS a shorter one must come
 * first: `asp.net` is matched and removed before bare `.net` is looked for,
 * which is what stops "ASP.NET" also emitting `dotnetx` while
 * "ASP.NET on .NET 8" still correctly emits both.
 */
const VOCAB: ReadonlyArray<{
  readonly source: string;
  readonly sentinel: string;
  /**
   * Sentinels that ALSO satisfy a query for this token, because they name a
   * strict specialisation of it. One-directional: searching ".NET" should
   * return ASP.NET developers (they are .NET developers), but searching
   * "ASP.NET" must not return everyone who has merely touched .NET.
   */
  readonly alsoMatches?: readonly string[];
}> = [
  { source: "asp\\.net", sentinel: "aspdotnetx" },
  { source: "objective-c", sentinel: "objectivecx" },
  { source: "c\\+\\+", sentinel: "cplusplusx" },
  { source: "c#", sentinel: "csharpx" },
  { source: "f#", sentinel: "fsharpx" },
  // The dot must open the token — otherwise "subnet.network" and friends would
  // read as .NET. Matched last so asp.net is already gone.
  // Measured on the live library: 357 people carry ASP.NET but never write bare
  // ".NET", so without this widening a .NET search silently loses all of them.
  { source: "(^|[^a-z0-9])\\.net", sentinel: "dotnetx", alsoMatches: ["aspdotnetx"] },
];

/** The complete sentinel vocabulary. Must match the SQL function. */
export const TECH_SENTINELS: readonly string[] = VOCAB.map((v) => v.sentinel);

/**
 * Walk the vocabulary once, consuming each matched token so later patterns
 * cannot re-match text an earlier one already claimed. Returns the sentinels
 * found and whatever text is left over.
 */
function scan(text: string): { matched: typeof VOCAB[number][]; remainder: string } {
  let remainder = text.toLowerCase();
  const matched: typeof VOCAB[number][] = [];
  for (const entry of VOCAB) {
    const re = new RegExp(entry.source, "g");
    if (!re.test(remainder)) continue;
    matched.push(entry);
    remainder = remainder.replace(new RegExp(entry.source, "g"), " ");
  }
  return { matched, remainder };
}

/**
 * Which sentinels does this text contribute to the index?
 * Case-insensitive. Each sentinel appears AT MOST ONCE. Order is not asserted.
 * Empty array for text with no technical tokens. Never throws.
 */
export function techSentinelsFor(text: string | null | undefined): string[] {
  if (!text) return [];
  // Index side stores exactly ONE sentinel per token found. Widening belongs on
  // the query side only — storing aspdotnetx AND dotnetx for every ASP.NET
  // profile would make it impossible to search for one without the other.
  return scan(text).matched.map((e) => e.sentinel);
}

/**
 * Rewrite a recruiter's query TERM for use as Postgres to_tsquery atoms.
 *
 * - When the term contains no technical token: `{ rewritten: false, atoms: [] }`
 *   — the caller keeps its existing behaviour untouched.
 * - When it does: `{ rewritten: true, atoms: [...] }` — the sentinel(s) plus any
 *   ordinary words left over once the technical tokens have been consumed.
 *   Consuming them is what keeps the debris out: ".net core" yields
 *   ["dotnetx", "core"], never a stray "net" that would re-introduce the
 *   "net profit" collision this module exists to remove.
 *
 * A token that has specialisations becomes an OR-group atom rather than a bare
 * word: ".net" emits `(dotnetx | aspdotnetx)`, because 357 people in the live
 * library carry ASP.NET and never write bare ".NET".
 *
 * Every atom is either a bare lowercase word or a parenthesised OR-group of
 * them, so the result is always safe to hand to to_tsquery.
 */
export function rewriteTechTerm(term: string): { rewritten: boolean; atoms: string[] } {
  const { matched, remainder } = scan(term ?? "");
  if (matched.length === 0) return { rewritten: false, atoms: [] };
  const sentinelAtoms = matched.map((e) =>
    e.alsoMatches?.length ? `(${[e.sentinel, ...e.alsoMatches].join(" | ")})` : e.sentinel,
  );
  const leftovers = remainder.match(/[a-z0-9]+/g) ?? [];
  return { rewritten: true, atoms: [...new Set([...sentinelAtoms, ...leftovers])] };
}
