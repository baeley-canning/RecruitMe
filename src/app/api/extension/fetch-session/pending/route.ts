import { EXTENSION_CORS, extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import {
  findSessionInQueue,
  linkedInProfileMatches,
} from "@/lib/linkedin-capture";

// EXTENSION_CORS headers are computed per-request to restrict to extension origins

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const linkedinUrl = url.searchParams.get("linkedinUrl");

  if (!linkedinUrl) {
    return NextResponse.json({ pending: false }, { status: 400, headers: extensionCorsHeaders(req) });
  }

  const session = await findSessionInQueue(
    (s) =>
      linkedInProfileMatches(s.linkedinUrl, linkedinUrl) &&
      (s.status === "pending" ||
        s.status === "processing" ||
        s.status === "completed" ||
        s.status === "error")
  );

  if (!session) {
    return NextResponse.json({ pending: false, active: false, status: "idle" }, { headers: EXTENSION_CORS });
  }

  return NextResponse.json(
    {
      pending: session.status === "pending",
      active: true,
      status: session.status,
      sessionId: session.sessionId,
      candidateName: session.candidateName,
      linkedinUrl: session.linkedinUrl,
      message: session.message,
      error: session.error,
    },
    { headers: EXTENSION_CORS }
  );
}
