// Pure helpers extracted from the search route so they can be unit-tested
// independently of the 1288-line route handler. No side effects, no IO,
// no Prisma access — these are string utilities only.

const PLACEHOLDERS = new Set([
  "full name", "job title at company", "city, country", "unknown",
  "n/a", "not specified", "see profile", "na",
]);

const ORG_PATTERNS = [
  /\b(ministry|department|government|council|authority|commission)\b/i,
  /\b(university|college|institute|polytechnic|school|academy)\b/i,
  /\b(ltd|limited|inc|corp|corporation|llc|pty|plc)\b/i,
  /\b(recruitment|staffing|consulting|solutions|services|group|agency)\b/i,
  /\b(foundation|trust|society|association|hospital|health board)\b/i,
];

/** Filter out placeholder strings ("Full Name", "Unknown", etc.) and obvious garbage. */
export function looksReal(s: string): boolean {
  return s.length > 2 && s.length < 100 && !/^\[.*\]$/.test(s) && !PLACEHOLDERS.has(s.trim().toLowerCase());
}

/** Heuristic — is this string a person's name (vs a company / org)? */
export function looksLikePersonName(s: string): boolean {
  if (!looksReal(s)) return false;
  if (ORG_PATTERNS.some((p) => p.test(s))) return false;
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 6;
}

/** Strip site: prefixes, year-of-experience qualifiers, and the literal word
 * "location" so the query reads cleanly when shown in the UI. */
export function cleanQuery(q: string): string {
  return q
    .replace(/^site:linkedin\.com\/in\s*/i, "")
    .replace(/\b\d+\+?\s*years?\b/gi, "")
    .replace(/\blocation\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Clean each query, drop empties, and remove case-insensitive duplicates. */
export function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const query of queries.map(cleanQuery).filter(Boolean)) {
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(query);
  }
  return deduped;
}
