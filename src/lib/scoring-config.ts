import { prisma } from "./db";
import { safeParseJson } from "./utils";

export interface ScoringWeights {
  must_have:        number; // 0–1, contribution of must-have coverage
  skill_fit:        number;
  location_fit:     number;
  seniority_fit:    number;
  title_fit:        number;
  domain_fit:       number;
  nice_to_have_fit: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  must_have:        0.36,
  skill_fit:        0.22,
  location_fit:     0.08,
  seniority_fit:    0.10,
  title_fit:        0.08,
  domain_fit:       0.10,
  nice_to_have_fit: 0.06,
};

export const WEIGHT_LABELS: Record<keyof ScoringWeights, string> = {
  must_have:        "Must-have coverage",
  skill_fit:        "Skill fit",
  seniority_fit:    "Seniority fit",
  domain_fit:       "Domain fit",
  location_fit:     "Location fit",
  title_fit:        "Title fit",
  nice_to_have_fit: "Nice-to-haves",
};

export const WEIGHT_DESCRIPTIONS: Record<keyof ScoringWeights, string> = {
  must_have:        "How much of the listed must-haves the candidate can demonstrably cover",
  skill_fit:        "Technical and role-specific skill alignment across the whole profile",
  seniority_fit:    "Career level relative to the role's seniority expectation",
  domain_fit:       "Sector/domain experience and vocabulary alignment with the role",
  location_fit:     "Geographic proximity to the role's required location",
  title_fit:        "How closely past job titles match the target role family",
  nice_to_have_fit: "Coverage of preferred (non-essential) skills and experience",
};

function settingKey(orgId: string | null | undefined) {
  return orgId ? `SCORING_WEIGHTS_V1:${orgId}` : "SCORING_WEIGHTS_V1:default";
}

function readWeight(raw: Partial<ScoringWeights> | null | undefined, key: keyof ScoringWeights): number {
  const value = raw?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : DEFAULT_SCORING_WEIGHTS[key];
}

export function normaliseWeights(raw: Partial<ScoringWeights>): ScoringWeights {
  const cleaned: ScoringWeights = {
    must_have:        readWeight(raw, "must_have"),
    skill_fit:        readWeight(raw, "skill_fit"),
    location_fit:     readWeight(raw, "location_fit"),
    seniority_fit:    readWeight(raw, "seniority_fit"),
    title_fit:        readWeight(raw, "title_fit"),
    domain_fit:       readWeight(raw, "domain_fit"),
    nice_to_have_fit: readWeight(raw, "nice_to_have_fit"),
  };
  const total = Object.values(cleaned).reduce((s, v) => s + v, 0);
  if (total === 0) return DEFAULT_SCORING_WEIGHTS;
  const factor = 1 / total;
  return {
    must_have:        cleaned.must_have        * factor,
    skill_fit:        cleaned.skill_fit        * factor,
    location_fit:     cleaned.location_fit     * factor,
    seniority_fit:    cleaned.seniority_fit    * factor,
    title_fit:        cleaned.title_fit        * factor,
    domain_fit:       cleaned.domain_fit       * factor,
    nice_to_have_fit: cleaned.nice_to_have_fit * factor,
  };
}

export async function getOrgScoringWeights(orgId: string | null | undefined): Promise<ScoringWeights> {
  try {
    const key = settingKey(orgId);
    const row = await prisma.setting.findUnique({ where: { key } });
    if (!row) return DEFAULT_SCORING_WEIGHTS;
    const parsed = safeParseJson<ScoringWeights>(row.value, DEFAULT_SCORING_WEIGHTS);
    return normaliseWeights(parsed);
  } catch {
    return DEFAULT_SCORING_WEIGHTS;
  }
}

export async function saveOrgScoringWeights(orgId: string | null | undefined, weights: ScoringWeights): Promise<void> {
  const key = settingKey(orgId);
  const normalised = normaliseWeights(weights);
  await prisma.setting.upsert({
    where:  { key },
    update: { value: JSON.stringify(normalised) },
    create: { key, value: JSON.stringify(normalised) },
  });
}
