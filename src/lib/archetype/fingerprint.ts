/**
 * Deterministic career fingerprinting — no AI, no DB, pure computation.
 *
 * Produces a vector describing: which technologies a candidate has used,
 * how recently, their career trajectory, stability, seniority, and domain
 * clusters. This vector is the input to archetype matching and clustering.
 */

import { TECH_REQUIREMENT_ALIASES } from "@/lib/requirement-signals";

// ── Year range regex (matches "Jan 2019 – present", "2020 - 2023", etc.) ──
const MONTH_FRAG =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const YEAR_RANGE_RE = new RegExp(
  `\\b(?:${MONTH_FRAG}\\s+)?((?:19|20)\\d{2})\\s*(?:[-–—]|to)\\s*(?:(?:${MONTH_FRAG}\\s+)?((?:19|20)\\d{2})|present|current|now)\\b`,
  "gi",
);

const CURRENT_YEAR = new Date().getFullYear();

// ── Seniority token → numeric tier (1=junior … 5=executive) ──────────────
const SENIORITY_TIERS: [RegExp, number][] = [
  [/\b(?:chief|cto|ceo|coo|cfo|evp|svp)\b/i, 5],
  [/\b(?:director|vp|vice president|head of|gm|general manager)\b/i, 4],
  [/\b(?:principal|staff|lead|senior|sr\.?)\b/i, 3],
  [/\b(?:mid[- ]?level|intermediate)\b/i, 2],
  [/\b(?:junior|jr\.?|graduate|grad|associate|entry[- ]?level|intern)\b/i, 1],
];

// ── Domain clusters ────────────────────────────────────────────────────────
const DOMAIN_MAP: [RegExp, string][] = [
  [/\b(?:government|public sector|council|ministry|crown entity|local body)\b/i, "government"],
  [/\b(?:bank|insurance|investment|fintech|finance|wealth|kiwisaver|fund)\b/i, "finance"],
  [/\b(?:health|medical|hospital|clinical|aged care|pharmacy|pathology)\b/i, "healthcare"],
  [/\b(?:retail|e-?commerce|wholesale|consumer goods|fmcg)\b/i, "retail"],
  [/\b(?:defence|military|defense|nzdf|nzaf)\b/i, "defence"],
  [/\b(?:telco|telecom|telecommunications|network provider|isp)\b/i, "telco"],
  [/\b(?:energy|electricity|utilities|power grid|gas|meridian|contact energy)\b/i, "energy"],
  [/\b(?:education|university|weta|school|tertiary|polytechnic|tertiary)\b/i, "education"],
  [/\b(?:construction|infrastructure|engineering firm|civil|surveying)\b/i, "construction"],
  [/\b(?:saas|software company|tech startup|startup|technology company)\b/i, "software"],
  [/\b(?:consulting|advisory|professional services|big four|deloitte|pwc|kpmg|ey)\b/i, "consulting"],
  [/\b(?:manufacturing|industrial|factory|production|assembly)\b/i, "manufacturing"],
  [/\b(?:agriculture|farming|primary industry|forestry|fishing)\b/i, "agriculture"],
  [/\b(?:media|publishing|broadcast|journalism|creative agency)\b/i, "media"],
];

export interface SkillVector {
  skill: string;
  lastUsedYear: number | null;
  recency: number; // 0.0–1.0
  evidence: string; // snippet of profile text where skill was found
}

export type CareerTrajectory =
  | "ascending"
  | "lateral"
  | "descending"
  | "pivoting"
  | "unknown";

export type SeniorityLevel =
  | "junior"
  | "mid"
  | "senior"
  | "lead"
  | "executive"
  | "unknown";

export interface FingerprintData {
  skillVector: SkillVector[];
  trajectory: CareerTrajectory;
  avgTenureMonths: number | null;
  stabilityScore: number | null;
  domainClusters: string[];
  seniorityLevel: SeniorityLevel;
}

