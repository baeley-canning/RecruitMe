import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

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

export interface ScoreDimensions {
  skills: number;
  experience: number;
  industry: number;
  location: number;
  seniority: number;
}

export interface CandidateScore {
  score: number;
  summary: string;
  reasoning: string;
  dimensions: ScoreDimensions;
  strengths: string[];
  gaps: string[];
  recommended: boolean;
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

export async function scoreCandidate(
  profileText: string,
  parsedRole: ParsedRole,
  salary?: { min: number; max: number } | null
): Promise<CandidateScore> {
  const salaryLine = salary?.min || salary?.max
    ? `Salary budget: $${((salary.min || 0) / 1000).toFixed(0)}k–$${((salary.max || 0) / 1000).toFixed(0)}k NZD/year`
    : "";

  const roleContext = `Title: ${parsedRole.title}
Location: ${parsedRole.location}
Experience: ${parsedRole.experience}
${salaryLine}
Required skills: ${parsedRole.skills_required.join(", ")}
Preferred skills: ${parsedRole.skills_preferred.join(", ")}
Key responsibilities: ${parsedRole.responsibilities.slice(0, 5).join("; ")}`.trim();

  const text = await chat(`You are a recruitment assistant scoring a candidate against a job.

Job Requirements:
${roleContext}

Candidate Profile:
${profileText.slice(0, 3000)}

Return ONLY valid JSON. No markdown, no explanation, no newlines inside string values.
{"score":78,"summary":"One sentence verdict.","reasoning":"Two sentences max. Reference specific skills and titles from the profile.","dimensions":{"skills":85,"experience":70,"industry":75,"location":100,"seniority":60},"strengths":["strength"],"gaps":["gap"],"recommended":true}

Scoring rules:
- 80-100: strong match on most required skills and experience level
- 60-79: good match — relevant role/industry, some required skills confirmed
- 40-59: partial match — adjacent skills or wrong seniority
- 0-39: poor match

IMPORTANT: If the profile is a short snippet, score based on what IS confirmed — do not heavily penalise for skills not mentioned. A frontend developer with React in the right location should score 65-80 even if Python/Docker aren't mentioned, because these are learnable adjacent skills. Only penalise hard if the profile actively contradicts a requirement. Never invent facts.`);

  const parsed = parseJson<Partial<CandidateScore>>(text);
  const clamp  = (v: unknown) => typeof v === "number" ? Math.min(100, Math.max(0, Math.round(v))) : 0;
  const rawDim = parsed.dimensions as Partial<ScoreDimensions> | undefined;

  return {
    score:     clamp(parsed.score),
    summary:   parsed.summary ?? "",
    reasoning: parsed.reasoning ?? "",
    dimensions: {
      skills:     clamp(rawDim?.skills),
      experience: clamp(rawDim?.experience),
      industry:   clamp(rawDim?.industry),
      location:   clamp(rawDim?.location),
      seniority:  clamp(rawDim?.seniority),
    },
    strengths:   parsed.strengths ?? [],
    gaps:        parsed.gaps ?? [],
    recommended: parsed.recommended ?? false,
  };
}

export async function predictAcceptance(
  profileText: string,
  parsedRole: ParsedRole,
  salary?: { min: number; max: number } | null
): Promise<AcceptancePrediction> {
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
${profileText.slice(0, 3000)}

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

// ── Combined score — one call instead of two ─────────────────────────────────
// Use this instead of calling scoreCandidate + predictAcceptance separately.
// When profileText is short (snippet only), acceptance is skipped — there's
// simply not enough data to predict it meaningfully.

const ACCEPTANCE_MIN_CHARS = 250; // below this, don't waste tokens on acceptance

export interface CombinedScore {
  match:      CandidateScore;
  acceptance: AcceptancePrediction | null;
}

export async function scoreCandidateFull(
  profileText: string,
  parsedRole: ParsedRole,
  salary?: { min: number; max: number } | null
): Promise<CombinedScore> {
  const clamp = (v: unknown, fallback = 0) =>
    typeof v === "number" ? Math.min(100, Math.max(0, Math.round(v))) : fallback;

  const hasEnoughForAcceptance = profileText.length >= ACCEPTANCE_MIN_CHARS;
  const salaryLine = salary?.min || salary?.max
    ? `Budget: $${((salary.min || 0) / 1000).toFixed(0)}k–$${((salary.max || 0) / 1000).toFixed(0)}k NZD`
    : "";

  const acceptanceSection = hasEnoughForAcceptance ? `
  "a_score": 0-100,
  "a_likelihood": "high|medium|low",
  "a_headline": "one-line mobility signal",
  "a_signals": [{"label":"...","positive":true}]` : "";

  const acceptanceInstructions = hasEnoughForAcceptance ? `
Acceptance (a_*): 70+ high, 40-69 medium, 0-39 low. Use tenure, seniority step, location friction. Max 4 signals. Evidence only.` : "";

  // Build a rich role context using the new fields where available, falling back to legacy fields
  const mustHaves   = parsedRole.must_haves?.length   ? parsedRole.must_haves   : parsedRole.skills_required;
  const niceToHaves = parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : parsedRole.skills_preferred;
  const knockouts   = parsedRole.knockout_criteria ?? [];
  const seniorityLine = parsedRole.seniority_band ? `Seniority: ${parsedRole.seniority_band}` : "";
  const knockoutLine  = knockouts.length ? `Knockout criteria (instant fail if missing): ${knockouts.join("; ")}` : "";

  const text = await chat(
    `Score this candidate. Return ONLY compact JSON — no markdown, no newlines inside strings.

Role: ${parsedRole.title} | ${parsedRole.location}${salaryLine ? ` | ${salaryLine}` : ""}${seniorityLine ? ` | ${seniorityLine}` : ""}
Must-haves: ${mustHaves.slice(0, 10).join(", ")}
Nice-to-haves: ${niceToHaves.slice(0, 6).join(", ")}${knockoutLine ? `\n${knockoutLine}` : ""}

Candidate:
${profileText.slice(0, 2000)}

JSON format:
{"score":0-100,"summary":"one sentence","reasoning":"two sentences max","dimensions":{"skills":0,"experience":0,"industry":0,"location":0,"seniority":0},"strengths":["..."],"gaps":["..."],"recommended":true${acceptanceSection}}

Scoring: 80+ strong match, 60-79 good, 40-59 partial, 0-39 poor.
If knockout criteria are present and the candidate clearly fails one, cap score at 20 and state the knockout in gaps.
Short snippet? Score what IS confirmed — don't penalise for skills not mentioned.${acceptanceInstructions}`,
    0.1
  );

  // Parse JSON — the combined object may contain optional acceptance fields
  const raw = parseJson<Record<string, unknown>>(text);

  const rawDim = raw.dimensions as Partial<ScoreDimensions> | undefined;
  const match: CandidateScore = {
    score:     clamp(raw.score),
    summary:   typeof raw.summary === "string"   ? raw.summary   : "",
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    dimensions: {
      skills:     clamp(rawDim?.skills),
      experience: clamp(rawDim?.experience),
      industry:   clamp(rawDim?.industry),
      location:   clamp(rawDim?.location),
      seniority:  clamp(rawDim?.seniority),
    },
    strengths:   Array.isArray(raw.strengths) ? raw.strengths.filter((s): s is string => typeof s === "string") : [],
    gaps:        Array.isArray(raw.gaps)      ? raw.gaps.filter((s): s is string => typeof s === "string")      : [],
    recommended: raw.recommended === true,
  };

  let acceptance: AcceptancePrediction | null = null;
  if (hasEnoughForAcceptance && raw.a_score !== undefined) {
    const rawLikelihood = raw.a_likelihood;
    const likelihood: "high" | "medium" | "low" =
      rawLikelihood === "high" || rawLikelihood === "medium" || rawLikelihood === "low"
        ? rawLikelihood : "medium";
    acceptance = {
      score:     clamp(raw.a_score, 50),
      likelihood,
      headline:  typeof raw.a_headline === "string" ? raw.a_headline : "",
      signals:   Array.isArray(raw.a_signals)
        ? raw.a_signals
            .filter((s): s is AcceptanceSignal => typeof s === "object" && s !== null && typeof (s as AcceptanceSignal).label === "string")
            .slice(0, 4)
        : [],
      summary: "",
    };
  }

  return { match, acceptance };
}

export async function generateOutreachMessage(
  profileText: string,
  parsedRole: ParsedRole,
  candidateName: string
): Promise<OutreachMessage> {
  const text = await chat(`You are a recruitment consultant writing a personalized outreach message to a passive candidate.

Role being offered:
Title: ${parsedRole.title}
Company: ${parsedRole.company || "our client"}
Location: ${parsedRole.location}

Candidate: ${candidateName}
Profile:
${profileText.slice(0, 2500)}

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
