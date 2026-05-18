/**
 * Pure decision logic for the per-candidate badge set introduced in PR 4.
 *
 * Inputs are a normalised CandidateBadgeState (server-shaped) plus the
 * current viewing context (job-detail page vs library list). Output is an
 * ordered array of BadgeDescriptor entries the React layer renders.
 *
 * Lives separately from the React component so the rule-set has its own
 * tested behaviour, free from JSX dependency drag and unit-testable
 * without DOM.
 *
 * Badge meanings (the plan's §F mapping):
 *
 *   library_only    — no current-job score for this candidate. The score
 *                     badge in the UI must render "—", never a tier colour
 *                     from another role. This badge labels that state.
 *
 *   scored          — matchScore is current for THIS job AND
 *                     profileTextHash matches the candidate's hash now.
 *                     Render the tier-coloured number.
 *
 *   needs_rescore   — matchScore exists, but profileTextHash mismatches.
 *                     Surface as a warning pill so the recruiter sees the
 *                     score is stale before acting on it.
 *
 *   insight_reused  — extracted insight EXISTS for this identity at a
 *                     usable extractionVersion, AND wasn't extracted as
 *                     part of this job's most recent scoring run. Renders
 *                     neutral so it doesn't shout.
 *
 *   from_jobadder   — `source === "jobadder_import"`. Warning tone only
 *                     when profileText is empty (the Bede class). Else
 *                     neutral provenance tag.
 *
 * Multi-badge ordering: highest-priority badges come first so the row
 * stays scannable. Order: needs_rescore > library_only > insight_reused
 * > scored > from_jobadder. Render order is what the React layer iterates.
 */

export interface CandidateBadgeState {
  /** Match score for the current job context. null when no role context
   *  (library list) OR no scoring has happened yet. */
  matchScore: number | null | undefined;
  /** Hash stored alongside matchScore at scoring time. */
  scoredProfileTextHash: string | null | undefined;
  /** Hash of the candidate's CURRENT profileText. Compare to scoredProfileTextHash
   *  to detect "stale score" without adding a new column. */
  currentProfileTextHash: string | null | undefined;
  /** Source provenance from Candidate.source. */
  source: string | null | undefined;
  /** Did profileText come up empty/missing — the Bede shape? */
  profileTextEmpty: boolean;
  /** Whether a ProfileInsight row exists and is at the version Stage 1
   *  ranker would accept. Caller decides this (server-side) — the badge
   *  helper doesn't reach into the DB. */
  hasUsableInsight: boolean;
  /** True when the insight was reused from an existing row vs freshly
   *  extracted for this job's pull. Used to drive the "Insight reused" pill. */
  insightWasReused: boolean;
  /** "job" if a current Job is being viewed (the page knows the job context);
   *  "library" for the standalone library list / cross-role view. */
  context: "job" | "library";
}

export type BadgeKind =
  | "library_only"
  | "scored"
  | "needs_rescore"
  | "insight_reused"
  | "from_jobadder";

export type BadgeTone = "neutral" | "accent" | "warning" | "danger";

export interface BadgeDescriptor {
  kind: BadgeKind;
  label: string;
  tone: BadgeTone;
  /** Tooltip body. The §F plan calls for unambiguous wording so the
   *  recruiter never confuses "Insight reused" with "score reused".
   *  Keep these tooltips short, factual, and free of jargon. */
  tooltip: string;
}

const BADGE_PRIORITY: Record<BadgeKind, number> = {
  needs_rescore: 1,
  library_only: 2,
  insight_reused: 3,
  scored: 4,
  from_jobadder: 5,
};

/**
 * Decide which badges apply to a candidate. Order is by BADGE_PRIORITY
 * so highest-attention pills come first. Pure function — no IO.
 */
export function decideBadges(state: CandidateBadgeState): BadgeDescriptor[] {
  const out: BadgeDescriptor[] = [];

  // Library context: no role-fit info shown. The score badge in the
  // candidate-card UI displays "—" instead of a tier number — see plan §F
  // single design rule.
  if (state.context === "library" || state.matchScore == null) {
    out.push({
      kind: "library_only",
      label: "Library only",
      tone: "neutral",
      tooltip: "No role fit yet — open from a job to score this candidate.",
    });
  }

  // Stale score detection. Two equivalent shapes for "scored but profile
  // changed since" — the codebase convention (existing in candidate-card.tsx)
  // is that profileTextHash is CLEARED when profileText is updated, then
  // re-set on the next scoring run. So:
  //   (a) matchScore != null AND scoredProfileTextHash == null
  //   (b) both hashes present, mismatch
  // Either way the score is stale. (a) is the historical signal the card
  // already renders as a small dot; (b) is the future-state signal once
  // server-side hash comparison is wired up.
  // Critic B §8b — surface the existing hash mismatch, not a new column.
  const hashCleared =
    state.matchScore != null && state.scoredProfileTextHash == null;
  const hashMismatch =
    state.matchScore != null &&
    state.scoredProfileTextHash != null &&
    state.currentProfileTextHash != null &&
    state.scoredProfileTextHash !== state.currentProfileTextHash;
  const staleHash = hashCleared || hashMismatch;
  if (staleHash) {
    out.push({
      kind: "needs_rescore",
      label: "Needs rescore",
      tone: "warning",
      tooltip: "Profile changed since the last scoring run. The score below is stale until you re-score.",
    });
  }

  // Fresh score for this job context. Suppressed when also Library-only —
  // those two are mutually exclusive (the library-only branch above
  // catches matchScore == null).
  if (state.context === "job" && state.matchScore != null && !staleHash) {
    out.push({
      kind: "scored",
      label: "Scored",
      tone: "accent",
      tooltip: "Match score is current for this role and this candidate's profile.",
    });
  }

  // Universal insight surfaced. Neutral on purpose — this should be the
  // default-happy state once backfill steady-state runs and shouldn't
  // visually shout.
  if (state.hasUsableInsight && state.insightWasReused) {
    out.push({
      kind: "insight_reused",
      label: "Insight reused",
      tone: "neutral",
      tooltip: "What we know about this person was extracted previously and is still current. The score is a fresh assessment against this role.",
    });
  }

  // JobAdder-source provenance. Warning when profileText is empty
  // (the Bede shape) so the recruiter sees the problem; neutral otherwise.
  if ((state.source ?? "").trim() === "jobadder_import") {
    out.push({
      kind: "from_jobadder",
      label: "From JobAdder",
      tone: state.profileTextEmpty ? "warning" : "neutral",
      tooltip: state.profileTextEmpty
        ? "JobAdder import without a CV. Upload a CV or paste profile text before scoring."
        : "Imported from JobAdder.",
    });
  }

  out.sort((a, b) => BADGE_PRIORITY[a.kind] - BADGE_PRIORITY[b.kind]);
  return out;
}
