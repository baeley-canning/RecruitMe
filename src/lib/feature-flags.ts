/**
 * Server-only feature-flag helpers. Each flag has a server-side reader
 * (this file) and, when needed by client components, a sibling
 * NEXT_PUBLIC_ variant that the bundler inlines into client builds.
 *
 * Two flags survived the May 2026 cleanup pass:
 *   • RECRUITME_PROFILE_INSIGHT_WRITE_ENABLED — gates the insight extractor.
 *     Active rollout in flight; the route 404s when off.
 *   • RECRUITME_IDENTITY_MERGE_UI_ENABLED — gates the merge/unmerge routes
 *     while the recruiter-confirmation UI is built.
 *
 * Removed flags (no longer in code):
 *   • RECRUITME_PROFILE_INSIGHT_RANKING — was declared in May 2026 as a
 *     placeholder for "Stage 1 ranker uses insight signals" work that was
 *     never written. Removed in commit (this one).
 *   • RECRUITME_PROFILE_INSIGHT_UI_BADGES + NEXT_PUBLIC_ variant — gated
 *     the candidate-card badges. Shipped as default in commit (this one);
 *     badges now always render.
 */

function readBool(envVar: string, defaultValue: boolean): boolean {
  const raw = process.env[envVar];
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "off" || v === "no") return false;
  return true;
}

/** Read+write ProfileInsight rows. Off-by-default until backfill
 *  reaches steady state. */
export function isProfileInsightWriteEnabled(): boolean {
  return readBool("RECRUITME_PROFILE_INSIGHT_WRITE_ENABLED", false);
}

/** Identity-merge admin UI (PR 5). */
export function isIdentityMergeUiEnabled(): boolean {
  return readBool("RECRUITME_IDENTITY_MERGE_UI_ENABLED", false);
}

/** Scraper worker API — gates GET/PATCH /api/scraper/jobs endpoints.
 *  Off by default; set RECRUITME_SCRAPER_ENABLED=true when the worker is live. */
export function isScraperEnabled(): boolean {
  return readBool("RECRUITME_SCRAPER_ENABLED", false);
}
