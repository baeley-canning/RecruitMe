/**
 * Decide which scraper must run from the URL the job points at, not from the
 * platform column that travelled alongside it.
 *
 * This is not hypothetical. 100 jobs were written with platform="linkedin" and
 * a profileUrl of "seek:https://nz.employer.seek.com/talentsearch/profile/…" —
 * a merge-key string that leaked into the linkedinUrl column. The worker
 * dispatched every one of them to the LinkedIn scraper, which rejected them in
 * about four seconds each. Because the loop paced itself from job COMPLETION,
 * those fast failures cycled roughly six times faster than intended and the
 * owner's LinkedIn account was flagged.
 *
 * This module is the worker's second line of defence: even handed a
 * contradictory row, it must not point the wrong scraper at a URL.
 */

export type ScrapePlatform = "linkedin" | "seek" | "jobadder";

export type JobTarget =
  | { ok: true; platform: ScrapePlatform; url: string }
  | { ok: false; error: string };

const PLATFORMS: ReadonlySet<string> = new Set(["linkedin", "seek", "jobadder"]);

/**
 * Strip a merge-key prefix only when a real http(s) URL immediately follows it.
 * Anything else stays untouched and will fail later because it is not https.
 */
function stripMergeKeyPrefix(input: string): string {
  return input.replace(/^(linkedin|seek|jobadder):(?=https?:\/\/)/i, "");
}

/**
 * Parse an https URL and reject anything malformed, including hosts with spaces.
 * Returns null instead of throwing.
 */
function parseHttpsUrl(input: string): URL | null {
  if (!/^https:\/\//i.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") return null;
    if (!url.hostname || url.hostname.includes(" ")) return null;
    if (/[^a-z0-9.-]/i.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function isLinkedInHost(hostname: string): boolean {
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function isSeekHost(hostname: string): boolean {
  return ["seek.com", "seek.co.nz", "seek.com.au"].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

/**
 * Route a job to the right scraper based on its profile URL, falling back to
 * the job's own platform when the URL identifies nothing (e.g. JobAdder's
 * customer-specific hosts). Never throws.
 */
export function resolveJobTarget(job: {
  platform: ScrapePlatform;
  profileUrl: string | null | undefined;
}): JobTarget {
  const raw = job.profileUrl?.trim() ?? "";
  if (!raw) {
    return { ok: false, error: `No profileUrl to route: ${raw}` };
  }

  const stripped = stripMergeKeyPrefix(raw);
  const url = parseHttpsUrl(stripped);
  if (!url) {
    return { ok: false, error: `Only https URLs are accepted: ${raw}` };
  }

  if (isLinkedInHost(url.hostname)) {
    return { ok: true, platform: "linkedin", url: stripped };
  }

  if (isSeekHost(url.hostname) && url.pathname.includes("/talentsearch/profile/")) {
    return { ok: true, platform: "seek", url: stripped };
  }

  if (PLATFORMS.has(job.platform)) {
    return { ok: true, platform: job.platform, url: stripped };
  }

  return { ok: false, error: `Unknown platform for URL ${raw}` };
}