// ── Recency scoring ────────────────────────────────────────────────────────
// 0 years ago → 1.0, 1 year → 0.85, 5 years → 0.25, 7+ years → 0
export function computeRecency(lastUsedYear: number | null): number {
  if (lastUsedYear === null) return 0.5; // unknown — give benefit of doubt
  const age = CURRENT_YEAR - lastUsedYear;
  if (age <= 0) return 1.0;
  if (age >= 7) return 0.0;
  return Math.max(0, 1 - age * 0.15);
}

// ── Extract all year ranges from profile text ──────────────────────────────
interface YearRange {
  startYear: number;
  endYear: number; // CURRENT_YEAR if "present"
  index: number; // character position in text
}

function extractYearRanges(text: string): YearRange[] {
  const ranges: YearRange[] = [];
  let m: RegExpExecArray | null;
  YEAR_RANGE_RE.lastIndex = 0;
  while ((m = YEAR_RANGE_RE.exec(text)) !== null) {
    const startYear = parseInt(m[1], 10);
    const endYear = m[2] ? parseInt(m[2], 10) : CURRENT_YEAR;
    if (!isNaN(startYear) && !isNaN(endYear) && startYear >= 1980 && endYear <= CURRENT_YEAR + 1) {
      ranges.push({ startYear, endYear, index: m.index });
    }
  }
  return ranges;
}

// Find the most recent year range that appears within `window` characters
// before or after the position of a skill mention.
function nearestEndYear(position: number, ranges: YearRange[], window = 800): number | null {
  let best: number | null = null;
  for (const r of ranges) {
    const dist = Math.abs(r.index - position);
    if (dist <= window) {
      if (best === null || r.endYear > best) best = r.endYear;
    }
  }
  return best;
}

// ── Skill detection ────────────────────────────────────────────────────────
function detectSkills(text: string, ranges: YearRange[]): SkillVector[] {
  const seen = new Set<string>();
  const skills: SkillVector[] = [];

  for (const [pattern, aliases] of TECH_REQUIREMENT_ALIASES) {
    const key = aliases[0] ?? String(pattern);
    if (seen.has(key)) continue;

    // Find all positions where this skill appears
    const re = new RegExp(pattern.source, "gi");
    let match: RegExpExecArray | null;
    let latestYear: number | null = null;
    let evidenceSnippet = "";

    while ((match = re.exec(text)) !== null) {
      const endYear = nearestEndYear(match.index, ranges);
      if (latestYear === null || (endYear !== null && endYear > latestYear)) {
        latestYear = endYear;
      }
      if (!evidenceSnippet) {
        // Grab a short snippet around the match
        const start = Math.max(0, match.index - 30);
        const end = Math.min(text.length, match.index + match[0].length + 30);
        evidenceSnippet = text.slice(start, end).replace(/\s+/g, " ").trim();
      }
    }

    if (evidenceSnippet) {
      seen.add(key);
      skills.push({
        skill: key,
        lastUsedYear: latestYear,
        recency: computeRecency(latestYear),
        evidence: evidenceSnippet.slice(0, 80),
      });
    }
  }

  return skills;
}

// ── Career trajectory ──────────────────────────────────────────────────────
// Extract job title lines (lines with a year range, or lines that look like
// a title nearby a year range), classify each by seniority tier, then look
// at the direction of the progression.

function classifySeniority(title: string): number {
  for (const [re, tier] of SENIORITY_TIERS) {
    if (re.test(title)) return tier;
  }
  return 2; // default mid
}

function extractTitles(text: string, ranges: YearRange[]): Array<{ tier: number; year: number }> {
  // Split into lines and find lines near year ranges
  const lines = text.split(/\n/);
  let charOffset = 0;
  const titled: Array<{ tier: number; year: number }> = [];

  for (const line of lines) {
    const lineStart = charOffset;
    charOffset += line.length + 1;

    // Skip lines that are too long (paragraphs) or too short (noise)
    const trimmed = line.trim();
    if (trimmed.length < 4 || trimmed.length > 120) continue;

    // Is there a year range nearby?
    const nearby = ranges.filter(
      (r) => Math.abs(r.index - lineStart) < 400
    );
    if (nearby.length === 0) continue;

    const tier = classifySeniority(trimmed);
    const latestEnd = Math.max(...nearby.map((r) => r.endYear));
    titled.push({ tier, year: latestEnd });
  }

  return titled.sort((a, b) => a.year - b.year);
}

