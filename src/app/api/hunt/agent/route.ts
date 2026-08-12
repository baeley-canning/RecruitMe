/**
 * Agent turn proxy for the browser companion.
 *
 * The extension runs the loop and performs the tools; this endpoint is the only
 * thing that talks to the model. That split exists for one reason: the API key.
 * The extension is installed on customer machines and anyone can read its
 * source, so a key shipped inside it is a key given away. Here it stays in
 * Railway's environment, behind org auth, rate limiting and the spend cap.
 *
 * See src/lib/ai/agent.ts for the prompt-injection rules that constrain which
 * tools may exist at all.
 */
import { extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth } from "@/lib/session";
import { checkRateLimit, checkSpendCap, recordUsage } from "@/lib/usage";
import { reportError } from "@/lib/error-reporting";
import { agentStep, type AgentMessage } from "@/lib/ai/agent";

export const maxDuration = 120;

const MessageSchema = z.union([
  z.object({ role: z.literal("user"), content: z.string().max(60_000) }),
  z.object({ role: z.literal("assistant"), content: z.string().max(60_000) }),
  z.object({
    role: z.literal("assistant_tool_use"),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(80),
    input: z.record(z.unknown()).default({}),
  }),
  z.object({
    role: z.literal("tool_result"),
    tool_use_id: z.string().min(1).max(200),
    content: z.string().max(60_000),
  }),
]);

const BodySchema = z.object({
  jobId: z.string().min(1).optional(),
  // The whole conversation so far. Capped: a runaway loop should hit this wall
  // rather than quietly costing more each turn.
  messages: z.array(MessageSchema).min(1).max(80),
});

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function POST(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: extensionCorsHeaders(req) });
  }

  // Org isolation: if a job is named, it must belong to the caller.
  if (parsed.data.jobId) {
    const job = await prisma.job.findUnique({ where: { id: parsed.data.jobId }, select: { orgId: true } });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404, headers: extensionCorsHeaders(req) });
    }
    if (!auth.isOwner && job.orgId !== auth.orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: extensionCorsHeaders(req) });
    }
  }

  // Every turn is a model call, so it draws on the same per-org score budget.
  const limit = await checkRateLimit(auth.orgId, "score");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit reached", retryAfterMs: limit.retryAfterMs },
      { status: 429, headers: extensionCorsHeaders(req) },
    );
  }

  // The daily spend ceiling applies here exactly as it does to scoring — an
  // agent loop is the easiest way to spend real money by accident.
  const cap = await checkSpendCap(auth.orgId).catch(() => null);
  if (cap && !cap.allowed) {
    return NextResponse.json(
      {
        error:
          `Daily AI spend cap reached ($${cap.spentUsd.toFixed(2)} of $${cap.capUsd.toFixed(2)}). ` +
          `The hunt is paused until it resets.`,
      },
      { status: 402, headers: extensionCorsHeaders(req) },
    );
  }

  try {
    const step = await agentStep({
      messages: parsed.data.messages as AgentMessage[],
      orgId: auth.orgId,
      userId: auth.userId,
    });
    return NextResponse.json({ step }, { headers: extensionCorsHeaders(req) });
  } catch (err) {
    reportError(err, { route: "hunt/agent", orgId: auth.orgId ?? undefined });
    try {
      await recordUsage(auth.orgId, auth.userId, "ai_error", { costTag: "hunt-agent" });
    } catch {
      /* attribution must not mask the real error */
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The agent call failed." },
      { status: 502, headers: extensionCorsHeaders(req) },
    );
  }
}
