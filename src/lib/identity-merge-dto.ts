/**
 * Shared DTOs for the identity merge-review UI — imported by BOTH the
 * GET /api/candidates/[id]/identity/related route and the review panel so the
 * payload shape and the UI types can't drift (the recurring contract-drift bug
 * class). See src/lib/identity-merge.ts for the matching primitives and the
 * merge/unmerge routes for the write side.
 */

/** Why two identities are suggested as the same person. */
export type IdentityMatchReason = "email" | "phone" | "name";

export const IDENTITY_MATCH_REASON_LABEL: Record<IdentityMatchReason, string> = {
  email: "Same email",
  phone: "Same phone",
  name: "Same name",
};

export interface IdentityCandidateSample {
  id: string;
  name: string;
  headline: string | null;
  jobTitle: string | null;
}

export interface IdentitySummary {
  identityId: string;
  canonicalName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
  /** How many Candidate rows currently point at this identity. */
  candidateCount: number;
  /** Up to a handful of candidates on this identity, for recruiter context. */
  sampleCandidates: IdentityCandidateSample[];
}

/** A different identity in the same org that looks like the same person. */
export interface MergeSuggestion extends IdentitySummary {
  matchReasons: IdentityMatchReason[];
}

/** An identity previously merged INTO the current one — eligible to unmerge. */
export interface MergedFromEntry {
  originalIdentityId: string;
  canonicalName: string;
  mergedAt: string;
  reason: string;
}

export interface IdentityRelatedResponse {
  /** False when the candidate has no CandidateIdentity yet (clustering
   *  hasn't run, or it's an org-less owner library row). The panel renders a
   *  short note in that case — there's nothing to merge against. */
  hasIdentity: boolean;
  current: IdentitySummary | null;
  /** Other identities that look like the same person (tombstone-aware). */
  suggestions: MergeSuggestion[];
  /** Identities merged into the current one — recruiter can split them back. */
  mergedFrom: MergedFromEntry[];
}
