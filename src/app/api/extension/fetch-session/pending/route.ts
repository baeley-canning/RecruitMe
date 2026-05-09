import { EXTENSION_CORS, extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import {
  findSessionInQueue,
  linkedInProfileMatches,
} from "@/lib/linkedin-capture";
import { verifyExtensionAuth } from "@/lib/session";

// EXTENSION_CORS headers are computed per-request to restrict to extension origins

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function GET(req: Request) {
  // AUTH: without this, anyone can probe pending sessions by LinkedIn URL and
  // learn whether a target candidate is being captured by an org. CORS doesn't
  // protect machine-to-machine callers; only Basic auth does.
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const url = new URL(req.url);
  const linkedinUrl = url.searchParams.get("linkedinUrl");

  if (!linkedinUrl) {
    return NextResponse.json({ pending: false }, { status: 400, headers: extensionCorsHeaders(req) });
  }

  // Only return sessions the caller is authorised to see. Owner sees all.
  // For everyone else: must be owned by the user, owned by the same org, OR
  // a fully-anonymous legacy session (no userId AND no orgId) that pre-dates
  // session-tagging. Sessions with an orgId set are NEVER visible cross-org
  // even if userId is absent — that closes the audit's legacy-bypass hole.
  const session = await findSessionInQueue((s) => {
    if (!linkedInProfileMatches(s.linkedinUrl, linkedinUrl)) return false;
    if (
      s.status !== "pending" &&
      s.status !== "processing" &&
      s.status !== "completed" &&
      s.status !== "error"
    ) return false;
    if (auth.isOwner) return true;
    if (s.userId && s.userId === auth.userId) return true;
    if (s.orgId && auth.orgId && s.orgId === auth.orgId) return true;
    if (!s.userId && !s.orgId) return true; // truly legacy/anonymous
    return false;
  });

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
