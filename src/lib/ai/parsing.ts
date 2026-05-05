import { chat, getJobParsingProvider, parseJson, SONNET } from "./chat";
import { enrichRoleWithSecurityClearance } from "../security-clearance";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SkillNote {
  skill: string;
  type: "legacy" | "rare";
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
      type: item.type === "rare" ? "rare" as const : "legacy" as const,
      note: ensureString(item.note),
      alternatives: ensureStringArray(item.alternatives),
    }))
    .filter((note) => note.skill.length > 0 && note.alternatives.length > 0);
}

// ─── AI function ───────────────────────────────────────────────────────────────

export async function parseJobDescription(jd: string): Promise<ParsedRole> {
  const text = await chat(`You are a senior recruitment consultant with deep knowledge of the NZ market. You will receive either a formal job description (JD) or an informal hiring brief. Extract a structured hiring profile that powers candidate search and screening.

Input (JD or hiring brief):
${jd.slice(0, 8000)}

Return ONLY valid JSON (no markdown, no explanation):
{
  "title": "standardised market-facing job title — if the internal title is unusual, translate it to what the person would actually be called",
  "title_source": "explicit|inferred|empty string if unknown",
  "company": "company or client name, or empty string",
  "company_source": "explicit|inferred|empty string if unknown",
  "location": "city or region only — e.g. 'Auckland', 'Wellington'",
  "location_source": "explicit|inferred|empty string if unknown",
  "experience": "years requirement only if explicitly stated — e.g. '5+ years'. Empty string otherwise.",
  "seniority_band": "one of: Graduate | Junior | Mid-level | Senior | Lead | Principal | Manager | Director | Executive",
  "seniority_source": "explicit|inferred|empty string if unknown",
  "salary_band": "inferred NZD salary range — use your NZ market knowledge if not stated. Format '$90k–$120k NZD'. Empty string only if genuinely impossible to estimate.",
  "salary_source": "explicit|inferred|empty string if unknown",
  "location_rules": "office/remote policy in plain English — e.g. 'Auckland CBD, 3 days in office' or 'Fully remote, NZ-based only' or 'Flexible'",
  "location_rules_source": "explicit|inferred|empty string if unknown",
  "visa_flags": ["work rights or visa requirements — e.g. 'NZ citizen or permanent resident only', 'Open Work Visa accepted'. Empty array if not mentioned."],
  "must_haves": ["only explicit or near-explicit must-haves from the ad — do not harden soft wording into stricter requirements than the ad supports. Be specific and exhaustive."],
  "nice_to_haves": ["explicitly preferred or advantageous things — 'would be great', 'advantageous', 'desirable'. Separate from must-haves."],
  "knockout_criteria": ["ONLY true binary gates — legal/compliance requirements a recruiter would ask on a screening call before reading the CV. Examples: work rights, mandatory licences (driver's licence, security clearance), specific mandatory professional registration. DO NOT include skills, experience years, or technologies here — those belong in must_haves and are scoring factors, not gates. Most JDs have zero or one knockout criteria. If there are none, return an empty array."],
  "application_requirements": ["explicit application asks or screening asks such as 'Portfolio requested', 'Cover letter requested', 'Expected salary question'. Empty array if none."],
  "explicitly_stated": ["short recruiter-readable facts written in the ad itself. Do not include inference here."],
  "strongly_inferred": ["short recruiter-readable inferences that are reasonable but not explicitly written in the ad."],
  "search_expansion": ["broader sourcing angles that help search but are NOT ad facts."],
  "synonym_titles": ["7-10 real LinkedIn headline titles — how actual people in this role describe themselves on their profile, NOT generic job board terms. Only include titles you would genuinely find on LinkedIn profiles. Examples for a Rails developer: 'Ruby on Rails Developer', 'Full Stack Engineer', 'Backend Engineer', 'Rails Engineer', 'Software Engineer' — NOT made-up compound titles like 'Technical Developer' or 'Application Developer' that no one uses."],
  "responsibilities": ["concrete day-to-day activities from the JD — what they will actually do"],
  "search_queries": [
    "query 1: most common LinkedIn headline equivalent for this role + 1-2 core skills",
    "query 2: different seniority angle or adjacent title people actually use",
    "query 3: industry/domain angle — sector or type of company"
  ],
  "google_queries": [
    "query 1: skills-first angle using the 2-3 most distinctive requirements",
    "query 2: seniority + domain angle that appears in real LinkedIn headlines"
  ],
  "skills_required": ["technical and hard skills from must_haves — same content, skills only"],
  "skills_preferred": ["technical and hard skills from nice_to_haves — same content, skills only"],
  "skill_notes": [
    {"skill": "Sybase", "type": "legacy", "note": "Sybase (SAP ASE) is largely obsolete — candidates with SQL Server or SAP HANA may adapt quickly", "alternatives": ["SAP HANA", "SQL Server", "PostgreSQL"]}
  ],
  "anchor_terms": ["C++", "Sybase", "SQL"]
}

Rules:
- Separate truth from inference. If the ad does not explicitly say something, do not place it in explicitly_stated.
- Use the *_source fields honestly. If seniority, salary, or work setup are inferred from context, mark them as "inferred".
- must_haves should stay faithful to the ad. If wording is softer (for example "assist with backend and front-end applications"), do not rewrite it into a harder requirement than the ad supports.
- Put broader recruiter logic in strongly_inferred and search_expansion, not in explicitly_stated.
- search_queries and google_queries: KEYWORD TERMS ONLY. Location and site:linkedin.com/in are added automatically. No years of experience. Never copy the exact job title verbatim.
- synonym_titles is the most important field for search coverage — a "Digital Solutions Analyst" might be "Business Analyst", "Systems Analyst", "Product Analyst", "IT Analyst", "Digital Analyst" on LinkedIn. Think about what 10 different people doing this job would call themselves. Banned terms that no one uses on LinkedIn: "Application Developer", "Technical Developer", "IT Developer", "Mid-level Developer", "Junior Developer", "Graduate Developer" — use the actual technology stack or domain in the title instead.
- must_haves vs nice_to_haves: if the JD says "required" or "must have" it's a must-have. If it says "preferred", "advantageous", "desirable", "bonus" it's nice-to-have.
- Grouped/partial skill lists: when a JD says "experience across at least half of the following", "one or more of", "familiarity with any of", or similar partial-coverage language, compress those items into ONE single must-have string that preserves the threshold — e.g. "At least half of: Java, Node.js, React, GitLab CI, Jenkins, Terraform, Jira, Ansible". Do NOT expand a partial list into separate individual must-haves — that would over-penalise candidates who meet the actual threshold.
- Security clearance: if the ad explicitly says a clearance is required, must be held, or must be obtainable, add it to knockout_criteria and must_haves. If the ad only implies sensitive government/security context through the employer or product area, do NOT make it a knockout; put it in strongly_inferred/search_expansion instead.
- knockout_criteria: STRICT — only legal/compliance binary gates a recruiter asks on a phone screen before looking at the CV. Work rights, mandatory licences, explicit security clearances. Skills and experience are NOT knockouts — they go in must_haves. Most roles have one knockout or none. When in doubt, leave it out.
- anchor_terms: 2–5 specific technology or tool names that a strong candidate MUST have visible somewhere in their LinkedIn profile or headline. These drive candidate search filtering — they must be concrete, unambiguous terms (e.g. "C++", "Sybase", "Salesforce", "JMeter", "ServiceNow", "React", "Kubernetes"). Rules: only include terms from the must_haves list; never include soft skills, generic terms ("SQL" alone is too broad — prefer "SQL Server" or "PostgreSQL" if specified), methodologies, or degree requirements; if the role has no rare/distinctive technical anchor (e.g. a generic Project Manager role), return an empty array; maximum 5 terms.
- skill_notes: identify at most 3 skills in the JD that are legacy/obsolete and where considering modern alternatives would genuinely widen the candidate pool. Use type "legacy". Classic examples: Sybase → SAP HANA/SQL Server, COBOL → Java/mainframe-IBM, VB6/Visual Basic → C#/.NET, ColdFusion → PHP/Node.js, Informix → PostgreSQL/Oracle, Delphi/Pascal → C#/Java, Flash/ActionScript → React/Vue, Lotus Notes → SharePoint/M365. Do NOT flag any mainstream modern technology (React, Python, AWS, Azure, Docker, Kubernetes, Java, C#, .NET, PostgreSQL, MySQL, SQL Server, MongoDB, C, C++, Go, Rust, etc.). Do NOT flag C or C++ — they are specific, legitimate modern requirements. Only flag skills whose alternatives are genuine replacements, not just related technologies. Return an empty array if nothing applies — most JDs should have no skill_notes at all.
- application_requirements: use this for portfolio / CV / cover letter asks and application questions. These are not knockout criteria unless the ad clearly says mandatory.
- salary_band: if the JD states a range, use it. If not, use your knowledge of NZ market rates for this role and seniority.`, 0.1, 2048, {
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
