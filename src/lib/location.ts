import { distanceKm, getCityCoords, NZ_CITIES } from "./nz-cities";

const NZ_MARKERS = ["new zealand", "aotearoa"];
const OVERSEAS_MARKERS = [
  "australia",
  "united kingdom",
  "uk",
  "england",
  "scotland",
  "wales",
  "ireland",
  "china",
  "hong kong",
  "singapore",
  "india",
  "philippines",
  "malaysia",
  "indonesia",
  "thailand",
  "vietnam",
  "japan",
  "korea",
  "canada",
  "united states",
  "usa",
  "mexico",
  "brazil",
  "argentina",
  "south africa",
  "germany",
  "france",
  "spain",
  "italy",
  "netherlands",
  "poland",
  "portugal",
  "romania",
  "uae",
  "dubai",
];

export interface LocationFitAssessment {
  score: number;
  evidence: string;
}

function stripDiacritics(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeLocationText(value: string): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedIncludesAny(value: string, terms: string[]): boolean {
  const normalized = normalizeLocationText(value);
  return terms.some((term) => normalized.includes(normalizeLocationText(term)));
}

export function isNzLocation(location: string): boolean {
  const normalized = normalizeLocationText(location);
  if (!normalized) return false;
  if (NZ_MARKERS.some((marker) => normalized.includes(marker))) return true;
  return NZ_CITIES.some((city) =>
    city.keywords.some((keyword) => normalized.includes(normalizeLocationText(keyword)))
  );
}

export function isExplicitlyOverseasLocation(location: string): boolean {
  const normalized = normalizeLocationText(location);
  if (!normalized) return false;
  if (NZ_MARKERS.some((marker) => normalized.includes(marker))) return false;
  return OVERSEAS_MARKERS.some((marker) => normalized.includes(normalizeLocationText(marker)));
}

function isRemoteFriendlyLocationRule(locationRules?: string | null): boolean {
  const normalized = normalizeLocationText(locationRules ?? "");
  if (!normalized) return false;
  if (normalized.includes("hybrid") || normalized.includes("office")) return false;
  return (
    normalized.includes("remote") ||
    normalized.includes("work from home") ||
    normalized.includes("nz based") ||
    normalized.includes("new zealand based") ||
    normalized.includes("anywhere in nz")
  );
}

/**
 * Expand a location string to all known aliases.
 * Example: "Wellington" -> ["wellington", "poneke", "te whanganui a tara", ...]
 */
export function expandLocationKeywords(location: string): string[] {
  const base = location
    .split(/[,/|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);

  const expanded = new Set(base);

  for (const term of base) {
    const normalizedTerm = normalizeLocationText(term);
    for (const city of NZ_CITIES) {
      if (
        city.keywords.some((keyword) => {
          const normalizedKeyword = normalizeLocationText(keyword);
          return normalizedTerm.includes(normalizedKeyword) || normalizedKeyword.includes(normalizedTerm);
        })
      ) {
        city.keywords.forEach((keyword) => expanded.add(keyword));
      }
    }
  }

  return [...expanded];
}

/**
 * Returns true if the candidate location is compatible with any of the
 * expanded job location keywords. When a candidate location explicitly names
 * an overseas country, reject it even if a city name overlaps.
 */
export function locationMatches(candidateLoc: string, jobKeywords: string[]): boolean {
  if (!candidateLoc || jobKeywords.length === 0) return true;
  if (isExplicitlyOverseasLocation(candidateLoc)) return false;

  const normalized = normalizeLocationText(candidateLoc);
  const keywords = jobKeywords
    .map((keyword) => normalizeLocationText(keyword))
    .filter((keyword) => keyword.length > 1);

  return keywords.some((keyword) => normalized.includes(keyword));
}

export function assessLocationFit(
  candidateLocation: string | null | undefined,
  targetLocation: string | null | undefined,
  locationRules?: string | null,
): LocationFitAssessment | null {
  const targetRaw = targetLocation?.trim() ?? "";
  if (!targetRaw) return null;

  const candidateRaw = candidateLocation?.trim() ?? "";
  const remoteFriendly = isRemoteFriendlyLocationRule(locationRules);

  if (!candidateRaw) {
    return {
      score: remoteFriendly ? 55 : 45,
      evidence: "Candidate location is not clearly stated in the available profile data.",
    };
  }

  // Detect when the stored "location" is actually a person's full name — a data
  // extraction error (e.g. "Wellington Gomes Graciani" parsed as Wellington NZ).
  // Heuristic: 3+ titlecase words, no comma, no digits, no overseas markers.
  const nameWords = candidateRaw.trim().split(/\s+/);
  const looksLikeName =
    nameWords.length >= 3 &&
    !candidateRaw.includes(",") &&
    !/\d/.test(candidateRaw) &&
    nameWords.every((w) => /^[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÜÇ]/u.test(w)) &&
    !isExplicitlyOverseasLocation(candidateRaw) &&
    !isNzLocation(candidateRaw);
  if (looksLikeName) {
    return {
      score: remoteFriendly ? 55 : 45,
      evidence: "Candidate location is not clearly stated in the available profile data.",
    };
  }

  if (isExplicitlyOverseasLocation(candidateRaw)) {
    return {
      score: 0,
      evidence: `Based in ${candidateRaw}, outside the required ${targetRaw} market.`,
    };
  }

  const targetKeywords = expandLocationKeywords(targetRaw);
  const normalizedCandidate = normalizeLocationText(candidateRaw);
  const normalizedTarget = normalizeLocationText(targetRaw);

  if (
    normalizedCandidate === normalizedTarget ||
    normalizedCandidate.includes(normalizedTarget) ||
    normalizedIncludesAny(candidateRaw, targetKeywords)
  ) {
    return {
      score: 100,
      evidence: `Based in ${candidateRaw}, matching the required ${targetRaw} location.`,
    };
  }

  const candidateCoords = getCityCoords(candidateRaw);
  const targetCoords = getCityCoords(targetRaw);

  if (candidateCoords && targetCoords) {
    const distance = Math.round(
      distanceKm(candidateCoords.lat, candidateCoords.lng, targetCoords.lat, targetCoords.lng)
    );

    if (distance <= 30) {
      return {
        score: 100,
        evidence: `Based in ${candidateCoords.name}, within ${distance} km of ${targetCoords.name}.`,
      };
    }

    if (distance <= 80) {
      return {
        score: 80,
        evidence: `Based in ${candidateCoords.name}, about ${distance} km from ${targetCoords.name} and still commutable.`,
      };
    }

    if (distance <= 150) {
      return {
        score: remoteFriendly ? 75 : 55,
        evidence: `Based in ${candidateCoords.name}, about ${distance} km from ${targetCoords.name}; close enough for occasional travel but not local.`,
      };
    }

    return {
      score: remoteFriendly ? 70 : 20,
      evidence: `Based in ${candidateCoords.name}, about ${distance} km from ${targetCoords.name}, so this is not a local match.`,
    };
  }

  if (isNzLocation(candidateRaw) && isNzLocation(targetRaw)) {
    return {
      score: remoteFriendly ? 70 : 35,
      evidence: `NZ-based in ${candidateRaw}, but not clearly local to ${targetRaw}.`,
    };
  }

  return {
    score: 45,
    evidence: `Location fit is unclear from the stated location: ${candidateRaw}.`,
  };
}
