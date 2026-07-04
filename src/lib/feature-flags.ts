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

/** Use ProfileInsight facts as a ranking signal in library search (the talent
 *  flywheel read-path). Off-by-default and ships dark: when off, or when no
 *  insight exists for a candidate, search ranking is byte-identical to today's
 *  FTS+matchScore order. Flip on only after the backfill has populated rows. */
export function isProfileInsightReadEnabled(): boolean {
  return readBool("RECRUITME_PROFILE_INSIGHT_READ_ENABLED", false);
}

/** Identity-merge admin UI (PR 5). */
export function isIdentityMergeUiEnabled(): boolean {
  return readBool("RECRUITME_IDENTITY_MERGE_UI_ENABLED", false);
}

/** Scraper worker API — gates GET/POST/PATCH /api/scraper/jobs endpoints.
 *  Off by default; set RECRUITME_SCRAPER_ENABLED=true when the worker is live. */
export function isScraperEnabled(): boolean {
  return readBool("RECRUITME_SCRAPER_ENABLED", false);
}

/** Phase B: scraper-side LinkedIn search discovery — when on, multi-source
 *  search opportunistically enqueues background search jobs so the worker
 *  grows the local library from its own LinkedIn searches (the flywheel).
 *  Off by default until pacing is dialled in. The worker has the same flag
 *  (SCRAPER_DISCOVERY_ENABLED) on its end; toggle BOTH together. */
export function isScraperDiscoveryEnabled(): boolean {
  // Default ON: the scraper IS the SERP replacement. A multi-source search must
  // enqueue LinkedIn/SEEK discovery so a niche query the local library can't
  // satisfy (e.g. "Business Analyst" AND "Oracle Fusion") gets filled from live
  // search instead of returning 0. The worker paces itself (its own
  // SCRAPER_DISCOVERY_ENABLED + DAILY_SEARCH_CAP); set SCRAPER_DISCOVERY_ENABLED=false
  // on the app to disable.
  return readBool("SCRAPER_DISCOVERY_ENABLED", true);
}

/** CRM: clients / submissions / placements (triage Stage 1). Off by default.
 *  Set FEATURES_CRM_ENABLED=true to expose the clients + placements features. */
export function isCrmEnabled(): boolean {
  return readBool("FEATURES_CRM_ENABLED", false);
}

/** Reminders + candidate tags (triage Stage 2). Off by default.
 *  Set FEATURES_REMINDERS_ENABLED=true to activate. */
export function isRemindersEnabled(): boolean {
  return readBool("FEATURES_REMINDERS_ENABLED", false);
}

/** Profile-Update Alerts — recruiter-defined SEEK watches + the feed/bell.
 *  Off by default; gates the /api/watches routes + the /updates feed UI (404 /
 *  render nothing when off). Set FEATURES_PROFILE_WATCH_ENABLED=true to activate. */
export function isProfileWatchEnabled(): boolean {
  return readBool("FEATURES_PROFILE_WATCH_ENABLED", false);
}

/** Profile-Update Alerts scheduler — gates POST /api/watches/run-due (the
 *  cron-driven due-watch sweep). Off by default and independent of the feature
 *  flag so the scheduler can be armed separately. Set
 *  FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED=true to activate. */
export function isProfileWatchSchedulerEnabled(): boolean {
  return readBool("FEATURES_PROFILE_WATCH_SCHEDULER_ENABLED", false);
}

/** White-label theming (triage Stage 4). Off by default.
 *  Set FEATURES_WHITE_LABEL_ENABLED=true to activate. */
export function isWhiteLabelEnabled(): boolean {
  return readBool("FEATURES_WHITE_LABEL_ENABLED", false);
}
