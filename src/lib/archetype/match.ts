/**
 * Match a candidate's fingerprint against stored archetypes for this org.
 * Returns the best matching archetype (if any) and anti-archetype warnings.
 */

import { prisma } from "@/lib/db";
import { cosineSimilarity } from "./clustering";
import type { SkillVector } from "./fingerprint";

export interface ArchetypeMatch {
  archetypeId: string;
  archetypeName: string;
  similarity: number; // 0-1 cosine similarity to centroid
  successRate: number; // historical placement success rate
  isAntiArchetype: boolean;
  warning?: string; // set when near an anti-archetype centroid
}

const MATCH_THRESHOLD = 0.50; // minimum similarity to report a match
const ANTI_WARNING_THRESHOLD = 0.70; // flag when this similar to a failure centroid

export async function matchCandidateToArchetypes(
  orgId: string,
  fingerprint: SkillVector[]
): Promise<ArchetypeMatch[]> {
  if (!orgId || fingerprint.length === 0) return [];

  const archetypes = await prisma.archetype.findMany({
    where: { orgId },
    select: {
      id: true,
      name: true,
      centroidVector: true,
      successRate: true,
      isAntiArchetype: true,
      antiCentroidVector: true,
      failureCount: true,
    },
  });

  if (archetypes.length === 0) return [];

  const results: ArchetypeMatch[] = [];

  for (const arch of archetypes) {
    let centroid: SkillVector[];
    try {
      centroid = JSON.parse(arch.centroidVector) as SkillVector[];
    } catch {
      continue;
    }

    const similarity = cosineSimilarity(fingerprint, centroid);
    if (similarity < MATCH_THRESHOLD) continue;

    const match: ArchetypeMatch = {
      archetypeId: arch.id,
      archetypeName: arch.name,
      similarity,
      successRate: arch.successRate,
      isAntiArchetype: arch.isAntiArchetype,
    };

    // Check anti-centroid proximity for non-anti archetypes that have failure data
    if (!arch.isAntiArchetype && arch.antiCentroidVector && arch.failureCount >= 3) {
      try {
        const antiCentroid = JSON.parse(arch.antiCentroidVector) as SkillVector[];
        const antiSimilarity = cosineSimilarity(fingerprint, antiCentroid);
        if (antiSimilarity >= ANTI_WARNING_THRESHOLD) {
          match.warning = `Similar profiles have historically underperformed for ${arch.name} roles (anti-archetype match: ${Math.round(antiSimilarity * 100)}%)`;
        }
      } catch {
        // ignore parse errors
      }
    }

    if (arch.isAntiArchetype && similarity >= ANTI_WARNING_THRESHOLD) {
      match.warning = `Warning: ${arch.name} is an anti-archetype (${arch.failureCount} failures, ${Math.round(arch.successRate * 100)}% success rate). This candidate profile matches patterns associated with unsuccessful placements.`;
    }

    results.push(match);
  }

  // Sort: warnings first, then by similarity desc
  return results.sort((a, b) => {
    if (!!a.warning !== !!b.warning) return a.warning ? -1 : 1;
    return b.similarity - a.similarity;
  });
}

// ── Anti-archetype context for AI scoring prompt ───────────────────────────
export function buildAntiArchetypeWarning(matches: ArchetypeMatch[]): string {
  const warnings = matches.filter((m) => m.warning);
  if (warnings.length === 0) return "";

  const lines = [
    "Anti-archetype warnings from this organisation's placement history:",
    "(Based on real outcomes — treat these as risk signals, not disqualifiers.)",
    "",
  ];
  for (const w of warnings) {
    lines.push(`⚠ ${w.warning}`);
    lines.push(`  Success rate for this archetype: ${Math.round(w.successRate * 100)}%`);
    lines.push("");
  }
  return lines.join("\n");
}
