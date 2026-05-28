/**
 * Market Trend Detection — P5-2
 *
 * Aggregates ScoreBreakdown must_have_coverage data across the platform to detect:
 *   - Skills rising/falling in demand (frequency of appearing as must-have)
 *   - Seniority levels in oversupply (high candidate availability per role)
 *   - Average time-to-placement by role type
 *
 * NOTE: This aggregates within a single org only. Cross-org anonymised trends
 * are the P5-4 marketplace feature and require explicit opt-in.
 *
 * Called from GET /api/market-trends (org-scoped).
 */

import { prisma } from "./db";
import { safeParseJson } from "./utils";
import type { ScoreBreakdown } from "./scoring";
import type { SkillVector } from "./archetype/fingerprint";

export interface SkillTrend {
  skill: string;
  demandCount: number;          // times appeared as must-have in last 90 days
  avgScore: number;             // avg must-have score when present
  trend: "rising" | "falling" | "stable";
  changeVsLastQuarter: number;  // % change in demand vs previous 90-day period
}

export interface SenioritySupplyDemand {
  level: string;
  openRoles: number;           // jobs in this org at this seniority
  avgCandidateScore: number;
  avgCandidatesPerRole: number;
  supplySignal: "oversupply" | "balanced" | "undersupply";
}

export interface MarketIntelligence {
  orgId: string;
  topSkillsByDemand: SkillTrend[];
  seniorityBreakdown: SenioritySupplyDemand[];
  avgMatchScoreByRoleType: Array<{ roleType: string; avgScore: number; count: number }>;
  analyzedAt: Date;
}

const SENIORITY_RE: Array<[RegExp, string]> = [
  [/\b(?:chief|cto|ceo|svp|evp)\b/i,                                    "executive"],
  [/\b(?:director|vp|vice president|head of)\b/i,                        "lead"],
  [/\b(?:principal|staff|lead|senior|sr\.?)\b/i,                         "senior"],
  [/\b(?:mid[- ]?level|intermediate)\b/i,                                "mid"],
  [/\b(?:junior|jr\.?|graduate|associate|entry[- ]?level|intern)\b/i,    "junior"],
];

function inferSeniorityFromTitle(title: string): string {
  for (const [re, level] of SENIORITY_RE) {
    if (re.test(title)) return level;
  }
  return "mid";
}

