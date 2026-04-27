import { prisma } from "./db";
import { randomUUID } from "crypto";

export type UsageType = "search" | "score" | "score_all" | "capture" | "parse";

// Per-org rate limits: max events of that type in the rolling window.
// Override via env vars for flexibility without deploys.
const LIMITS: Record<UsageType, { max: number; windowMs: number }> = {
  search:    { max: Number(process.env.RATE_LIMIT_SEARCH    ?? 30),  windowMs: 60 * 60 * 1000 },  // 30/hr
  score_all: { max: Number(process.env.RATE_LIMIT_SCORE_ALL ?? 20),  windowMs: 60 * 60 * 1000 },  // 20/hr
  score:     { max: Number(process.env.RATE_LIMIT_SCORE     ?? 200), windowMs: 60 * 60 * 1000 },  // 200/hr
  capture:   { max: Number(process.env.RATE_LIMIT_CAPTURE   ?? 100), windowMs: 60 * 60 * 1000 },  // 100/hr
  parse:     { max: Number(process.env.RATE_LIMIT_PARSE     ?? 100), windowMs: 60 * 60 * 1000 },  // 100/hr
};

/**
 * Check if an org is within rate limit for a given usage type.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 * Orgs without an orgId (owner accounts) are never rate-limited.
 */
export async function checkRateLimit(
  orgId: string | null | undefined,
  type: UsageType,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  if (!orgId) return { allowed: true }; // owner is never limited

  const { max, windowMs } = LIMITS[type];
  const since = new Date(Date.now() - windowMs);

  const count = await prisma.usageEvent.count({
    where: { orgId, type, createdAt: { gte: since } },
  });

  if (count < max) return { allowed: true };

  // Find the oldest event in the window to compute retry-after.
  const oldest = await prisma.usageEvent.findFirst({
    where: { orgId, type, createdAt: { gte: since } },
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
