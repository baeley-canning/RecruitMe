import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  addSessionToQueue,
  findSessionInQueue,
  getSessionQueue,
  normaliseLinkedInUrl,
  removeSessionFromQueue,
  type ExtensionCaptureSession,
} from "@/lib/linkedin-capture";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const StartSchema = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
});

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const parsed = StartSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: CORS });
  }

  const { jobId, candidateId } = parsed.data;
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });

  if (!candidate || candidate.jobId !== jobId) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404, headers: CORS });
  }
  if (!candidate.linkedinUrl) {
    return NextResponse.json({ error: "Candidate has no LinkedIn URL" }, { status: 400, headers: CORS });
  }

  const now = new Date().toISOString();
  const session: ExtensionCaptureSession = {
    sessionId: randomUUID(),
    jobId,
    candidateId,
    candidateName: candidate.name,
    linkedinUrl: normaliseLinkedInUrl(candidate.linkedinUrl),
    status: "pending",
    message: "Waiting for browser extension to capture the profile",
    createdAt: now,
    updatedAt: now,
  };

  await addSessionToQueue(session);

  return NextResponse.json(session, { headers: CORS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  if (sessionId) {
    // Polling by sessionId: 404 signals the session has expired or been cleared.
    const session = await findSessionInQueue((s) => s.sessionId === sessionId);
    if (!session) {
      return NextResponse.json({ session: null }, { status: 404, headers: CORS });
    }
    return NextResponse.json(session, { headers: CORS });
  }

  // No sessionId = popup / status query; return all sessions (or null if empty).
  const queue = await getSessionQueue();
  return NextResponse.json(queue.length > 0 ? queue : null, { headers: CORS });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  if (sessionId) {
    const session = await findSessionInQueue((s) => s.sessionId === sessionId);
    if (!session) {
      return NextResponse.json({ cleared: false }, { headers: CORS });
    }
    await removeSessionFromQueue(sessionId);
    return NextResponse.json({ cleared: true }, { headers: CORS });
  }

  // No sessionId = clear entire queue.
  const queue = await getSessionQueue();
  for (const s of queue) {
    await removeSessionFromQueue(s.sessionId);
  }
  return NextResponse.json({ cleared: true }, { headers: CORS });
}
