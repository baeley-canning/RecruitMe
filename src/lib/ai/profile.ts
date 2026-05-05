import { chat, withRetry, parseJson, SONNET } from "./chat";
import {
  sanitizeCandidateProfileDraft,
  type EvidenceCandidateProfileDraft,
  type SanitizedCandidateProfileDraft,
} from "../candidate-profile";
import {
  buildProfileExcerpt,
  buildRequirementAwareProfileExcerpt,
  SCORE_PROFILE_EXCERPT_MAX_CHARS,
  ACCEPTANCE_PROFILE_EXCERPT_MAX_CHARS,
} from "../profile-excerpt";
import { getJobParsingProvider } from "./chat";
import type { ParsedRole } from "./parsing";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SkillGroup {
  title: string;
  skills: string[];
}

export interface ProfileDocSections {
  executiveSummary: string;
  skillGroups: SkillGroup[];
  workHistory: Array<{ company: string; role: string; dates: string; bullets: string[] }>;
  qualifications: Array<{ institution: string; courseYear: string }>;
  availability: string;
  trimmedPositions: number; // jobs excluded as irrelevant to the target role
}

// Internal type returned by Pass 1 (fact extraction + curation)
interface ExtractedFacts {
  workHistory: Array<{ company: string; role: string; dates: string; bullets: string[] }>;
  skillGroups: SkillGroup[];
  qualifications: Array<{ institution: string; courseYear: string }>;
  availability: string;
  trimmedPositions: number;
}

// ─── AI functions ──────────────────────────────────────────────────────────────

/**
 * Two-pass profile generation:
 * Pass 1 — Extract AND curate facts for the specific target role. Irrelevant
 *           positions are excluded; skills are grouped by category.
 * Pass 2 — Write a concise executive summary positioned for the target role,
 *           using only the verified facts from Pass 1.
 */
