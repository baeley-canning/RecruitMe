import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findSessionInQueue,
  normaliseLinkedInUrl,
  saveCapturedProfileToCandidate,
  updateSessionInQueue,
} from "@/lib/linkedin-capture";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const BodySchema = z.object({
  sessionId: z.string().min(1),
  linkedinUrl: z.string().url().max(500),
  profileText: z.string().min(100).max(100_000),
});

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function processCaptureCompletion(args: {
  sessionId: string;
  session: NonNullable<Awaited<ReturnType<typeof findSessionInQueue>>>;
  linkedinUrl: string;
  profileText: string;
}) {
  const { sessionId, session, linkedinUrl, profileText } = args;

  try {
    await saveCapturedProfileToCandidate({
      jobId: session.jobId,
      candidateId: session.candidateId,
      linkedinUrl,
      profileText,
    });

    await updateSessionInQueue({
      sessionId,
      status: "completed",
      message: "Profile captured and scored",
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save captured profile";
    await updateSessionInQueue({
      sessionId,
      status: "error",
      message,
      error: message,
    });
  }
}

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: CORS });
  }

  const { sessionId, linkedinUrl, profileText } = parsed.data;
  const session = await findSessionInQueue((s) => s.sessionId === sessionId);

  if (!session) {
    return NextResponse.json({ error: "No matching capture session" }, { status: 404, headers: CORS });
  }

  if (normaliseLinkedInUrl(session.linkedinUrl) !== normaliseLinkedInUrl(linkedinUrl)) {
    await updateSessionInQueue({
      sessionId,
      status: "error",
      message: "Captured profile URL did not match the pending candidate",
      error: "linkedin_url_mismatch",
    });
    return NextResponse.json({ error: "LinkedIn URL mismatch" }, { status: 409, headers: CORS });
  }

  await updateSessionInQueue({
    sessionId,
    status: "processing",
    message: "Profile received - scoring with AI",
  });

  void processCaptureCompletion({ sessionId, session, linkedinUrl, profileText });

  return NextResponse.json(
    {
      accepted: true,
      sessionId,
      status: "processing",
      message: "Profile received - scoring with AI",
    },
    { status: 202, headers: CORS }
  );
}
