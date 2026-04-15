import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { chat } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";

export interface CandidateSummaryInput {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  matchScore: number | null;
  matchReason: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  notes: string | null;
  linkedinUrl: string | null;
  profileText: string | null;
}

export interface CandidateSummaryResult {
  id: string;
  name: string;
  paragraph: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole ?? null, null);
  if (!parsedRole) {
    return NextResponse.json({ error: "Job not yet analysed. Run Step 1 first." }, { status: 400 });
  }

  const body = await req.json() as { candidates?: CandidateSummaryInput[] };
  const candidates = body.candidates;

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ error: "No candidates provided" }, { status: 400 });
  }

  // Build candidate blurbs for the prompt
  const candidateBlurbs = candidates.map((c, i) => {
    const score    = c.matchScore   != null ? `Match: ${c.matchScore}%` : "Match: unscored";
    const accept   = c.acceptanceScore != null ? `Acceptance likelihood: ${c.acceptanceScore}%` : "";
    const location = c.location ?? "location unknown";
    const headline = c.headline ?? "no headline";
    const notes    = c.notes?.trim() ? `Recruiter notes: ${c.notes.trim()}` : "";
    const profile  = c.profileText ? c.profileText.slice(0, 600) : "";

    // matchReason is stored as JSON — extract human-readable fields
    let reasonText = "";
    if (c.matchReason) {
      try {
        const mr = JSON.parse(c.matchReason) as { summary?: string; reasoning?: string; strengths?: string[]; gaps?: string[] };
        const parts: string[] = [];
        if (mr.summary)    parts.push(mr.summary);
        if (mr.reasoning)  parts.push(mr.reasoning);
        if (mr.strengths?.length) parts.push(`Strengths: ${mr.strengths.join(", ")}`);
        if (mr.gaps?.length)      parts.push(`Gaps: ${mr.gaps.join(", ")}`);
        reasonText = parts.join(" ").trim();
      } catch { reasonText = ""; }
    }

    // acceptanceReason is also JSON
    let acceptText = "";
    if (c.acceptanceReason) {
      try {
        const ar = JSON.parse(c.acceptanceReason) as { headline?: string; summary?: string };
        acceptText = [ar.headline, ar.summary].filter(Boolean).join(" ").trim();
      } catch { acceptText = ""; }
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
    const text = await chat(prompt, 0.3, tokenBudget);

    // Extract JSON array
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");

    const parsed = JSON.parse(match[0]) as CandidateSummaryResult[];
    summaries = parsed.filter(
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
