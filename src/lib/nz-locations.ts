/**
 * Canonical NZ location list — the single source of truth for the search
 * location dropdown AND the server-side location filter on scraped results.
 *
 * WHY: the LinkedIn/SEEK scrape legs return NZ-wide cards, and the app used to
 * ingest every one regardless of the requested location — so an Auckland or
 * Christchurch profile landed in a "Wellington" search. The Library leg already
 * filters by location; `locationMatches` gives the scrape legs the same gate,
 * keyed off this list so a region's variant spellings (Christchurch↔Canterbury,
 * Napier↔Hastings↔Hawke's Bay) all match.
 *
 * `value` is what the UI submits + what the Library ILIKE filter uses (so it
 * must be a real substring of stored locations). `matchTerms` is the broader
 * set the scrape-card filter accepts. Empty value = "All New Zealand" (no
 * location filter — full NZ results).
 */
export interface NzLocation {
  value: string;
  label: string;
  /** Lowercased substrings; a card's location matches if it contains ANY. */
  matchTerms: string[];
}

export const NZ_LOCATIONS: NzLocation[] = [
  { value: "",                label: "All New Zealand",                 matchTerms: [] },
  { value: "Auckland",        label: "Auckland",                        matchTerms: ["auckland"] },
  { value: "Wellington",      label: "Wellington",                      matchTerms: ["wellington"] },
  { value: "Christchurch",    label: "Christchurch / Canterbury",       matchTerms: ["christchurch", "canterbury"] },
  { value: "Hamilton",        label: "Hamilton / Waikato",              matchTerms: ["hamilton", "waikato"] },
  { value: "Tauranga",        label: "Tauranga / Bay of Plenty",        matchTerms: ["tauranga", "bay of plenty"] },
  { value: "Dunedin",         label: "Dunedin / Otago",                 matchTerms: ["dunedin", "otago"] },
  { value: "Palmerston North",label: "Palmerston North / Manawatū",     matchTerms: ["palmerston north", "manawat"] },
  { value: "Napier",          label: "Napier / Hastings / Hawke's Bay", matchTerms: ["napier", "hastings", "hawke"] },
  { value: "Nelson",          label: "Nelson",                          matchTerms: ["nelson"] },
  { value: "Rotorua",         label: "Rotorua",                         matchTerms: ["rotorua"] },
  { value: "New Plymouth",    label: "New Plymouth / Taranaki",         matchTerms: ["new plymouth", "taranaki"] },
  { value: "Whangarei",       label: "Whangārei / Northland",           matchTerms: ["whangarei", "whangārei", "northland"] },
  { value: "Invercargill",    label: "Invercargill / Southland",        matchTerms: ["invercargill", "southland"] },
  { value: "Queenstown",      label: "Queenstown",                      matchTerms: ["queenstown", "wakatipu"] },
];

/**
 * True if a scraped card's location should be kept for the selected location.
 * - No selected location ("All NZ") → keep everything.
 * - A location IS selected but the card has no location → drop it (we can't
 *   confirm it's in-region; the user asked to narrow, mirror Library's ILIKE
 *   which excludes NULLs).
 * - Otherwise match on the location's matchTerms (or the raw value as fallback).
 */
export function locationMatches(
  cardLocation: string | null | undefined,
  selected: string | null | undefined,
): boolean {
  const sel = (selected ?? "").trim();
  if (!sel) return true;
  const loc = (cardLocation ?? "").toLowerCase().trim();
  if (!loc) return false;
  const entry = NZ_LOCATIONS.find((l) => l.value.toLowerCase() === sel.toLowerCase());
  const terms = entry && entry.matchTerms.length ? entry.matchTerms : [sel.toLowerCase()];
  return terms.some((t) => loc.includes(t));
}
