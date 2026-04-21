import { NextResponse } from "next/server";
import { z } from "zod";
import { findSessionInQueue, updateSessionInQueue } from "@/lib/linkedin-capture";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const BodySchema = z.object({
  sessionId: z.string().min(1),
  error: z.string().trim().min(1).max(500),
});

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: CORS });
  }

  const session = await findSessionInQueue((s) => s.sessionId === parsed.data.sessionId);
  if (!session) {
    return NextResponse.json({ error: "No matching capture session" }, { status: 404, headers: CORS });
  }

  const error = parsed.data.error.trim();
  const updated = await updateSessionInQueue({
    sessionId: parsed.data.sessionId,
    status: "error",
    message: error,
    error,
  });

  return NextResponse.json(updated ?? { ok: true }, { headers: CORS });
}
