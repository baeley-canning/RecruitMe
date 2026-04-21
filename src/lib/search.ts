import { normaliseLinkedInUrl } from "./linkedin";
import { getCityCoords, NZ_CITIES } from "./nz-cities";

export interface SearchResult {
  name: string;
  headline: string;
  location: string;
  linkedinUrl: string;
  snippet: string;
  fullText?: string; // full profile text for sources that return it (PDL)
  source: "serpapi" | "bing" | "pdl";
}

// ─── Name / org filtering ────────────────────────────────────────────────────

const ORG_PATTERNS = [
  /\b(ministry|department|government|council|authority|commission|bureau)\b/i,
  /\b(university|college|institute|polytechnic|wānanga|school|academy)\b/i,
  /\b(ltd|limited|inc|incorporated|corp|corporation|llc|pty|plc|co\.)\b/i,
  /\b(recruitment|staffing|consulting|consultancy|solutions|services|group|agency)\b/i,
  /\b(foundation|trust|society|association|federation|charity|ngo)\b/i,
  /\b(hospital|clinic|health board|district health)\b/i,
  /\b(bank|insurance|accounting|auditing|law firm)\b/i,
];

const TITLE_STARTERS = [
  "manager", "director", "specialist", "analyst", "engineer", "developer",
  "consultant", "coordinator", "officer", "administrator", "executive",
  "head of", "chief", "vp ", "vice president", "president", "ceo", "cto",
  "coo", "cfo", "senior", "junior", "lead ", "principal", "associate",
  "recruiting", "talent", "hr ", "human resources", "technical",
];

const LOCATION_SEPARATOR_RE = /\s+[|·•]\s+|\s+[-–—]\s+|\n+/g;
const LOCATION_COUNTRY_RE =
  /\b(new zealand|aotearoa|australia|united kingdom|uk|england|scotland|wales|ireland|china|hong kong|singapore|india|philippines|malaysia|indonesia|thailand|vietnam|japan|korea|canada|united states|usa|mexico|brazil|argentina|south africa|germany|france|spain|italy|netherlands|poland|portugal|romania|uae|dubai)\b/i;

function cleanSearchText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

function stripSearchLocationNoise(value: string): string {
  return value
    .replace(/\b(hybrid|remote|remotely|onsite|on-site|in office|office based|office|work from home|wfh)\b.*$/i, "")
    .replace(/[|/]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[,\-–—\s]+$/g, "")
    .trim();
}

function buildLocationSearchTerm(location: string): string {
  const cleaned = stripSearchLocationNoise(location);
  if (!cleaned) return "";

  const city = getCityCoords(cleaned);
  if (city) return `${city.name} New Zealand`;
  return cleaned;
}

function buildLinkedInSearchQuery(query: string, location: string): string {
  const locationTerm = buildLocationSearchTerm(location);
  return locationTerm
    ? `site:linkedin.com/in ${query} ${locationTerm}`
    : `site:linkedin.com/in ${query}`;
}

