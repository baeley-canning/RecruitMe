/**
 * Hierarchical agglomerative clustering over fingerprint skill vectors.
 * Produces Archetype records from ArchetypePlacement history.
 * 100% deterministic — no AI, no external ML library.
 */

import { prisma } from "@/lib/db";
import type { SkillVector } from "./fingerprint";

// ── Cosine similarity ──────────────────────────────────────────────────────
// Represents each fingerprint as a sparse skill recency vector.
// Common axis: the union of all skills across both vectors.

export function cosineSimilarity(a: SkillVector[], b: SkillVector[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const mapA = new Map(a.map((s) => [s.skill, s.recency]));
  const mapB = new Map(b.map((s) => [s.skill, s.recency]));
  const allSkills = new Set([...mapA.keys(), ...mapB.keys()]);

  let dot = 0, normA = 0, normB = 0;
  for (const skill of allSkills) {
    const va = mapA.get(skill) ?? 0;
    const vb = mapB.get(skill) ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Centroid of a set of skill vectors ────────────────────────────────────
export function computeCentroid(vectors: SkillVector[][]): SkillVector[] {
  if (vectors.length === 0) return [];

  const totals = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const vec of vectors) {
    for (const s of vec) {
      totals.set(s.skill, (totals.get(s.skill) ?? 0) + s.recency);
      counts.set(s.skill, (counts.get(s.skill) ?? 0) + 1);
    }
  }

  return Array.from(totals.entries()).map(([skill, total]) => ({
    skill,
    lastUsedYear: null,
    recency: total / (counts.get(skill) ?? 1),
    evidence: "",
  }));
}

// ── Cluster name ──────────────────────────────────────────────────────────
// "Wellington Senior Terraform+AWS Government"
function buildClusterName(
  centroid: SkillVector[],
  seniorities: string[],
  domains: string[]
): string {
  const topSkills = centroid
    .sort((a, b) => b.recency - a.recency)
    .slice(0, 3)
    .map((s) => s.skill);

  const parts: string[] = [];
  if (domains.length > 0) parts.push(domains[0]);
  const seniorityMode = mode(seniorities);
  if (seniorityMode && seniorityMode !== "unknown") {
    parts.push(capitalize(seniorityMode));
  }
  if (topSkills.length > 0) parts.push(topSkills.join("+"));
  return parts.join(" ") || "Mixed Profile";
}

function mode(arr: string[]): string | null {
  const counts = new Map<string, number>();
  for (const x of arr) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null, bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Main clustering function ───────────────────────────────────────────────
// Groups ArchetypePlacement records by fingerprint similarity.
// Clusters with ≥ 3 members are saved as Archetype records.
// Clusters with failureCount > 3 become anti-archetypes.

export async function clusterArchetypes(orgId: string): Promise<{
  created: number;
  updated: number;
  antiArchetypes: number;
}> {
  const SIMILARITY_THRESHOLD = 0.65;
  const MIN_CLUSTER_SIZE = 3;
  const ANTI_ARCHETYPE_THRESHOLD = 3;

  // Load all archetype placements for org
  const placements = await prisma.archetypePlacement.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
  });

  if (placements.length < MIN_CLUSTER_SIZE) {
    return { created: 0, updated: 0, antiArchetypes: 0 };
  }

  // Parse fingerprint vectors
  type PlacementWithVec = {
    id: string;
    fingerprintVector: SkillVector[];
    outcomeCategory: string;
    roleTitle: string;
    roleMustHaves: string[];
    matchScore: number;
    finalStatus: string;
  };

  const parsed: PlacementWithVec[] = placements
    .map((p) => {
      try {
        return {
          id: p.id,
          fingerprintVector: JSON.parse(p.fingerprintVector) as SkillVector[],
          outcomeCategory: p.outcomeCategory,
          roleTitle: p.roleTitle,
          roleMustHaves: JSON.parse(p.roleMustHaves) as string[],
          matchScore: p.matchScore,
          finalStatus: p.finalStatus,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as PlacementWithVec[];

  // Greedy agglomerative clustering
  const clusters: PlacementWithVec[][] = [];
  const assigned = new Set<string>();

  for (const p of parsed) {
    if (assigned.has(p.id)) continue;

    // Find the best existing cluster this placement fits
    let bestCluster: PlacementWithVec[] | null = null;
    let bestSim = 0;

    for (const cluster of clusters) {
      const centroid = computeCentroid(cluster.map((x) => x.fingerprintVector));
      const sim = cosineSimilarity(p.fingerprintVector, centroid);
      if (sim >= SIMILARITY_THRESHOLD && sim > bestSim) {
        bestSim = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      bestCluster.push(p);
    } else {
      clusters.push([p]);
    }
    assigned.add(p.id);
  }

  // Write qualifying clusters to DB
  let created = 0, updated = 0, antiArchetypes = 0;

  // Clear old archetypes for this org before rewriting
  await prisma.archetype.deleteMany({ where: { orgId } });

  for (const cluster of clusters) {
    if (cluster.length < MIN_CLUSTER_SIZE) continue;

    const successItems = cluster.filter((p) => p.outcomeCategory === "success");
    const failureItems = cluster.filter((p) => p.outcomeCategory === "failure");

    const successCount = successItems.length;
    const failureCount = failureItems.length;
    const totalPlacements = cluster.length;
    const successRate = totalPlacements > 0 ? successCount / totalPlacements : 0;
    const avgMatchScore = cluster.reduce((s, p) => s + p.matchScore, 0) / cluster.length;

    const centroid = computeCentroid(cluster.map((p) => p.fingerprintVector));
    const isAntiArchetype = failureCount >= ANTI_ARCHETYPE_THRESHOLD && failureCount > successCount;

    let antiCentroid: SkillVector[] | null = null;
    if (isAntiArchetype && failureItems.length > 0) {
      antiCentroid = computeCentroid(failureItems.map((p) => p.fingerprintVector));
    }

    // Extract domain and seniority for naming (from CandidateFingerprint)
    const candidateIds = cluster.map((p) => p.id); // We use placement IDs as proxy
    const name = buildClusterName(centroid, [], []);

    await prisma.archetype.create({
      data: {
        orgId,
        name,
        centroidVector: JSON.stringify(centroid),
        totalPlacements,
        successCount,
        failureCount,
        successRate,
        avgMatchScore,
        antiCentroidVector: antiCentroid ? JSON.stringify(antiCentroid) : null,
        isAntiArchetype,
        memberCount: cluster.length,
        lastClusteredAt: new Date(),
      },
    });

    if (isAntiArchetype) antiArchetypes++;
    created++;
  }

  return { created, updated, antiArchetypes };
}
