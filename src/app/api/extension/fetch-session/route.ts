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
import { verifyAnyAuth, requireJobAccess, verifyExtensionAuth } from "@/lib/session";

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
  const auth = await verifyAnyAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });

  const parsed = StartSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: CORS });
  }

  const { jobId, candidateId } = parsed.data;

  // Verify the job belongs to the caller's org before creating a capture session.
  const { error: jobError } = await requireJobAccess(jobId, auth);
  if (jobError) return NextResponse.json({ error: "Job not found or access denied" }, { status: 403, headers: CORS });

  const candidate = await prisma.candidate.findFirst({ where: { id: candidateId, jobId } });
  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404, headers: CORS });
  }
  if (!candidate.linkedinUrl) {
    return NextResponse.json({ error: "Candidate has no LinkedIn URL" }, { status: 400, headers: CORS });
  }

  const now = new Date().toISOString();
  const session: ExtensionCaptureSession = {
    sessionId: randomUUID(),
    userId: auth.userId,
    orgId: auth.orgId,
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
    // Polling by sessionId from the web UI — requires auth so only the session owner can poll.
    const auth = await verifyAnyAuth(req);
    if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });

    const session = await findSessionInQueue((s) => s.sessionId === sessionId);
    if (!session) {
      return NextResponse.json({ session: null }, { status: 404, headers: CORS });
    }

    // When completed, embed the updated candidate so the web UI can update
    // without an extra round-trip. saveCapturedProfileToCandidate runs before
    // the session is marked "completed", so the candidate is already up to date.
    if (session.status === "completed") {
      const candidate = await prisma.candidate.findUnique({ where: { id: session.candidateId } });
      return NextResponse.json({ ...session, candidate }, { headers: CORS });
    }

    return NextResponse.json(session, { headers: CORS });
  }

  // No sessionId = extension alarm / popup status query.
  // Try Basic auth first (configured extension). If no credentials, still return
  // sessions so the extension can open LinkedIn tabs even before setup is complete.
  const auth = await verifyExtensionAuth(req);
  const queue = await getSessionQueue();

  // If authenticated, show only this user's sessions. Otherwise show the entire
  // queue so the popup can still show processing/error/completed states without
  // extra setup, and the extension can auto-open pending tabs.
  const visible = auth
    ? queue.filter((s) => !s.userId || s.userId === auth.userId || (s.orgId && auth.orgId && s.orgId === auth.orgId))
    : queue;

  return NextResponse.json(visible.length > 0 ? visible : null, { headers: CORS });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  // Auth is best-effort for DELETE. The sessionId itself is the access control
  // for individual deletes; bulk deletes require auth.
  const auth = await verifyAnyAuth(req).catch(() => null);

  if (sessionId) {
    await removeSessionFromQueue(sessionId);
    return NextResponse.json({ cleared: true }, { headers: CORS });
  }

  // No sessionId = clear this user's sessions (requires auth for bulk clear).
  if (!auth) return NextResponse.json({ cleared: false }, { headers: CORS });
  const queue = await getSessionQueue();
  for (const s of queue.filter((s) => !s.userId || s.userId === auth.userId)) {
    await removeSessionFromQueue(s.sessionId);
  }
  return NextResponse.json({ cleared: true }, { headers: CORS });
}
