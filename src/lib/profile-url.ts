/**
 * Profile-URL cleaning and platform routing.
 *
 * Lives here rather than in the route because a Next.js route module may only
 * export request handlers — exporting these for tests broke `next build`.
 */
import { isSeekProfileUrl } from "@/lib/seek";

/** Merge-key strings ("seek:https://…") leak into URL columns; strip the kind
 *  prefix and accept only a real https URL. Returns null when unusable. */
export function cleanProfileUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/^(?:linkedin|seek|jobadder):(?=https?:\/\/)/i, "");
  return /^https:\/\//i.test(stripped) ? stripped : null;
}

export function firstUsableProfileUrl(candidates: Array<string | null | undefined>): string | null {
  for (const raw of candidates) {
    const cleaned = cleanProfileUrl(raw);
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * Decide which scraper to use.
 *
 * The URL wins ONLY when it positively identifies a platform — that is what
 * fixes the bug where a "seek:https://…" merge-key string sat in the
 * linkedinUrl column and got dispatched to the LinkedIn scraper.
 *
 * Otherwise fall back to the column the URL came from. JobAdder instances live
 * on customer-specific hosts (no "jobadder" in the domain), so there is nothing
 * in the URL to match on — insisting on host detection would silently skip every
 * JobAdder candidate.
 */
export function platformForUrl(
  url: string,
  hint?: "linkedin" | "seek" | "jobadder" | null,
): "linkedin" | "seek" | "jobadder" | null {
  const host = safeHost(url);
  if (/(^|\.)linkedin\.com$/i.test(host)) return "linkedin";
  if (isSeekProfileUrl(url)) return "seek";
  // Never let a hint claim a URL that another platform already owns.
  return hint ?? null;
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** Pick the first usable URL and the platform to scrape it with, together, so
 *  the two can never disagree. */
export function resolveProfileTarget(c: {
  linkedinUrl?: string | null;
  seekUrl?: string | null;
  jobAdderUrl?: string | null;
}): { url: string; platform: "linkedin" | "seek" | "jobadder" } | null {
  const columns: Array<["linkedin" | "seek" | "jobadder", string | null | undefined]> = [
    ["linkedin", c.linkedinUrl],
    ["seek", c.seekUrl],
    ["jobadder", c.jobAdderUrl],
  ];
  for (const [hint, raw] of columns) {
    const url = cleanProfileUrl(raw);
    if (!url) continue;
    const platform = platformForUrl(url, hint);
    if (platform) return { url, platform };
  }
  return null;
}
