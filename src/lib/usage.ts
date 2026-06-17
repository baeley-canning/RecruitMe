import { prisma } from "./db";
import { randomUUID } from "crypto";
import { computeCostUsd } from "./ai-pricing";
import { reportError } from "./error-reporting";

/** Event types that go through the count-based rate limiter. */
export type RateLimitedType = "search" | "score" | "score_all" | "capture" | "parse" | "insight_extract";
/** All event types persisted in UsageEvent. "ai_call" is cost-tracked
 *  separately by checkSpendCap and is NOT count-rate-limited. "ai_error"
 *  records a FAILED AI call (credit-exhausted, rate-limited, crash) so the
 *  admin can see who hit a wall and when. */
export type UsageType = RateLimitedType | "ai_call" | "ai_error";

/** Coarse reason an AI call failed — derived from the provider error so the
 *  activity log can say *why* (e.g. "out of credit") not just "failed". */
export type AiFailureReason =
  | "insufficient_credit"
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "timeout"
  | "other";

/**
 * Classify a thrown AI-provider error into a coarse, human-meaningful reason.
 * Anthropic/OpenAI SDK errors carry an HTTP `status`; we also sniff the message
 * for the credit-vs-rate distinction (both are 429). Defensive against any
 * shape — unknown errors fall through to "other".
 */
export function classifyAiFailure(err: unknown): AiFailureReason {
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
  const name = (err as { name?: unknown })?.name;
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();

  if (status === 429 || /\b429\b|too many requests|rate limit/.test(msg)) {
    // 429 covers BOTH billing-exhaustion and request-rate throttling — split by message.
    if (/credit|billing|quota|insufficient|balance|payment|plan/.test(msg)) return "insufficient_credit";
    return "rate_limit";
  }
  if (status === 402 || /credit|billing|quota|insufficient|balance|payment/.test(msg)) return "insufficient_credit";
  if (status === 529 || /overloaded/.test(msg)) return "overloaded";
  if (status === 401 || status === 403 || /api key|x-api-key|unauthor|forbidden|authentication/.test(msg)) return "auth";
  if (name === "APIConnectionTimeoutError" || /timeout|timed out|etimedout|econnreset|aborted|socket hang up/.test(msg)) return "timeout";
  return "other";
}

/** Default daily AI spend ceiling per org. Override via env var.
 *  The recent $10-rescore-burn motivated this — a cap that's high enough
 *  for a normal recruiter's day but low enough that a runaway loop or
 *  model mis-config burns the cap, not the credit card. */
const DEFAULT_DAILY_SPEND_CAP_USD = Number(process.env.AI_DAILY_SPEND_CAP_USD ?? 5);

// Per-org rate limits: max events of that type in the rolling window.
// Override via env vars for flexibility without deploys.
const LIMITS: Record<RateLimitedType, { max: number; windowMs: number }> = {
  search:           { max: Number(process.env.RATE_LIMIT_SEARCH    ?? 30),  windowMs: 60 * 60 * 1000 },  // 30/hr
  score_all:        { max: Number(process.env.RATE_LIMIT_SCORE_ALL ?? 20),  windowMs: 60 * 60 * 1000 },  // 20/hr
  score:            { max: Number(process.env.RATE_LIMIT_SCORE     ?? 200), windowMs: 60 * 60 * 1000 },  // 200/hr
  capture:          { max: Number(process.env.RATE_LIMIT_CAPTURE   ?? 100), windowMs: 60 * 60 * 1000 },  // 100/hr
  parse:            { max: Number(process.env.RATE_LIMIT_PARSE     ?? 100), windowMs: 60 * 60 * 1000 },  // 100/hr
  // ProfileInsight extraction back-pressure. Critic B §6 flagged that a
  // degenerate JobAdder sync that flips one whitespace char per nightly
  // re-import would otherwise re-extract the entire 13.5k library every
  // day. Window is 24h (not hourly) — extractions cluster around backfill
  // sweeps and library pulls, not steady-state traffic. Default 200/day
  // per org.
  insight_extract:  { max: Number(process.env.RATE_LIMIT_INSIGHT_EXTRACT ?? 200), windowMs: 24 * 60 * 60 * 1000 },
};