export async function generateCandidateProfileSections(
  profileText: string,
  candidateName: string,
  targetRole: string,
  jdText?: string
): Promise<ProfileDocSections> {
  const excerpt = profileText.slice(0, 16000);
  const roleContext = jdText?.trim()
    ? `\nJob description for the target role:\n${jdText.slice(0, 3000)}`
    : "";

  // ── Pass 1: Extract and curate for target role ────────────────────────────
  const extractionPrompt = `You are a recruitment consultant preparing a candidate presentation for a client.

Candidate name: ${candidateName}
Being put forward for: ${targetRole}${roleContext}

SOURCE MATERIAL:
${excerpt}

TASK: Extract and CURATE the candidate's profile for the target role above. This is NOT a full CV dump — include only what is relevant and compelling for this specific placement.

RULES:
- Extract ONLY what is explicitly stated. Do not infer, assume, or invent.
- Work history: include the 3–5 positions MOST RELEVANT to "${targetRole}". Skip roles with no connection to the target. If all roles are relevant, keep up to 5 most recent/relevant. Count how many you excluded in trimmedPositions.
- For work bullets: restate key achievements and responsibilities clearly. Keep them punchy — 1–2 sentences each. Focus on what matters for "${targetRole}".
- Skills: group into logical categories relevant to "${targetRole}" (e.g. "Technical Skills", "Frameworks & Tools", "Domain Expertise"). Most relevant category first. Only include skills mentioned in the source.
- If a field has no data, use empty string or empty array. If dates are missing, use "".

Return ONLY valid JSON:
{
  "workHistory": [
    {
      "company": "Exact company name",
      "role": "Exact job title",
      "dates": "Start – End (or empty string)",
      "bullets": ["Specific achievement or responsibility"]
    }
  ],
  "skillGroups": [
    {
      "title": "Category name relevant to target role",
      "skills": ["Skill A", "Skill B"]
    }
  ],
  "qualifications": [
    { "institution": "Institution name", "courseYear": "Degree/Certification | Year" }
  ],
  "availability": "As stated in source, or empty string",
  "trimmedPositions": 0
}`;

  let facts: ExtractedFacts = {
    workHistory: [], skillGroups: [], qualifications: [], availability: "", trimmedPositions: 0,
  };

  try {
    const raw = await withRetry(() => chat(extractionPrompt, 0.1, 2500, { model: SONNET }));
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<ExtractedFacts>;
      facts = {
        workHistory: Array.isArray(parsed.workHistory)
          ? parsed.workHistory.slice(0, 5).map((j) => ({
              company: String(j.company ?? ""),
              role:    String(j.role ?? ""),
              dates:   String(j.dates ?? ""),
              bullets: Array.isArray(j.bullets) ? j.bullets.map(String).filter(Boolean) : [],
            }))
          : [],
        skillGroups: Array.isArray(parsed.skillGroups)
          ? parsed.skillGroups.map((g) => ({
              title:  String(g.title ?? ""),
              skills: Array.isArray(g.skills) ? g.skills.map(String).filter(Boolean) : [],
            })).filter((g) => g.title && g.skills.length > 0)
          : [],
        qualifications: Array.isArray(parsed.qualifications) ? parsed.qualifications : [],
        availability:   String(parsed.availability ?? ""),
        trimmedPositions: Number(parsed.trimmedPositions ?? 0),
      };
    }
  } catch {
    return { executiveSummary: "", skillGroups: [], workHistory: [], qualifications: [], availability: "", trimmedPositions: 0 };
  }

  if (facts.workHistory.length === 0) {
    return { executiveSummary: "", skillGroups: facts.skillGroups, workHistory: [], qualifications: facts.qualifications, availability: facts.availability, trimmedPositions: facts.trimmedPositions };
  }

  // ── Pass 2: Write executive summary positioned for the target role ─────────
  const factsJson = JSON.stringify({
    name: candidateName,
    targetRole,
    workHistory: facts.workHistory.map((j) => ({
      company: j.company, role: j.role, dates: j.dates, keyPoints: j.bullets.slice(0, 3),
    })),
    skills: facts.skillGroups.flatMap((g) => g.skills).slice(0, 20),
    availability: facts.availability,
  }, null, 2);

  const jdAngle = jdText?.trim()
    ? `\nThis candidate is being put forward for: ${targetRole}. Lead with what is most relevant to the hiring manager's needs. Reference specific requirements from the JD where supported by evidence. Do NOT mention gaps or requirements the candidate doesn't meet.\n`
    : `\nThis candidate is being put forward for: ${targetRole}. Lead with their most relevant experience for this role.\n`;

  const summaryPrompt = `Write a concise executive summary for a client-facing candidate profile.

Rules:
- Under 150 words. Brevity is quality.
- Third person only. No "I" or "we".
- Every fact must come from the verified list below. No invention, no embellishment.
- Explicitly position the candidate for "${targetRole}" — not a generic summary.
- No filler: no "proven track record", "strong communicator", "passionate about", "results-driven", "extensive experience".
- Do not re-summarise the work history — write the pitch that makes the hiring manager want to read on.
- Every sentence must add something specific. Cut anything generic.
${jdAngle}
Verified facts:
${factsJson}

Write 2–3 short paragraphs (2–3 sentences each):
1. Who they are and why they suit "${targetRole}" specifically
2. The 2–3 most compelling facts for this placement (specific employer, achievement, or rare skill)
3. One closing sentence only if it adds a concrete differentiating fact (metric, rare skill, availability). Skip if nothing new to add.

Return ONLY the summary text. No JSON. No headings. No labels.`;

  let executiveSummary = "";
  try {
    executiveSummary = (await withRetry(() => chat(summaryPrompt, 0.2, 1000, { model: SONNET }))).trim();
  } catch {
    executiveSummary = "";
  }

  return {
    executiveSummary,
    skillGroups:    facts.skillGroups,
    workHistory:    facts.workHistory,
    qualifications: facts.qualifications,
    availability:   facts.availability,
    trimmedPositions: facts.trimmedPositions,
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
${rawText.slice(0, 12000)}

Return ONLY the cleaned CV text. No commentary, no preamble.`,
    0,
    2048
  );
  // If Claude returns something extremely short it probably failed — fall back to raw
  return text.trim().length > 100 ? text.trim() : rawText;
}

export async function draftCandidateProfileFromSource(sourceText: string): Promise<SanitizedCandidateProfileDraft> {
  const source = sourceText.slice(0, 16000);
  const text = await chat(
    `You are drafting a client-facing candidate profile from recruiter notes, CV text, LinkedIn profile text, or an existing profile.

Truthfulness is mandatory. You must not infer, embellish, estimate, or invent. Every output fact must have an evidence_quote copied exactly from the source text. If a fact is not clearly supported, leave it blank or omit it.

Source text:
${source}

Return ONLY valid JSON with this exact shape:
{
  "candidate": {"value": "", "evidence_quote": ""},
  "role": {"value": "", "evidence_quote": ""},
  "dateAvailable": {"value": "", "evidence_quote": ""},
  "executiveSummary": [
    {"text": "One concise, client-ready sentence supported by the source.", "evidence_quote": "exact source quote"}
  ],
  "skillGroups": [
    {
      "title": {"value": "Skill group title copied or directly supported by source terms", "evidence_quote": "exact source quote"},
      "skills": [{"text": "Specific skill from source", "evidence_quote": "exact source quote"}]
    }
  ],
  "workHistory": [
    {
      "company": {"value": "", "evidence_quote": ""},
      "role": {"value": "", "evidence_quote": ""},
      "dates": {"value": "", "evidence_quote": ""},
      "bullets": [{"text": "Specific responsibility or achievement from source", "evidence_quote": "exact source quote"}]
    }
  ],
  "educationTitle": "Qualifications",
  "education": [
    {
      "institution": {"value": "", "evidence_quote": ""},
      "course": {"value": "", "evidence_quote": ""},
      "year": {"value": "", "evidence_quote": ""}
    }
  ]
}

Rules:
- Evidence quotes must be copied verbatim from the source text. Do not paraphrase evidence_quote.
- The text/value may be lightly cleaned for client readability, but only if the evidence_quote proves it.
- Do not create availability, education, dates, companies, titles, certifications, achievements, salary, location, or motivations unless the source says them.
- Executive summary should be 3-6 short factual sentences, each with its own evidence quote.
- Work bullets should be factual, specific, and source-backed. Avoid generic recruiter filler.
- If the source is too thin, return fewer fields rather than guessing.`,
    0,
    4096,
    { provider: getJobParsingProvider(), model: SONNET }
  );

  return sanitizeCandidateProfileDraft(parseJson<EvidenceCandidateProfileDraft>(text), source);
}

export async function extractCandidateInfo(
  profileText: string
): Promise<{ name: string; headline: string; location: string }> {
  if (!profileText || profileText.trim().length < 50) {
    return { name: "", headline: "", location: "" };
  }
  try {
    const text = await chat(`Extract the candidate's name, job title/headline, and location from this LinkedIn profile text. Return actual values found in the text only.

Profile text:
${profileText.slice(0, 2500)}

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
