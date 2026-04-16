import { NextResponse } from "next/server";
import {
  findSessionInQueue,
  normaliseLinkedInUrl,
} from "@/lib/linkedin-capture";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const linkedinUrl = url.searchParams.get("linkedinUrl");

  if (!linkedinUrl) {
    return NextResponse.json({ pending: false }, { status: 400, headers: CORS });
  }

  const normUrl = normaliseLinkedInUrl(linkedinUrl);
  const session = await findSessionInQueue(
    (s) => s.status === "pending" && normaliseLinkedInUrl(s.linkedinUrl) === normUrl
  );

  if (!session) {
    return NextResponse.json({ pending: false, status: "idle" }, { headers: CORS });
  }

  return NextResponse.json(
    {
      pending: true,
      status: session.status,
      sessionId: session.sessionId,
      candidateName: session.candidateName,
      linkedinUrl: session.linkedinUrl,
      message: session.message,
      error: session.error,
    },
    { headers: CORS }
  );
}
