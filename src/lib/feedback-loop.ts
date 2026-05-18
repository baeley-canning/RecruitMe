/**
 * Correction Feedback Loop — P5-1
 *
 * Aggregates ScoreCorrection records to detect systematic bias in AI scoring.
 * Produces weight adjustment recommendations per org.
 *
 * Run weekly (or on demand via POST /api/admin/tune-weights).
 *
 * Algorithm:
 * 1. Group corrections by role similarity (title keyword overlap)
 * 2. Compute mean delta (recruiterScore - originalScore) per role cluster
 * 3. If mean delta is consistently positive → AI underscores for this role type
 *    If negative → AI overscores
 * 4. Map role clusters to ScoreBreakdown categories
 * 5. Produce weight adjustment recommendations (+/- 0.02 per category per cycle)
 *
 * The weight adjustments are suggestions, not automatic — they show in the UI
 * as "Tune your scoring" prompts. The recruiter approves before saving.
 */

import { prisma } from "./db";
import { safeParseJson } from "./utils";
import type { ScoreBreakdown } from "./scoring";

export interface CorrectionPattern {
  roleCluster: string;          // human-readable cluster label
  sampleSize: number;
  meanDelta: number;            // positive = AI underscore, negative = AI overscore
  direction: "underscore" | "overscore" | "neutral";
  confidence: "high" | "medium" | "low";
  affectedCategories: string[]; // which breakdown categories likely caused the bias
}

export interface WeightAdjustmentRecommendation {
  category: string;
  currentWeight: number;
  suggestedWeight: number;
  delta: number;
  rationale: string;
}

export interface FeedbackLoopResult {
  orgId: string;
  correctionCount: number;
  patterns: CorrectionPattern[];
  recommendations: WeightAdjustmentRecommendation[];
  analyzedAt: Date;
}

const MIN_CORRECTIONS_FOR_PATTERN = 3;
const MEANINGFUL_DELTA_THRESHOLD  = 8; // points

// Role cluster definitions — keyword → category hint
const ROLE_CLUSTERS: Array<{ keywords: string[]; label: string; affectedCategories: string[] }> = [
  { keywords: ["senior", "lead", "principal", "staff"], label: "Senior IC roles",        affectedCategories: ["seniority_fit"] },
  { keywords: ["manager", "head", "director", "vp"],    label: "Leadership roles",       affectedCategories: ["seniority_fit", "title_fit"] },
  { keywords: ["cloud", "devops", "platform", "infra"], label: "Cloud/DevOps roles",     affectedCategories: ["skill_fit"] },
  { keywords: ["fullstack", "full stack", "frontend", "backend"], label: "Developer roles", affectedCategories: ["skill_fit"] },
  { keywords: ["data", "analytics", "scientist", "ml"], label: "Data/Analytics roles",  affectedCategories: ["skill_fit", "domain_fit"] },
  { keywords: ["security", "cyber", "infosec", "isms"], label: "Security roles",         affectedCategories: ["skill_fit"] },
  { keywords: ["government", "public sector", "council"], label: "Government sector",    affectedCategories: ["domain_fit"] },
  { keywords: ["agile", "scrum", "project", "delivery"], label: "Project/Delivery roles", affectedCategories: ["title_fit", "seniority_fit"] },
];

function classifyRole(roleTitle: string): { label: string; affectedCategories: string[] } {
  if (!roleTitle) return { label: "General roles", affectedCategories: ["skill_fit"] };
  const lower = roleTitle.toLowerCase();
  for (const cluster of ROLE_CLUSTERS) {
    if (cluster.keywords.some((k) => lower.includes(k))) {
      return { label: cluster.label, affectedCategories: cluster.affectedCategories };
    }
  }
  return { label: "General roles", affectedCategories: ["skill_fit"] };
}

export async function analyseCorrectionPatterns(orgId: string): Promise<FeedbackLoopResult> {
  const corrections = await prisma.scoreCorrection.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      originalScore: true,
      recruiterScore: true,
      roleTitle: true,
      reason: true,
      createdAt: true,
      candidate: { select: { scoreBreakdown: true } },
    },
  });

  if (corrections.length === 0) {
    return {
      orgId,
      correctionCount: 0,
      patterns: [],
      recommendations: [],
      analyzedAt: new Date(),
    };
  }

  // Group by role cluster
  const clusters = new Map<string, {
    deltas: number[];
    affectedCategories: string[];
    breakdowns: ScoreBreakdown[];
  }>();

  for (const c of corrections) {
    const delta = c.recruiterScore - c.originalScore;
    const { label, affectedCategories } = classifyRole(c.roleTitle ?? "");

    if (!clusters.has(label)) {
      clusters.set(label, { deltas: [], affectedCategories, breakdowns: [] });
    }
    const cluster = clusters.get(label)!;
    cluster.deltas.push(delta);

    const bd = safeParseJson<ScoreBreakdown | null>(c.candidate.scoreBreakdown, null);
    if (bd) cluster.breakdowns.push(bd);
  }

  const patterns: CorrectionPattern[] = [];

  for (const [label, { deltas, affectedCategories }] of clusters) {
    if (deltas.length < MIN_CORRECTIONS_FOR_PATTERN) continue;

    const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const direction =
      mean >= MEANINGFUL_DELTA_THRESHOLD  ? "underscore" :
      mean <= -MEANINGFUL_DELTA_THRESHOLD ? "overscore"  : "neutral";

    const variance = deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length;
    const stdDev = Math.sqrt(variance);
    const confidence =
      stdDev < 10 && deltas.length >= 10 ? "high" :
      stdDev < 20 && deltas.length >= 5  ? "medium" : "low";

    patterns.push({
      roleCluster: label,
      sampleSize: deltas.length,
      meanDelta: Math.round(mean * 10) / 10,
      direction,
      confidence,
      affectedCategories,
    });
  }

  // Generate weight recommendations from patterns
  const categoryAdjustments = new Map<string, number>();

  for (const pattern of patterns) {
    if (pattern.direction === "neutral" || pattern.confidence === "low") continue;
    const sign = pattern.direction === "underscore" ? 1 : -1;
    const magnitude = Math.min(0.02, Math.abs(pattern.meanDelta) / 200); // cap at +/- 0.02

    for (const cat of pattern.affectedCategories) {
      categoryAdjustments.set(cat, (categoryAdjustments.get(cat) ?? 0) + sign * magnitude);
    }
  }

  // Base weights (from scoring.ts CATEGORY_WEIGHTS_V2)
  const BASE_WEIGHTS: Record<string, number> = {
    skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10,
    title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06,
  };

  const recommendations: WeightAdjustmentRecommendation[] = [];
  for (const [cat, adj] of categoryAdjustments) {
    if (Math.abs(adj) < 0.005) continue; // too small to bother
    const current = BASE_WEIGHTS[cat] ?? 0.1;
    const suggested = Math.max(0.02, Math.min(0.40, current + adj));
    const delta = Math.round((suggested - current) * 1000) / 1000;
    const direction = delta > 0 ? "increase" : "decrease";
    recommendations.push({
      category: cat,
      currentWeight: current,
      suggestedWeight: suggested,
      delta,
      rationale: `Recruiters consistently adjusted scores ${delta > 0 ? "up" : "down"} for ${cat.replace(/_/g, " ")} assessments. ${direction === "increase" ? "Increasing" : "Decreasing"} weight by ${Math.abs(delta * 100).toFixed(1)}%.`,
    });
  }

  return {
    orgId,
    correctionCount: corrections.length,
    patterns,
    recommendations,
    analyzedAt: new Date(),
  };
}
