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
  // United Kingdom + Ireland. NOTE: dropped "reading" / "oxford" / "cambridge"
  // / "cork" — they're common English words that false-positive in normal
  // profile text ("reading list", "Oxford comma", "Cambridge University
  // Press"). Cambridge also collides with a NZ town. UK candidates from
  // those cities will still be caught by other signals (UK country marker,
  // explicit UK location, etc.) when they actually live there.
  "london", "manchester", "birmingham", "leeds", "glasgow", "edinburgh",
  "liverpool", "bristol", "cardiff", "belfast", "sheffield", "newcastle upon tyne",
  "nottingham", "leicester", "coventry", "southampton",
  "dublin", "galway", "limerick",
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

// ─── Profile-text country inference ──────────────────────────────────────
//
// Even when the structured `location` field is empty, a captured LinkedIn
// profile usually carries enough signal to place the candidate. We use a
// deliberately narrow inference — only the candidate's CURRENT role
// (the experience block ending in "Present") and explicit "based in"
// phrases. Past roles, education, and country-name frequency are ignored
// because they're how returnee Kiwis (worked overseas, now home) get
// false-positived.
//
// NZ veto: any unambiguous NZ token anywhere in the profile (NZ, New
// Zealand, Aotearoa, Auckland, Wellington, Christchurch, etc.) overrides
// every overseas signal. Better to occasionally let an overseas candidate
// through than to ban a returnee.

// Tokens that, when found in a candidate's profile, are treated as evidence
// they're in NZ. Used as a tie-breaker — see inferCandidateCountry.
//
// CAREFUL: substring-matched against the full text. "wellington" alone matches
// the candidate's surname "Wellington Smith". To prevent that, the veto is
// only applied when overseas signals are weak (< 2). When overseas signals
// corroborate (e.g. explicit Sydney + Present-Sydney), the body name match
// can no longer override.
const NZ_VETO_TOKENS = [
  "new zealand", "aotearoa", "auckland", "wellington", "christchurch",
  "hamilton, waikato", "tauranga", "dunedin", "palmerston north", "rotorua",
  "napier", "nelson", "queenstown", "invercargill", "whangarei", "porirua",
  "lower hutt", "upper hutt", "petone", "remote, nz", "remote from nz",
  "remote (nz)", "based in nz", "nz based",
  // Te reo place names — caught the agent review for missing them.
  "te whanganui-a-tara", "te whanganui a tara", "poneke",
  "tamaki makaurau", "otautahi", "kirikiriroa", "otepoti",
];

// Companies that virtually never employ NZ-based staff. A candidate whose
// CURRENT role is at one of these and whose location signal isn't NZ-positive
// is very likely overseas. NZ-suffixed forms (e.g. Westpac NZ) are always
// safe — they're distinct names. List drawn from agent research; conservative.
const DEFINITELY_OVERSEAS_COMPANIES = [
  "atlassian", "canva", "telstra", "commonwealth bank", "commbank",
  "macquarie group", "macquarie bank", "national australia bank",
  "qantas", "optus", "bunnings", "rea group", "carsales", "seek limited",
  "myob", "kelly+partners", "westpac banking corporation",
  "tata consultancy services", "infosys", "wipro", "hcl technologies",
  "tech mahindra", "cognizant", "reliance industries",
  "alibaba", "tencent", "huawei", "bytedance",
  "hsbc", "barclays", "lloyds banking", "standard chartered",
  "vodafone group",
  "sap se", "siemens", "ericsson", "spotify",
];

