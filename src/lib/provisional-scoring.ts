/**
 * Provisional search-snippet scoring.
 *
 * When a candidate comes from a LinkedIn search result (name, headline,
 * location, snippet — no full profile text), we can't call Claude for a
 * full structured score. Instead we build a ScoreBreakdown from keyword
 * signal matching and simple heuristics. The result is clearly marked as
 * provisional and carries a 30% floor so the candidate lands in the list
 * for the recruiter to evaluate, not silently dropped.
 *
 * Thresholds used by the search route's import gates are exported here so
 * they're one edit away from the logic that produces the scores.
 */

import {
  buildScoreBreakdown,
  CATEGORY_WEIGHTS_V2,
  type MustHaveStatus,
  type NiceToHaveStatus,
} from "./scoring";
import { applyLocationFitOverride } from "./score-utils";
import { isNzLocation } from "./location";
import type { ParsedRole } from "./ai";
import type { ScoringWeights } from "./scoring-config";
import type { ScoreBreakdown } from "./scoring";

// ── Shared score-gate thresholds ────────────────────────────────────────────
// Exported so the search route and any future callers use the same numbers.

/** Full-profile candidates below this are dropped for specialist roles. */
export const SCORE_CUTOFF_FULL_PROFILE = 45;

/** Snippet candidates below this are dropped for specialist roles.
 *  Lower because provisional scores are conservative by design. */
export const SCORE_CUTOFF_SNIPPET = 30;

/** Minimum overall score for any imported snippet candidate.
 *  A snippet that passed the source gate has enough signal to be worth
 *  showing — don't let missing fields collapse the score below this. */
export const PROVISIONAL_SCORE_FLOOR = 30;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SearchSnippet {
  name: string;
  headline: string | null | undefined;
  snippet: string | null | undefined;
}

// requirementSignals / hasSignal / normaliseText are defined in search/route.ts
// inline helpers. They're passed as callbacks so this module doesn't need to
// import from a 1200-line route file.
type SignalFn  = (req: string) => string[];
type MatchFn   = (haystack: string, signal: string) => boolean;
type NormFn    = (text: string) => string;

// ── Work-rights shortcut ─────────────────────────────────────────────────────
// NZ citizenship / work rights requirements can be provisionally assessed from
// the candidate's location alone (NZ-based → likely eligible) because the full
// answer lives in the extension/profile capture, not the snippet.
const WORK_RIGHTS_RE = /right to work|work rights|nz citizen|nz resident|\bvisa\b|work in new zealand/i;

