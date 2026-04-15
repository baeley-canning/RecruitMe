import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateOutreachMessage } from "@/lib/ai";
import type { ParsedRole } from "@/lib/ai";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  const { id, candidateId } = await params;

  const [job, candidate] = await Promise.all([
    prisma.job.findUnique({ where: { id } }),
    prisma.candidate.findUnique({ where: { id: candidateId } }),
  ]);

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
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
    const parsedRole = JSON.parse(job.parsedRole) as ParsedRole;
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
