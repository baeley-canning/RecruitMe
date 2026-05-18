/**
 * Australian cities for location scoring.
 * Same structure as NZ_CITIES — enables the shared haversine distance and
 * keyword lookup functions to work for AU jobs and candidates.
 *
 * Distance thresholds used for AU scoring:
 *   same metro:   0–50 km   → 100
 *   close:       50–200 km  → 80
 *   regional:   200–600 km  → 50
 *   interstate: 600+ km     → 20 (AU capitals are 700–4000 km apart)
 */

import { distanceKm } from "./nz-cities";
import type { NZCity } from "./nz-cities";

export type AUCity = NZCity; // same shape — name, keywords, lat, lng, parentMetro?

export const AU_CITIES: AUCity[] = [
  // ── New South Wales ───────────────────────────────────────────────────────
  { name: "Sydney",          keywords: ["sydney", "nsw", "new south wales"],                      lat: -33.8688, lng: 151.2093 },
  { name: "Parramatta",      keywords: ["parramatta", "western sydney"],                           lat: -33.8150, lng: 151.0011, parentMetro: "Sydney" },
  { name: "North Sydney",    keywords: ["north sydney"],                                           lat: -33.8370, lng: 151.2093, parentMetro: "Sydney" },
  { name: "Wollongong",      keywords: ["wollongong", "illawarra"],                                lat: -34.4278, lng: 150.8931 },
  { name: "Newcastle",       keywords: ["newcastle", "hunter valley", "hunter region"],            lat: -32.9283, lng: 151.7817 },
  { name: "Canberra",        keywords: ["canberra", "act", "australian capital territory"],        lat: -35.2809, lng: 149.1300 },

  // ── Victoria ─────────────────────────────────────────────────────────────
  { name: "Melbourne",       keywords: ["melbourne", "vic", "victoria"],                           lat: -37.8136, lng: 144.9631 },
  { name: "Richmond",        keywords: ["richmond melbourne", "richmond vic"],                     lat: -37.8182, lng: 144.9974, parentMetro: "Melbourne" },
  { name: "St Kilda",        keywords: ["st kilda", "saint kilda"],                               lat: -37.8678, lng: 144.9817, parentMetro: "Melbourne" },
  { name: "Geelong",         keywords: ["geelong"],                                                lat: -38.1499, lng: 144.3617 },
  { name: "Ballarat",        keywords: ["ballarat"],                                               lat: -37.5622, lng: 143.8503 },
  { name: "Bendigo",         keywords: ["bendigo"],                                                lat: -36.7570, lng: 144.2780 },

  // ── Queensland ────────────────────────────────────────────────────────────
  { name: "Brisbane",        keywords: ["brisbane", "qld", "queensland"],                          lat: -27.4698, lng: 153.0251 },
  { name: "Gold Coast",      keywords: ["gold coast", "surfers paradise", "tweed heads"],          lat: -28.0167, lng: 153.4000 },
  { name: "Sunshine Coast",  keywords: ["sunshine coast", "noosa", "maroochydore"],               lat: -26.6500, lng: 153.0667 },
  { name: "Townsville",      keywords: ["townsville"],                                             lat: -19.2590, lng: 146.8169 },
  { name: "Cairns",          keywords: ["cairns"],                                                 lat: -16.9186, lng: 145.7781 },
  { name: "Toowoomba",       keywords: ["toowoomba"],                                              lat: -27.5598, lng: 151.9507 },

  // ── South Australia ───────────────────────────────────────────────────────
  { name: "Adelaide",        keywords: ["adelaide", "sa", "south australia"],                      lat: -34.9285, lng: 138.6007 },
  { name: "Mount Barker",    keywords: ["mount barker sa"],                                        lat: -35.0680, lng: 138.8564, parentMetro: "Adelaide" },

  // ── Western Australia ─────────────────────────────────────────────────────
  { name: "Perth",           keywords: ["perth", "wa", "western australia"],                       lat: -31.9505, lng: 115.8605 },
  { name: "Fremantle",       keywords: ["fremantle"],                                              lat: -32.0569, lng: 115.7439, parentMetro: "Perth" },

  // ── Tasmania ─────────────────────────────────────────────────────────────
  { name: "Hobart",          keywords: ["hobart", "tas", "tasmania"],                              lat: -42.8821, lng: 147.3272 },
  { name: "Launceston",      keywords: ["launceston"],                                             lat: -41.4343, lng: 147.1316 },

  // ── Northern Territory ────────────────────────────────────────────────────
  { name: "Darwin",          keywords: ["darwin", "nt", "northern territory"],                     lat: -12.4634, lng: 130.8456 },
];

// AU state abbreviations for detection
export const AU_STATE_KEYWORDS = ["nsw", "vic", "qld", "sa", "wa", "tas", "act", "nt"];
export const AU_MARKERS = ["australia", "australian", ...AU_STATE_KEYWORDS];

export function isAuLocation(location: string): boolean {
  if (!location) return false;
  const normalized = location.toLowerCase().trim();
  if (AU_MARKERS.some((m) => normalized.includes(m))) return true;
  return AU_CITIES.some((city) =>
    city.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
  );
}

/** Distance-based score for AU candidate-to-job location matching. */
export function assessAuLocationFit(
  candidateLocation: string | null | undefined,
  targetLocation: string | null | undefined,
): { score: number; evidence: string } | null {
  if (!targetLocation?.trim() || !candidateLocation?.trim()) return null;

  const candidateNorm = candidateLocation.toLowerCase();
  const targetNorm = targetLocation.toLowerCase();

  // Find candidate city
  const candidateCity = AU_CITIES.find((c) =>
    c.keywords.some((k) => candidateNorm.includes(k.toLowerCase()))
  );
  const targetCity = AU_CITIES.find((c) =>
    c.keywords.some((k) => targetNorm.includes(k.toLowerCase()))
  );

  if (!candidateCity || !targetCity) return null;

  // Same city or same metro
  if (candidateCity.name === targetCity.name) {
    return { score: 100, evidence: `Both in ${candidateCity.name}.` };
  }
  if (
    candidateCity.parentMetro && targetCity.parentMetro &&
    candidateCity.parentMetro === targetCity.parentMetro
  ) {
    return { score: 100, evidence: `Both in ${candidateCity.parentMetro} metro.` };
  }
  if (candidateCity.parentMetro === targetCity.name || candidateCity.name === targetCity.parentMetro) {
    return { score: 100, evidence: `${candidateCity.name} is part of ${targetCity.parentMetro ?? targetCity.name} metro.` };
  }

  const km = distanceKm(
    candidateCity.lat, candidateCity.lng,
    targetCity.lat, targetCity.lng,
  );

  if (km < 50)  return { score: 90, evidence: `${candidateCity.name} is ${Math.round(km)} km from ${targetCity.name}.` };
  if (km < 200) return { score: 70, evidence: `${candidateCity.name} is ${Math.round(km)} km from ${targetCity.name}.` };
  if (km < 600) return { score: 45, evidence: `${candidateCity.name} is ${Math.round(km)} km from ${targetCity.name} — regional.` };
  return {
    score: 20,
    evidence: `${candidateCity.name} to ${targetCity.name} is ${Math.round(km)} km — interstate commute not viable.`,
  };
}