// "Present · Sydney, Australia" / "Present — Melbourne, VIC" / "Present | London"
const PRESENT_LOCATION_RE =
  /\b(?:Present|Now|Current)\b\s*[·•\-–—|,]\s*([A-Z][\w' .,-]{2,80}?)(?:\n|$|\s{2,})/g;

// "based in Sydney" / "Sydney-based" / "located in Melbourne" / "live in London"
const BASED_IN_RE =
  /\b(?:based|located|live|living|reside|residing|currently)\s+in\s+([A-Z][\w' -]{2,40})\b/gi;
const X_BASED_RE = /\b([A-Z][\w' -]{2,40})-based\b/g;

// "previously based in X" / "moved from X" / "originally from X" — DON'T count.
// Note: "moved to X" is a CURRENT-residence signal (the candidate is now in X),
// so it must NOT be in this list — including "to" inverted the semantics and
// suppressed the destination as an overseas signal. Same for "relocated to".
const NEGATIVE_PREFIX_RE =
  /\b(?:previously|formerly|originally|ex-|moved\s+from|relocated\s+from|left\s+|grew\s+up\s+in)\s+(?:[\w\s]{0,30}?)$/i;

export interface CandidateCountryInference {
  country: "NZ" | "OVERSEAS" | "UNKNOWN";
  confidence: "high" | "medium" | "low";
  evidence: string;
}

/**
 * Infer a candidate's country from their profile text + headline + explicit
 * location, applying the false-positive guards from the design review:
 *   - Present-block exclusivity (only current role counts).
 *   - NZ veto (any NZ token wins).
 *   - Two-signal requirement for OVERSEAS verdict (one signal alone returns
 *     UNKNOWN so the candidate is reviewable, not auto-rejected).
 */
export function inferCandidateCountry(args: {
  profileText?: string | null;
  headline?: string | null;
  explicitLocation?: string | null;
}): CandidateCountryInference {
  const text = [args.explicitLocation, args.headline, args.profileText]
    .filter((v): v is string => Boolean(v))
    .join("\n");

  if (!text) return { country: "UNKNOWN", confidence: "low", evidence: "no profile text" };

  const lc = text.toLowerCase();

  // ── Hard NZ signals — these are unambiguous and short-circuit ────────
  if (args.explicitLocation && isNzLocation(args.explicitLocation)) {
    return {
      country: "NZ", confidence: "high",
      evidence: `explicit NZ location: "${args.explicitLocation}"`,
    };
  }
  if (/\+64\b/.test(text)) {
    return { country: "NZ", confidence: "high", evidence: "phone +64 in profile" };
  }

  // ── Collect overseas signals ─────────────────────────────────────────
  const overseasSignals: string[] = [];
  if (args.explicitLocation && isExplicitlyOverseasLocation(args.explicitLocation)) {
    overseasSignals.push(`explicit location is overseas: "${args.explicitLocation}"`);
  }

  const phoneOverseas = text.match(/\+(61|44|91)\b/);
  if (phoneOverseas) {
    overseasSignals.push(`phone country code +${phoneOverseas[1]}`);
  }

  // Present-block location — only the current role's location string.
  PRESENT_LOCATION_RE.lastIndex = 0;
  let presentMatch: RegExpExecArray | null;
  while ((presentMatch = PRESENT_LOCATION_RE.exec(text)) !== null) {
    const raw = presentMatch[1].trim().replace(/\s+/g, " ");
    if (raw.length > 80) continue;
    if (isExplicitlyOverseasLocation(raw)) {
      overseasSignals.push(`Present-role location: "${raw}"`);
      break;
    }
  }

  // "based in X" / "X-based" — reject if preceded by negative qualifier.
  for (const re of [BASED_IN_RE, X_BASED_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (NEGATIVE_PREFIX_RE.test(before)) continue;
      const captured = m[1].trim();
      if (isExplicitlyOverseasLocation(captured)) {
        overseasSignals.push(`based-in: "${captured}"`);
        break;
      }
    }
  }

  // Definitely-overseas company in CURRENT role context only.
  for (const company of DEFINITELY_OVERSEAS_COMPANIES) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b[^\\n]{0,200}\\bPresent\\b`, "i");
    if (re.test(text)) {
      overseasSignals.push(`current role at overseas-only company: "${company}"`);
      break;
    }
  }

  // ── Soft NZ veto ─────────────────────────────────────────────────────
  // Body-text mentions of NZ tokens (e.g. profile body says "Wellington",
  // or candidate's surname is "Wellington") are NOT enough on their own
  // to override corroborated overseas signals. They DO override single-
  // signal overseas, since a single signal is too weak to auto-reject.
  const nzMentions = NZ_VETO_TOKENS.filter((t) => lc.includes(t));

  // Two corroborating overseas signals — hard reject regardless of body
  // NZ mentions. This catches "Wellington Smith" with explicit Sydney +
  // Present-Sydney: name happens to contain "wellington" but the two
  // unambiguous Sydney signals win.
  if (overseasSignals.length >= 2) {
    return {
      country: "OVERSEAS",
      confidence: "high",
      evidence: overseasSignals.join("; "),
    };
  }

  // Single overseas signal + NZ mentions in body → NZ wins (returnee Kiwi,
  // mentions Sydney once, has NZ city in summary). Reviewable medium
  // confidence — recruiter still gets the candidate.
  if (overseasSignals.length === 1 && nzMentions.length > 0) {
    return {
      country: "NZ", confidence: "medium",
      evidence: `single overseas signal (${overseasSignals[0]}) overridden by NZ mentions: ${nzMentions.join(", ")}`,
    };
  }

  // Single overseas signal, no NZ mention → UNKNOWN (reviewable, not
  // auto-rejected).
  if (overseasSignals.length === 1) {
    return {
      country: "UNKNOWN",
      confidence: "medium",
      evidence: `weak overseas signal (${overseasSignals[0]}) — reviewable`,
    };
  }

  // No overseas signals. NZ tokens in body → soft NZ verdict.
  if (nzMentions.length > 0) {
    return {
      country: "NZ", confidence: "medium",
      evidence: `NZ mentions in profile: ${nzMentions.join(", ")}`,
    };
  }

  return { country: "UNKNOWN", confidence: "low", evidence: "no strong country signal" };
}

/**
 * Strict country gate that combines the explicit location check with profile-
 * text inference. Use this at save sites that have profileText available.
 * Hard reject only when inference is "OVERSEAS" with high confidence — the
 * UNKNOWN bucket is intentionally permissive.
 */
export function shouldRejectAsOverseas(args: {
  explicitLocation?: string | null;
  headline?: string | null;
  profileText?: string | null;
  isRemote?: boolean;
}): { reject: boolean; evidence: string } {
  if (args.isRemote) return { reject: false, evidence: "role is remote" };
  // Cheap path first — explicit-overseas location is a hard reject.
  if (args.explicitLocation && isExplicitlyOverseasLocation(args.explicitLocation)) {
    return { reject: true, evidence: `explicit location: "${args.explicitLocation}"` };
  }
  // Inference path — only reject on high-confidence OVERSEAS verdict.
  const inferred = inferCandidateCountry(args);
  if (inferred.country === "OVERSEAS" && inferred.confidence === "high") {
    return { reject: true, evidence: inferred.evidence };
  }
  return { reject: false, evidence: inferred.evidence };
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
