import { chat, parseJson } from "./chat";
import {
  OUTREACH_PROFILE_EXCERPT_MAX_CHARS,
  buildProfileExcerpt,
} from "../profile-excerpt";
import type { ParsedRole } from "./parsing";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface OutreachMessage {
  linkedin: string;
  email: string;
}

export interface GeneratedJobAd {
  headline: string;
  body: string;
}

export interface GeneratedOfferLetter {
  subject: string;
  body: string;
}

// ─── AI functions ──────────────────────────────────────────────────────────────

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

export async function generateJobAd(
  parsedRole: ParsedRole,
  company: string | null,
  rawJd: string
): Promise<GeneratedJobAd> {
  const mustHaves = (parsedRole.must_haves?.length ? parsedRole.must_haves : parsedRole.skills_required).slice(0, 8);
  const niceToHaves = (parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : parsedRole.skills_preferred).slice(0, 5);
  const responsibilities = (parsedRole.responsibilities ?? []).slice(0, 6);
  const salaryLine = parsedRole.salary_band ? `Salary: ${parsedRole.salary_band}` : "";
  const seniorityLine = parsedRole.seniority_band ? `Seniority: ${parsedRole.seniority_band}` : "";
  const experienceLine = parsedRole.experience ? `Experience: ${parsedRole.experience}` : "";
  const locationLine = parsedRole.location_rules || parsedRole.location;

  const prompt = `You are an expert recruitment copywriter. Write a compelling job advertisement based on the information below.

Role: ${parsedRole.title}
Company: ${company ?? parsedRole.company ?? "our client"}
Location: ${locationLine}
Employment type: Full-time
${salaryLine}
${seniorityLine}
${experienceLine}

Required skills: ${mustHaves.join(", ")}
${niceToHaves.length ? `Nice to have: ${niceToHaves.join(", ")}` : ""}
${responsibilities.length ? `Key responsibilities: ${responsibilities.join("; ")}` : ""}

Original JD for context:
${rawJd.slice(0, 1500)}

Write a job ad in this format:
- An engaging 2–3 sentence opening about the opportunity and company
- "The Role" section: 4–6 bullet points on key responsibilities
- "What You'll Bring" section: 5–7 bullet points on skills/experience
- A compelling 1–2 sentence closing call-to-action

Keep it honest, direct, and compelling. No filler phrases like "dynamic" or "passionate". Write for a New Zealand professional audience.

Return JSON: {"headline": "short compelling tagline under 10 words", "body": "full ad text with sections"}`;

  const text = await chat(prompt, 0.4, 2000);
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as GeneratedJobAd;
      if (parsed.headline && parsed.body) return parsed;
    } catch { /* fall through */ }
  }
  // Fallback if JSON parse fails
  return { headline: `${parsedRole.title} — ${parsedRole.location}`, body: text.trim() };
}

export async function generateRejectionEmail(
  candidateName: string,
  roleTitle: string,
  company: string | null,
  recruiterNotes?: string
): Promise<string> {
  const prompt = `You are a recruiter writing a professional, warm rejection email for a candidate.

Candidate name: ${candidateName}
Role they applied for: ${roleTitle}
Company: ${company ?? "our client"}
${recruiterNotes ? `Internal notes (do NOT include verbatim, use for tone only): ${recruiterNotes.slice(0, 300)}` : ""}

Write a rejection email that:
- Opens with genuine thanks for their time and interest
- Clearly but kindly communicates they haven't been selected
- Does NOT give specific reasons (keeps it clean legally)
- Encourages them to apply for future roles if appropriate
- Is warm, human, and 3–4 short paragraphs
- Signs off from "The ${company ?? "Recruitment"} Team"

Write only the email body (no subject line). No filler phrases like "we were overwhelmed with applications". Keep it real.`;

  return (await chat(prompt, 0.4, 600)).trim();
}

export async function generateOfferLetter(
  candidateName: string,
  roleTitle: string,
  company: string | null,
  salary?: { min?: number; max?: number } | null,
  startDate?: string
): Promise<GeneratedOfferLetter> {
  const salaryLine = salary?.min || salary?.max
    ? `Salary: $${((salary.min ?? salary.max ?? 0) / 1000).toFixed(0)}k–$${((salary.max ?? salary.min ?? 0) / 1000).toFixed(0)}k NZD per annum`
    : "Salary: [TO BE CONFIRMED]";

  const prompt = `You are a recruiter drafting an offer letter for a successful candidate.

Candidate: ${candidateName}
Role: ${roleTitle}
Company: ${company ?? "[Company Name]"}
${salaryLine}
Start date: ${startDate ?? "[START DATE]"}

Write a professional offer letter that:
- Warmly congratulates them and expresses genuine excitement
- Confirms the role title, company, and key terms
- Includes salary, start date, and notes that a formal employment agreement will follow
- Sets a clear acceptance deadline (suggest 5 business days)
- Is professional but not overly corporate — genuine and human
- Is 4–5 paragraphs

Return JSON: {"subject": "email subject line", "body": "full letter text"}
Use [PLACEHOLDER] format for anything that needs to be filled in.`;

  const text = await chat(prompt, 0.4, 800);
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as GeneratedOfferLetter;
      if (parsed.subject && parsed.body) return parsed;
    } catch { /* fall through */ }
  }
  return {
    subject: `Offer of Employment — ${roleTitle} at ${company ?? "[Company]"}`,
    body: text.trim(),
  };
}
