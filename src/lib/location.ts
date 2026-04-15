// All location data lives in nz-cities.ts — this file only exposes the
// matching functions that the search route uses.
import { NZ_CITIES } from "./nz-cities";

/**
 * Expand a location string to all known aliases (English + Māori + abbreviations).
 * e.g. "Wellington" → ["wellington", "pōneke", "poneke", "te whanganui-a-tara", ...]
 */
export function expandLocationKeywords(location: string): string[] {
  const base = location
    .toLowerCase()
    .split(/[,/|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  const expanded = new Set(base);

  for (const term of base) {
    for (const city of NZ_CITIES) {
      if (city.keywords.some((kw) => term.includes(kw) || kw.includes(term))) {
        city.keywords.forEach((kw) => expanded.add(kw));
      }
    }
  }

  return [...expanded];
}

/**
 * Returns true if the candidate location is compatible with any of the
 * expanded job location keywords. Lenient when either value is empty.
 */
export function locationMatches(candidateLoc: string, jobKeywords: string[]): boolean {
  if (!candidateLoc || jobKeywords.length === 0) return true;
  const lower = candidateLoc.toLowerCase();
  return jobKeywords.some((kw) => lower.includes(kw));
}
