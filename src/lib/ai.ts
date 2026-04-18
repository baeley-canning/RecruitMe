import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  buildScoreBreakdown,
  CATEGORY_WEIGHTS_V2,
  type ScoreBreakdown,
  type MustHaveStatus,
  type NiceToHaveStatus,
  type CategoryScore,
} from "./scoring";
import {
  ACCEPTANCE_PROFILE_EXCERPT_MAX_CHARS,
  buildProfileExcerpt,
  OUTREACH_PROFILE_EXCERPT_MAX_CHARS,
  SCORE_PROFILE_EXCERPT_MAX_CHARS,
} from "./profile-excerpt";

// ─── Unified chat helper ───────────────────────────────────────────────────────
// Abstracts over Claude, OpenAI, and Ollama so all AI functions stay clean.

export async function chat(prompt: string, temperature = 0.1, maxTokens = 2048): Promise<string> {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  // ── Claude (Anthropic) ──
  if (provider === "claude") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env.local");

    const client = new Anthropic({ apiKey });
    const model  = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "user", content: prompt }],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }

  // ── OpenAI ──
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set in .env.local");

    const client = new OpenAI({ apiKey });
    const model  = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
    });

    return response.choices[0]?.message?.content ?? "";
  }

  // ── Ollama (default) ──
  const base = await findOllamaBase();
  const client = new OpenAI({ baseURL: `${base}/v1`, apiKey: "ollama" });
  const model  = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature,
    max_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content ?? "";
}

// ─── Ollama auto-detect ────────────────────────────────────────────────────────

const OLLAMA_URL_CANDIDATES = [
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  "http://127.0.0.1:11434",
  "http://localhost:11434",
  "http://10.255.255.254:11434",
];

let _ollamaBaseCache: string | null = null;

async function findOllamaBase(): Promise<string> {
  if (_ollamaBaseCache) return _ollamaBaseCache;

  const urls = [...new Set(OLLAMA_URL_CANDIDATES)];
  const checks = urls.map(async (base) => {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error("not ok");
    return base;
  });

  try {
    _ollamaBaseCache = await Promise.any(checks);
    return _ollamaBaseCache;
  } catch {
    throw new Error(
      `Cannot connect to Ollama.\nTried: ${urls.join(", ")}\n\n` +
      `Run: ollama serve   or set AI_PROVIDER=claude in .env.local`
    );
  }
}

// ─── Shared JSON parser ────────────────────────────────────────────────────────

function parseJson<T>(text: string): T {
  // Match either an object {...} or array [...]
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON found in AI response");

  const raw = match[0];

  // 1. Try raw
  try { return JSON.parse(raw) as T; } catch { /* continue */ }

  // 2. Normalize internal whitespace
  const normalized = raw.replace(/[\r\n\t]/g, " ");
  try { return JSON.parse(normalized) as T; } catch { /* continue */ }

  // 3. Remove trailing commas before ] or }
  const detrailed = normalized.replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(detrailed) as T; } catch { /* continue */ }

  // 4. Balance unclosed braces (handles truncated responses)
  let opens = 0, closes = 0;
  for (const ch of detrailed) {
    if (ch === "{") opens++;
    else if (ch === "}") closes++;
  }
  const needed = opens - closes;
  if (needed > 0 && needed < 6) {
    try { return JSON.parse(detrailed + "}".repeat(needed)) as T; } catch { /* continue */ }
  }

  throw new Error("Failed to parse JSON from AI response");
}

function normalizeCoverageKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findCoverageMatch<T extends { requirement: string }>(
  expectedRequirement: string,
  items: T[],
  usedIndexes: Set<number>
): T | null {
  const expectedKey = normalizeCoverageKey(expectedRequirement);
  let looseIndex = -1;

  for (let index = 0; index < items.length; index += 1) {
    if (usedIndexes.has(index)) continue;
    const candidateKey = normalizeCoverageKey(items[index].requirement);
    if (!candidateKey) continue;
    if (candidateKey === expectedKey) {
      usedIndexes.add(index);
      return items[index];
    }
    if (looseIndex === -1 && (candidateKey.includes(expectedKey) || expectedKey.includes(candidateKey))) {
      looseIndex = index;
    }
  }

  if (looseIndex !== -1) {
    usedIndexes.add(looseIndex);
    return items[looseIndex];
  }

  return null;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedRole {
  title: string;
  company: string;
  location: string;
  experience: string;
  // Rich hiring brief fields (populated by updated parser)
  seniority_band: string;       // e.g. "Senior IC", "Tech Lead", "Mid-level"
  salary_band: string;          // inferred e.g. "$110k–$140k NZD"
  location_rules: string;       // e.g. "Auckland CBD 3 days/week"
  visa_flags: string[];         // e.g. ["NZ citizen or PR only"]
  must_haves: string[];         // non-negotiable requirements
  nice_to_haves: string[];      // desirable but not blocking
  knockout_criteria: string[];  // instant disqualifiers
  synonym_titles: string[];     // alternative LinkedIn titles to search
  responsibilities: string[];
  search_queries: string[];
  google_queries: string[];
  // Legacy — kept populated for backward compat with older scored candidates
  skills_required: string[];
  skills_preferred: string[];
}

export interface AcceptanceSignal {
  label: string;
  positive: boolean;
}

export interface AcceptancePrediction {
  score: number;
  likelihood: "high" | "medium" | "low";
  headline: string;
  signals: AcceptanceSignal[];
  summary: string;
}

export interface OutreachMessage {
  linkedin: string;
  email: string;
}

// ─── AI functions ──────────────────────────────────────────────────────────────

export async function parseJobDescription(jd: string): Promise<ParsedRole> {
  const text = await chat(`You are a senior recruitment consultant with deep knowledge of the NZ market. You will receive either a formal job description (JD) or an informal hiring brief. Extract a structured hiring profile that powers candidate search and screening.

Input (JD or hiring brief):
${jd.slice(0, 5000)}

Return ONLY valid JSON (no markdown, no explanation):
{
  "title": "standardised market-facing job title — if the internal title is unusual, translate it to what the person would actually be called",
  "company": "company or client name, or empty string",
  "location": "city or region only — e.g. 'Auckland', 'Wellington'",
  "experience": "years requirement only if explicitly stated — e.g. '5+ years'. Empty string otherwise.",
  "seniority_band": "one of: Graduate | Junior | Mid-level | Senior | Lead | Principal | Manager | Director | Executive",
  "salary_band": "inferred NZD salary range — use your NZ market knowledge if not stated. Format '$90k–$120k NZD'. Empty string only if genuinely impossible to estimate.",
  "location_rules": "office/remote policy in plain English — e.g. 'Auckland CBD, 3 days in office' or 'Fully remote, NZ-based only' or 'Flexible'",
  "visa_flags": ["work rights or visa requirements — e.g. 'NZ citizen or permanent resident only', 'Open Work Visa accepted'. Empty array if not mentioned."],
  "must_haves": ["non-negotiable requirements the person MUST have — hard skills, certs, experience the JD treats as mandatory. Be specific and exhaustive."],
  "nice_to_haves": ["explicitly preferred or advantageous things — 'would be great', 'advantageous', 'desirable'. Separate from must-haves."],
  "knockout_criteria": ["ONLY true binary gates — legal/compliance requirements a recruiter would ask on a screening call before reading the CV. Examples: work rights, mandatory licences (driver's licence, security clearance), specific mandatory professional registration. DO NOT include skills, experience years, or technologies here — those belong in must_haves and are scoring factors, not gates. Most JDs have zero or one knockout criteria. If there are none, return an empty array."],
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
  "skills_preferred": ["technical and hard skills from nice_to_haves — same content, skills only"]
}

Rules:
- search_queries and google_queries: KEYWORD TERMS ONLY. Location and site:linkedin.com/in are added automatically. No years of experience. Never copy the exact job title verbatim.
- synonym_titles is the most important field for search coverage — a "Digital Solutions Analyst" might be "Business Analyst", "Systems Analyst", "Product Analyst", "IT Analyst", "Digital Analyst" on LinkedIn. Think about what 10 different people doing this job would call themselves. Banned terms that no one uses on LinkedIn: "Application Developer", "Technical Developer", "IT Developer", "Mid-level Developer", "Junior Developer", "Graduate Developer" — use the actual technology stack or domain in the title instead.
- must_haves vs nice_to_haves: if the JD says "required" or "must have" it's a must-have. If it says "preferred", "advantageous", "desirable", "bonus" it's nice-to-have.
- knockout_criteria: STRICT — only legal/compliance binary gates a recruiter asks on a phone screen before looking at the CV. Work rights, mandatory licences, security clearances. Skills and experience are NOT knockouts — they go in must_haves. Most roles have one knockout or none. When in doubt, leave it out.
- salary_band: if the JD states a range, use it. If not, use your knowledge of NZ market rates for this role and seniority.`);

  const parsed = parseJson<Partial<ParsedRole>>(text);

  return {
    title:             parsed.title ?? "",
    company:           parsed.company ?? "",
    location:          parsed.location ?? "",
    experience:        parsed.experience ?? "",
    seniority_band:    parsed.seniority_band ?? "",
    salary_band:       parsed.salary_band ?? "",
    location_rules:    parsed.location_rules ?? "",
    visa_flags:        parsed.visa_flags ?? [],
    must_haves:        parsed.must_haves ?? [],
    nice_to_haves:     parsed.nice_to_haves ?? [],
    knockout_criteria: parsed.knockout_criteria ?? [],
    synonym_titles:    parsed.synonym_titles ?? [],
    responsibilities:  parsed.responsibilities ?? [],
    search_queries:    parsed.search_queries ?? [],
    google_queries:    parsed.google_queries ?? [],
    skills_required:   parsed.skills_required ?? [],
    skills_preferred:  parsed.skills_preferred ?? [],
  };
}

export async function predictAcceptance(
  profileText: string,
  parsedRole: ParsedRole,
  salary?: { min: number; max: number } | null
): Promise<AcceptancePrediction> {
  const profileSlice = buildProfileExcerpt(profileText, ACCEPTANCE_PROFILE_EXCERPT_MAX_CHARS);
  const salaryLine = salary?.min || salary?.max
    ? `Salary offered: $${((salary.min || 0) / 1000).toFixed(0)}k–$${((salary.max || 0) / 1000).toFixed(0)}k NZD/year`
    : "";

  const text = await chat(`You are a senior recruitment consultant estimating whether a candidate is likely to accept a job offer.

Role being offered:
Title: ${parsedRole.title}
Location: ${parsedRole.location}
Experience required: ${parsedRole.experience}
${salaryLine}

Candidate profile:
${profileSlice}

Assess using only evidence in the profile. Consider: tenure in current role, career momentum, job mobility history, salary uplift, title step up/lateral/down, location friction, company instability signals, bio language.

Return ONLY valid JSON (no markdown):
{"score":68,"likelihood":"medium","headline":"3 years without visible promotion — likely open to the right move","signals":[{"label":"3 years in current role — within typical move window","positive":true}],"summary":"2-3 sentence recruiter assessment."}

Score: 70-100 high, 40-69 medium, 0-39 low. Max 5 signals. Only include signals with actual evidence.`);

  const parsed = parseJson<Partial<AcceptancePrediction>>(text);
  const clamp  = (v: unknown) => typeof v === "number" ? Math.min(100, Math.max(0, Math.round(v))) : 50;

  const rawLikelihood = parsed.likelihood;
  const likelihood: "high" | "medium" | "low" =
    rawLikelihood === "high" || rawLikelihood === "medium" || rawLikelihood === "low"
      ? rawLikelihood : "medium";

  return {
    score:     clamp(parsed.score),
    likelihood,
    headline:  parsed.headline ?? "",
    signals:   Array.isArray(parsed.signals)
      ? parsed.signals
          .filter((s): s is AcceptanceSignal => typeof s === "object" && s !== null && typeof s.label === "string")
          .slice(0, 5)
      : [],
    summary: parsed.summary ?? "",
  };
}

export async function generateOutreachMessage(
  profileText: string,
  parsedRole: ParsedRole,
  candidateName: string
): Promise<OutreachMessage> {
  const profileSlice = buildProfileExcerpt(profileText, OUTREACH_PROFILE_EXCERPT_MAX_CHARS);
  const text = await chat(`You are a recruitment consultant writing a personalized outreach message to a passive candidate.

Role being offered:
Title: ${parsedRole.title}
Company: ${parsedRole.company || "our client"}
Location: ${parsedRole.location}

Candidate: ${candidateName}
Profile:
${profileSlice}

Write two personalised outreach messages. Reference their ACTUAL job titles, companies, and specific skills — never be generic.

1. LinkedIn connection request (max 300 characters, first-name only, conversational, no sycophancy)
2. Email (subject line + 3 short paragraphs: hook on their background, why this role fits, clear call to action)

Return ONLY valid JSON (no markdown):
{"linkedin":"Hi [FirstName], noticed your [specific detail] — working on a [role] that looks relevant. Worth a quick chat?","email":"Subject: [Role] — [hook]\\n\\nHi [FirstName],\\n\\n[Para 1]\\n\\n[Para 2]\\n\\n[CTA]\\n\\n[Sign-off]"}`, 0.4);

  const parsed = parseJson<Partial<OutreachMessage>>(text);

  return {
    linkedin: (parsed.linkedin ?? "").slice(0, 300),
    email:    parsed.email ?? "",
  };
}

// Cleans raw PDF-extracted text into readable, well-structured prose.
// PDF parsers produce garbled output from multi-column layouts, headers/footers,
// and broken line breaks. This runs once per manual upload and dramatically
// improves downstream scoring accuracy.
export async function cleanCvText(rawText: string): Promise<string> {
  const text = await chat(
    `You are processing a CV that was extracted from a PDF. The raw text may have broken line breaks, jumbled columns, or garbled formatting from the PDF parser.

Rewrite it as clean, readable plain text preserving ALL information. Structure it naturally:
- Full name and contact details at the top
- Current/most recent role
- Work history: each role with company, title, dates, and what they did
- Skills and technologies
- Education and certifications

Rules:
- Keep every piece of information — do NOT summarise or omit anything
- Plain text only — no markdown #headers, no bullet symbols like • or *, just dashes or blank lines
- Fix garbled words caused by PDF column parsing (e.g. "S enior" → "Senior")
- Remove page numbers, headers/footers, and repeated document title text
- If the text is already clean and readable, return it unchanged

Raw CV text:
${rawText.slice(0, 6000)}

Return ONLY the cleaned CV text. No commentary, no preamble.`,
    0,
    2048
  );
  // If Claude returns something extremely short it probably failed — fall back to raw
  return text.trim().length > 100 ? text.trim() : rawText;
}

// ── Structured scoring v2 ─────────────────────────────────────────────────────
// The AI populates 7 category scores, per-requirement coverage, and reasons.
// The overall score, evidence_coverage_score, and confidence are computed
// deterministically from those outputs — the AI never produces a final score.

export type { ScoreBreakdown } from "./scoring";

export async function scoreCandidateStructured(
  profileText: string,
  parsedRole: ParsedRole,
  salary?: { min: number; max: number } | null
): Promise<ScoreBreakdown> {
  const clamp = (v: unknown, fallback = 50) =>
    typeof v === "number" ? Math.min(100, Math.max(0, Math.round(v))) : fallback;

  const mustHaves   = (parsedRole.must_haves?.length   ? parsedRole.must_haves   : parsedRole.skills_required).slice(0, 12);
  const niceToHaves = (parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : parsedRole.skills_preferred).slice(0, 6);
  const knockouts   = parsedRole.knockout_criteria ?? [];

  const salaryLine    = salary?.min || salary?.max
    ? `Budget: $${((salary.min || 0) / 1000).toFixed(0)}k–$${((salary.max || 0) / 1000).toFixed(0)}k NZD` : "";
  const seniorityLine = parsedRole.seniority_band ? `Seniority: ${parsedRole.seniority_band}` : "";
  const knockoutLine  = knockouts.length ? `Knockout criteria (instant fail if clearly absent): ${knockouts.join("; ")}` : "";
  const mustHavesList = mustHaves.map((m, i) => `${i + 1}. ${m}`).join("\n");
  const niceList      = niceToHaves.map((n, i) => `${i + 1}. ${n}`).join("\n");

  const profileSlice = buildProfileExcerpt(profileText, SCORE_PROFILE_EXCERPT_MAX_CHARS);

  const text = await chat(
    `You are a senior recruitment consultant scoring a candidate against a specific role. Return ONLY compact JSON — no markdown, no newlines inside string values.

Role: ${parsedRole.title} | ${parsedRole.location}${salaryLine ? ` | ${salaryLine}` : ""}${seniorityLine ? ` | ${seniorityLine}` : ""}

Must-haves (numbered — include ALL in must_have_coverage):
${mustHavesList}

Nice-to-haves (numbered — include ALL in nice_to_have_coverage):
${niceList || "(none listed)"}
${knockoutLine}

Candidate profile:
${profileSlice}

Return EXACTLY this JSON structure:
{
  "categories": {
    "skill_fit":         {"score":0,"evidence":"one sentence grounding the score in actual profile text"},
    "location_fit":      {"score":0,"evidence":"one sentence"},
    "seniority_fit":     {"score":0,"evidence":"one sentence"},
    "title_fit":         {"score":0,"evidence":"one sentence"},
    "industry_fit":      {"score":0,"evidence":"one sentence"},
    "nice_to_have_fit":  {"score":0,"evidence":"one sentence about how many nice-to-haves are present"},
    "keyword_alignment": {"score":0,"evidence":"one sentence about vocabulary and terminology match"}
  },
  "must_have_coverage": [
    {"requirement":"exact text from must-haves list","status":"confirmed|likely|missing|negative|unknown","evidence":"direct quote or paraphrase from profile, or Not mentioned"}
  ],
  "nice_to_have_coverage": [
    {"requirement":"exact text from nice-to-haves list","status":"confirmed|likely|absent","evidence":"direct quote or paraphrase, or Not mentioned"}
  ],
  "reasons_for": ["specific positive signal from the profile","..."],
  "reasons_against": ["specific concern or gap from the profile","..."],
  "missing_evidence": ["specific fact that would change the score if known","..."],
  "recruiter_summary": "1-2 sentences a recruiter would say to a client. Specific, no jargon, no superlatives."
}

Category score rules:
- skill_fit: 80+ = most must-have skills confirmed; 60-79 = several confirmed; 40-59 = adjacent; 0-39 = mismatch
- location_fit: 100 = same city/region; 80 = commutable; 50 = same country; 0 = overseas
- seniority_fit: 100 = exact match; 70 = one level off; 40 = two levels off; 0 = completely wrong level
- title_fit: do recent titles align with how people in this role describe themselves on LinkedIn?
- industry_fit: relevant sector/domain experience matching the role's context?
- nice_to_have_fit: 80+ = most nice-to-haves present; 50 = some; 20 = few; if none listed, score 50
- keyword_alignment: 80+ = vocabulary strongly matches role language; 40-79 = partial; 0-39 = different domain

must_have_coverage rules:
- "confirmed" = clearly and explicitly stated in the profile
- "likely" = strongly implied by adjacent evidence (e.g. a company or framework implies a skill)
- "missing" = not mentioned — could have it but unverifiable
- "negative" = profile actively contradicts this requirement (e.g. no work rights, wrong country)
- "unknown" = insufficient data to make any assessment
- Include EXACTLY one entry per must-have. Do not skip or merge any.${knockouts.length ? `
- If any knockout criterion is failed, status must be "negative".` : ""}

nice_to_have_coverage rules:
- "confirmed" = explicitly present; "likely" = implied; "absent" = not present or not mentioned
- Include EXACTLY one entry per nice-to-have. If no nice-to-haves were listed, return empty array.

reasons_for: 2–4 specific, evidenced positive signals. Not generic praise. Reference actual job titles, companies, skills from the profile.
reasons_against: 2–4 specific concerns. Not speculation — only what the profile actually shows or fails to show.
missing_evidence: 2–4 specific facts that are NOT in the profile and would materially change the score (e.g. "Years in role not stated", "No mention of team leadership despite Senior title").

Short snippet rule: score what IS confirmed. Do not penalise for skills not mentioned. Only penalise hard for active contradictions.`,
    0.1,
    3000
  );

  type RawCat = { score?: number; evidence?: string };
  type RawAI = {
    categories?: {
      skill_fit?:         RawCat;
      location_fit?:      RawCat;
      seniority_fit?:     RawCat;
      title_fit?:         RawCat;
      industry_fit?:      RawCat;
      nice_to_have_fit?:  RawCat;
      keyword_alignment?: RawCat;
    };
    must_have_coverage?:   Array<{ requirement?: string; status?: string; evidence?: string }>;
    nice_to_have_coverage?: Array<{ requirement?: string; status?: string; evidence?: string }>;
    reasons_for?:     string[];
    reasons_against?: string[];
    missing_evidence?: string[];
    recruiter_summary?: string;
  };

  const raw = parseJson<RawAI>(text);

  const parseCategory = (key: keyof NonNullable<RawAI["categories"]>, weight: number): CategoryScore => ({
    score:    clamp(raw.categories?.[key]?.score),
    weight,
    evidence: typeof raw.categories?.[key]?.evidence === "string" ? raw.categories[key]!.evidence : "",
  });

  const validMH  = new Set(["confirmed", "likely", "missing", "negative", "unknown"]);
  const validNTH = new Set(["confirmed", "likely", "absent"]);

  const rawMustHaveCoverage: MustHaveStatus[] = (raw.must_have_coverage ?? [])
    .filter((c) => typeof c?.requirement === "string" && typeof c?.status === "string")
    .map((c) => ({
      requirement: c.requirement!,
      status:      validMH.has(c.status!) ? (c.status as MustHaveStatus["status"]) : "unknown",
      evidence:    typeof c.evidence === "string" ? c.evidence : "Not mentioned",
    }));

  const rawNiceToHaveCoverage: NiceToHaveStatus[] = (raw.nice_to_have_coverage ?? [])
    .filter((c) => typeof c?.requirement === "string" && typeof c?.status === "string")
    .map((c) => ({
      requirement: c.requirement!,
      status:      validNTH.has(c.status!) ? (c.status as NiceToHaveStatus["status"]) : "absent",
      evidence:    typeof c.evidence === "string" ? c.evidence : "Not mentioned",
    }));

  const usedMustHaveIndexes = new Set<number>();
  const mustHaveCoverage: MustHaveStatus[] = mustHaves.map((requirement) => {
    const match = findCoverageMatch(requirement, rawMustHaveCoverage, usedMustHaveIndexes);
    if (match) {
      return {
        requirement,
        status: match.status,
        evidence: match.evidence,
      };
    }
    return {
      requirement,
      status: "unknown",
      evidence: "No coverage returned by model for this must-have.",
    };
  });

  const usedNiceToHaveIndexes = new Set<number>();
  const niceToHaveCoverage: NiceToHaveStatus[] = niceToHaves.map((requirement) => {
    const match = findCoverageMatch(requirement, rawNiceToHaveCoverage, usedNiceToHaveIndexes);
    if (match) {
      return {
        requirement,
        status: match.status,
        evidence: match.evidence,
      };
    }
    return {
      requirement,
      status: "absent",
      evidence: "No coverage returned by model for this nice-to-have.",
    };
  });

  const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

  const categories: ScoreBreakdown["categories"] = {
    skill_fit:         parseCategory("skill_fit",         CATEGORY_WEIGHTS_V2.skill_fit),
    location_fit:      parseCategory("location_fit",      CATEGORY_WEIGHTS_V2.location_fit),
    seniority_fit:     parseCategory("seniority_fit",     CATEGORY_WEIGHTS_V2.seniority_fit),
    title_fit:         parseCategory("title_fit",         CATEGORY_WEIGHTS_V2.title_fit),
    industry_fit:      parseCategory("industry_fit",      CATEGORY_WEIGHTS_V2.industry_fit),
    nice_to_have_fit:  parseCategory("nice_to_have_fit",  CATEGORY_WEIGHTS_V2.nice_to_have_fit),
    keyword_alignment: parseCategory("keyword_alignment", CATEGORY_WEIGHTS_V2.keyword_alignment),
  };

  return buildScoreBreakdown({
    categories,
    must_have_coverage:    mustHaveCoverage,
    nice_to_have_coverage: niceToHaveCoverage,
    reasons_for:           stringArray(raw.reasons_for),
    reasons_against:       stringArray(raw.reasons_against),
    missing_evidence:      stringArray(raw.missing_evidence),
    recruiter_summary:     typeof raw.recruiter_summary === "string" ? raw.recruiter_summary : "",
    profileCharCount:      profileText.length,
  });
}

export async function extractCandidateInfo(
  profileText: string
): Promise<{ name: string; headline: string; location: string }> {
  try {
    const text = await chat(`Extract the candidate's name, job title/headline, and location from this LinkedIn profile text. Return actual values found in the text only.

Profile text:
${profileText.slice(0, 1500)}

Return ONLY valid JSON:
{"name":"Sarah Johnson","headline":"Senior Recruiter at Acme Corp","location":"Auckland, New Zealand"}`, 0);

    const parsed = parseJson<{ name?: string; headline?: string; location?: string }>(text);
    return {
      name:     parsed.name ?? "Unknown",
      headline: parsed.headline ?? "",
      location: parsed.location ?? "",
    };
  } catch {
    return { name: "Unknown", headline: "", location: "" };
  }
}
