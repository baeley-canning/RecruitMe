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
  // Additional countries missing from current list
  "pakistan",
  "bangladesh",
  "sri lanka",
  "nepal",
  "myanmar",
  "cambodia",
  "turkey",
  "egypt",
  "kenya",
  "nigeria",
  "ghana",
  "ethiopia",
  "greece",
  "czech republic",
  "hungary",
  "sweden",
  "norway",
  "denmark",
  "finland",
  "switzerland",
  "austria",
  "colombia",
  "chile",
  "peru",
  "ukraine",
  "russia",
  "belarus",
  // Additional city/region names that appear in profiles
  "istanbul",
  "ankara",
  "cairo",
  "nairobi",
  "lagos",
  "johannesburg",
  "stockholm",
  "oslo",
  "copenhagen",
  "helsinki",
  "zurich",
  "vienna",
  "warsaw",
  "prague",
  "budapest",
  "bucharest",
  "sao paulo",
  "buenos aires",
  "bogota",
  "lima",
  "moscow",
  "kyiv",
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
  "engineering",
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
  "integration",
  "software",
  "solutions",
  "technology",
  "services",
  "systems",
  "university",
  "student",
  "intern",
  "architect",
  "administrator",
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

// US state two-letter codes and AU/UK state abbreviations that appear in location strings
// like "Chicago, IL" or "Sydney, NSW". Standalone abbreviations are too ambiguous (WA = Western
// Australia OR Washington); we only fire when preceded by a comma, space, or start of string.
const US_STATE_RE = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WV|WI|WY|DC)\b/;
const AU_STATE_RE = /\b(NSW|VIC|QLD|TAS|ACT|NT)\b/; // WA omitted — clashes with Washington

// Cities that, when they appear in a location string with no NZ marker, almost
// always indicate the candidate is overseas. Major centres only — adding a small
// town can produce false positives if a NZ candidate worked there years ago and
// the city name leaked into their location field. The list is substring-matched
// against the normalised location, so "Sydney, NSW, Australia" and bare "Sydney"
// both fire. Conservative on regional cities — when in doubt, leave them out.
const OVERSEAS_CITIES = [
  // Australia
  "sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "hobart",
  "darwin", "gold coast", "wollongong", "newcastle", "geelong", "townsville",
  "cairns", "ballarat", "bendigo", "launceston", "mackay", "rockhampton",
  // United Kingdom + Ireland
  "london", "manchester", "birmingham", "leeds", "glasgow", "edinburgh",
  "liverpool", "bristol", "cardiff", "belfast", "sheffield", "newcastle upon tyne",
  "nottingham", "leicester", "coventry", "southampton", "reading", "oxford",
  "cambridge", "dublin", "cork", "galway", "limerick",
  // India
  "mumbai", "delhi", "new delhi", "bangalore", "bengaluru", "hyderabad", "chennai",
  "kolkata", "pune", "ahmedabad", "jaipur", "lucknow", "kanpur", "nagpur", "indore",
  "noida", "gurgaon", "gurugram", "thane",
  // East / SE Asia (singapore + hong kong already in country markers)
  "tokyo", "osaka", "kyoto", "yokohama", "seoul", "busan", "incheon", "beijing",
  "shanghai", "shenzhen", "guangzhou", "chengdu", "hangzhou", "kuala lumpur",
  "jakarta", "manila", "bangkok", "ho chi minh city", "hanoi", "taipei",
  // Middle East
  "dubai", "abu dhabi", "doha", "riyadh", "jeddah", "muscat", "manama",
  "kuwait city", "tel aviv", "jerusalem",
  // North America (also covered by US_STATE_RE / US_CITIES_RE for explicit forms,
  // but bare city names still need entries here)
  "toronto", "vancouver", "montreal", "calgary", "ottawa", "edmonton", "winnipeg",
  // Europe
  "berlin", "munich", "frankfurt", "hamburg", "paris", "lyon", "marseille",
  "madrid", "barcelona", "valencia", "rome", "milan", "naples", "turin",
  "amsterdam", "rotterdam", "the hague", "brussels", "antwerp", "lisbon", "porto",
  "athens", "thessaloniki", "warsaw", "krakow", "prague", "budapest", "bucharest",
  // South America
  "sao paulo", "rio de janeiro", "buenos aires", "santiago", "bogota", "lima",
  // Africa
  "johannesburg", "cape town", "durban", "pretoria", "lagos", "abuja", "nairobi",
  "cairo", "casablanca",
];
// Common US cities not covered by OVERSEAS_MARKERS
const US_CITIES_RE = /\b(pittsburgh|philadelphia|chicago|houston|atlanta|dallas|boston|denver|seattle|miami|charlotte|raleigh|phoenix|minneapolis|portland|detroit|sacramento|austin|nashville|baltimore|st louis|new orleans|tampa|las vegas|cincinnati|cleveland|kansas city|columbus|indianapolis|louisville|memphis|san francisco|san diego|san jose|los angeles|new york|washington dc)\b/i;

