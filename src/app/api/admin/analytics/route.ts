import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

const USAGE_TYPES = ["search", "score", "score_all", "parse", "capture"] as const;
type UsageType = typeof USAGE_TYPES[number];

type AnySession = { user?: { role?: string } } | null;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [events, orgs, recentRaw] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ["orgId", "type"],
      where: { createdAt: { gte: since } },
      _count: { id: true },
      // Sum the actual money + token spend. Cost lives on "ai_call" events
      // (which aren't in USAGE_TYPES, the per-action count buckets), so without
      // this the dashboard could count actions but never answer "which org is
      // burning money?". costUsd/tokens are null on non-AI rows → summed as 0.
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
      orderBy: { orgId: "asc" },
    }),
    prisma.org.findMany({ select: { id: true, name: true } }),
    prisma.usageEvent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, orgId: true, type: true, meta: true, createdAt: true },
    }),
  ]);

  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  // Per-org breakdown.
  // orgId is null for owner (role="owner") actions — these are explicitly bucketed
  // under the "__owner__" key so they don't get merged with any tenant org.
  type OrgRow = { orgId: string | null; orgName: string | null } & Record<UsageType, number> & {
    total: number; costUsd: number; inputTokens: number; outputTokens: number;
  };
  const byOrgMap = new Map<string, OrgRow>();

  for (const row of events) {
    // Owners have orgId=null by design (they have no org assignment)
    const key = row.orgId ?? "__owner__";
    if (!byOrgMap.has(key)) {
      byOrgMap.set(key, {
        orgId: row.orgId,
        orgName: row.orgId ? (orgMap.get(row.orgId) ?? `Unknown org (${row.orgId})`) : "Owner",
        search: 0, score: 0, score_all: 0, parse: 0, capture: 0, total: 0,
        costUsd: 0, inputTokens: 0, outputTokens: 0,
      });
    }
    const entry = byOrgMap.get(key)!;
    const t = row.type as UsageType;
    if (USAGE_TYPES.includes(t)) entry[t] += row._count.id;
    entry.total += row._count.id;
    entry.costUsd += row._sum.costUsd ?? 0;
    entry.inputTokens += row._sum.inputTokens ?? 0;
    entry.outputTokens += row._sum.outputTokens ?? 0;
  }

  const byOrg = [...byOrgMap.values()].sort((a, b) => b.total - a.total);
  // "Who's burning money right now" — same rows, ranked by actual USD spend.
  const topSpenders = [...byOrgMap.values()]
    .filter((o) => o.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
    .map((o) => ({ orgId: o.orgId, orgName: o.orgName, costUsd: Number(o.costUsd.toFixed(4)), inputTokens: o.inputTokens, outputTokens: o.outputTokens }));

  // Global totals
  const totals = { search: 0, score: 0, score_all: 0, parse: 0, capture: 0, total: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  for (const row of events) {
    const t = row.type as UsageType;
    if (USAGE_TYPES.includes(t)) totals[t] += row._count.id;
    totals.total += row._count.id;
    totals.costUsd += row._sum.costUsd ?? 0;
    totals.inputTokens += row._sum.inputTokens ?? 0;
    totals.outputTokens += row._sum.outputTokens ?? 0;
  }
  totals.costUsd = Number(totals.costUsd.toFixed(4));

  // Recent activity with org names
  const recent = recentRaw.map((e) => ({
    id: e.id,
    orgName: e.orgId ? (orgMap.get(e.orgId) ?? e.orgId) : "Owner",
    type: e.type,
    meta: e.meta,
    createdAt: e.createdAt.toISOString(),
  }));

  return NextResponse.json({ totals, byOrg, topSpenders, recent, days, since: since.toISOString() });
}
