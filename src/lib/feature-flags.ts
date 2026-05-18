/**
 * Server-only feature-flag helpers. Each flag has a server-side reader
 * (this file) and, when needed by client components, a sibling
 * NEXT_PUBLIC_ variant that the bundler inlines into client builds.
 *
 * Default-OFF semantics are non-negotiable for this redesign per plan §H —
 * any of these can flip without a deploy by tweaking env vars.
 */

function readBool(envVar: string, defaultValue: boolean): boolean {
  const raw = process.env[envVar];
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "off" || v === "no") return false;
  return true;
}

/** Show ProfileInsight-aware badges on candidate cards.
 *  Client-side reads MUST use the NEXT_PUBLIC_ variant — see
 *  `isInsightBadgesEnabledClient` below. */
export function isInsightBadgesEnabled(): boolean {
  return readBool("RECRUITME_PROFILE_INSIGHT_UI_BADGES", false);
}

/** Stage 1 ranker consumes insight signals when true. */
export function isInsightRankingEnabled(): boolean {
  return readBool("RECRUITME_PROFILE_INSIGHT_RANKING", false);
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

/**
 * Client-side mirror for the badge flag. Next.js inlines NEXT_PUBLIC_
 * env vars at build time, so this is safe to call from client components.
 * The two env vars (RECRUITME_PROFILE_INSIGHT_UI_BADGES and
 * NEXT_PUBLIC_RECRUITME_PROFILE_INSIGHT_UI_BADGES) should be kept in lock-step
 * by deploy config — flipping only the server variant won't flip the UI.
 */
export function isInsightBadgesEnabledClient(): boolean {
  const raw = process.env.NEXT_PUBLIC_RECRUITME_PROFILE_INSIGHT_UI_BADGES;
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "off" || v === "no") return false;
  return true;
}
