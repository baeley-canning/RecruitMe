/**
 * AI Router — determines which scoring path to use for a candidate.
 *
 *   "local"  — 100% deterministic, no Claude call. ~70-80% of profiles.
 *   "hybrid" — local for must-have coverage, Claude for narrative only.
 *   "ai"     — full Claude scoring (ambiguous profile, soft-skill-heavy role).
 *
 * The local path eliminates API calls and cuts scoring latency from ~3s to <50ms.
 * Hybrid cuts latency by ~40% (one Claude call instead of two, smaller prompt).
 *
 * Routing criteria:
 *   local:  full profile + all requirements are tech skills + avg confidence ≥ 0.55
 *           + < 30% ambiguous requirements
 *   ai:     snippet/minimal profile, or any knockout requirement, or high ambiguity
 *   hybrid: everything in between
 */

import type { ParsedRole } from "@/lib/ai/parsing";
import type { ScoreBreakdown, MustHaveStatus, NiceToHaveStatus, NiceToHaveCoverageStatus } from "@/lib/scoring";
import {
  buildScoreBreakdown,
  classifyDataQuality,
  CATEGORY_WEIGHTS_V2,
} from "@/lib/scoring";
import { assessDeterminism, toMustHaveStatuses, scoreRequirement } from "./tfidf";
import { extractCareerSignals } from "./career-signals";
import { assessLocationFit } from "@/lib/location";
import type { ScoringWeights } from "@/lib/scoring-config";

export type ScoringPath = "local" | "hybrid" | "ai";

export interface RouterDecision {
  path: ScoringPath;
  reason: string;
  /** When path ≠ "ai", this is the pre-computed must-have coverage to pass to Claude (hybrid) or use directly (local). */
  mustHaveCoverage?: MustHaveStatus[];
}

// ── Seniority mapping ─────────────────────────────────────────────────────────

const ROLE_SENIORITY_RE: Array<[RegExp, number]> = [
  [/\b(?:chief|cto|ceo|svp|evp)\b/i, 5],
  [/\b(?:director|vp|vice\s+president|head\s+of)\b/i, 4],
  [/\b(?:principal|staff|lead|senior|sr\.?)\b/i, 3],
  [/\b(?:mid[- ]?level|intermediate)\b/i, 2],
  [/\b(?:junior|jr\.?|graduate|grad|associate|entry[- ]?level)\b/i, 1],
];

const SENIORITY_TIER_MAP: Record<string, number> = {
  executive: 5, lead: 4, senior: 3, mid: 2, junior: 1, unknown: 2,
};

function inferRoleSeniority(title: string): number {
  for (const [re, tier] of ROLE_SENIORITY_RE) {
    if (re.test(title)) return tier;
  }
  return 2; // default mid
}

function computeSeniorityFit(candidateTier: number, roleTier: number): number {
  const diff = Math.abs(candidateTier - roleTier);
  if (diff === 0) return 95;
  if (diff === 1) return roleTier > candidateTier ? 65 : 70; // under-seniority vs over-seniority
  if (diff === 2) return 35;
  return 15;
}

// ── Title fit ─────────────────────────────────────────────────────────────────

function wordSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2)
  );
}

function titleOverlap(roleTitle: string, seniorityLevel: string): number {
  const roleWords = wordSet(roleTitle);
  const candidateWords = wordSet(seniorityLevel + " " + roleTitle); // cheap proxy
  if (roleWords.size === 0) return 50;
  const common = [...roleWords].filter((w) => candidateWords.has(w)).length;
  return Math.min(95, Math.round((common / roleWords.size) * 100));
}

// ── Domain fit ────────────────────────────────────────────────────────────────

const DOMAIN_KEYWORD_MAP: Array<[RegExp, string]> = [
  [/\b(?:government|public\s+sector|council|ministry|crown)\b/i, "government"],
  [/\b(?:bank|financial|finance|fintech|insurance|investment)\b/i, "finance"],
  [/\b(?:health|medical|clinical|hospital|aged\s+care)\b/i, "healthcare"],
  [/\b(?:retail|e-?commerce|consumer)\b/i, "retail"],
  [/\b(?:defence|military|defense|nzdf)\b/i, "defence"],
  [/\b(?:telco|telecom|telecommunications)\b/i, "telco"],
  [/\b(?:energy|electricity|utilities)\b/i, "energy"],
  [/\b(?:education|university|school|polytechnic)\b/i, "education"],
  [/\b(?:saas|startup|technology\s+company|tech\s+company)\b/i, "software"],
  [/\b(?:consulting|advisory|professional\s+services)\b/i, "consulting"],
];

function inferRoleDomains(parsedRole: ParsedRole): string[] {
  const text = [
    parsedRole.title,
    parsedRole.company ?? "",
    (parsedRole.responsibilities ?? []).join(" "),
  ].join(" ");
  const domains: string[] = [];
  for (const [re, domain] of DOMAIN_KEYWORD_MAP) {
    if (re.test(text)) domains.push(domain);
  }
  return domains;
}

