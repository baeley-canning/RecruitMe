import { NextResponse } from "next/server";
import {
  findSessionInQueue,
  linkedInProfileMatches,
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

  const session = await findSessionInQueue(
    (s) =>
      linkedInProfileMatches(s.linkedinUrl, linkedinUrl) &&
      (s.status === "pending" ||
        s.status === "processing" ||
        s.status === "completed" ||
        s.status === "error")
  );

  if (!session) {
    return NextResponse.json({ pending: false, active: false, status: "idle" }, { headers: CORS });
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
    { headers: CORS }
  );
}
