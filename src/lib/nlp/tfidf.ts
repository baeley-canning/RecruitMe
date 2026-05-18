/**
 * Requirement-to-profile confidence scorer.
 *
 * For each must-have requirement, produces a confidence score (0–1) that
 * indicates how certain we are about the candidate's coverage:
 *   ≥ 0.70 → confirmed
 *   0.40–0.69 → likely
 *   < 0.40 → missing (or unknown for partial profiles)
 *
 * Combines three signal layers:
 *   1. Direct match via signalMatchesText (binary, highest weight)
 *   2. Skills graph equivalents/implications
 *   3. TF-IDF token overlap (fallback for unrecognised terms)
 */

import { extractSignalsFromRequirement, signalMatchesText } from "@/lib/requirement-signals";
import { getEquivalents, getImplied } from "./skills-graph";
import type { MustHaveStatus } from "@/lib/scoring";
import type { MustHaveCoverageStatus } from "@/lib/scoring";

const CONFIRMED_THRESHOLD = 0.70;
const LIKELY_THRESHOLD    = 0.40;

// ── TF-IDF helpers ────────────────────────────────────────────────────────────

function tokenise(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) ?? [];
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "has", "have", "had", "are", "was", "were",
  "will", "can", "this", "that", "they", "them", "from", "into", "through",
  "using", "used", "use", "strong", "good", "experience", "knowledge",
  "understanding", "ability", "skills", "proven", "demonstrated",
  "excellent", "solid", "deep", "broad",
]);

function getTerms(text: string): Set<string> {
  return new Set(tokenise(text).filter((t) => t.length > 2 && !STOP_WORDS.has(t)));
}

// ── TF-IDF: simple term-frequency score ───────────────────────────────────────
// For each term in the requirement, check whether it appears in the profile.
// Score = fraction of requirement terms found in profile.
function tokenOverlapScore(requirement: string, profileText: string): number {
  const reqTerms  = getTerms(requirement);
  const profTerms = getTerms(profileText);
  if (reqTerms.size === 0) return 0;
  let matched = 0;
  for (const term of reqTerms) {
    if (profTerms.has(term)) matched++;
  }
  return matched / reqTerms.size;
}

// ── Per-requirement confidence ────────────────────────────────────────────────

export interface RequirementScore {
  requirement: string;
  confidence: number;          // 0–1
  status: MustHaveCoverageStatus;
  evidence: string;            // short snippet or empty
  matchedVia: "direct" | "equivalent" | "implied" | "token_overlap" | "none";
}

export function scoreRequirement(
  requirement: string,
  profileText: string,
): RequirementScore {
  const signals = extractSignalsFromRequirement(requirement);

  // Layer 1: direct signal match
  for (const signal of signals) {
    if (signalMatchesText(profileText, signal)) {
      const snippetPos = profileText.toLowerCase().indexOf(signal.toLowerCase());
      const evidence = snippetPos >= 0
        ? profileText.slice(Math.max(0, snippetPos - 20), snippetPos + signal.length + 20).trim()
        : signal;
      return {
        requirement,
        confidence: 0.95,
        status: "confirmed",
        evidence: evidence.slice(0, 80),
        matchedVia: "direct",
      };
    }
  }

  // Layer 2: skills-graph equivalent / implied
  for (const signal of signals) {
    const equivalents = getEquivalents(signal);
    for (const eq of equivalents) {
      if (signalMatchesText(profileText, eq)) {
        return {
          requirement,
          confidence: 0.85,
          status: "confirmed",
          evidence: `via equivalent: ${eq}`,
          matchedVia: "equivalent",
        };
      }
    }
    const implied = getImplied(signal);
    for (const { skill: imp, weight } of implied) {
      if (signalMatchesText(profileText, imp) && weight >= 0.7) {
        return {
          requirement,
          confidence: weight * 0.8,
          status: weight >= 0.85 ? "confirmed" : "likely",
          evidence: `via implication: ${imp}`,
          matchedVia: "implied",
        };
      }
    }
  }

  // Layer 3: token overlap (for soft-skill and non-tech requirements)
  const overlap = tokenOverlapScore(requirement, profileText);
  if (overlap >= 0.6) {
    return {
      requirement,
      confidence: overlap * 0.7, // cap at 0.42 — enough for "likely" but not "confirmed"
      status: "likely",
      evidence: "",
      matchedVia: "token_overlap",
    };
  }

  // No match found
  return {
    requirement,
    confidence: overlap * 0.5,
    status: "missing",
    evidence: "",
    matchedVia: "none",
  };
}

// ── Score all requirements ────────────────────────────────────────────────────

export function scoreMustHaves(
  mustHaves: string[],
  profileText: string,
): RequirementScore[] {
  return mustHaves.map((req) => scoreRequirement(req, profileText));
}

// ── Convert to MustHaveStatus for ScoreBreakdown ─────────────────────────────

export function toMustHaveStatuses(scores: RequirementScore[]): MustHaveStatus[] {
  return scores.map((s) => ({
    requirement: s.requirement,
    status: s.status,
    evidence: s.evidence,
  }));
}

// ── Overall determinism assessment ───────────────────────────────────────────
// Returns a confidence that the local scoring path can handle this profile+role.
// High = we can skip Claude; Low = Claude is needed.

export interface DeterminismAssessment {
  canScoreLocally: boolean;
  avgConfidence: number;
  ambiguousCount: number;  // requirements in the 0.4–0.7 range
  scores: RequirementScore[];
}

export function assessDeterminism(
  mustHaves: string[],
  profileText: string,
): DeterminismAssessment {
  if (mustHaves.length === 0) {
    return { canScoreLocally: true, avgConfidence: 1.0, ambiguousCount: 0, scores: [] };
  }

  const scores = scoreMustHaves(mustHaves, profileText);
  const avg = scores.reduce((s, r) => s + r.confidence, 0) / scores.length;
  const ambiguous = scores.filter(
    (s) => s.confidence >= LIKELY_THRESHOLD && s.confidence < CONFIRMED_THRESHOLD
  ).length;

  // Can score locally when:
  // - average confidence is high (most requirements clearly confirmed/missing)
  // - few ambiguous requirements (< 30% in the uncertain band)
  const ambiguousRatio = ambiguous / scores.length;
  const canScoreLocally =
    avg >= 0.55 &&
    ambiguousRatio < 0.30 &&
    profileText.length >= 1500;

  return { canScoreLocally, avgConfidence: avg, ambiguousCount: ambiguous, scores };
}