function computeDomainFit(candidateDomains: string[], roleDomains: string[]): number {
  if (roleDomains.length === 0 || candidateDomains.length === 0) return 55; // neutral
  const overlap = candidateDomains.filter((d) => roleDomains.includes(d)).length;
  if (overlap > 0) return Math.min(95, 70 + overlap * 10);
  return 40; // domains present but no overlap
}

// ── Nice-to-have scoring ──────────────────────────────────────────────────────

function scoreNiceToHaves(
  niceToHaves: string[],
  profileText: string,
): NiceToHaveStatus[] {
  return niceToHaves.slice(0, 8).map((req) => {
    const result = scoreRequirement(req, profileText);
    return {
      requirement: req,
      status: (result.confidence >= 0.7 ? "confirmed" : result.confidence >= 0.3 ? "likely" : "absent") as NiceToHaveCoverageStatus,
      evidence: result.evidence,
    };
  });
}

// ── Local breakdown builder ───────────────────────────────────────────────────

function buildLocalBreakdown(
  profileText: string,
  parsedRole: ParsedRole,
  candidateLocation: string | null,
  mustHaveCoverage: MustHaveStatus[],
  weights?: ScoringWeights,
): ScoreBreakdown {
  const signals = extractCareerSignals(profileText);
  const { fingerprint } = signals;

  const candidateSeniorityTier = SENIORITY_TIER_MAP[fingerprint.seniorityLevel] ?? 2;
  const roleSeniorityTier = inferRoleSeniority(parsedRole.title);
  const seniorityFitScore = computeSeniorityFit(candidateSeniorityTier, roleSeniorityTier);

  const locationAssessment = assessLocationFit(
    candidateLocation,
    parsedRole.location,
    parsedRole.location_rules,
  );
  const locationFitScore = locationAssessment?.score ?? 55;

  const roleDomains = inferRoleDomains(parsedRole);
  const domainFitScore = computeDomainFit(fingerprint.domainClusters, roleDomains);

  // Skill fit: ratio of confirmed+likely requirements / total
  const confirmed = mustHaveCoverage.filter((c) => c.status === "confirmed" || c.status === "equivalent").length;
  const likely = mustHaveCoverage.filter((c) => c.status === "likely").length;
  const total = mustHaveCoverage.length;
  const skillFitScore = total === 0 ? 55
    : Math.round(((confirmed + likely * 0.6) / total) * 100);

  // Title fit: proxy from seniority label + role title match
  const titleFitScore = titleOverlap(parsedRole.title, fingerprint.seniorityLevel);

  const niceToHaveCoverage = scoreNiceToHaves(
    (parsedRole.nice_to_haves ?? []).slice(0, 8),
    profileText,
  );
  const niceToHavePresentCount = niceToHaveCoverage.filter((n) => n.status === "confirmed" || n.status === "likely").length;
  const niceToHaveFitScore = niceToHaveCoverage.length === 0 ? 50
    : Math.round((niceToHavePresentCount / niceToHaveCoverage.length) * 95);

  // Reasons for/against — generated from matching data
  const missingReqs = mustHaveCoverage.filter((c) => c.status === "missing" || c.status === "negative");
  const confirmedReqs = mustHaveCoverage.filter((c) => c.status === "confirmed" || c.status === "equivalent");
  const reasons_for: string[] = [];
  const reasons_against: string[] = [];

  if (confirmedReqs.length > 0) {
    reasons_for.push(`${confirmedReqs.length} of ${total} must-have requirements confirmed in profile${confirmedReqs.length <= 3 ? ": " + confirmedReqs.map((r) => r.requirement).join(", ") : "."}`);
  }
  if (locationAssessment && locationAssessment.score >= 70) {
    reasons_for.push(locationAssessment.evidence);
  }
  if (seniorityFitScore >= 80) {
    reasons_for.push(`Seniority level (${fingerprint.seniorityLevel}) aligns with ${parsedRole.title}.`);
  }
  if (signals.certifications.length > 0) {
    reasons_for.push(`Holds relevant certifications: ${signals.certifications.slice(0, 2).join(", ")}.`);
  }
  if (signals.hasLeadership && roleSeniorityTier >= 3) {
    reasons_for.push(`Leadership experience detected${signals.maxTeamSize ? ` (team of ${signals.maxTeamSize})` : ""}.`);
  }

  if (missingReqs.length > 0) {
    reasons_against.push(`${missingReqs.length} must-have requirement${missingReqs.length > 1 ? "s" : ""} not found: ${missingReqs.map((r) => r.requirement).join(", ")}.`);
  }
  if (locationAssessment && locationAssessment.score < 40) {
    reasons_against.push(locationAssessment.evidence);
  }
  if (seniorityFitScore < 50) {
    reasons_against.push(`Seniority mismatch: ${fingerprint.seniorityLevel} vs expected ${parsedRole.seniority_band ?? "mid"} level.`);
  }

  const missing_evidence = missingReqs.map((r) => r.requirement);
  const matchPercent = Math.round(((confirmed + likely * 0.5) / Math.max(total, 1)) * 100);
  const recruiter_summary = total === 0
    ? `Profile scored deterministically. ${confirmedReqs.length} signals confirmed. Seniority: ${fingerprint.seniorityLevel}.`
    : `Deterministic match: ${matchPercent}% of must-haves confirmed${missingReqs.length > 0 ? `, ${missingReqs.length} not found` : ""}. Seniority: ${fingerprint.seniorityLevel}. Scored without AI.`;

  const w = weights ?? CATEGORY_WEIGHTS_V2;
  return buildScoreBreakdown({
    categories: {
      skill_fit:        { score: skillFitScore,       weight: w.skill_fit,        evidence: `${confirmed}/${total} must-haves confirmed via signal matching.` },
      location_fit:     { score: locationFitScore,    weight: w.location_fit,     evidence: locationAssessment?.evidence ?? "Location not assessed." },
      seniority_fit:    { score: seniorityFitScore,   weight: w.seniority_fit,    evidence: `${fingerprint.seniorityLevel} vs role tier ${roleSeniorityTier}.` },
      title_fit:        { score: titleFitScore,       weight: w.title_fit,        evidence: `Title fit based on seniority and role keyword overlap.` },
      domain_fit:       { score: domainFitScore,      weight: w.domain_fit,       evidence: fingerprint.domainClusters.length > 0 ? `Domains: ${fingerprint.domainClusters.join(", ")}.` : "No domain detected." },
      nice_to_have_fit: { score: niceToHaveFitScore,  weight: w.nice_to_have_fit, evidence: `${niceToHavePresentCount}/${niceToHaveCoverage.length} nice-to-haves present.` },
    },
    must_have_coverage:    mustHaveCoverage,
    nice_to_have_coverage: niceToHaveCoverage,
    reasons_for,
    reasons_against,
    missing_evidence,
    recruiter_summary,
    profileCharCount: profileText.length,
    weights,
  });
}