export async function computeMarketIntelligence(orgId: string): Promise<MarketIntelligence> {
  const now = new Date();
  const ninetyDaysAgo    = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const oneEightyDaysAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

  // Fetch scored candidates for this org in last 180 days
  const candidates = await prisma.candidate.findMany({
    where: {
      orgId,
      scoreBreakdown: { not: null },
      updatedAt: { gte: oneEightyDaysAgo },
    },
    select: {
      matchScore: true,
      scoreBreakdown: true,
      updatedAt: true,
      job: { select: { title: true } },
    },
    take: 2000,
  });

  // Split into current quarter and last quarter
  const current  = candidates.filter((c) => c.updatedAt >= ninetyDaysAgo);
  const previous = candidates.filter((c) => c.updatedAt < ninetyDaysAgo);

  // ── Skill demand aggregation ───────────────────────────────────────────────
  function countSkillDemand(items: typeof candidates): Map<string, { count: number; scoreSum: number }> {
    const skills = new Map<string, { count: number; scoreSum: number }>();
    for (const c of items) {
      const bd = safeParseJson<ScoreBreakdown | null>(c.scoreBreakdown, null);
      if (!bd) continue;
      for (const mh of bd.must_have_coverage ?? []) {
        const req = mh.requirement.toLowerCase().slice(0, 40);
        const existing = skills.get(req) ?? { count: 0, scoreSum: 0 };
        const pts = mh.status === "confirmed" ? 1 : mh.status === "likely" ? 0.7 : 0;
        skills.set(req, { count: existing.count + 1, scoreSum: existing.scoreSum + pts });
      }
    }
    return skills;
  }

  const currentSkills  = countSkillDemand(current);
  const previousSkills = countSkillDemand(previous);

  const skillTrends: SkillTrend[] = Array.from(currentSkills.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([skill, { count, scoreSum }]) => {
      const prevCount = previousSkills.get(skill)?.count ?? 0;
      const change = prevCount === 0 ? 0 : ((count - prevCount) / prevCount) * 100;
      const trend: SkillTrend["trend"] =
        change > 20 ? "rising" : change < -20 ? "falling" : "stable";
      return {
        skill,
        demandCount: count,
        avgScore: count > 0 ? Math.round((scoreSum / count) * 100) : 0,
        trend,
        changeVsLastQuarter: Math.round(change),
      };
    });

  // ── Seniority supply/demand ────────────────────────────────────────────────
  const seniorityMap = new Map<string, { roles: Set<string>; scores: number[]; candidates: number }>();

  for (const c of current) {
    const level = c.job?.title ? inferSeniorityFromTitle(c.job.title) : "mid";
    if (!seniorityMap.has(level)) {
      seniorityMap.set(level, { roles: new Set(), scores: [], candidates: 0 });
    }
    const entry = seniorityMap.get(level)!;
    if (c.job?.title) entry.roles.add(c.job.title);
    if (c.matchScore != null) entry.scores.push(c.matchScore);
    entry.candidates++;
  }

  const seniorityBreakdown: SenioritySupplyDemand[] = Array.from(seniorityMap.entries()).map(
    ([level, { roles, scores, candidates }]) => {
      const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length) : 0;
      const perRole  = roles.size > 0 ? Math.round((candidates / roles.size) * 10) / 10 : 0;
      const supply: SenioritySupplyDemand["supplySignal"] =
        perRole > 15 ? "oversupply" : perRole < 5 ? "undersupply" : "balanced";
      return {
        level,
        openRoles: roles.size,
        avgCandidateScore: avgScore,
        avgCandidatesPerRole: perRole,
        supplySignal: supply,
      };
    }
  );

  // ── Avg match score by role type ──────────────────────────────────────────
  const roleTypeMap = new Map<string, { scores: number[] }>();
  for (const c of current) {
    if (c.matchScore == null || !c.job?.title) continue;
    const { label } = inferRoleType(c.job.title);
    if (!roleTypeMap.has(label)) roleTypeMap.set(label, { scores: [] });
    roleTypeMap.get(label)!.scores.push(c.matchScore);
  }

  const avgByRole = Array.from(roleTypeMap.entries())
    .map(([roleType, { scores }]) => ({
      roleType,
      avgScore: Math.round(scores.reduce((s, n) => s + n, 0) / scores.length),
      count: scores.length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    orgId,
    topSkillsByDemand: skillTrends,
    seniorityBreakdown,
    avgMatchScoreByRoleType: avgByRole,
    analyzedAt: now,
  };
}

const ROLE_TYPE_CLUSTERS: Array<[RegExp, string]> = [
  [/\b(?:devops|platform|sre|cloud|infrastructure)\b/i,                   "DevOps/Cloud"],
  [/\b(?:frontend|react|vue|angular|ui)\b/i,                              "Frontend"],
  [/\b(?:backend|api|java|dotnet|node|python)\b/i,                        "Backend"],
  [/\b(?:fullstack|full.stack)\b/i,                                       "Full Stack"],
  [/\b(?:data|analytics|scientist|machine learning|ml|ai)\b/i,            "Data/AI"],
  [/\b(?:security|cyber|infosec|penetration|pen test)\b/i,                "Security"],
  [/\b(?:manager|head|director|vp)\b/i,                                   "Leadership"],
  [/\b(?:project|program|delivery|agile|scrum)\b/i,                       "Project/Delivery"],
  [/\b(?:qa|quality|test|automation)\b/i,                                 "QA/Testing"],
  [/\b(?:architect|architecture|principal|staff)\b/i,                     "Architecture"],
];

function inferRoleType(title: string): { label: string } {
  for (const [re, label] of ROLE_TYPE_CLUSTERS) {
    if (re.test(title)) return { label };
  }
  return { label: "Other" };
}

// ── Placement fingerprint trend (from ArchetypePlacement) ─────────────────────
export async function computeSkillTrendsFromPlacements(orgId: string): Promise<{
  risingSkills: string[];
  fallingSkills: string[];
}> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const oneEightyDaysAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);

  const [recent, older] = await Promise.all([
    prisma.archetypePlacement.findMany({
      where: { orgId, outcomeCategory: "success", createdAt: { gte: ninetyDaysAgo } },
      select: { fingerprintVector: true },
    }),
    prisma.archetypePlacement.findMany({
      where: { orgId, outcomeCategory: "success", createdAt: { gte: oneEightyDaysAgo, lt: ninetyDaysAgo } },
      select: { fingerprintVector: true },
    }),
  ]);

  function countSkills(items: typeof recent): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of items) {
      try {
        const vec = JSON.parse(p.fingerprintVector) as SkillVector[];
        for (const s of vec) {
          if (s.recency >= 0.5) {
            counts.set(s.skill, (counts.get(s.skill) ?? 0) + 1);
          }
        }
      } catch { /* skip */ }
    }
    return counts;
  }

  const recentCounts = countSkills(recent);
  const olderCounts  = countSkills(older);
  const rising: string[] = [];
  const falling: string[] = [];

  for (const [skill, count] of recentCounts) {
    const prev = olderCounts.get(skill) ?? 0;
    if (count === 0) continue;
    const change = prev === 0 ? 100 : ((count - prev) / prev) * 100;
    if (change > 30 && count >= 2) rising.push(skill);
    if (change < -30 && count >= 2) falling.push(skill);
  }

  return {
    risingSkills:  rising.slice(0, 10),
    fallingSkills: falling.slice(0, 10),
  };
}
