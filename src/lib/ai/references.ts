import { chat } from "./chat";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ReferenceQuestion {
  question: string;
  category: string; // "performance" | "culture" | "skills" | "reliability" | "role-specific"
}

// ─── AI functions ──────────────────────────────────────────────────────────────

export async function generateReferenceQuestions(
  candidateName: string,
  candidateProfile: string,
  roleTitle: string,
  requiredSkills: string[],
  relationship: string
): Promise<ReferenceQuestion[]> {
  const profileExcerpt = candidateProfile.slice(0, 1500);
  const prompt = `You are a senior recruiter preparing a structured reference check for a candidate.

Candidate: ${candidateName}
Role they're being considered for: ${roleTitle}
Key skills required: ${requiredSkills.slice(0, 6).join(", ")}
Referee relationship to candidate: ${relationship}
Candidate profile excerpt:
${profileExcerpt}

Generate 10 targeted reference check questions. Mix of:
- 3 performance/output questions (concrete results, metrics)
- 2 culture/behaviour questions (team fit, communication style)
- 2 role-specific skill questions (directly tied to the required skills above)
- 2 reliability/professionalism questions (attendance, delivery, attitude)
- 1 closing question (would you rehire / what should we know)

Tailor the questions to the referee relationship (e.g. manager questions differ from peer questions).

Return ONLY a JSON array, no commentary:
[{"question":"...", "category":"performance"}, ...]`;

  const text = await chat(prompt, 0.3, 1200);
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as ReferenceQuestion[];
    return parsed.filter((q) => q.question && q.category).slice(0, 10);
  } catch {
    return [];
  }
}

export async function summariseReferenceCheck(
  candidateName: string,
  roleTitle: string,
  referee: { name: string; title?: string; company?: string; relationship?: string },
  responses: Array<{ question: string; answer: string }>
): Promise<string> {
  const qa = responses
    .filter((r) => r.answer.trim())
    .map((r) => `Q: ${r.question}\nA: ${r.answer}`)
    .join("\n\n");

  const prompt = `You are a senior recruiter writing a reference check summary for a client report.

Candidate: ${candidateName}
Role: ${roleTitle}
Referee: ${referee.name}${referee.title ? `, ${referee.title}` : ""}${referee.company ? ` at ${referee.company}` : ""} (${referee.relationship ?? "referee"})

Reference Q&A:
${qa}

Write a 3–4 sentence professional summary of this reference check suitable for sharing with a hiring manager. Cover:
- Overall assessment of the candidate
- Key strengths highlighted
- Any concerns or caveats raised
- Whether the referee would recommend the candidate

Be direct and specific. No bullet points. Professional tone. Return only the paragraph.`;

  return (await chat(prompt, 0.3, 400)).trim();
}
