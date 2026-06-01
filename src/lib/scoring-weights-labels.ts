/**
 * Client-safe scoring-weight labels.
 *
 * These are pure presentation strings, kept OUT of `scoring-config.ts` because
 * that module imports `prisma` (./db). A client component that value-imported
 * the labels from there dragged PrismaClient into the browser bundle and the
 * page crashed with "PrismaClient is unable to run in this browser environment".
 * Importing the type below is erased at build time, so this module has no
 * runtime dependency on scoring-config (or prisma) and is safe for "use client".
 */
import type { ScoringWeights } from "./scoring-config";

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
