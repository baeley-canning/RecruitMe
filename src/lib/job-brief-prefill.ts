import type { ParsedRole } from "./ai";
import { isRemoteFriendlyLocationRule } from "./location";

export interface JobBriefUploadPrefill {
  title: string;
  company: string;
  location: string;
  isRemote: boolean;
  salaryEnabled: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  /** "ai" = full structured parse via Claude; "regex" = simple line/keyword
   *  fallback when AI parse failed or returned empty fields. Recruiter can
   *  see in the UI which path was used and review accordingly. */
  source: "ai" | "regex" | "merged";
}

// ─── Regex fallback ────────────────────────────────────────────────────────
// When the AI parse fails OR returns empty title/company/location, try a
// minimal text-level extraction so the recruiter at least gets the title
// pre-filled. Better than an empty form.

const NZ_CITY_RE = /\b(Wellington|Auckland|Christchurch|Hamilton|Tauranga|Dunedin|Palmerston North|Napier|Hastings|Nelson|Rotorua|Whangarei|Invercargill|New Plymouth|Whanganui|Gisborne|Timaru|Levin|Masterton|Porirua|Lower Hutt|Upper Hutt)\b/i;

export function extractTitleFromBriefText(jd: string): string {
  // The first non-empty, non-trivial line of a JD is almost always the title.
  // We trim common decorations and skip obvious template prefixes.
  for (const rawLine of jd.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip very long lines (probably a paragraph, not a title) and very short
    // ones (likely a header artefact like "JD" or "Role").
    if (line.length < 4 || line.length > 120) continue;
    // Skip obvious non-title patterns.
    if (/^(?:job description|hiring brief|position description|jd|role|about (?:the |us|the role|the company)|responsible to|reports to)$/i.test(line)) continue;
    if (/^(?:date|version|page)\b/i.test(line)) continue;
    // Strip trailing decoration ("- POWER", "(2024)", "v2") — keep useful suffixes.
    return line;
  }
  return "";
}

export function extractLocationFromBriefText(jd: string): string {
  // Prefer explicit "Location: X" line, fall back to first NZ city mention.
  const labelled = jd.match(/(?:^|\n)\s*Location\s*[:\-]\s*([^\n]{2,80})/i);
  if (labelled) {
    const value = labelled[1].trim().replace(/\s+/g, " ");
    if (value) return value;
  }
  const city = jd.match(NZ_CITY_RE);
  if (city) return city[1];
  return "";
}

export function extractCompanyFromBriefText(jd: string): string {
  // Conservative — only return when we see an explicit "Company: X" label.
  // First-line guessing produces too many false positives (the title is more
  // valuable to extract right than the company).
  const labelled = jd.match(/(?:^|\n)\s*(?:Company|Organisation|Organization|Client|Employer)\s*[:\-]\s*([^\n]{2,80})/i);
  if (labelled) {
    const value = labelled[1].trim().replace(/\s+/g, " ");
    if (value) return value;
  }
  return "";
}

/**
 * Build a prefill from the raw JD text using regex only — no AI. Used as a
 * fallback when parseJobDescription fails or returns empty fields. Better
 * than nothing.
 */
