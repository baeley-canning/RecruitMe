import { chat, getJobParsingProvider, parseJson, SONNET } from "./chat";
import { enrichRoleWithSecurityClearance } from "../security-clearance";
import {
  PARSING_SYSTEM_CONTEXT,
  PARSING_JSON_SCHEMA,
  PARSING_RULES,
} from "./prompts/parsing";
import { buildScarceSkillsPromptBlock } from "../requirement-signals";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SkillNote {
  skill: string;
  type: "legacy" | "rare" | "scarce";
  note: string;
  alternatives: string[];
}

export interface ParsedRole {
  title: string;
  title_source: "explicit" | "inferred" | "";
  company: string;
  company_source: "explicit" | "inferred" | "";
  location: string;
  location_source: "explicit" | "inferred" | "";
  experience: string;
  // Rich hiring brief fields (populated by updated parser)
  seniority_band: string;       // e.g. "Senior IC", "Tech Lead", "Mid-level"
  seniority_source: "explicit" | "inferred" | "";
  salary_band: string;          // inferred e.g. "$110k–$140k NZD"
  salary_source: "explicit" | "inferred" | "";
  location_rules: string;       // e.g. "Auckland CBD 3 days/week"
  location_rules_source: "explicit" | "inferred" | "";
  visa_flags: string[];         // e.g. ["NZ citizen or PR only"]
  must_haves: string[];         // non-negotiable requirements
  nice_to_haves: string[];      // desirable but not blocking
  knockout_criteria: string[];  // instant disqualifiers
  application_requirements: string[];
  explicitly_stated: string[];
  strongly_inferred: string[];
  search_expansion: string[];
  synonym_titles: string[];     // alternative LinkedIn titles to search
  responsibilities: string[];
  search_queries: string[];
  google_queries: string[];
  // Legacy — kept populated for backward compat with older scored candidates
  skills_required: string[];
  skills_preferred: string[];
  // Recruiter-facing search tips: AI-detected legacy/rare skills with suggested alternatives
  skill_notes?: SkillNote[];
  // Skills whose tip the recruiter has dismissed — preserved across re-analyses
  dismissed_skill_notes?: string[];
  // The 2–5 most distinctive hard-skill terms that a strong candidate MUST have
  // somewhere in their profile. Drives search anchoring — set by the AI at parse
  // time so it works for any technology, not just the hardcoded Sybase/C++ list.
  anchor_terms?: string[];
  // Recruiter overrides: knockout criteria that have been dismissed (treated as
  // informational only, not scoring gates). Persisted across re-analyses.
  dismissed_knockout_criteria?: string[];
  // Visa flags (e.g. clearance eligibility) that the recruiter has promoted to
  // must_haves so they count in scoring.
  promoted_visa_flags?: string[];
}

// ─── Private helpers ───────────────────────────────────────────────────────────

function ensureString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSource(value: unknown): "explicit" | "inferred" | "" {
  return value === "explicit" || value === "inferred" ? value : "";
}

// These title patterns are never actually used on LinkedIn profiles.
// Filter them out even when the AI occasionally generates them.
const BANNED_SYNONYM_TITLE_RE =
  /\b(application developer|technical developer|it developer|mid.?level developer|junior developer|graduate developer|entry.?level developer|software professional|technology specialist|it professional)\b/i;

function filterSynonymTitles(titles: string[]): string[] {
  return titles.filter((t) => !BANNED_SYNONYM_TITLE_RE.test(t));
}

function ensureSkillNotes(value: unknown): SkillNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      skill: ensureString(item.skill),
      type: item.type === "rare" ? "rare" as const : item.type === "scarce" ? "scarce" as const : "legacy" as const,
      note: ensureString(item.note),
      alternatives: ensureStringArray(item.alternatives),
    }))
    .filter((note) => note.skill.length > 0 && note.alternatives.length > 0);
}

// ─── AI function ───────────────────────────────────────────────────────────────

export async function parseJobDescription(jd: string): Promise<ParsedRole> {
  const scarceBlock = buildScarceSkillsPromptBlock();
  const text = await chat(`${PARSING_SYSTEM_CONTEXT}

Input (JD or hiring brief):
${jd.slice(0, 8000)}

${PARSING_JSON_SCHEMA}

${PARSING_RULES}

NZ Scarce Skills (authoritative list — use ONLY these for type "scarce" notes):
${scarceBlock}`, 0.1, 2048, {
    provider: getJobParsingProvider(),
    model: SONNET,
  });

  const parsed = parseJson<Partial<ParsedRole>>(text);

  const normalizedRole = {
    title: ensureString(parsed.title),
    title_source: normalizeSource(parsed.title_source),
    company: ensureString(parsed.company),
    company_source: normalizeSource(parsed.company_source),
    location: ensureString(parsed.location),
    location_source: normalizeSource(parsed.location_source),
    experience: ensureString(parsed.experience),
    seniority_band: ensureString(parsed.seniority_band),
    seniority_source: normalizeSource(parsed.seniority_source),
    salary_band: ensureString(parsed.salary_band),
    salary_source: normalizeSource(parsed.salary_source),
    location_rules: ensureString(parsed.location_rules),
    location_rules_source: normalizeSource(parsed.location_rules_source),
    visa_flags: ensureStringArray(parsed.visa_flags),
    must_haves: ensureStringArray(parsed.must_haves),
    nice_to_haves: ensureStringArray(parsed.nice_to_haves),
    knockout_criteria: ensureStringArray(parsed.knockout_criteria),
    application_requirements: ensureStringArray(parsed.application_requirements),
    explicitly_stated: ensureStringArray(parsed.explicitly_stated),
    strongly_inferred: ensureStringArray(parsed.strongly_inferred),
    search_expansion: ensureStringArray(parsed.search_expansion),
    synonym_titles: filterSynonymTitles(ensureStringArray(parsed.synonym_titles)),
    responsibilities: ensureStringArray(parsed.responsibilities),
    search_queries: ensureStringArray(parsed.search_queries),
    google_queries: ensureStringArray(parsed.google_queries),
    skills_required: ensureStringArray(parsed.skills_required),
    skills_preferred: ensureStringArray(parsed.skills_preferred),
    skill_notes: ensureSkillNotes(parsed.skill_notes),
    dismissed_skill_notes: ensureStringArray(parsed.dismissed_skill_notes),
    anchor_terms: ensureStringArray(parsed.anchor_terms),
  };

  return enrichRoleWithSecurityClearance(jd, normalizedRole);
}
