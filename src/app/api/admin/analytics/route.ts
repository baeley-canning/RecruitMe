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

  // Per-org breakdown
  type OrgRow = { orgId: string | null; orgName: string | null } & Record<UsageType, number> & { total: number };
  const byOrgMap = new Map<string, OrgRow>();

  for (const row of events) {
    const key = row.orgId ?? "__owner__";
    if (!byOrgMap.has(key)) {
      byOrgMap.set(key, {
        orgId: row.orgId,
        orgName: row.orgId ? (orgMap.get(row.orgId) ?? row.orgId) : "Owner (no org)",
        search: 0, score: 0, score_all: 0, parse: 0, capture: 0, total: 0,
      });
    }
    const entry = byOrgMap.get(key)!;
    const t = row.type as UsageType;
    if (USAGE_TYPES.includes(t)) entry[t] += row._count.id;
    entry.total += row._count.id;
  }

  const byOrg = [...byOrgMap.values()].sort((a, b) => b.total - a.total);

  // Global totals
  const totals = { search: 0, score: 0, score_all: 0, parse: 0, capture: 0, total: 0 };
  for (const row of events) {
    const t = row.type as UsageType;
    if (USAGE_TYPES.includes(t)) totals[t] += row._count.id;
    totals.total += row._count.id;
  }

  // Recent activity with org names
  const recent = recentRaw.map((e) => ({
    id: e.id,
    orgName: e.orgId ? (orgMap.get(e.orgId) ?? e.orgId) : "Owner",
    type: e.type,
    meta: e.meta,
    createdAt: e.createdAt.toISOString(),
  }));

  return NextResponse.json({ totals, byOrg, recent, days, since: since.toISOString() });
}