export function deriveRegexFallbackPrefill(jdText: string): JobBriefUploadPrefill | null {
  const title = extractTitleFromBriefText(jdText);
  const location = extractLocationFromBriefText(jdText);
  const company = extractCompanyFromBriefText(jdText);

  if (!title && !location && !company) return null;

  return {
    title,
    company,
    location,
    isRemote: false,
    salaryEnabled: false,
    salaryMin: null,
    salaryMax: null,
    source: "regex",
  };
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function parseAmount(raw: string, unit?: string | null, fallbackUnit?: string | null): number | null {
  const numeric = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const resolvedUnit = (unit ?? fallbackUnit ?? "").toLowerCase();
  if (resolvedUnit === "m") return Math.round(numeric * 1_000_000);
  if (resolvedUnit === "k") return Math.round(numeric * 1_000);
  if (numeric < 1_000) return Math.round(numeric * 1_000);
  return Math.round(numeric);
}

export function parseSalaryBandRange(salaryBand: string): { min: number | null; max: number | null } {
  const normalized = cleanText(salaryBand)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ");

  if (!normalized) return { min: null, max: null };

  const rangeMatch = normalized.match(/\$?\s*([\d,.]+)\s*(k|m)?\s*(?:-|to)\s*\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (rangeMatch) {
    const firstUnit = rangeMatch[2] ?? rangeMatch[4] ?? null;
    const secondUnit = rangeMatch[4] ?? rangeMatch[2] ?? null;
    return {
      min: parseAmount(rangeMatch[1], firstUnit, secondUnit),
      max: parseAmount(rangeMatch[3], secondUnit, firstUnit),
    };
  }

  const fromMatch = normalized.match(/\b(?:from|starting at|min(?:imum)?|base)\s+\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (fromMatch) {
    return { min: parseAmount(fromMatch[1], fromMatch[2]), max: null };
  }

  const upToMatch = normalized.match(/\b(?:up to|max(?:imum)?|capped at)\s+\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (upToMatch) {
    return { min: null, max: parseAmount(upToMatch[1], upToMatch[2]) };
  }

  const plusMatch = normalized.match(/\$?\s*([\d,.]+)\s*(k|m)?\s*\+/i);
  if (plusMatch) {
    return { min: parseAmount(plusMatch[1], plusMatch[2]), max: null };
  }

  return { min: null, max: null };
}

export function inferRemoteRole(locationRules: string): boolean {
  return isRemoteFriendlyLocationRule(locationRules);
}

export function deriveJobBriefUploadPrefill(
  parsedRole: Partial<ParsedRole> | null | undefined,
  /** Raw JD text — used as a regex-fallback source when AI fields are empty. */
  jdText?: string,
): JobBriefUploadPrefill | null {
  if (!parsedRole) {
    return jdText ? deriveRegexFallbackPrefill(jdText) : null;
  }

  const aiTitle = cleanText(parsedRole.title);
  const aiCompany = cleanText(parsedRole.company);
  const aiLocation = cleanText(parsedRole.location);
  const isRemote = inferRemoteRole(parsedRole.location_rules ?? "");
  const salaryRange = parseSalaryBandRange(parsedRole.salary_band ?? "");
  const hasFullSalaryRange = Boolean(salaryRange.min && salaryRange.max);

  // Regex fallback fills the gaps the AI missed. The AI is preferred for
  // every field it produces; the regex only fires for empty AI fields.
  // Recruiter sees a "merged" source flag if any field came from regex.
  let regexFallback: JobBriefUploadPrefill | null = null;
  const needsFallback = (!aiTitle || !aiLocation || !aiCompany) && jdText;
  if (needsFallback) regexFallback = deriveRegexFallbackPrefill(jdText!);

  const title = aiTitle || regexFallback?.title || "";
  const company = aiCompany || regexFallback?.company || "";
  const location = aiLocation || regexFallback?.location || "";
  const usedRegex = regexFallback !== null && (
    (!aiTitle && Boolean(regexFallback.title)) ||
    (!aiCompany && Boolean(regexFallback.company)) ||
    (!aiLocation && Boolean(regexFallback.location))
  );

  const prefill: JobBriefUploadPrefill = {
    title,
    company,
    location,
    isRemote,
    salaryEnabled: hasFullSalaryRange,
    salaryMin: hasFullSalaryRange ? salaryRange.min : null,
    salaryMax: hasFullSalaryRange ? salaryRange.max : null,
    source: usedRegex ? "merged" : "ai",
  };

  if (
    !prefill.title &&
    !prefill.company &&
    !prefill.location &&
    !prefill.isRemote &&
    !prefill.salaryEnabled
  ) {
    return null;
  }

  return prefill;
}
