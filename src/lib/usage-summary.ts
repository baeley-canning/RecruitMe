/**
 * Per-org usage & cost summary — the read side of billing.
 *
 * Reads the existing UsageEvent ledger (recordAiCall stamps costUsd on
 * type="ai_call"). This is what the /settings/usage page shows a recruiter and
 * what a future Stripe metered-billing sync will report as usage records — no
 * new tracking, just aggregation over what's already captured per org.
 *
 * Everything is org-scoped: every query filters by the caller's orgId.
 */

import { prisma } from "./db";

export interface UsageDayPoint {
  /** UTC date "YYYY-MM-DD". */
  date: string;
  costUsd: number;
  aiCalls: number;
}

export interface UsageByType {
  type: string;
  count: number;
  costUsd: number;
}

export interface OrgUsageSummary {
  orgId: string;
  windowDays: number;
  /** Total AI spend + call count over the window. */
  totalCostUsd: number;
  totalAiCalls: number;
  /** Spend + calls in the last rolling 24h (matches the daily spend cap window). */
  last24hCostUsd: number;
  last24hAiCalls: number;
  /** The org's effective daily spend cap (USD) — what checkSpendCap enforces. */
  dailyCapUsd: number;
  /** Rolling 24h spend as a fraction (0..1+) of the cap, for a progress bar. */
  capUsedFraction: number;
  /** Per-UTC-day spend, oldest→newest, zero-filled across the window. */
  daily: UsageDayPoint[];
  /** Spend + counts grouped by usage type (score, search, capture, parse…). */
  byType: UsageByType[];
}

const DEFAULT_DAILY_SPEND_CAP_USD = Number(process.env.AI_DAILY_SPEND_CAP_USD ?? 5);

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getOrgUsageSummary(orgId: string, windowDays = 30): Promise<OrgUsageSummary> {
  const days = Math.min(120, Math.max(1, Math.round(windowDays)));
  const now = Date.now();
  const since = new Date(now - days * 24 * 60 * 60 * 1000);
  const since24h = new Date(now - 24 * 60 * 60 * 1000);

  const [rows, byTypeAgg, last24h] = await Promise.all([
    // Per-event rows over the window (costUsd + createdAt) for the daily series.
    prisma.usageEvent.findMany({
      where: { orgId, type: "ai_call", createdAt: { gte: since } },
      select: { costUsd: true, createdAt: true },
    }),
    // Counts + cost grouped by type (all event types, not just ai_call).
    prisma.usageEvent.groupBy({
      by: ["type"],
      where: { orgId, createdAt: { gte: since } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
    prisma.usageEvent.aggregate({
      where: { orgId, type: "ai_call", createdAt: { gte: since24h } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
  ]);

  // Zero-filled per-day series across the whole window (so a quiet day renders
  // as a gap, not a missing bar).
  const dayMap = new Map<string, UsageDayPoint>();
  for (let i = 0; i < days; i++) {
    const d = utcDay(new Date(now - i * 24 * 60 * 60 * 1000));
    dayMap.set(d, { date: d, costUsd: 0, aiCalls: 0 });
  }
  let totalCostUsd = 0;
  let totalAiCalls = 0;
  for (const r of rows) {
    const key = utcDay(r.createdAt);
    const pt = dayMap.get(key);
    const cost = r.costUsd ?? 0;
    totalCostUsd += cost;
    totalAiCalls += 1;
    if (pt) {
      pt.costUsd += cost;
      pt.aiCalls += 1;
    }
  }
  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const byType: UsageByType[] = byTypeAgg
    .map((g) => ({ type: g.type, count: g._count._all, costUsd: g._sum.costUsd ?? 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.count - a.count);

  const last24hCostUsd = last24h._sum.costUsd ?? 0;
  // A concrete org (orgId non-null) uses the base cap ×1 (matches checkSpendCap).
  const dailyCapUsd = DEFAULT_DAILY_SPEND_CAP_USD;

  return {
    orgId,
    windowDays: days,
    totalCostUsd: round2(totalCostUsd),
    totalAiCalls,
    last24hCostUsd: round2(last24hCostUsd),
    last24hAiCalls: last24h._count._all,
    dailyCapUsd,
    capUsedFraction: dailyCapUsd > 0 ? last24hCostUsd / dailyCapUsd : 0,
    daily: daily.map((d) => ({ ...d, costUsd: round2(d.costUsd) })),
    byType: byType.map((t) => ({ ...t, costUsd: round2(t.costUsd) })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