function computeTrajectory(
  titles: Array<{ tier: number; year: number }>
): CareerTrajectory {
  if (titles.length < 2) return "unknown";

  const first = titles.slice(0, Math.ceil(titles.length / 2));
  const last = titles.slice(Math.ceil(titles.length / 2));
  const firstAvg = first.reduce((s, t) => s + t.tier, 0) / first.length;
  const lastAvg = last.reduce((s, t) => s + t.tier, 0) / last.length;
  const delta = lastAvg - firstAvg;

  // Check for domain pivoting: large spread of domains
  if (Math.abs(delta) > 1.5) return delta > 0 ? "ascending" : "descending";
  if (Math.abs(delta) > 0.4) return delta > 0 ? "ascending" : "lateral";
  return "lateral";
}

// ── Tenure and stability ───────────────────────────────────────────────────
function computeTenureAndStability(
  ranges: YearRange[]
): { avgTenureMonths: number | null; stabilityScore: number | null } {
  if (ranges.length === 0) return { avgTenureMonths: null, stabilityScore: null };

  const sorted = [...ranges].sort((a, b) => a.startYear - b.startYear);
  const tenures: number[] = [];
  let score = 100;
  let gapPenalty = 0;
  let shortPenalty = 0;
  let bonusPoints = 0;

  for (const r of sorted) {
    const months = (r.endYear - r.startYear) * 12;
    if (months > 0 && months < 600) tenures.push(months); // sanity cap at 50 years
    if (months < 12) shortPenalty++;
    if (months >= 24) bonusPoints++;
  }

  // Gap detection: sort by start and find gaps > 6 months
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].startYear - sorted[i - 1].endYear) * 12;
    if (gap > 6) gapPenalty++;
  }

  score = Math.max(0, Math.min(100, score - gapPenalty * 10 - shortPenalty * 5 + bonusPoints * 5));
  const avg = tenures.length > 0
    ? tenures.reduce((s, t) => s + t, 0) / tenures.length
    : null;

  return { avgTenureMonths: avg, stabilityScore: score };
}

// ── Domain cluster detection ───────────────────────────────────────────────
function detectDomains(text: string): string[] {
  const found = new Set<string>();
  for (const [re, domain] of DOMAIN_MAP) {
    if (re.test(text)) found.add(domain);
  }
  return Array.from(found);
}

// ── Seniority level (most recent) ─────────────────────────────────────────
function deriveSeniority(
  titles: Array<{ tier: number; year: number }>
): SeniorityLevel {
  if (titles.length === 0) return "unknown";
  const recent = titles[titles.length - 1].tier;
  if (recent >= 5) return "executive";
  if (recent === 4) return "lead";
  if (recent === 3) return "senior";
  if (recent === 2) return "mid";
  return "junior";
}

// ── Main export ────────────────────────────────────────────────────────────
export function computeFingerprint(profileText: string): FingerprintData {
  if (!profileText || profileText.length < 50) {
    return {
      skillVector: [],
      trajectory: "unknown",
      avgTenureMonths: null,
      stabilityScore: null,
      domainClusters: [],
      seniorityLevel: "unknown",
    };
  }

  const ranges = extractYearRanges(profileText);
  const skillVector = detectSkills(profileText, ranges);
  const titles = extractTitles(profileText, ranges);
  const trajectory = computeTrajectory(titles);
  const { avgTenureMonths, stabilityScore } = computeTenureAndStability(ranges);
  const domainClusters = detectDomains(profileText);
  const seniorityLevel = deriveSeniority(titles);

  return { skillVector, trajectory, avgTenureMonths, stabilityScore, domainClusters, seniorityLevel };
}