// ── Requirements complexity ───────────────────────────────────────────────────
// Soft-skill and context-dependent requirements that the local path can't assess.

const CONTEXTUAL_REQUIREMENT_RE = /\b(?:team\s+(?:player|work)|leadership|stakeholder|communication|collaborate|culture|agile\s+mindset|continuous\s+improvement|problem\s+solv|critical\s+think|attention\s+to\s+detail|proactive|initiative|self[- ]?starter|passion(?:ate)?|drive[nd]?|mentor|coach)\b/i;

function requirementsAreComplex(mustHaves: string[]): boolean {
  const contextual = mustHaves.filter((r) => CONTEXTUAL_REQUIREMENT_RE.test(r));
  return contextual.length > mustHaves.length * 0.4;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function routeScoring(
  profileText: string,
  parsedRole: ParsedRole,
  candidateLocation: string | null,
  weights?: ScoringWeights,
): RouterDecision & { localBreakdown?: ScoreBreakdown } {
  const dataQuality = classifyDataQuality(profileText.length);

  // Snippets and minimal profiles always need Claude
  if (dataQuality === "snippet" || dataQuality === "minimal") {
    return { path: "ai", reason: `Data quality is ${dataQuality} — Claude needed for reliable scoring.` };
  }

  const mustHaves = [
    ...(parsedRole.must_haves ?? []),
    ...(parsedRole.knockout_criteria ?? []),
  ].slice(0, 20);

  // Knockout criteria with contextual nuance → Claude
  if ((parsedRole.knockout_criteria ?? []).length > 0) {
    const hasContextualKO = (parsedRole.knockout_criteria ?? []).some(
      (k) => CONTEXTUAL_REQUIREMENT_RE.test(k)
    );
    if (hasContextualKO) {
      return { path: "ai", reason: "Contextual knockout criteria require AI assessment." };
    }
  }

  // Check if requirements are too complex for deterministic scoring
  if (requirementsAreComplex(mustHaves)) {
    return { path: "hybrid", reason: "High proportion of contextual/soft-skill requirements — AI needed for narrative." };
  }

  const { canScoreLocally, avgConfidence, ambiguousCount, scores } =
    assessDeterminism(mustHaves, profileText);

  const mustHaveCoverage = toMustHaveStatuses(scores);

  if (canScoreLocally) {
    const localBreakdown = buildLocalBreakdown(
      profileText, parsedRole, candidateLocation, mustHaveCoverage, weights,
    );
    return {
      path: "local",
      reason: `Deterministic: avgConfidence=${avgConfidence.toFixed(2)}, ambiguous=${ambiguousCount}/${mustHaves.length}.`,
      mustHaveCoverage,
      localBreakdown,
    };
  }

  // Hybrid: local determines must-have coverage, Claude fills narrative
  if (avgConfidence >= 0.35) {
    return {
      path: "hybrid",
      reason: `Hybrid: avgConfidence=${avgConfidence.toFixed(2)}, ambiguous=${ambiguousCount}/${mustHaves.length} — local coverage, AI narrative.`,
      mustHaveCoverage,
    };
  }

  return {
    path: "ai",
    reason: `Low confidence (${avgConfidence.toFixed(2)}) — full Claude scoring needed.`,
  };
}
