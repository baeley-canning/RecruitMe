import { randomUUID } from "crypto";
import { EXTENSION_CORS, extensionCorsHeaders } from "@/lib/extension-cors";
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

// EXTENSION_CORS headers are computed per-request to restrict to extension origins

const StartSchema = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
});

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function POST(req: Request) {
  const auth = await verifyAnyAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });

  const parsed = StartSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: extensionCorsHeaders(req) });
  }

  const { jobId, candidateId } = parsed.data;

  // Verify the job belongs to the caller's org before creating a capture session.
  const { error: jobError } = await requireJobAccess(jobId, auth);
  if (jobError) return NextResponse.json({ error: "Job not found or access denied" }, { status: 403, headers: extensionCorsHeaders(req) });

  const candidate = await prisma.candidate.findFirst({ where: { id: candidateId, jobId } });
  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404, headers: extensionCorsHeaders(req) });
  }
  if (!candidate.linkedinUrl) {
    return NextResponse.json({ error: "Candidate has no LinkedIn URL" }, { status: 400, headers: extensionCorsHeaders(req) });
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

  return NextResponse.json(session, { headers: EXTENSION_CORS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  if (sessionId) {
    const session = await findSessionInQueue((s) => s.sessionId === sessionId);
    if (!session) {
      return NextResponse.json({ session: null }, { status: 404, headers: extensionCorsHeaders(req) });
    }

    // The web UI polls by an unguessable UUID it just created. Allow that token
    // to keep working even if the browser drops auth cookies while LinkedIn is
    // open; if auth is present, still enforce ownership/org visibility.
    const auth = await verifyAnyAuth(req).catch(() => null);
    if (auth) {
      const sameUser = !session.userId || session.userId === auth.userId;
      const sameOrg = Boolean(session.orgId && auth.orgId && session.orgId === auth.orgId);
      if (!auth.isOwner && !sameUser && !sameOrg) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: extensionCorsHeaders(req) });
      }
    }

    // When completed, embed the updated candidate so the web UI can update
    // without an extra round-trip. saveCapturedProfileToCandidate runs before
    // the session is marked "completed", so the candidate is already up to date.
    if (session.status === "completed") {
      const candidate = await prisma.candidate.findUnique({ where: { id: session.candidateId } });
      return NextResponse.json({ ...session, candidate }, { headers: EXTENSION_CORS });
    }

    return NextResponse.json(session, { headers: EXTENSION_CORS });
  }

  // No sessionId = extension alarm / popup status query.
  // Require Basic auth — returning all sessions to unauthenticated callers leaks
  // session metadata (candidateName, linkedinUrl, status) across all orgs.
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    // Return null rather than 401 so the popup shows "not configured" gracefully
    // rather than an error banner. The extension should prompt for credentials.
    return NextResponse.json(null, { headers: EXTENSION_CORS });
  }

  const queue = await getSessionQueue();
  const visible = queue.filter(
    (s) => !s.userId || s.userId === auth.userId || (s.orgId && auth.orgId && s.orgId === auth.orgId)
  );
  return NextResponse.json(visible.length > 0 ? visible : null, { headers: EXTENSION_CORS });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  // Always require auth — sessionId is a UUID but is not a secret; allowing
  // unauthenticated deletion would let anyone cancel captures by guessing IDs.
  const auth = await verifyAnyAuth(req).catch(() => null);
  if (!auth) return NextResponse.json({ cleared: false }, { headers: EXTENSION_CORS });

  if (sessionId) {
    // Verify the session belongs to this user / org before deleting.
    const session = await findSessionInQueue((s) => s.sessionId === sessionId);
    if (session) {
      const sameUser = !session.userId || session.userId === auth.userId;
      const sameOrg  = Boolean(session.orgId && auth.orgId && session.orgId === auth.orgId);
      if (!auth.isOwner && !sameUser && !sameOrg) {
        return NextResponse.json({ cleared: false }, { headers: EXTENSION_CORS });
      }
    }
    await removeSessionFromQueue(sessionId);
    return NextResponse.json({ cleared: true }, { headers: EXTENSION_CORS });
  }

  // No sessionId = clear this user's sessions only.
  const queue = await getSessionQueue();
  for (const s of queue.filter((s) => !s.userId || s.userId === auth.userId || (s.orgId && auth.orgId && s.orgId === auth.orgId))) {
    await removeSessionFromQueue(s.sessionId);
  }
  return NextResponse.json({ cleared: true }, { headers: EXTENSION_CORS });
}
