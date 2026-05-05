import { NextResponse } from "next/server";
import { generateOutreachMessage } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";
import { safeParseJson } from "@/lib/utils";
import { getAuth, requireCandidateAccess, unauthorized } from "@/lib/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id, candidateId } = await params;
  const { job, candidate, error } = await requireCandidateAccess(id, candidateId, auth);
  if (error || !job || !candidate) return error;
  if (!job.parsedRole) {
    return NextResponse.json(
      { error: "Parse the job description first." },
      { status: 400 }
    );
  }
  if (!candidate.profileText) {
    return NextResponse.json(
      { error: "Candidate has no profile text to generate a message from." },
      { status: 400 }
    );
  }

  try {
    const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    if (!parsedRole) {
      return NextResponse.json({ error: "Job parse data is invalid. Parse the job description again." }, { status: 400 });
    }
    const message = await generateOutreachMessage(
      candidate.profileText,
      parsedRole,
      candidate.name
    );
    return NextResponse.json(message);
  } catch (err) {
    console.error("Outreach generation error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Generation failed" },
      { status: 500 }
    );
  }
}
