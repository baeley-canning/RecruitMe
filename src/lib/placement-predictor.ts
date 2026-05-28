/**
 * Placement Success Predictor — P5-3
 *
 * Uses logistic regression over ArchetypePlacement history to estimate
 * the probability a candidate will be placed successfully.
 *
 * Features:
 *   - matchScore (0-100)
 *   - acceptanceScore (0-100, if available)
 *   - archetypeSuccessRate (from nearest archetype, 0-1)
 *   - archetype similarity (0-1)
 *   - stabilityScore (0-100 from fingerprint)
 *   - seniorityMatch (1 = exact, 0.7 = one tier off, 0 = large mismatch)
 *
 * Weights are learned from the org's ArchetypePlacement history using
 * simple gradient descent (no external ML library, 100% deterministic).
 *
 * Falls back to heuristic weights when insufficient history (<20 placements).
 */

import { prisma } from "./db";
import type { SkillVector } from "./archetype/fingerprint";
import { cosineSimilarity } from "./archetype/clustering";

export interface PlacementPrediction {
  probability: number;    // 0-1
  confidence: "high" | "medium" | "low";
  factors: Array<{ name: string; contribution: number; value: number }>;
}

// ── Logistic function ─────────────────────────────────────────────────────────
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── Feature extraction ────────────────────────────────────────────────────────
interface FeatureVector {
  matchScore:          number; // 0-1
  acceptanceScore:     number; // 0-1
  archetypeSuccessRate: number; // 0-1
  archetypeSimilarity: number; // 0-1
  stabilityScore:      number; // 0-1
  seniorityMatch:      number; // 0-1
}

function extractFeatures(args: {
  matchScore: number;
  acceptanceScore?: number | null;
  archetypeSuccessRate?: number;
  archetypeSimilarity?: number;
  stabilityScore?: number | null;
  seniorityMatch?: number;
}): FeatureVector {
  return {
    matchScore:           (args.matchScore ?? 0) / 100,
    acceptanceScore:      (args.acceptanceScore ?? args.matchScore ?? 0) / 100,
    archetypeSuccessRate: args.archetypeSuccessRate ?? 0.5,
    archetypeSimilarity:  args.archetypeSimilarity ?? 0,
    stabilityScore:       (args.stabilityScore ?? 70) / 100,
    seniorityMatch:       args.seniorityMatch ?? 0.7,
  };
}

// ── Heuristic weights (used when history is insufficient) ────────────────────
const HEURISTIC_WEIGHTS = {
  bias:                -1.5,
  matchScore:           3.0,   // most predictive
  acceptanceScore:      1.5,
  archetypeSuccessRate: 1.8,
  archetypeSimilarity:  0.8,
  stabilityScore:       0.7,
  seniorityMatch:       0.9,
};

// ── Simple logistic regression training ─────────────────────────────────────
// Gradient descent with L2 regularisation.
// Returns learned weights.
function trainLogisticRegression(
  examples: Array<{ features: FeatureVector; label: number }>,
  learningRate = 0.1,
  epochs = 200,
  lambda = 0.01,
): typeof HEURISTIC_WEIGHTS {
  const w = { ...HEURISTIC_WEIGHTS }; // init from heuristic

  const keys = Object.keys(w).filter((k) => k !== "bias") as Array<keyof FeatureVector>;

  for (let e = 0; e < epochs; e++) {
    for (const { features, label } of examples) {
      const z = w.bias + keys.reduce((s, k) => s + w[k as keyof typeof w] * features[k], 0);
      const pred = sigmoid(z);
      const err  = pred - label;

      w.bias -= learningRate * err;
      for (const k of keys) {
        w[k as keyof typeof w] -= learningRate * (err * features[k] + lambda * w[k as keyof typeof w]);
      }
    }
  }

  return w;
}

// ── Cached weights per org ────────────────────────────────────────────────────
const WEIGHTS_CACHE = new Map<string, { weights: typeof HEURISTIC_WEIGHTS; trainedAt: number }>();
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

