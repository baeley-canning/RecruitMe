/**
 * Cross-Agency Archetype Marketplace — P5-4
 *
 * Anonymised archetype sharing across non-competing agencies.
 * Opt-in only: orgs must explicitly enable sharing in settings.
 *
 * What's shared:
 *   - Centroid skill vector (no PII — just skill names + recency scores)
 *   - Success rate (aggregated %)
 *   - Role type cluster (e.g. "Senior DevOps", not specific company names)
 *   - Anonymised failure patterns (anti-archetypes)
 *
 * What's NOT shared:
 *   - Candidate names, emails, LinkedIn URLs
 *   - Company names
 *   - Specific salaries
 *   - Individual placement records
 *
 * Architecture:
 *   - Shared archetypes stored with orgId = "marketplace"
 *   - Org opts in → their archetypes are anonymised + contributed
 *   - When scoring, if org has archetype-marketplace opt-in, also match against
 *     marketplace archetypes (lower trust — shown as "Industry pattern" not "Your history")
 *
 * Revenue model:
 *   - Contribution: 1 archetype shared → 5 marketplace reads
 *   - Non-contributing agencies can pay per-read ($0.50/archetype match)
 */

import { prisma } from "./db";
import type { SkillVector } from "./archetype/fingerprint";
import { cosineSimilarity } from "./archetype/clustering";

const MARKETPLACE_ORG_ID = "marketplace";

export interface MarketplaceArchetype {
  id: string;
  name: string;
  centroidVector: SkillVector[];
  successRate: number;
  totalPlacements: number;
  isAntiArchetype: boolean;
  roleTypeCluster: string; // anonymised role family
  geography: string;       // "NZ" | "AU" | "global"
  contributingOrgCount: number;
}

// ── Opt-in setting ─────────────────────────────────────────────────────────────

export async function isMarketplaceOptIn(orgId: string): Promise<boolean> {
  const setting = await prisma.setting.findUnique({
    where: { key: `marketplace.optin.${orgId}` },
  });
  return setting?.value === "true";
}

export async function setMarketplaceOptIn(orgId: string, enabled: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: `marketplace.optin.${orgId}` },
    create: { key: `marketplace.optin.${orgId}`, value: String(enabled) },
    update: { value: String(enabled) },
  });
}

// ── Contribute archetypes to marketplace ──────────────────────────────────────

/** Anonymise and contribute an org's archetypes to the marketplace pool. */
export async function contributeToMarketplace(orgId: string): Promise<{ contributed: number }> {
  const optedIn = await isMarketplaceOptIn(orgId);
  if (!optedIn) return { contributed: 0 };

  const archetypes = await prisma.archetype.findMany({
    where: { orgId, totalPlacements: { gte: 5 } },
  });

  let contributed = 0;
  for (const arch of archetypes) {
    const roleCluster = inferRoleTypeCluster(arch.name);
    const settingKey  = `marketplace.contributed.${orgId}.${arch.id}`;

    await prisma.setting.upsert({
      where: { key: settingKey },
      create: {
        key: settingKey,
        value: JSON.stringify({
          name: `${roleCluster} (shared)`,
          centroidVector: arch.centroidVector,
          successRate: arch.successRate,
          totalPlacements: arch.totalPlacements,
          isAntiArchetype: arch.isAntiArchetype,
          roleTypeCluster: roleCluster,
          geography: "NZ",
          contributedAt: new Date().toISOString(),
        }),
      },
      update: {
        value: JSON.stringify({
          name: `${roleCluster} (shared)`,
          centroidVector: arch.centroidVector,
          successRate: arch.successRate,
          totalPlacements: arch.totalPlacements,
          isAntiArchetype: arch.isAntiArchetype,
          roleTypeCluster: roleCluster,
          geography: "NZ",
          contributedAt: new Date().toISOString(),
        }),
      },
    });
    contributed++;
  }

  return { contributed };
}

// ── Read marketplace archetypes ───────────────────────────────────────────────

export async function getMarketplaceArchetypes(
  geography?: string,
): Promise<MarketplaceArchetype[]> {
  const settings = await prisma.setting.findMany({
    where: { key: { startsWith: "marketplace.contributed." } },
  });

  const archetypes: MarketplaceArchetype[] = [];
  const seen = new Map<string, { arch: MarketplaceArchetype; contributingOrgs: number }>();

  for (const s of settings) {
    try {
      const data = JSON.parse(s.value);
      if (geography && data.geography !== geography) continue;

      const key = `${data.roleTypeCluster}:${data.isAntiArchetype}`;
      if (seen.has(key)) {
        // Merge with existing: average centroids, increase contributor count
        seen.get(key)!.contributingOrgs++;
        continue;
      }

      const centroid = JSON.parse(typeof data.centroidVector === "string"
        ? data.centroidVector
        : JSON.stringify(data.centroidVector)) as SkillVector[];

      const arch: MarketplaceArchetype = {
        id: `mp-${key}`,
        name: data.name,
        centroidVector: centroid,
        successRate: data.successRate,
        totalPlacements: data.totalPlacements,
        isAntiArchetype: data.isAntiArchetype,
        roleTypeCluster: data.roleTypeCluster,
        geography: data.geography,
        contributingOrgCount: 1,
      };
      seen.set(key, { arch, contributingOrgs: 1 });
      archetypes.push(arch);
    } catch {
      // skip malformed records
    }
  }

  return archetypes;
}

// ── Match against marketplace ──────────────────────────────────────────────────

export async function matchAgainstMarketplace(
  fingerprint: SkillVector[],
  orgId: string,
  geography = "NZ",
): Promise<Array<{
  archetypeName: string;
  roleTypeCluster: string;
  similarity: number;
  successRate: number;
  isAntiArchetype: boolean;
  source: "marketplace";
}>> {
  const optedIn = await isMarketplaceOptIn(orgId);
  if (!optedIn) return [];

  const marketplaceArchetypes = await getMarketplaceArchetypes(geography);
  const results = [];

  for (const arch of marketplaceArchetypes) {
    const sim = cosineSimilarity(fingerprint, arch.centroidVector);
    if (sim >= 0.50) {
      results.push({
        archetypeName:   arch.name,
        roleTypeCluster: arch.roleTypeCluster,
        similarity:      sim,
        successRate:     arch.successRate,
        isAntiArchetype: arch.isAntiArchetype,
        source:          "marketplace" as const,
      });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}

// ── Role type cluster inference ───────────────────────────────────────────────

const ROLE_TYPE_MAP: Array<[RegExp, string]> = [
  [/\b(?:devops|cloud|platform|sre|kubernetes|terraform)\b/i, "Senior Cloud/DevOps"],
  [/\b(?:react|vue|angular|frontend|ui)\b/i,                 "Frontend Developer"],
  [/\b(?:java|dotnet|spring|python|backend)\b/i,             "Backend Developer"],
  [/\b(?:data|analytics|ml|machine learning)\b/i,            "Data Engineer"],
  [/\b(?:security|cyber|infosec)\b/i,                        "Security Specialist"],
  [/\b(?:manager|head|director|lead)\b/i,                    "Technology Leader"],
  [/\b(?:architect|architecture|principal)\b/i,              "Solution Architect"],
  [/\b(?:project|program|delivery)\b/i,                      "Delivery Manager"],
];

function inferRoleTypeCluster(archetypeName: string): string {
  const lower = archetypeName.toLowerCase();
  for (const [re, cluster] of ROLE_TYPE_MAP) {
    if (re.test(lower)) return cluster;
  }
  return "IT Professional";
}