function looksLikeLocationFragment(fragment: string): boolean {
  const lower = fragment.toLowerCase();
  if (!lower || lower.length < 2 || lower.length > 80) return false;
  if (
    /\b(contact info|connections|followers|message|follow|connect|linkedin|skills|experience|education|recommendations|company|full-time|part-time|present)\b/i.test(
      fragment
    )
  ) {
    return false;
  }

  if (LOCATION_COUNTRY_RE.test(fragment)) return true;
  // Comma-separated "City, Country" pattern is a reliable location indicator.
  if (/^[a-z .'-]+,\s*[a-z .'-]+(?:,\s*[a-z .'-]+)?$/i.test(fragment)) return true;
  // NZ city keyword — but only if the fragment is short enough to be a place name,
  // not a person's full name (e.g. "Wellington Gomes Graciani" has 3 words and is
  // NOT a location, even though it starts with the NZ city "Wellington").
  const wordCount = fragment.trim().split(/\s+/).length;
  if (wordCount <= 2 && NZ_CITIES.some((city) => city.keywords.some((kw) => lower.includes(kw)))) return true;
  return false;
}

export function inferLocationFromSearchText(...values: string[]): string {
  for (const value of values) {
    const cleaned = cleanSearchText(value);
    if (!cleaned) continue;

    const fragments = cleaned
      .split(LOCATION_SEPARATOR_RE)
      .map((fragment) => cleanSearchText(fragment))
      .filter(Boolean);

    for (const fragment of fragments) {
      // Always sub-split on ". " — handles "Title at Co. City, Country" patterns.
      // Single-part fragments (no period) pass through unchanged.
      const parts = fragment.split(/\.\s+/).map(cleanSearchText).filter(Boolean);
      for (const part of parts) {
        if (looksLikeLocationFragment(part)) return part;
      }
    }

    const commaPhrase = cleaned.match(
      /([A-Za-z .'-]+,\s*[A-Za-z .'-]+(?:,\s*(?:New Zealand|Australia|United Kingdom|England|China|India|Singapore|Canada|United States|USA))?)/i
    )?.[1];
    if (commaPhrase && looksLikeLocationFragment(commaPhrase)) {
      return cleanSearchText(commaPhrase);
    }
  }

  return "";
}

/** Returns false if the name looks like an organisation or a job title */
function looksLikePersonName(name: string): boolean {
  if (!name || name.length < 3 || name.length > 60) return false;
  if (ORG_PATTERNS.some((p) => p.test(name))) return false;
  const lower = name.toLowerCase();
  if (TITLE_STARTERS.some((t) => lower.startsWith(t))) return false;
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  return true;
}

/** Parse LinkedIn profiles out of a generic list of search result items */
function parseLinkedInResults(
  items: Array<{ title?: string; url?: string; link?: string; snippet?: string }>,
  source: "serpapi" | "bing"
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const item of items) {
    const link = item.url ?? item.link ?? "";
    if (!link.includes("linkedin.com/in/")) continue;

    const rawTitle = item.title ?? "";
    const namePart = rawTitle.split(" - ")[0]?.split(" | ")[0]?.trim() ?? "";
    const headlinePart = rawTitle.split(" - ")[1]?.split(" | ")[0]?.trim() ?? "";
    const locationPart = inferLocationFromSearchText(rawTitle, item.snippet ?? "");

    if (!looksLikePersonName(namePart)) continue;

    results.push({
      name: namePart,
      headline: headlinePart,
      location: locationPart,
      linkedinUrl: link,
      snippet: item.snippet ?? "",
      source,
    });
  }
  return results;
}

// ─── SerpAPI (Google) ─────────────────────────────────────────────────────────

export async function searchLinkedInProfiles(
  query: string,
  location: string,
  start = 0,
): Promise<SearchResult[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error("SERPAPI_API_KEY is not configured");

  const searchQuery = buildLinkedInSearchQuery(query, location);

  const params = new URLSearchParams({
    engine: "google",
    q: searchQuery,
    api_key: apiKey,
    num: "10",
    start: String(start),
    gl: "nz",
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) throw new Error(`SerpAPI error: ${res.status} ${res.statusText}`);

  const data = await res.json() as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  return parseLinkedInResults(data.organic_results ?? [], "serpapi");
}

// ─── Bing Web Search ──────────────────────────────────────────────────────────

export async function searchBingLinkedInProfiles(
  query: string,
  location: string,
  offset = 0,
): Promise<SearchResult[]> {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) throw new Error("BING_API_KEY is not configured");

  const searchQuery = buildLinkedInSearchQuery(query, location);

  const params = new URLSearchParams({
    q: searchQuery,
    count: "10",
    offset: String(offset),
    mkt: "en-NZ",
    responseFilter: "Webpages",
  });

  const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?${params}`, {
    headers: { "Ocp-Apim-Subscription-Key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Bing API error: ${res.status}`);

  const data = await res.json() as {
    webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> };
  };

  return parseLinkedInResults(
    (data.webPages?.value ?? []).map((r) => ({ title: r.name, url: r.url, snippet: r.snippet })),
    "bing"
  );
}

// ─── People Data Labs ─────────────────────────────────────────────────────────
// Aggregates from hundreds of public sources — not a LinkedIn scraper.
// Two uses: (1) enrich a known LinkedIn URL, (2) search for candidates directly.

interface PDLExperience {
  company?: { name?: string; industry?: string; size?: string };
  title?: { name?: string; role?: string; levels?: string[] };
  start_date?: string;
  end_date?: string | null;
  location_names?: string[];
  is_primary?: boolean;
}

interface PDLEducation {
  school?: { name?: string };
  degrees?: string[];
  majors?: string[];
  start_date?: string;
  end_date?: string;
}

