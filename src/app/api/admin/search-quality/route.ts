import { NextResponse } from "next/server";
import { parseIntParam } from "@/lib/utils";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

type AnySession = { user?: { role?: string } } | null;

interface OrgRollup {
  orgId: string | null;
  orgName: string;
  total: number;
  fail: number;
  warning: number;
  ok: number;
  avgScore: number | null;
}

interface ProblemJob {
  jobId: string;
  jobTitle: string;
  orgName: string;
  failedRuns: number;
  lastEvaluation: string | null;
  lastRunAt: string;
}

function evalCategory(evaluation: string | null): "fail" | "warning" | "ok" | "unknown" {
  if (!evaluation) return "unknown";
  if (evaluation.startsWith("FAIL"))    return "fail";
  if (evaluation.startsWith("WARNING")) return "warning";
  if (evaluation.startsWith("OK"))      return "ok";
  return "unknown";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const days = parseIntParam(url.searchParams.get("days"), { min: 1, max: 90, default: 30 });
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [sessions, orgs] = await Promise.all([
    prisma.searchSession.findMany({
      where: {
        createdAt: { gte: since },
        status: { not: "running" },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        jobId: true,
        orgId: true,
        evaluation: true,
        avgScore: true,
        collected: true,
        createdAt: true,
        job: { select: { title: true } },
      },
    }),
    prisma.org.findMany({ select: { id: true, name: true } }),
  ]);

  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  // ── Top-level totals ──────────────────────────────────────────────────────
  let total = 0;
  let fail = 0;
  let warning = 0;
  let ok = 0;
  let scoreSum = 0;
  let scoredCount = 0;

  // ── Per-org rollup ────────────────────────────────────────────────────────
  const byOrg = new Map<string, OrgRollup>();

  // ── Problem jobs (jobs with the most FAIL evaluations) ────────────────────
  const failByJob = new Map<string, { jobTitle: string; orgName: string; failedRuns: number; lastEvaluation: string | null; lastRunAt: Date }>();

  for (const s of sessions) {
    total++;
    const cat = evalCategory(s.evaluation);
    if (cat === "fail") fail++;
    else if (cat === "warning") warning++;
    else if (cat === "ok") ok++;
    if (typeof s.avgScore === "number") {
      scoreSum += s.avgScore;
      scoredCount++;
    }

    const orgKey = s.orgId ?? "__owner__";
    const orgName = s.orgId ? (orgMap.get(s.orgId) ?? `Unknown (${s.orgId})`) : "Owner";
    if (!byOrg.has(orgKey)) {
      byOrg.set(orgKey, { orgId: s.orgId, orgName, total: 0, fail: 0, warning: 0, ok: 0, avgScore: null });
    }
    const rollup = byOrg.get(orgKey)!;
    rollup.total++;
    if (cat === "fail") rollup.fail++;
    else if (cat === "warning") rollup.warning++;
    else if (cat === "ok") rollup.ok++;

    if (cat === "fail" && s.jobId) {
      const existing = failByJob.get(s.jobId);
      if (existing) {
        existing.failedRuns++;
        if (s.createdAt > existing.lastRunAt) {
          existing.lastEvaluation = s.evaluation;
          existing.lastRunAt = s.createdAt;
        }
      } else {
        failByJob.set(s.jobId, {
          jobTitle: s.job?.title ?? "(unknown)",
          orgName,
          failedRuns: 1,
          lastEvaluation: s.evaluation,
          lastRunAt: s.createdAt,
        });
      }
    }
  }

  // Compute per-org avg score in a second pass (numerator/denom across that org's sessions).
  const orgScoreAggs = new Map<string, { sum: number; count: number }>();
  for (const s of sessions) {
    if (typeof s.avgScore !== "number") continue;
    const orgKey = s.orgId ?? "__owner__";
    const agg = orgScoreAggs.get(orgKey) ?? { sum: 0, count: 0 };
    agg.sum += s.avgScore;
    agg.count++;
    orgScoreAggs.set(orgKey, agg);
  }
  for (const [orgKey, rollup] of byOrg) {
    const agg = orgScoreAggs.get(orgKey);
    rollup.avgScore = agg && agg.count > 0 ? Math.round(agg.sum / agg.count) : null;
  }

  const problemJobs: ProblemJob[] = [...failByJob.entries()]
    .map(([jobId, v]) => ({
      jobId,
      jobTitle: v.jobTitle,
      orgName: v.orgName,
      failedRuns: v.failedRuns,
      lastEvaluation: v.lastEvaluation,
      lastRunAt: v.lastRunAt.toISOString(),
    }))
    .sort((a, b) => b.failedRuns - a.failedRuns)
    .slice(0, 10);

  return NextResponse.json({
    days,
    since: since.toISOString(),
    totals: {
      total,
      fail,
      warning,
      ok,
      failPct:    total > 0 ? Math.round((fail / total) * 100) : 0,
      warningPct: total > 0 ? Math.round((warning / total) * 100) : 0,
      okPct:      total > 0 ? Math.round((ok / total) * 100) : 0,
      avgScore:   scoredCount > 0 ? Math.round(scoreSum / scoredCount) : null,
    },
    byOrg: [...byOrg.values()].sort((a, b) => b.total - a.total),
    problemJobs,
  });
}
