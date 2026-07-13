/**
 * Record confidence — "how solid is this candidate record", distinct from
 * matchScore ("how well do they fit the role"). Confidence answers: do we have a
 * real profile, is it fresh, is it corroborated by more than one source, and do
 * we have a verified way to reach them. It NEVER feeds ranking or scoring — it's
 * a trust signal for the recruiter, derived from data we already hold.
 *
 * Pure + cheap (no new scraping, no AI): a weighted sum over existing signals.
 */

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceSignals {
  /** We hold real profile text, not just a search snippet/headline. */
  hasFullProfile: boolean;
  /** When the profile was last captured — drives freshness. Null = unknown. */
  capturedAt?: Date | string | null;
  /** How many sources corroborate this person (library/linkedin/seek/jobadder). */
  sourceCount: number;
  /** We have a verified contact key (email/phone) on file. */
  hasVerifiedContact?: boolean;
  /** "Now" override for deterministic tests. */
  now?: number;
}

export interface Confidence {
  level: ConfidenceLevel;
  /** 0–100 — exposed for tooltips/sorting, NOT for ranking. */
  score: number;
  reasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(at: Date | string | null | undefined, nowMs: number): number | null {
  if (!at) return null;
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / DAY_MS);
}

/**
 * Derive a record-confidence level from signals we already have. Weights:
 *  full profile +40 · fresh capture +25/+10 · corroboration +20/+5 · contact +15.
 * high ≥ 70, medium ≥ 40, else low.
 */
export function deriveConfidence(sig: ConfidenceSignals): Confidence {
  const nowMs = sig.now ?? Date.now();
  let score = 0;
  const reasons: string[] = [];

  if (sig.hasFullProfile) {
    score += 40;
    reasons.push("Full profile captured");
  } else {
    reasons.push("Snippet only — not yet fetched");
  }

  const age = daysSince(sig.capturedAt, nowMs);
  if (age !== null) {
    if (age <= 60) {
      score += 25;
      reasons.push("Captured recently");
    } else if (age <= 180) {
      score += 10;
      reasons.push("Captured within 6 months");
    } else {
      reasons.push("Capture is stale (>6 months)");
    }
  }

  if (sig.sourceCount >= 2) {
    score += 20;
    reasons.push(`Corroborated by ${sig.sourceCount} sources`);
  } else if (sig.sourceCount === 1) {
    score += 5;
    reasons.push("Single source");
  }

  if (sig.hasVerifiedContact) {
    score += 15;
    reasons.push("Verified contact on file");
  }

  score = Math.max(0, Math.min(100, score));
  const level: ConfidenceLevel = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { level, score, reasons };
}

/** A candidate-shaped record (Candidate row or DTO) we can read signals off. */
export interface CandidateLike {
  profileText?: string | null;
  profileCapturedAt?: Date | string | null;
  linkedinUrl?: string | null;
  seekUrl?: string | null;
  jobAdderUrl?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * Confidence for a real Candidate/identity row. A profile counts as "full" only
 * with substantive text (≥200 chars) — a one-line headline stub shouldn't read
 * as a complete record. Sources = how many platform URLs corroborate the person.
 */
export function candidateConfidence(c: CandidateLike, now?: number): Confidence {
  const sourceCount = [c.linkedinUrl, c.seekUrl, c.jobAdderUrl].filter(Boolean).length;
  return deriveConfidence({
    hasFullProfile: !!c.profileText && c.profileText.trim().length >= 200,
    capturedAt: c.profileCapturedAt ?? null,
    sourceCount,
    hasVerifiedContact: !!(c.email || c.phone),
    now,
  });
}