// Secondary, shorter-window ceilings layered on top of LIMITS for types
// where a burst is worse than a sustained rate. Critic B §6: 200 insight
// extractions spread across a day is fine; 200 in five minutes (a
// degenerate re-sync repeating nightly) is a cost-shape problem.
// When a type appears here, checkRateLimit consults BOTH windows and
// requires both to be under their respective ceilings.
const BURST_LIMITS: Partial<Record<RateLimitedType, { max: number; windowMs: number }>> = {
  insight_extract: { max: Number(process.env.RATE_LIMIT_INSIGHT_EXTRACT_HOUR ?? 30), windowMs: 60 * 60 * 1000 },  // 30/hr
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

  // Build the list of windows to enforce. The primary (daily/hourly per
  // LIMITS) always applies; BURST_LIMITS layers a shorter ceiling for
  // types that need burst protection.
  const windows: { max: number; windowMs: number }[] = [LIMITS[type]];
  const burst = BURST_LIMITS[type];
  if (burst) windows.push(burst);

  let worstRetryAfterMs = 0;
  let breached = false;

  for (const { max, windowMs } of windows) {
    const effectiveMax = max * ownerMultiplier;
    const since = new Date(Date.now() - windowMs);

    const count = await prisma.usageEvent.count({
      where: { orgId: orgId ?? null, type, createdAt: { gte: since } },
    });

    if (count < effectiveMax) continue;

    breached = true;
    // Find the oldest event in this window to compute retry-after.
    const oldest = await prisma.usageEvent.findFirst({
      where: { orgId: orgId ?? null, type, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
    });
    const retryAfterMs = oldest
      ? windowMs - (Date.now() - oldest.createdAt.getTime())
      : windowMs;
    if (retryAfterMs > worstRetryAfterMs) worstRetryAfterMs = retryAfterMs;
  }

  if (!breached) return { allowed: true };
  return { allowed: false, retryAfterMs: Math.max(0, worstRetryAfterMs) };
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
    reportError(err, { fn: "recordUsage", type, orgId: orgId ?? null, userId });
  });
}

/**
 * Record an AI call's cost. Called by chat.ts after each successful
 * Anthropic / Ollama call. Fire-and-forget — never blocks the response.
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
    reportError(err, { fn: "recordAiCall", model: args.model, orgId: args.orgId ?? null, userId: args.userId ?? undefined });
  });
}

/**
 * Record a FAILED AI call so the admin activity log can show who hit a wall and
 * when (the headline case: "out of credit"). Called from chat.ts's catch BEFORE
 * the error re-throws. Fire-and-forget — must never mask the original failure.
 * userId is whatever the caller passed (present for parse/search/acceptance/
 * capture; null for the frozen scoring path — the reason+time are still
 * captured and correlate to the triggering user via the action log).
 */
export async function recordAiError(args: {
  orgId: string | null | undefined;
  userId: string | null | undefined;
  model: string;
  reason: AiFailureReason;
  tag?: string;
  message?: string;
}): Promise<void> {
  await prisma.usageEvent.create({
    data: {
      id:     randomUUID(),
      orgId:  args.orgId  ?? null,
      userId: args.userId ?? null,
      type:   "ai_error",
      meta:   JSON.stringify({
        model:   args.model,
        reason:  args.reason,
        ...(args.tag ? { tag: args.tag } : {}),
        // Truncate — the message can be a long provider blob; the reason is the signal.
        ...(args.message ? { message: args.message.slice(0, 300) } : {}),
      }),
    },
  }).catch((err) => {
    reportError(err, { fn: "recordAiError", model: args.model, reason: args.reason, orgId: args.orgId ?? null });
  });
}

/**
 * Sum AI spend (USD) for an org over the trailing 24h window and compare
 * against the daily cap. Owner accounts (orgId null) get a 5× multiplier
 * on the effective cap — same reasoning as checkRateLimit's ownerMultiplier:
 * the admin path needs headroom for bulk ops (e.g. score-all on a
 * 50-candidate job repeatedly during the day) that user orgs rarely run.
 * The returned `capUsd` reflects the EFFECTIVE cap so UI ("you've spent
 * $X of $Y") shows the cap the caller is actually being measured against.
 */
export async function checkSpendCap(
  orgId: string | null | undefined,
  capUsd: number = DEFAULT_DAILY_SPEND_CAP_USD,
): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
  const ownerMultiplier = orgId ? 1 : 5;
  const effectiveCapUsd = capUsd * ownerMultiplier;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const agg = await prisma.usageEvent.aggregate({
    where: { orgId: orgId ?? null, type: "ai_call", createdAt: { gte: since } },
    _sum: { costUsd: true },
  });
  const spentUsd = agg._sum.costUsd ?? 0;
  return { allowed: spentUsd < effectiveCapUsd, spentUsd, capUsd: effectiveCapUsd };
}
