/**
 * Deciding whether a killed search still has something worth reporting.
 *
 * Observed live on the box 2026-08-12:
 *
 *   00:00:01.577 ERROR job ... failed: linkedin-search timed out after 240000ms
 *   00:00:02.457 INFO  linkedin-search: harvested 4 cards (4 with names)
 *
 * LinkedIn was authenticated and page 1 had returned four real candidates. The
 * outer wedge-guard timeout fired during pagination, `withTimeout` rejected,
 * and the harvest — accumulated in a Map local to the scraper — died with the
 * promise. The job was posted FAILED and the recruiter saw an empty result for
 * a search that had genuinely found people.
 *
 * The wedge guard is still right: a page that stops responding must not hold
 * the worker forever. What was wrong is throwing away the work already done.
 *
 * Salvage applies to a TIMEOUT ONLY. An auth challenge has to keep failing
 * loudly — it takes the no-retry/no-backoff path and needs a human re-login,
 * and quietly reporting a few cards would disguise a dead session as a thin
 * search. Every other error stays fatal too: "0 cards and no no-results
 * marker" means the selectors drifted, and salvaging that would re-introduce
 * exactly the silent-failure class this codebase keeps getting bitten by.
 */
import { isAuthChallengeMessage } from "./auth-failure.js";

/**
 * Should a failed search report the candidates it gathered before it died?
 *
 * True only when ALL of:
 *   - the error is the wedge-guard timeout for THIS operation (`label`), and
 *   - at least one candidate was actually harvested, and
 *   - it is not an auth challenge wearing a timeout's clothes.
 *
 * Never throws, whatever it is handed.
 */
export function shouldSalvagePartialHarvest(
  err: unknown,
  harvestedCount: number,
  label: string,
): boolean {
  if (!Number.isFinite(harvestedCount) || harvestedCount <= 0) return false;

  // Only a real Error carries the wedge guard's message; a bare string thrown
  // from somewhere unknown is not evidence that THIS operation timed out.
  const message = err instanceof Error ? err.message : "";
  if (!message) return false;

  // An auth challenge is never salvageable, even if it also mentions a timeout.
  if (isAuthChallengeMessage(message)) return false;

  // withTimeout throws exactly `${label} timed out after ${ms}ms`. Anchoring to
  // the label keeps an unrelated timeout (a profile fetch surfacing inside a
  // search) from being read as this operation finishing early.
  return new RegExp(`^${escapeRegex(label)} timed out after \\d+ms$`).test(message);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