function provisionalWorkRightsStatus(
  requirement: string,
  candidateLocation: string | null | undefined,
): MustHaveStatus {
  const nzBased = Boolean(candidateLocation && isNzLocation(candidateLocation));
  return {
    requirement,
    status: nzBased ? "likely" : "unknown",
    evidence: nzBased
      ? `Candidate appears NZ-based (${candidateLocation}); work rights still need confirmation.`
      : "Search snippet does not verify work rights.",
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

export function buildProvisionalSearchScore(
  result: SearchSnippet,
  parsedRole: ParsedRole,
  candidateLocation: string | null | undefined,
  targetLocation: string,
  locationRules: string | null | undefined,
  isRemote: boolean,
  weights: ScoringWeights | undefined,
  // Signal helpers injected so this module stays side-effect-free.
  deps: { requirementSignals: SignalFn; hasSignal: MatchFn; normaliseText: NormFn },
): ScoreBreakdown {
  const { requirementSignals, hasSignal, normaliseText } = deps;

  const baseMustHaves = parsedRole.must_haves?.length ? parsedRole.must_haves : parsedRole.skills_required;
  const knockouts = parsedRole.knockout_criteria ?? [];
  const mustHaves = [
    ...baseMustHaves,
    ...knockouts.filter((ko) => !baseMustHaves.some((mh) => mh.toLowerCase().includes(ko.toLowerCase().slice(0, 25)))),
  ].slice(0, 14);
  const niceToHaves = (parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : parsedRole.skills_preferred).slice(0, 6);

  const profileText = [result.name, result.headline, candidateLocation, result.snippet].filter(Boolean).join("\n");
  const haystack = normaliseText(profileText);

  const mustHaveCoverage: MustHaveStatus[] = mustHaves.map((requirement) => {
    if (WORK_RIGHTS_RE.test(requirement)) {
      return provisionalWorkRightsStatus(requirement, candidateLocation);
    }
    const signals = requirementSignals(requirement);
    const matched = signals.filter((signal) => hasSignal(haystack, signal));
    return {
      requirement,
      status: matched.length > 0 ? "likely" : "missing",
      evidence: matched.length > 0
        ? `Snippet/headline mentions ${matched.slice(0, 3).join(", ")}.`
        : "Not found in search snippet.",
    };
  });

  const niceToHaveCoverage: NiceToHaveStatus[] = niceToHaves.map((requirement) => {
    const signals = requirementSignals(requirement);
    const matched = signals.filter((signal) => hasSignal(haystack, signal));
    return {
      requirement,
      status: matched.length > 0 ? "likely" : "absent",
      evidence: matched.length > 0
        ? `Snippet/headline mentions ${matched.slice(0, 3).join(", ")}.`
        : "Not mentioned in search snippet.",
    };
  });

  const supported = mustHaveCoverage.filter((c) =>
    c.status === "confirmed" || c.status === "equivalent" || c.status === "likely"
  ).length;
  const mustHaveRatio = mustHaveCoverage.length ? supported / mustHaveCoverage.length : 0.5;

  const titleSignals = requirementSignals(parsedRole.title);
  const titleMatches = titleSignals.filter((s) =>
    hasSignal(normaliseText(`${result.headline ?? ""} ${result.name}`), s)
  ).length;

  const seniorityText = normaliseText(result.headline ?? "");
  const wantedSeniority = (parsedRole.seniority_band ?? "").toLowerCase();
  const seniorityScore =
    wantedSeniority.includes("junior") && /\b(senior|lead|principal|head|manager|director)\b/.test(seniorityText) ? 45 :
    wantedSeniority.includes("senior") && /\b(junior|graduate|intern)\b/.test(seniorityText) ? 45 :
    70;

  const breakdown = buildScoreBreakdown({
    categories: {
      skill_fit:        { score: Math.min(75, Math.round(35 + mustHaveRatio * 45)),    weight: weights?.skill_fit        ?? CATEGORY_WEIGHTS_V2.skill_fit,        evidence: "Provisional score from LinkedIn search snippet." },
      location_fit:     { score: candidateLocation ? 75 : (isRemote ? 50 : 25),       weight: weights?.location_fit     ?? CATEGORY_WEIGHTS_V2.location_fit,     evidence: candidateLocation ? `Search result location: ${candidateLocation}.` : "Location not available in search snippet." },
      seniority_fit:    { score: seniorityScore,                                       weight: weights?.seniority_fit    ?? CATEGORY_WEIGHTS_V2.seniority_fit,    evidence: "Seniority inferred from headline only." },
      title_fit:        { score: Math.min(85, Math.max(35, 45 + titleMatches * 15)),  weight: weights?.title_fit        ?? CATEGORY_WEIGHTS_V2.title_fit,        evidence: "Title fit inferred from LinkedIn headline." },
      domain_fit:       { score: Math.round((50 + Math.min(80, Math.round(35 + mustHaveRatio * 50))) / 2), weight: weights?.domain_fit ?? CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Domain fit estimated provisionally from snippet keywords." },
      nice_to_have_fit: { score: 45,                                                   weight: weights?.nice_to_have_fit ?? CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Nice-to-haves are provisional until the full profile is captured." },
    },
    must_have_coverage: mustHaveCoverage,
    nice_to_have_coverage: niceToHaveCoverage,
    reasons_for: [
      `${result.name} appears in LinkedIn search for this role.`,
      result.headline ? `Headline: ${result.headline}.` : "Search result includes a candidate profile.",
    ],
    reasons_against: ["Only a LinkedIn search snippet is available; fetch the full profile for reliable scoring."],
    missing_evidence: ["Full LinkedIn profile text", "Detailed experience history", "Confirmed work rights"],
    recruiter_summary: "Provisional search match from a LinkedIn snippet. Fetch the full profile before treating the score as reliable.",
    profileCharCount: profileText.length,
    weights,
  });

  const provisionalScore = applyLocationFitOverride(breakdown, candidateLocation, targetLocation, locationRules, isRemote, weights);

  // Floor: a snippet that passed the source gate has enough signal to be
  // worth showing. Don't let missing fields collapse the score below the floor.
  if (provisionalScore.overall < PROVISIONAL_SCORE_FLOOR) {
    (provisionalScore as { overall: number }).overall = PROVISIONAL_SCORE_FLOOR;
  }
  return provisionalScore;
}
