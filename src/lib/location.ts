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

const NON_LOCATION_TERMS = [
  "specialist",
  "training",
  "design",
  "development",
  "delivery",
  "clients",
  "client",
  "manager",
  "director",
  "engineer",
  "developer",
  "consultant",
  "analyst",
  "coordinator",
  "officer",
  "lead",
  "senior",
  "junior",
  "principal",
  "multiple",
  "at",
  "for",
  "with",
  "across",
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
  return OVERSEAS_MARKERS.some((marker) => {
    const normalizedMarker = normalizeLocationText(marker);
    if (normalizedMarker.length <= 3) {
      return new RegExp(`(^| )${normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(normalized);
    }
    return normalized.includes(normalizedMarker);
  });
}

export function isPlausibleLocation(value: string | null | undefined): boolean {
  const raw = value?.trim() ?? "";
  if (!raw || raw.length > 120) return false;

  if (isNzLocation(raw) || isExplicitlyOverseasLocation(raw)) return true;

  const normalized = normalizeLocationText(raw);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;

  const hasTitleLanguage = NON_LOCATION_TERMS.some((term) =>
    words.includes(normalizeLocationText(term))
  );
  if (hasTitleLanguage) return false;

  if (raw.includes(",")) {
    const segments = raw.split(",").map((part) => normalizeLocationText(part)).filter(Boolean);
    return (
      segments.length >= 2 &&
      segments.length <= 3 &&
      segments.every((segment) => {
        const segmentWords = segment.split(/\s+/).filter(Boolean);
        return segmentWords.length > 0 && segmentWords.length <= 4;
      })
    );
  }

  return words.length <= 3;
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

export function extractKnownLocationTargets(...values: Array<string | null | undefined>): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeLocationText(value ?? "");
    if (!normalized) continue;

    const matches = NZ_CITIES.flatMap((city) => {
      const indexes = city.keywords
        .map((keyword) => {
          const normalizedKeyword = normalizeLocationText(keyword);
          const match = new RegExp(`(^| )${normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).exec(normalized);
          return match?.index ?? -1;
        })
        .filter((index) => index >= 0);
      const firstIndex = indexes.length > 0 ? Math.min(...indexes) : -1;
      return firstIndex >= 0 ? [{ city, index: firstIndex }] : [];
    }).sort((a, b) => a.index - b.index);

    for (const { city } of matches) {
      const key = normalizeLocationText(city.name);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(city.name);
    }
  }

  return targets;
}

export function buildTargetLocationLabel(...values: Array<string | null | undefined>): string {
  const targets = extractKnownLocationTargets(...values);
  if (targets.length > 0) return targets.join(" OR ");
  return values.map((value) => value?.trim()).find(Boolean) ?? "";
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

  if (!candidateRaw || !isPlausibleLocation(candidateRaw)) {
    return {
      score: remoteFriendly ? 55 : 45,
      evidence: "Candidate location is not clearly stated in the available profile data.",
    };
  }

  // Detect when the stored "location" is actually a person's full name — a data
  // extraction error (e.g. "Wellington Gomes Graciani" parsed as Wellington NZ).
  // Heuristic: 2+ titlecase words, no comma, no digits, no known location markers.
  const nameWords = candidateRaw.trim().split(/\s+/);
  const looksLikeName =
    nameWords.length >= 2 &&
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

  const explicitTargets = extractKnownLocationTargets(targetRaw, locationRules);
  if (explicitTargets.length > 1) {
    const assessments = explicitTargets
      .map((target) => assessLocationFit(candidateRaw, target, null))
      .filter((assessment): assessment is LocationFitAssessment => Boolean(assessment));
    if (assessments.length > 0) {
      const best = assessments.reduce((currentBest, assessment) =>
        assessment.score > currentBest.score ? assessment : currentBest
      );
      return {
        ...best,
        evidence: `${best.evidence} Acceptable role locations: ${explicitTargets.join(", ")}.`,
      };
    }
  }

  const effectiveTarget = explicitTargets[0] ?? targetRaw;
  const targetKeywords = expandLocationKeywords(effectiveTarget);
  const normalizedCandidate = normalizeLocationText(candidateRaw);
  const normalizedTarget = normalizeLocationText(effectiveTarget);

  if (
    normalizedCandidate === normalizedTarget ||
    normalizedCandidate.includes(normalizedTarget) ||
    normalizedIncludesAny(candidateRaw, targetKeywords)
  ) {
    return {
      score: 100,
      evidence: `Based in ${candidateRaw}, matching the required ${effectiveTarget} location.`,
    };
  }

  const candidateCoords = getCityCoords(candidateRaw);
  const targetCoords = getCityCoords(effectiveTarget);

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