interface PDLPerson {
  full_name?: string;
  job_title?: string;
  job_company_name?: string;
  location_locality?: string;
  location_region?: string;
  location_country?: string;
  linkedin_url?: string;
  experience?: PDLExperience[];
  education?: PDLEducation[];
  skills?: string[];
  inferred_salary?: string;
  summary?: string;
}

function pdlPersonToText(p: PDLPerson): string {
  const lines: string[] = [];

  if (p.full_name) lines.push(`Name: ${p.full_name}`);

  if (p.job_title) {
    const headline = p.job_company_name
      ? `${p.job_title} at ${p.job_company_name}`
      : p.job_title;
    lines.push(`Headline: ${headline}`);
  }

  const loc = [p.location_locality, p.location_region, p.location_country]
    .filter(Boolean).join(", ");
  if (loc) lines.push(`Location: ${loc}`);

  if (p.summary) lines.push(`\nAbout:\n${p.summary}`);

  if (p.experience?.length) {
    lines.push("\nExperience:");
    for (const exp of p.experience.slice(0, 10)) {
      const title   = exp.title?.name ?? "Role";
      const company = exp.company?.name ?? "Company";
      const start   = exp.start_date?.slice(0, 4) ?? "?";
      const end     = exp.end_date ? exp.end_date.slice(0, 4) : "Present";
      lines.push(`- ${title} at ${company} (${start}–${end})`);
      if (exp.location_names?.[0]) lines.push(`  Location: ${exp.location_names[0]}`);
      if (exp.company?.industry)   lines.push(`  Industry: ${exp.company.industry}`);
    }
  }

  if (p.education?.length) {
    lines.push("\nEducation:");
    for (const edu of p.education) {
      const school = edu.school?.name ?? "School";
      const degree = edu.degrees?.join(", ") ?? "Degree";
      const major  = edu.majors?.length ? ` in ${edu.majors.join(", ")}` : "";
      const year   = edu.end_date ? ` (${edu.end_date.slice(0, 4)})` : "";
      lines.push(`- ${degree}${major} — ${school}${year}`);
    }
  }

  if (p.skills?.length) {
    lines.push(`\nSkills: ${p.skills.slice(0, 30).join(", ")}`);
  }

  if (p.inferred_salary) {
    lines.push(`\nInferred salary: ${p.inferred_salary}`);
  }

  return lines.join("\n").trim();
}

/**
 * Search People Data Labs for candidates matching a role title + location.
 * Uses the SQL query format — simpler and more predictable than Elasticsearch.
 * NOTE: costs 1 credit per result returned. Keep size conservative.
 */
export async function searchPDLProfiles(
  roleTitle: string,
  location: string,
  size: number = 15
): Promise<SearchResult[]> {
  const apiKey = process.env.PDL_API_KEY;
  if (!apiKey) return [];

  try {
    // Build title terms from the role title (split on common delimiters)
    const titleTerms = roleTitle
      .split(/[,/|&]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2)
      .slice(0, 3);

    if (titleTerms.length === 0) return [];

    const titleClause = titleTerms
      .map((t) => `job_title LIKE '%${t.replace(/'/g, "''")}%'`)
      .join(" OR ");

    // For NZ always include country; also try to match locality
    const locationClause = location
      ? `AND (location_locality='${location.toLowerCase().replace(/'/g, "''")}' OR location_country='new zealand')`
      : "AND location_country='new zealand'";

    const sql = `SELECT * FROM person WHERE (${titleClause}) ${locationClause} AND linkedin_url IS NOT NULL LIMIT ${size}`;

    const res = await fetch("https://api.peopledatalabs.com/v5/person/search", {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, size }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return [];

    const data = await res.json() as { status: number; data?: PDLPerson[] };
    if (!data.data?.length) return [];

    return data.data
      .filter((p) => p.linkedin_url && p.full_name && looksLikePersonName(p.full_name))
      .map((p) => {
        const fullText = pdlPersonToText(p);
        return {
          name: p.full_name!,
          headline: p.job_title
            ? (p.job_company_name ? `${p.job_title} at ${p.job_company_name}` : p.job_title)
            : "",
          location: [p.location_locality, p.location_region, p.location_country]
            .filter(Boolean).join(", "),
          linkedinUrl: normaliseLinkedInUrl(p.linkedin_url!),
          snippet: fullText.slice(0, 400),
          fullText,
          source: "pdl" as const,
        };
      });
  } catch {
    return [];
  }
}


// ─── Utility ──────────────────────────────────────────────────────────────────
