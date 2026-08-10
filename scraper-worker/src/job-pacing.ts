/**
 * Account-safety pacing for the job loop.
 *
 * Its own module (like auth-failure.ts) so it is testable without booting the
 * worker — importing index.ts starts polling.
 */

/**
 * How long to wait before STARTING the next job.
 *
 * The loop used to pace itself with a 2-6s pause after each job, which only
 * works while the job itself is slow. A job that fails instantly (bad URL, open
 * circuit) returns in ~4s, so the cycle collapsed to ~7s — roughly six times the
 * intended rate at the platform, which is how a routing bug turned a paced queue
 * into a burst and got the account flagged. Pacing from the START holds the
 * floor no matter how the job ends.
 */
export function msUntilNextJobAllowed(
  lastStartMs: number,
  nowMs: number,
  minIntervalMs: number,
): number {
  if (!lastStartMs || minIntervalMs <= 0) return 0;
  return Math.max(0, minIntervalMs - (nowMs - lastStartMs));
}
