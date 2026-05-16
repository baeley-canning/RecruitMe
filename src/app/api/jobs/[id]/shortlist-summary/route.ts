import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJson } from "@/lib/ai/chat";
import { chatWithMaybeFailover } from "@/lib/ai/chat-with-failover";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";
import type { ScoreBreakdown } from "@/lib/scoring";
import { getAuth, requireJobAccess, unauthorized } from "@/lib/session";

const CandidateSummaryInputSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  headline: z.string().nullable(),
  location: z.string().nullable(),
  matchScore: z.number().nullable(),
  matchReason: z.string().nullable(),
  scoreBreakdown: z.string().nullable(),
  acceptanceScore: z.number().nullable(),
  acceptanceReason: z.string().nullable(),
  notes: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  profileText: z.string().nullable(),
});

const ShortlistSummaryBodySchema = z.object({
  candidates: z.array(CandidateSummaryInputSchema).min(1, "No candidates provided").max(100),
});

export type CandidateSummaryInput = z.infer<typeof CandidateSummaryInputSchema>;

export interface CandidateSummaryResult {
  id: string;
  name: string;
  paragraph: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const { job, error } = await requireJobAccess(id, auth);
  if (error || !job) return error;

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole ?? null, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Job not yet analysed. Run Step 1 first." }, { status: 400 });
  }

  const parsed = ShortlistSummaryBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { candidates } = parsed.data;

  // Build candidate blurbs for the prompt
  const candidateBlurbs = candidates.map((c, i) => {
    const score    = c.matchScore   != null ? `Match: ${c.matchScore}%` : "Match: unscored";
    const accept   = c.acceptanceScore != null ? `Acceptance likelihood: ${c.acceptanceScore}%` : "";
    const location = c.location ?? "location unknown";
    const headline = c.headline ?? "no headline";
    const notes    = c.notes?.trim() ? `Recruiter notes: ${c.notes.trim()}` : "";
    const profile  = c.profileText ? c.profileText.slice(0, 600) : "";

    const breakdown = safeParseJson<ScoreBreakdown | null>(c.scoreBreakdown, null);
    const legacyMatch = safeParseJson<{ summary?: string; reasoning?: string; strengths?: string[]; gaps?: string[] } | null>(c.matchReason, null);

    let reasonText = "";
    if (breakdown) {
      const parts: string[] = [];
      if (breakdown.recruiter_summary) parts.push(breakdown.recruiter_summary);
      if (breakdown.reasons_for?.length) parts.push(`Strengths: ${breakdown.reasons_for.join(", ")}`);
      if (breakdown.reasons_against?.length) parts.push(`Gaps: ${breakdown.reasons_against.join(", ")}`);
      reasonText = parts.join(" ").trim();
    } else if (legacyMatch) {
      const parts: string[] = [];
      if (legacyMatch.summary) parts.push(legacyMatch.summary);
      if (legacyMatch.reasoning) parts.push(legacyMatch.reasoning);
      if (legacyMatch.strengths?.length) parts.push(`Strengths: ${legacyMatch.strengths.join(", ")}`);
      if (legacyMatch.gaps?.length) parts.push(`Gaps: ${legacyMatch.gaps.join(", ")}`);
      reasonText = parts.join(" ").trim();
    }

    // acceptanceReason is also JSON
    let acceptText = "";
    if (c.acceptanceReason) {
      const ar = safeParseJson<{ headline?: string; summary?: string } | null>(c.acceptanceReason, null);
      acceptText = [ar?.headline, ar?.summary].filter(Boolean).join(" ").trim();
    }

    return `--- CANDIDATE ${i + 1} (id: ${c.id}) ---
Name: ${c.name}
Headline: ${headline}
Location: ${location}
${score}${accept ? `\n${accept}` : ""}
${reasonText ? `Scoring rationale: ${reasonText}` : ""}
${acceptText ? `Acceptance context: ${acceptText}` : ""}
${notes}
${profile}`.trim();
  }).join("\n\n");

  const prompt = `You are a senior recruitment consultant writing a client-ready shortlist report. The hiring manager will read this — be specific, professional, and direct. Never be generic.

Role: ${parsedRole.title}${parsedRole.company ? ` at ${parsedRole.company}` : ""}
Location: ${parsedRole.location}
Required skills: ${parsedRole.skills_required.slice(0, 6).join(", ")}

For each candidate below, write a 2-3 sentence recruiter paragraph suitable for emailing to the hiring manager. Each paragraph must:
- Open with their current role/headline and where they are based
- Name the specific skills or experience that make them relevant to this role
- End with a sentence on their likelihood to move / notable consideration (salary, location, seniority)
- Be written in third person, professional tone, no fluff or sycophancy

Return ONLY a JSON array — one object per candidate, in the same order. No markdown, no explanation.
[{"id":"<id>","name":"<name>","paragraph":"<2-3 sentence paragraph>"}]

CANDIDATES:
${candidateBlurbs}`;

  let summaries: CandidateSummaryResult[] = [];

  try {
    // Allow up to 200 tokens per candidate for the output
    const tokenBudget = Math.min(4096, Math.max(1024, candidates.length * 200));
    const text = await chatWithMaybeFailover(prompt, 0.3, tokenBudget);

    // parseJson handles the brace-balancing + trailing-comma fixup that the
    // greedy `match(/\[[\s\S]*\]/)` previously got wrong when the model
    // emitted prose around the array.
    const parsed = parseJson<unknown>(text);
    if (!Array.isArray(parsed)) throw new Error("Response was not a JSON array");

    summaries = (parsed as CandidateSummaryResult[]).filter(
      (s): s is CandidateSummaryResult =>
        typeof s === "object" && s !== null &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        typeof s.paragraph === "string"
    );
  } catch (err) {
    console.error("Shortlist summary error:", err);
    return NextResponse.json({ error: "AI failed to generate summaries. Try again." }, { status: 500 });
  }

  return NextResponse.json({ summaries });
}