async function getOrTrainWeights(orgId: string): Promise<typeof HEURISTIC_WEIGHTS> {
  const cached = WEIGHTS_CACHE.get(orgId);
  if (cached && Date.now() - cached.trainedAt < CACHE_TTL_MS) {
    return cached.weights;
  }

  const placements = await prisma.archetypePlacement.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      matchScore: true,
      acceptanceScore: true,
      fingerprintVector: true,
      outcomeCategory: true,
    },
  });

  if (placements.length < 20) {
    return HEURISTIC_WEIGHTS;
  }

  const examples = placements.map((p) => ({
    features: extractFeatures({
      matchScore: p.matchScore,
      acceptanceScore: p.acceptanceScore,
    }),
    label: p.outcomeCategory === "success" ? 1 : 0,
  }));

  const weights = trainLogisticRegression(examples);
  WEIGHTS_CACHE.set(orgId, { weights, trainedAt: Date.now() });
  return weights;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function predictPlacementSuccess(args: {
  orgId: string;
  matchScore: number;
  acceptanceScore?: number | null;
  profileText?: string | null;
  archetypeMatch?: { successRate: number; similarity: number } | null;
  stabilityScore?: number | null;
  seniorityMatch?: number;
}): Promise<PlacementPrediction> {
  const weights = await getOrTrainWeights(args.orgId);

  const features = extractFeatures({
    matchScore:           args.matchScore,
    acceptanceScore:      args.acceptanceScore,
    archetypeSuccessRate: args.archetypeMatch?.successRate,
    archetypeSimilarity:  args.archetypeMatch?.similarity,
    stabilityScore:       args.stabilityScore,
    seniorityMatch:       args.seniorityMatch,
  });

  const keys = Object.keys(weights).filter((k) => k !== "bias") as Array<keyof FeatureVector>;
  const z = weights.bias + keys.reduce((s, k) => s + weights[k as keyof typeof weights] * features[k], 0);
  const probability = Math.max(0.01, Math.min(0.99, sigmoid(z)));

  // Confidence: how many real training examples we have
  const placementCount = await prisma.archetypePlacement.count({ where: { orgId: args.orgId } });
  const confidence: PlacementPrediction["confidence"] =
    placementCount >= 50 ? "high" :
    placementCount >= 20 ? "medium" : "low";

  const factors = keys.map((k) => ({
    name: k.replace(/([A-Z])/g, " $1").toLowerCase(),
    contribution: Math.round(weights[k as keyof typeof weights] * features[k] * 100) / 100,
    value: Math.round(features[k] * 100),
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return { probability, confidence, factors };
}

/** Predict for multiple candidates efficiently (uses same weights). */
export async function batchPredictPlacement(
  orgId: string,
  candidates: Array<{
    candidateId: string;
    matchScore: number;
    acceptanceScore?: number | null;
    stabilityScore?: number | null;
    archetypeMatch?: { successRate: number; similarity: number } | null;
  }>,
): Promise<Map<string, PlacementPrediction>> {
  const weights = await getOrTrainWeights(orgId);
  const results = new Map<string, PlacementPrediction>();
  const keys = Object.keys(weights).filter((k) => k !== "bias") as Array<keyof FeatureVector>;

  for (const c of candidates) {
    const features = extractFeatures({
      matchScore:           c.matchScore,
      acceptanceScore:      c.acceptanceScore,
      archetypeSuccessRate: c.archetypeMatch?.successRate,
      archetypeSimilarity:  c.archetypeMatch?.similarity,
      stabilityScore:       c.stabilityScore,
    });

    const z = weights.bias + keys.reduce((s, k) => s + weights[k as keyof typeof weights] * features[k], 0);
    const probability = Math.max(0.01, Math.min(0.99, sigmoid(z)));

    results.set(c.candidateId, {
      probability,
      confidence: "low", // batch mode uses cached weights
      factors: [],
    });
  }

  return results;
}
