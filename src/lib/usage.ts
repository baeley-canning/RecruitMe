import { prisma } from "./db";
import { randomUUID } from "crypto";
import { computeCostUsd } from "./ai-pricing";

/** Event types that go through the count-based rate limiter. */
export type RateLimitedType = "search" | "score" | "score_all" | "capture" | "parse";
/** All event types persisted in UsageEvent. "ai_call" is cost-tracked
 *  separately by checkSpendCap and is NOT count-rate-limited. */
export type UsageType = RateLimitedType | "ai_call";

/** Default daily AI spend ceiling per org. Override via env var.
 *  The recent $10-rescore-burn motivated this — a cap that's high enough
 *  for a normal recruiter's day but low enough that a runaway loop or
 *  model mis-config burns the cap, not the credit card. */
const DEFAULT_DAILY_SPEND_CAP_USD = Number(process.env.AI_DAILY_SPEND_CAP_USD ?? 5);

// Per-org rate limits: max events of that type in the rolling window.
// Override via env vars for flexibility without deploys.
const LIMITS: Record<RateLimitedType, { max: number; windowMs: number }> = {
  search:    { max: Number(process.env.RATE_LIMIT_SEARCH    ?? 30),  windowMs: 60 * 60 * 1000 },  // 30/hr
  score_all: { max: Number(process.env.RATE_LIMIT_SCORE_ALL ?? 20),  windowMs: 60 * 60 * 1000 },  // 20/hr
  score:     { max: Number(process.env.RATE_LIMIT_SCORE     ?? 200), windowMs: 60 * 60 * 1000 },  // 200/hr
  capture:   { max: Number(process.env.RATE_LIMIT_CAPTURE   ?? 100), windowMs: 60 * 60 * 1000 },  // 100/hr
  parse:     { max: Number(process.env.RATE_LIMIT_PARSE     ?? 100), windowMs: 60 * 60 * 1000 },  // 100/hr
};

/**
 * Check if an org is within rate limit for a given usage type.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 * Owner accounts (orgId null) get 5× the normal limit so they can operate freely
 * but a runaway script or compromised account still can't exhaust API quotas.
 */
export async function checkRateLimit(
  orgId: string | null | undefined,
  type: RateLimitedType,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const ownerMultiplier = orgId ? 1 : 5;

  const { max, windowMs } = LIMITS[type];
  const effectiveMax = max * ownerMultiplier;
  const since = new Date(Date.now() - windowMs);

  const count = await prisma.usageEvent.count({
    where: { orgId: orgId ?? null, type, createdAt: { gte: since } },
  });

  if (count < effectiveMax) return { allowed: true };

  // Find the oldest event in the window to compute retry-after.
  const oldest = await prisma.usageEvent.findFirst({
    where: { orgId: orgId ?? null, type, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });
  const retryAfterMs = oldest
    ? windowMs - (Date.now() - oldest.createdAt.getTime())
    : windowMs;

  return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
}

/**
 * Record a usage event. Call this after the action succeeds.
 */
export async function recordUsage(
  orgId: string | null | undefined,
  userId: string | undefined,
  type: UsageType,
  meta?: Record<string, unknown>,
): Promise<void> {
  await prisma.usageEvent.create({
    data: {
      id:     randomUUID(),
      orgId:  orgId ?? null,
      userId: userId ?? null,
      type,
      meta:   meta ? JSON.stringify(meta) : null,
    },
  }).catch((err) => {
    // Non-fatal — never block the happy path for logging failures.
    console.error("[usage] failed to record event:", err);
  });
}

/**
 * Record an AI call's cost. Called by chat.ts after each successful
 * Anthropic / OpenAI call. Fire-and-forget — never blocks the response.
 *
 * Cost is null when the model isn't in the pricing table; the event is
 * still recorded so the call is countable, but `checkSpendCap` won't
 * factor it in (which is the safe direction — we under-count rather than
 * blocking on a stale price).
 */
export async function recordAiCall(args: {
  orgId: string | null | undefined;
  userId: string | null | undefined;
  model: string;
  inputTokens: number;
  outputTokens: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const costUsd = computeCostUsd(args.model, args.inputTokens, args.outputTokens);
  await prisma.usageEvent.create({
    data: {
      id:           randomUUID(),
      orgId:        args.orgId  ?? null,
      userId:       args.userId ?? null,
      type:         "ai_call",
      meta:         JSON.stringify({ model: args.model, ...(args.meta ?? {}) }),
      inputTokens:  args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd:      costUsd ?? undefined,
    },
  }).catch((err) => {
    console.error("[usage] failed to record ai_call:", err);
  });
}

/**
 * Sum AI spend (USD) for an org over the trailing 24h window and compare
 * against the daily cap. Owner accounts (orgId null) get the same cap —
 * we are not interested in special-casing the human admin path here; the
 * goal is "no single tenant burns more than $X/day on AI."
 */
export async function checkSpendCap(
  orgId: string | null | undefined,
  capUsd: number = DEFAULT_DAILY_SPEND_CAP_USD,
): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const agg = await prisma.usageEvent.aggregate({
    where: { orgId: orgId ?? null, type: "ai_call", createdAt: { gte: since } },
    _sum: { costUsd: true },
  });
  const spentUsd = agg._sum.costUsd ?? 0;
  return { allowed: spentUsd < capUsd, spentUsd, capUsd };
}
