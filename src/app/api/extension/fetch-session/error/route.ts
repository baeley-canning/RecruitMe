import { extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { z } from "zod";
import { findSessionInQueue, updateSessionInQueue } from "@/lib/linkedin-capture";
import { verifyExtensionAuth } from "@/lib/session";

// EXTENSION_CORS headers are computed per-request to restrict to extension origins

const BodySchema = z.object({
  sessionId: z.string().min(1),
  error: z.string().trim().min(1).max(500),
});

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function POST(req: Request) {
  // AUTH: without this anyone could mark any session errored by guessing a
  // sessionId, blocking a legit capture from ever completing.
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: extensionCorsHeaders(req) });
  }

  const session = await findSessionInQueue((s) => s.sessionId === parsed.data.sessionId);
  if (!session) {
    return NextResponse.json({ error: "No matching capture session" }, { status: 404, headers: extensionCorsHeaders(req) });
  }

  const sameUser = Boolean(session.userId) && session.userId === auth.userId;
  const sameOrg  = Boolean(session.orgId && auth.orgId && session.orgId === auth.orgId);
  const legacy   = !session.userId && !session.orgId;
  if (!auth.isOwner && !sameUser && !sameOrg && !legacy) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: extensionCorsHeaders(req) });
  }

  const error = parsed.data.error.trim();
  const updated = await updateSessionInQueue({
    sessionId: parsed.data.sessionId,
    status: "error",
    message: error,
    error,
  });

  return NextResponse.json(updated ?? { ok: true }, { headers: extensionCorsHeaders(req) });
}
