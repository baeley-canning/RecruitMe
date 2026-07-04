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
import {
  extractDistinctiveSignalsFromRequirement,
  extractRoleAwareDistinctiveAnchors,
  extractSignalsFromRequirement,
} from "./requirement-signals";
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

/** Specialist hybrid-role snippet cap. When a role has distinctive
 *  anchors (e.g. SCADA/PLC for a POWER engineer, ISO 27001/ISMS for a
 *  compliance manager) and the candidate's snippet shows ZERO of them,
 *  cap the provisional score below the snippet cutoff so the candidate
 *  is filtered. Generic "Technical Support Engineer" snippets must not
 *  pass for these roles just because title/location score reasonable. */
export const SPECIALIST_SNIPPET_NO_ANCHOR_CAP = 25;

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
  opts?: {
    /** What `result.snippet` actually holds. "snippet" (default) = a search-
     *  result blurb; "profile" = the candidate's FULL stored profile/CV text.
     *  Same deterministic matching either way — this only changes the honest
     *  wording of evidence lines, the caps (a full text that matches earns
     *  more trust than a snippet), and the nice-to-have score (real coverage
     *  instead of a flat unknown). */
    evidenceKind?: "snippet" | "profile";
  },
): ScoreBreakdown {
  const { requirementSignals, hasSignal, normaliseText } = deps;
  const fullEvidence = opts?.evidenceKind === "profile";
  const evidenceName = fullEvidence ? "stored profile/CV" : "search snippet";

  const baseMustHaves = parsedRole.must_haves?.length ? parsedRole.must_haves : parsedRole.skills_required;
  const knockouts = parsedRole.knockout_criteria ?? [];
  const mustHaves = [
    ...baseMustHaves,
    ...knockouts.filter((ko) => !baseMustHaves.some((mh) => mh.toLowerCase().includes(ko.toLowerCase().slice(0, 25)))),
  ].slice(0, 20);
  const niceToHaves = (parsedRole.nice_to_haves?.length ? parsedRole.nice_to_haves : parsedRole.skills_preferred).slice(0, 6);

  const profileText = [result.name, result.headline, candidateLocation, result.snippet].filter(Boolean).join("\n");
  const haystack = normaliseText(profileText);
  // Pre-compute the candidate's own signal set by running BOTH alias tables
  // over their haystack:
  //   - TECH expands "programmable logic controller" → PLC, "remote terminal
  //     unit" → RTU, "information security management system" → ISMS, etc.
  //   - DISTINCTIVE expands adjacent-domain phrases like "substation" →
  //     "power distribution" so a substation/HV candidate registers the same
  //     anchor a SCADA/HV role JD would emit.
  // Without DISTINCTIVE expansion, a "Substation commissioning engineer at
  // Vector" snippet has no overlap with a POWER role's anchor set even though
  // they're plainly adjacent — they get capped at 25 and silently filtered.
  const candidateSignals = new Set([
    ...extractSignalsFromRequirement(haystack),
    ...extractDistinctiveSignalsFromRequirement(haystack),
  ].map((s) => s.toLowerCase()));
  const matchesCandidate = (signal: string): boolean =>
    candidateSignals.has(signal.toLowerCase()) || hasSignal(haystack, signal);

  const mustHaveCoverage: MustHaveStatus[] = mustHaves.map((requirement) => {
    if (WORK_RIGHTS_RE.test(requirement)) {
      return provisionalWorkRightsStatus(requirement, candidateLocation);
    }
    const signals = requirementSignals(requirement);
    const matched = signals.filter(matchesCandidate);
    return {
      requirement,
      status: matched.length > 0 ? "likely" : "missing",
      evidence: matched.length > 0
        ? `${fullEvidence ? "Profile/CV text" : "Snippet/headline"} mentions ${matched.slice(0, 3).join(", ")}.`
        : `Not found in ${evidenceName}.`,
    };
  });

  const niceToHaveCoverage: NiceToHaveStatus[] = niceToHaves.map((requirement) => {
    const signals = requirementSignals(requirement);
    const matched = signals.filter(matchesCandidate);
    return {
      requirement,
      status: matched.length > 0 ? "likely" : "absent",
      evidence: matched.length > 0
        ? `${fullEvidence ? "Profile/CV text" : "Snippet/headline"} mentions ${matched.slice(0, 3).join(", ")}.`
        : `Not mentioned in ${evidenceName}.`,
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

  // Nice-to-have score: with full evidence we can report REAL coverage; a
  // snippet keeps the historical flat 45 ("unknown until the profile lands").
  const ntSupported = niceToHaveCoverage.filter((c) => c.status !== "absent").length;
  const ntRatio = niceToHaveCoverage.length ? ntSupported / niceToHaveCoverage.length : 0.5;
  const niceToHaveScore = fullEvidence ? Math.round(30 + ntRatio * 55) : 45;

  // Skill-fit cap: a snippet match is weak evidence (cap 75); a match found in
  // the full stored profile/CV is the real thing the AI scorer would read too,
  // so it earns a higher ceiling (85) while still never claiming AI certainty.
  const skillFitScore = fullEvidence
    ? Math.min(85, Math.round(35 + mustHaveRatio * 50))
    : Math.min(75, Math.round(35 + mustHaveRatio * 45));

  const supportedCount = mustHaveCoverage.filter((c) => c.status !== "missing" && c.status !== "unknown").length;

  const breakdown = buildScoreBreakdown({
    categories: {
      skill_fit:        { score: skillFitScore,                                        weight: weights?.skill_fit        ?? CATEGORY_WEIGHTS_V2.skill_fit,        evidence: fullEvidence ? `Deterministic keyword match against the ${evidenceName}: ${supportedCount}/${mustHaveCoverage.length} must-haves found.` : "Provisional score from LinkedIn search snippet." },
      location_fit:     { score: candidateLocation ? 75 : (isRemote ? 50 : 25),       weight: weights?.location_fit     ?? CATEGORY_WEIGHTS_V2.location_fit,     evidence: candidateLocation ? `${fullEvidence ? "Recorded" : "Search result"} location: ${candidateLocation}.` : `Location not available in ${evidenceName}.` },
      seniority_fit:    { score: seniorityScore,                                       weight: weights?.seniority_fit    ?? CATEGORY_WEIGHTS_V2.seniority_fit,    evidence: "Seniority inferred from headline only." },
      title_fit:        { score: Math.min(85, Math.max(35, 45 + titleMatches * 15)),  weight: weights?.title_fit        ?? CATEGORY_WEIGHTS_V2.title_fit,        evidence: `Title fit inferred from the ${fullEvidence ? "recorded headline" : "LinkedIn headline"}.` },
      domain_fit:       { score: Math.round((50 + Math.min(80, Math.round(35 + mustHaveRatio * 50))) / 2), weight: weights?.domain_fit ?? CATEGORY_WEIGHTS_V2.domain_fit, evidence: `Domain fit estimated from ${evidenceName} keywords.` },
      nice_to_have_fit: { score: niceToHaveScore,                                      weight: weights?.nice_to_have_fit ?? CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: fullEvidence ? `${ntSupported}/${niceToHaveCoverage.length} nice-to-haves found in the ${evidenceName}.` : "Nice-to-haves are provisional until the full profile is captured." },
    },
    must_have_coverage: mustHaveCoverage,
    nice_to_have_coverage: niceToHaveCoverage,
    reasons_for: fullEvidence
      ? [
          `Matched ${supportedCount} of ${mustHaveCoverage.length} must-haves by keyword against the stored profile/CV.`,
          result.headline ? `Headline: ${result.headline}.` : `Scored from the candidate's stored ${evidenceName} text.`,
        ]
      : [
          `${result.name} appears in LinkedIn search for this role.`,
          result.headline ? `Headline: ${result.headline}.` : "Search result includes a candidate profile.",
        ],
    reasons_against: fullEvidence
      ? ["Deterministic keyword score — it verifies terms are present, not how well they were used. Run an AI re-score for judgment on seniority arc and transferable skills."]
      : ["Only a LinkedIn search snippet is available; fetch the full profile for reliable scoring."],
    missing_evidence: fullEvidence
      ? ["AI assessment (optional — Re-score)", "Confirmed work rights"]
      : ["Full LinkedIn profile text", "Detailed experience history", "Confirmed work rights"],
    recruiter_summary: fullEvidence
      ? `Deterministic fit score from the stored profile/CV: ${supportedCount}/${mustHaveCoverage.length} must-haves matched by keyword. No AI was used — run a re-score for an AI read on nuance.`
      : "Provisional search match from a LinkedIn snippet. Fetch the full profile before treating the score as reliable.",
    profileCharCount: profileText.length,
    weights,
  });

  const provisionalScore = applyLocationFitOverride(breakdown, candidateLocation, targetLocation, locationRules, isRemote, weights);

  // Specialist hybrid-role cap: if the role has distinctive anchors (SCADA,
  // PLC, ISO 27001, etc.) and the candidate's haystack shows NONE of them,
  // cap below the snippet cutoff so it gets filtered.
  //
  // Matching: we run extractSignalsFromRequirement against the candidate's
  // haystack to expand alias forms — a candidate writing "information
  // security management system" gets recognised as ISMS, "programmable
  // logic controller" as PLC, "remote terminal unit" as RTU, etc. The
  // earlier implementation matched the SHORT alias literally against the
  // haystack and produced a false negative for every candidate who used
  // the long form (the agents found this on a re-audit).
  // Role-aware: hybrid IT-ops roles strip ISMS/ISO 27001 from the gate so
  // they don't cap candidates whose snippets lack the acronym. See
  // extractRoleAwareDistinctiveAnchors for the rationale.
  const distinctiveAnchors = new Set<string>(
    extractRoleAwareDistinctiveAnchors({
      title: parsedRole.title,
      requirements: [
        ...(parsedRole.must_haves ?? []),
        ...(parsedRole.skills_required ?? []),
        ...(parsedRole.knockout_criteria ?? []),
      ],
    }).map((t) => t.toLowerCase()),
  );
  if (distinctiveAnchors.size > 0) {
    // Reuse the candidateSignals set already built for coverage matching.
    const anyAnchorPresent = [...distinctiveAnchors].some((anchor) =>
      candidateSignals.has(anchor),
    );
    if (!anyAnchorPresent && provisionalScore.overall > SPECIALIST_SNIPPET_NO_ANCHOR_CAP) {
      (provisionalScore as { overall: number }).overall = SPECIALIST_SNIPPET_NO_ANCHOR_CAP;
      // Don't apply the floor below — caller will filter via SCORE_CUTOFF_SNIPPET.
      return provisionalScore;
    }
  }

  // Floor: a snippet that passed the source gate has enough signal to be
  // worth showing. Don't let missing fields collapse the score below the floor.
  if (provisionalScore.overall < PROVISIONAL_SCORE_FLOOR) {
    (provisionalScore as { overall: number }).overall = PROVISIONAL_SCORE_FLOOR;
  }
  return provisionalScore;
}
