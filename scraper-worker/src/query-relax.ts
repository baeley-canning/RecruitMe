/**
 * Widening a live search that found nothing.
 *
 * The library path already retries: when a query with required terms returns no
 * rows it demotes them to optional and runs again. The live SEEK path had no
 * such fallback, so a query nobody could satisfy read as "no such candidates
 * exist".
 *
 * Observed 2026-08-12 — SEEK's own page reported `0 matching candidates` for:
 *
 *   c# AND ("senior full stack .net developer" OR "senior .net developer"
 *           OR "full stack engineer" OR ".net engineer" OR "software engineer")
 *       AND (.net OR react)
 *
 * That scrape was correct. The query was the problem: three hard-ANDed groups
 * against a country-sized pool matches nobody.
 *
 * Relaxing to the TITLE group alone applies the rule already proven for
 * LinkedIn (see linkedinTitleQuery) — titles find people, skills rank them
 * afterwards. Scoring downstream still filters on the skills, so nothing is
 * lost except the empty result.
 */

/**
 * Reduce a boolean query to its title OR-group, or null when there is nothing
 * to relax.
 *
 * The title group is the top-level parenthesised OR-group holding the most
 * QUOTED phrases — job titles are written as phrases ("full stack engineer"),
 * whereas skill gates are usually bare tokens (c#, react). Returning null when
 * no group qualifies keeps this from guessing: a caller that gets null reports
 * the honest zero rather than running a query we invented.
 *
 * Idempotent — relaxing an already-relaxed query returns null, so a retry loop
 * cannot run twice.
 */
export function relaxToTitleGroup(query: string): string | null {
  const groups = splitTopLevelAnd(query ?? "");
  if (groups.length < 2) return null;

  let best: string | null = null;
  let bestPhrases = 0;
  for (const g of groups) {
    if (!g.startsWith("(") || !g.endsWith(")")) continue;
    const phrases = countQuotedPhrases(g);
    if (phrases > bestPhrases) {
      bestPhrases = phrases;
      best = g;
    }
  }
  // No quoted phrases anywhere means we cannot tell titles from skills.
  return bestPhrases > 0 ? best : null;
}

/**
 * Split on ` AND ` that sits outside quotes and parentheses. Uppercase only —
 * SEEK's boolean operators are uppercase, so "research and development" inside
 * a phrase is a term, not an operator.
 */
function splitTopLevelAnd(query: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;

  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && query.startsWith(" AND ", i)) {
      out.push(query.slice(start, i).trim());
      i += 4; // skip " AND" — the loop's i++ consumes the trailing space
      start = i + 1;
    }
  }
  out.push(query.slice(start).trim());
  return out.filter(Boolean);
}

function countQuotedPhrases(group: string): number {
  return (group.match(/"[^"]+"/g) ?? []).length;
}
