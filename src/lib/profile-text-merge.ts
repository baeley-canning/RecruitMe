/**
 * Profile-text merge policy — the guard that stops a degraded scrape from
 * destroying a richer captured profile.
 *
 * WHY THIS EXISTS (real incident, 2026-07-16): ingestion used to write
 * `profileText` unconditionally on every scrape. A box re-scrape of a profile
 * originally captured by the browser extension replaced a 99,989-char profile
 * with the 1,015 chars the headless page yields — silent, permanent data loss.
 * The library is the moat; a re-fetch must never make it worse.
 *
 * The asymmetry is structural, not a bug in the scraper: the extension captures
 * the full profile (`/details/experience`, `/details/skills`, …) while the box's
 * headless view sees a fraction. So "newer" is NOT "better", and last-write-wins
 * is the wrong policy for this field.
 *
 * POLICY — accept incoming text only when it can't be a degradation:
 *   • no incoming text        → keep what we have (never null a profile out)
 *   • nothing stored yet      → accept (anything beats nothing)
 *   • stored is a stub        → accept (a real capture upgrades a placeholder)
 *   • incoming much thinner   → REJECT (this is the degradation case)
 *   • otherwise               → accept (comparable or richer = a genuine refresh)
 *
 * Pure + dependency-free so it's exhaustively unit-testable and usable from any
 * ingest path.
 */

/** Stored text at/below this length is a stub worth replacing with any real capture. */
export const STUB_MAX_CHARS = 200;

/**
 * Incoming text shorter than `existing × this` is treated as a degraded capture
 * and rejected. 0.7 allows a genuine edit (a removed role, a trimmed summary)
 * while still catching the pathological case (1k replacing 100k = 0.01).
 */
export const THINNER_REJECT_RATIO = 0.7;

export type MergeReason =
  | "no-incoming"
  | "no-existing"
  | "existing-stub"
  | "richer-or-comparable"
  | "rejected-thinner";

export interface MergeDecision {
  /** True when the incoming text should be written over the stored one. */
  accept: boolean;
  reason: MergeReason;
  /** Populated on a rejection so the caller can log what it protected. */
  incomingChars?: number;
  existingChars?: number;
}

/**
 * Decide whether an incoming scraped profileText may replace the stored one.
 * Never throws; treats null/undefined/whitespace as absent.
 */
export function shouldAcceptProfileText(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): MergeDecision {
  const inc = incoming?.trim() ?? "";
  const exi = existing?.trim() ?? "";

  if (inc.length === 0) return { accept: false, reason: "no-incoming" };
  if (exi.length === 0) return { accept: true, reason: "no-existing" };
  if (exi.length <= STUB_MAX_CHARS) return { accept: true, reason: "existing-stub" };

  if (inc.length < exi.length * THINNER_REJECT_RATIO) {
    return { accept: false, reason: "rejected-thinner", incomingChars: inc.length, existingChars: exi.length };
  }
  return { accept: true, reason: "richer-or-comparable" };
}