export function isExplicitlyOverseasLocation(location: string): boolean {
  const normalized = normalizeLocationText(location);
  if (!normalized) return false;
  if (NZ_MARKERS.some((marker) => normalized.includes(marker))) return false;
  if (OVERSEAS_MARKERS.some((marker) => {
    const normalizedMarker = normalizeLocationText(marker);
    if (normalizedMarker.length <= 3) {
      return new RegExp(`(^| )${normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(normalized);
    }
    return normalized.includes(normalizedMarker);
  })) return true;
  // Bare overseas city names (e.g. "Sydney" without "Australia") — these were
  // the silent leak path: SerpAPI/Bing snippets often only carry the city.
  if (OVERSEAS_CITIES.some((city) => normalized.includes(city))) return true;
  // US/AU state abbreviations and known US city names in the location string
  if (US_STATE_RE.test(location) || AU_STATE_RE.test(location) || US_CITIES_RE.test(normalized)) return true;
  return false;
}

/**
 * Hard country gate: would importing this candidate place a clearly-overseas
 * person on a NZ-only role? Use this at every Candidate save site so an
 * Australian / UK / Indian / etc. candidate cannot land on a Wellington (or
 * any NZ) role unless the role is explicitly remote.
 *
 * Semantics:
 *   - Remote roles → never block (anywhere is fine).
 *   - Primary location is explicitly overseas → block.
 *   - Otherwise → don't block. Unknown / NZ-but-distant locations are
 *     LOOSE-passed; city-distance scoring handles ranking, not import.
 */
export function isOverseasForNzRole(
  candidateLocation: string | null | undefined,
  isRemote?: boolean,
): boolean {
  if (isRemote) return false;
  const raw = candidateLocation?.trim() ?? "";
  if (!raw) return false; // unknown — let it through, fetch will reveal more
  return isExplicitlyOverseasLocation(raw);
}

export function isPlausibleLocation(value: string | null | undefined): boolean {
  const raw = value?.trim() ?? "";
  if (!raw || raw.length > 120) return false;

  const normalized = normalizeLocationText(raw);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;

  // Title-language check runs first — a job title that happens to contain a city
  // name (e.g. "Senior Developer at Wellington University") is not a location.
  const hasTitleLanguage = NON_LOCATION_TERMS.some((term) =>
    words.includes(normalizeLocationText(term))
  );
  if (hasTitleLanguage) return false;

  if (isNzLocation(raw) || isExplicitlyOverseasLocation(raw)) return true;

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

export function isRemoteFriendlyLocationRule(locationRules?: string | null): boolean {
  const normalized = normalizeLocationText(locationRules ?? "");
  if (!normalized) return false;
  // Office attendance (hybrid or partial) overrides a remote mention — e.g.
  // "Remote optional, 3 days in office" is NOT remote-friendly.
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

/**
 * Pick the best candidate-location guess by combining:
 *   1. Explicit location field (LinkedIn metadata, talent-pool entry).
 *   2. Snippet/profile-text scan for NZ city mentions (e.g. "Auckland-based"
 *      somewhere in the body even if the structured location field is empty).
 *
 * Used by the search route so candidates whose snippet plainly mentions
 * Auckland don't slip through when the recruiter's searching Wellington
 * and the structured location field is null.
 */
export function inferCandidateLocation(
  explicitLocation: string | null | undefined,
  ...textSources: Array<string | null | undefined>
): string | null {
  // Trust the explicit location if it's plausible.
  const trimmed = explicitLocation?.trim() ?? "";
  if (trimmed && isPlausibleLocation(trimmed)) return trimmed;

  // Otherwise scan supplied text fragments for an NZ city mention.
  for (const source of textSources) {
    if (!source) continue;
    const cities = extractKnownLocationTargets(source);
    if (cities.length > 0) return cities[0];
  }

  // Fall back to the explicit value even if implausible (better than null
  // for downstream "unknown" handling — assessLocationFit will give it a
  // soft 45 score).
  return trimmed || null;
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

export function isConfirmedOutOfAreaForLocalRole(
  candidateLocation: string | null | undefined,
  targetLocation: string | null | undefined,
  locationRules?: string | null,
  isRemote?: boolean,
): boolean {
  if (isRemote) return false;
  const assessment = assessLocationFit(candidateLocation, targetLocation, locationRules);
  // Unknown/unclear locations score 45 and should stay reviewable. A score of
  // 35 or below means we have a concrete non-local location, e.g. Auckland for
  // a Wellington office role.
  return Boolean(assessment && assessment.score <= 35);
}
