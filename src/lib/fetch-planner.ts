/**
 * Fetch planner for candidate profiles.
 *
 * SEEK profile fetches cost real credits, so we must be deliberate about which
 * thin candidates are worth spending on. LinkedIn and JobAdder fetches are free,
 * so they are never budget-limited.
 */

export type FetchPlatform = "seek" | "linkedin" | "jobadder";

export interface FetchCandidate {
  id: string;
  platform: FetchPlatform;
  /** Length of the stored profile text. 0 = nothing captured yet. */
  profileChars: number;
  /** Provisional match score from the thin data, if any. */
  matchScore: number | null;
  /** Heuristic "worth fetching" score, if any. */
  fetchPriorityScore: number | null;
  /** Candidate funnel status: new | reviewing | shortlisted | contacted |
   *  interviewing | offer_sent | hired | declined | rejected */
  status: string;
  /** False when there is no URL we could fetch. */
  hasProfileUrl: boolean;
}

export interface FetchPlanOptions {
  /** Max number of CREDIT-CHARGING fetches allowed. 0 = spend nothing. */
  budget: number;
  /** Chars at/above which a profile counts as already captured. Default 2000. */
  fullProfileChars?: number;
}

export interface FetchPlan {
  /** Candidate ids to fetch, best-first. */
  selected: string[];
  /** How many credit-charging fetches this plan implies. */
  estimatedCredits: number;
  /** Eligible candidates left unfetched because the budget ran out. */
  skippedForBudget: number;
}

/** Funnel stages that are dead ends — never spend a credit confirming these. */
const DEAD_END_STATUSES = new Set(["rejected", "declined", "hired"]);

/** Later funnel stages mean more invested, so they rank higher. Single source
 *  of truth: the engaged set is DERIVED from these keys, so the two can't drift
 *  apart. If they were declared separately, adding a status to the set but not
 *  the rank map would make the comparator return NaN and silently destabilise
 *  the sort. */
const ENGAGEMENT_RANK: Record<string, number> = {
  reviewing: 1,
  shortlisted: 2,
  contacted: 3,
  interviewing: 4,
  offer_sent: 5,
};

/** Funnel stages where the recruiter has already acted — worth confirming. */
const ENGAGED_STATUSES = new Set(Object.keys(ENGAGEMENT_RANK));

/** A candidate is worth fetching only if we have a URL and no full profile yet. */
function isEligible(candidate: FetchCandidate, fullProfileChars: number): boolean {
  return (
    candidate.hasProfileUrl &&
    candidate.profileChars < fullProfileChars &&
    !DEAD_END_STATUSES.has(candidate.status)
  );
}

/** Best-first comparator: engagement outranks score because a recruiter's
 *  action is a stronger signal than a thin-snippet heuristic. */
function compareCandidates(a: FetchCandidate, b: FetchCandidate): number {
  const aEngaged = ENGAGED_STATUSES.has(a.status);
  const bEngaged = ENGAGED_STATUSES.has(b.status);

  if (aEngaged !== bEngaged) {
    return aEngaged ? -1 : 1;
  }

  if (aEngaged && bEngaged) {
    const rankDiff = (ENGAGEMENT_RANK[b.status] ?? 0) - (ENGAGEMENT_RANK[a.status] ?? 0);
    if (rankDiff !== 0) return rankDiff;
  }

  const aScore = a.matchScore ?? a.fetchPriorityScore ?? 0;
  const bScore = b.matchScore ?? b.fetchPriorityScore ?? 0;
  if (aScore !== bScore) return bScore - aScore;

  // Plain codepoint comparison, NOT localeCompare: this tiebreak exists purely
  // to make the plan reproducible, and localeCompare's ordering depends on the
  // runtime's ICU data — so it could order differently on the box than on
  // Railway, which is exactly what "deterministic" is supposed to rule out.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function planProfileFetches(
  candidates: FetchCandidate[],
  options: FetchPlanOptions,
): FetchPlan {
  const fullProfileChars = options.fullProfileChars ?? 2000;

  const eligible = candidates.filter((c) => isEligible(c, fullProfileChars));
  const sorted = [...eligible].sort(compareCandidates);

  // Free platforms are never budget-limited — include every eligible one.
  const free = sorted.filter((c) => c.platform !== "seek");
  const seekPool = sorted.filter((c) => c.platform === "seek");

  const seekSelected = options.budget > 0 ? seekPool.slice(0, options.budget) : [];

  const selected = [...seekSelected, ...free].map((c) => c.id);
  const estimatedCredits = seekSelected.length;
  const skippedForBudget = seekPool.length - seekSelected.length;

  return { selected, estimatedCredits, skippedForBudget };
}
