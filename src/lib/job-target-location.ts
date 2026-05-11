/**
 * Compute the target-location string passed to assessLocationFit /
 * applyLocationFitOverride for a job.
 *
 * Source-of-truth precedence:
 *   1. job.location + job.location2 (recruiter intent — explicit).
 *      Joined with " / " so extractKnownLocationTargets sees two targets and
 *      assessLocationFit's multi-target branch picks the best fit for the
 *      candidate (Wellington-based candidate vs Christchurch-based candidate
 *      on a Wellington+Christchurch role both score 100).
 *   2. parsedRole.location (AI-extracted from the JD).
 *      Used when the recruiter never set a location override.
 *   3. null.
 *
 * The recruiter override wins because job.location is what they actually
 * typed in the form; parsedRole.location is best-effort JD parsing that may
 * have picked a "Remote" or "New Zealand" generic string.
 */
export function getJobTargetLocation(
  job: { location?: string | null; location2?: string | null },
  parsedRole?: { location?: string | null } | null,
): string | null {
  const explicit = [job.location, job.location2]
    .map((v) => v?.trim() ?? "")
    .filter((v) => v.length > 0);
  if (explicit.length > 0) return explicit.join(" / ");
  const fromParsed = parsedRole?.location?.trim();
  return fromParsed ? fromParsed : null;
}
