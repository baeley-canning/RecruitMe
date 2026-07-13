import { normaliseLinkedInUrl } from "./linkedin";
import { isPlausibleLocation } from "./location";
import { NZ_CITIES } from "./nz-cities";
import { recordProviderFailure, recordProviderSuccess } from "./provider-health";

export interface SearchResult {
  name: string;
  headline: string;
  location: string;
  linkedinUrl: string;
  snippet: string;
  fullText?: string; // full profile text for sources that return it (PDL)
  matchedQuery?: string;
  // Only PDL produces a SearchResult now (SerpAPI removed in Phase K;
  // LinkedIn discovery routes through the durable SearchRun + scraper).
  // Manual / extension / talent_pool / github values come from the
  // Candidate.source field at save time.
  source: "pdl";
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


// Phrases that flag a role as permanent / full-time. We exclude contract /
// freelance / consultant titles from search results only when the role is
// explicitly permanent. Ambiguous JDs (neither permanent nor contract
// language) default to NOT excluding — better to surface a contractor the
// recruiter can manually dismiss than silently lose a candidate.
const PERMANENT_ROLE_RE =
  /\b(?:permanent|perm\s+role|perm\s+position|full[- ]time\s+permanent|ongoing\s+role|continuing\s+role)\b/i;
// Hints the role is genuinely contract / fixed-term — we keep contractor
// titles in results when these appear.
const CONTRACT_ROLE_RE =
  /\b(?:contract\s+role|fixed[- ]term|fixed\s+term|interim|temporary|short[- ]term\s+contract|6[- ]month|9[- ]month|12[- ]month|18[- ]month|day[- ]rate|daily\s+rate|contractor)\b/i;

/** Classify a job description's employment type. Returns "permanent" only
 *  when the JD explicitly says so; "contract" when contract phrasing is
 *  present; "unknown" otherwise. Exported for testing + reuse. */
export function inferEmploymentType(jdOrRoleText: string | null | undefined): "permanent" | "contract" | "unknown" {
  const text = jdOrRoleText?.trim() ?? "";
  if (!text) return "unknown";
  // Contract phrasing wins when both are present — contract roles often say
  // "permanent staff would also be considered" but the role is still contract.
  if (CONTRACT_ROLE_RE.test(text)) return "contract";
  if (PERMANENT_ROLE_RE.test(text)) return "permanent";
  return "unknown";
}

function looksLikeLocationFragment(fragment: string): boolean {
  const lower = fragment.toLowerCase();
  if (!lower || lower.length < 2 || lower.length > 80) return false;
  if (!isPlausibleLocation(fragment)) return false;
  if (
    /\b(contact info|connections|followers|message|follow|connect|linkedin|skills|experience|education|recommendations|company|full-time|part-time|present)\b/i.test(
      fragment
    )
  ) {
    return false;
  }

  if (LOCATION_COUNTRY_RE.test(fragment)) return true;
  // Comma-separated location-like pattern, but reject long title/headline phrases.
  if (/^[a-z .'-]+,\s*[a-z .'-]+(?:,\s*[a-z .'-]+)?$/i.test(fragment)) {
    const segments = fragment.split(",").map((part) => cleanSearchText(part)).filter(Boolean);
    const locationLike = segments.length >= 2 && segments.every((segment) => {
      const segmentLower = segment.toLowerCase();
      const words = segment.split(/\s+/).filter(Boolean);
      if (words.length === 0 || words.length > 4) return false;
      if (TITLE_STARTERS.some((starter) => segmentLower.startsWith(starter))) return false;
      if (/\b(at|for|with|across|specialist|delivery|clients?|training|design|development)\b/i.test(segment)) {
        return false;
      }
      return true;
    });
    if (locationLike) return true;
  }
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

export interface PDLPerson {
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

export function pdlPersonToText(p: PDLPerson): string {
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
  size: number = 15,
  resolvedKey?: string,
): Promise<SearchResult[]> {
  const apiKey = resolvedKey || process.env.PDL_API_KEY;
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

    // NB: PDL rejects `LIMIT` inside the SQL ("LIMIT is not supported … use the
    // `size` input parameter instead") — a 400 that silently returned 0 results.
    // Row cap is the `size` field on the request body below, not the SQL.
    const sql = `SELECT * FROM person WHERE (${titleClause}) ${locationClause} AND linkedin_url IS NOT NULL`;

    const res = await fetch("https://api.peopledatalabs.com/v5/person/search", {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, size }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      recordProviderFailure("pdl", `${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json() as { status: number; data?: PDLPerson[] };
    // Even with empty results, the API call itself succeeded — record that
    // so the badge stays green when PDL is configured but returns 0 hits.
    recordProviderSuccess("pdl");
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
  } catch (err) {
    recordProviderFailure("pdl", err instanceof Error ? err.message : String(err));
    return [];
  }
}


// ─── Utility ──────────────────────────────────────────────────────────────────
