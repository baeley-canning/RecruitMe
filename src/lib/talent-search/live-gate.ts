/**
 * Library-first live-discovery gate.
 *
 * The library (pool FTS) runs synchronously and returns instantly. Live sources
 * (LinkedIn/SEEK scrapes) are slow, box-dependent, and — for SEEK — cost credits.
 * "Library-first" means: when the owned library already satisfies the query, DON'T
 * auto-reach-out to the box; only fire live when the library falls short. The user
 * can always force live explicitly.
 *
 * This centralises that decision (the plan's P3 fix) as one pure, tested function
 * used by both search entrypoints, so the two routes can't drift.
 */

export const LIBRARY_SUFFICIENT_DEFAULT = 25;

/** Threshold above which the library is considered "enough" (env-tunable). */
export function librarySufficientThreshold(): number {
  const raw = process.env.LIBRARY_SUFFICIENT_COUNT;
  if (!raw) return LIBRARY_SUFFICIENT_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : LIBRARY_SUFFICIENT_DEFAULT;
}

export interface LiveGateInput {
  /** Rows the library FTS returned for this query. */
  libraryCount: number;
  /** The user explicitly asked to search live regardless of library fill. */
  forceLive: boolean;
  /** Whether the library source was part of this search at all. */
  wantLibrary: boolean;
  /** Override the threshold (tests); defaults to librarySufficientThreshold(). */
  threshold?: number;
}

/**
 * Should we fire the live (scraper) sources for this search?
 *  - forceLive          → always yes (explicit user intent / "search live anyway")
 *  - no library leg     → yes (live is the only source; nothing to serve from cache)
 *  - library leg present → only when it came up short (< threshold)
 */
export function shouldFireLive(input: LiveGateInput): boolean {
  if (input.forceLive) return true;
  if (!input.wantLibrary) return true;
  const t = input.threshold ?? librarySufficientThreshold();
  return input.libraryCount < t;
}

/**
 * True when live sources were requested but HELD BACK because the library was
 * already sufficient — the signal the UI uses to show "Library had enough —
 * search live anyway".
 */
export function liveHeldForLibrary(input: LiveGateInput & { wantLiveSource: boolean }): boolean {
  return input.wantLiveSource && !shouldFireLive(input);
}
