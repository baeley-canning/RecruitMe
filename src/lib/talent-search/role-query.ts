/**
 * parsedRoleToBooleanQuery — turn a parsed job role into ONE boolean query so
 * the jobs-area "Find Candidates" can search straight from the role with no
 * boolean typed by hand. The shape is:
 *
 *   ("<Title>" OR "<Synonym 1>" OR …) AND "<anchor 1>" AND "<anchor 2>"
 *
 * Title-group OR-widens across the role's title + alternative titles; the
 * anchor terms (the few hard signals — anchor_terms, else must_haves) AND-narrow
 * it. Conservative slices (≤5 titles, ≤3 anchors) keep it from over-widening or
 * over-narrowing; the recruiter can still tweak it via the modal's "Refine"
 * field. Pure + deterministic — no scoring/network. Reuses cleanQuery so the
 * normalisation matches the rest of the search stack, and always returns a
 * string that parseBooleanQuery() accepts without errors (round-trip tested).
 */

import type { ParsedRole } from "@/lib/ai";
import { cleanQuery } from "@/lib/search-query-helpers";

/** Quote a phrase for boolean syntax: strip internal quotes (which would break
 *  the parser), and wrap multi-word phrases so they match as a unit. */
function quotePhrase(s: string): string {
  const cleaned = s.replace(/"/g, "").trim();
  if (!cleaned) return "";
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const c = cleanQuery(v ?? "");
    const key = c.toLowerCase();
    if (c && !seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

export function parsedRoleToBooleanQuery(role: ParsedRole): string {
  // Title OR-group: the role's title + alternative titles it could go by.
  const titles = uniqueNonEmpty([role.title, ...(role.synonym_titles ?? [])]).slice(0, 5).map(quotePhrase).filter(Boolean);
  // Anchor AND-terms: the rare/hard signals. Prefer anchor_terms; fall back to
  // must_haves for roles parsed before anchor_terms existed.
  const anchorSource = role.anchor_terms?.length ? role.anchor_terms : (role.must_haves ?? []);
  const anchors = uniqueNonEmpty(anchorSource).slice(0, 3).map(quotePhrase).filter(Boolean);

  const parts: string[] = [];
  if (titles.length > 1) parts.push(`(${titles.join(" OR ")})`);
  else if (titles.length === 1) parts.push(titles[0]);
  parts.push(...anchors);

  const query = parts.join(" AND ");
  // Fallbacks: a bare cleaned title, else empty (caller treats empty as
  // "fall back to manual entry").
  return query || quotePhrase(cleanQuery(role.title ?? "")) || "";
}
