import { NextResponse } from "next/server";
import { parseIntParam } from "@/lib/utils";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

const USAGE_TYPES = ["search", "score", "score_all", "parse", "capture"] as const;
type UsageType = typeof USAGE_TYPES[number];

type AnySession = { user?: { role?: string } } | null;

/** Safely pull a known key out of a stored meta JSON string. */
function metaField(meta: string | null, key: string): string | null {
  if (!meta) return null;
  try {
    const o = JSON.parse(meta) as Record<string, unknown>;
    const v = o[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const days = parseIntParam(url.searchParams.get("days"), { min: 1, max: 90, default: 30 });
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [events, byUserEvents, orgs, users, recentRaw] = await Promise.all([
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
    // Per-USER breakdown (the "track who's doing what" view). Counts actions +
    // ai_error per user; ai_call is excluded (it's the rolled-up noise and is
    // mostly unattributed on the frozen scoring path).
    prisma.usageEvent.groupBy({
      by: ["userId", "orgId", "type"],
      where: { createdAt: { gte: since }, userId: { not: null }, type: { not: "ai_call" } },
      _count: { id: true },
    }),
    prisma.org.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({ select: { id: true, username: true, orgId: true } }),
    // Clean ACTION log: actions + failures, NOT the raw per-candidate ai_call
    // firehose (the owner asked for "who did what", not 1700 anonymous AI calls).
    prisma.usageEvent.findMany({
      where: { createdAt: { gte: since }, type: { not: "ai_call" } },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, orgId: true, userId: true, type: true, meta: true, createdAt: true },
    }),
  ]);

  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));
  const userMap = new Map(users.map((u) => [u.id, u.username]));

  // Resolve job titles referenced in the recent rows' meta (one batched query)
  // so "doing notes" read "score-all · Senior .NET Developer" not "job 8f2a1c".
  const jobIds = [...new Set(recentRaw.map((e) => metaField(e.meta, "jobId")).filter((x): x is string => !!x))];
  const jobs = jobIds.length
    ? await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true } })
    : [];
  const jobMap = new Map(jobs.map((j) => [j.id, j.title]));

  // ── Per-org breakdown (+ AI-error count). orgId null = owner. ──
  type OrgRow = { orgId: string | null; orgName: string | null } & Record<UsageType, number> & {
    errors: number; total: number; costUsd: number; inputTokens: number; outputTokens: number;
  };
  const byOrgMap = new Map<string, OrgRow>();

  for (const row of events) {
    const key = row.orgId ?? "__owner__";
    if (!byOrgMap.has(key)) {
      byOrgMap.set(key, {
        orgId: row.orgId,
        orgName: row.orgId ? (orgMap.get(row.orgId) ?? `Unknown org (${row.orgId})`) : "Owner",
        search: 0, score: 0, score_all: 0, parse: 0, capture: 0, errors: 0, total: 0,
        costUsd: 0, inputTokens: 0, outputTokens: 0,
      });
    }
    const entry = byOrgMap.get(key)!;
    const t = row.type as UsageType;
    if (USAGE_TYPES.includes(t)) { entry[t] += row._count.id; entry.total += row._count.id; }
    if (row.type === "ai_error") entry.errors += row._count.id;
    entry.costUsd += row._sum.costUsd ?? 0;
    entry.inputTokens += row._sum.inputTokens ?? 0;
    entry.outputTokens += row._sum.outputTokens ?? 0;
  }

  const byOrg = [...byOrgMap.values()].sort((a, b) => b.total - a.total);
  const topSpenders = [...byOrgMap.values()]
    .filter((o) => o.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
    .map((o) => ({ orgId: o.orgId, orgName: o.orgName, costUsd: Number(o.costUsd.toFixed(4)), inputTokens: o.inputTokens, outputTokens: o.outputTokens }));

  // ── Per-user breakdown (who's doing what within each org + who hit AI walls). ──
  type UserRow = { userId: string; userName: string; orgName: string } & Record<UsageType, number> & {
    errors: number; total: number;
  };
  const byUserMap = new Map<string, UserRow>();
  for (const row of byUserEvents) {
    if (!row.userId) continue;
    if (!byUserMap.has(row.userId)) {
      byUserMap.set(row.userId, {
        userId: row.userId,
        userName: userMap.get(row.userId) ?? `Unknown user (${row.userId.slice(-6)})`,
        orgName: row.orgId ? (orgMap.get(row.orgId) ?? "Unknown org") : "Owner",
        search: 0, score: 0, score_all: 0, parse: 0, capture: 0, errors: 0, total: 0,
      });
    }
    const u = byUserMap.get(row.userId)!;
    const t = row.type as UsageType;
    if (USAGE_TYPES.includes(t)) { u[t] += row._count.id; u.total += row._count.id; }
    if (row.type === "ai_error") u.errors += row._count.id;
  }
  const byUser = [...byUserMap.values()].sort((a, b) => (b.total + b.errors) - (a.total + a.errors));

  // ── Global totals (+ AI errors). ──
  const totals = { search: 0, score: 0, score_all: 0, parse: 0, capture: 0, errors: 0, total: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  for (const row of events) {
    const t = row.type as UsageType;
    if (USAGE_TYPES.includes(t)) { totals[t] += row._count.id; totals.total += row._count.id; }
    if (row.type === "ai_error") totals.errors += row._count.id;
    totals.costUsd += row._sum.costUsd ?? 0;
    totals.inputTokens += row._sum.inputTokens ?? 0;
    totals.outputTokens += row._sum.outputTokens ?? 0;
  }
  totals.costUsd = Number(totals.costUsd.toFixed(4));

  // ── Clean action log: WHO · action · WHAT target · (why, if failed) · WHEN. ──
  const recent = recentRaw.map((e) => {
    const jobId = metaField(e.meta, "jobId");
    return {
      id: e.id,
      userName: e.userId ? (userMap.get(e.userId) ?? `user ${e.userId.slice(-6)}`) : "System",
      orgName: e.orgId ? (orgMap.get(e.orgId) ?? e.orgId) : "Owner",
      type: e.type,
      // Human "doing" target: the job title when known, else a short id hint.
      target: jobId ? (jobMap.get(jobId) ?? `job ${jobId.slice(-6)}`) : null,
      // Only set for ai_error rows — the failure reason ("insufficient_credit"…).
      reason: e.type === "ai_error" ? metaField(e.meta, "reason") : null,
      meta: e.meta,
      createdAt: e.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ totals, byOrg, byUser, topSpenders, recent, days, since: since.toISOString() });
}
