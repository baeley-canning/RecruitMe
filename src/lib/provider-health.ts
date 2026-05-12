/**
 * In-memory health tracker for every external provider RecruitMe talks to.
 * Single source of truth for the green/amber/red badges on the search card
 * and the failover banner. ALL provider call sites must record success or
 * failure here — that's how the UI knows what's actually working.
 *
 * Why in-memory and not the DB: this is per-process operational state, not
 * durable data. A Railway restart resets it; the first real call after
 * restart re-populates. Production is a single-process container, so we
 * don't need cross-process consensus.
 *
 * The module-level health for the Claude failover lives in
 * [[ai-failover-health.ts]] — that one tracks the binary "Claude is dead,
 * use Llama" state. This file tracks per-provider last-success / last-
 * failure timestamps for the badge UI. They're complementary; the API
 * endpoint that drives the UI reads both.
 */

export type ProviderName =
  | "claude"
  | "ollama"
  | "serpapi"
  | "searxng"   // free, self-hosted meta-search (Google/Bing/DDG via one API)
  | "openserp"  // free, self-hosted headless-browser SERP scraper
  | "pdl"
  | "firmable"
  | "github";

export interface ProviderHealthEntry {
  /** Last time we successfully reached this provider (ISO timestamp). */
  lastSuccessAt: string | null;
  /** Last time a call to this provider failed (ISO timestamp). */
  lastFailureAt: string | null;
  /** One-line reason for the most recent failure — surfaced in tooltips. */
  lastFailureReason: string | null;
  /** Number of consecutive failures since the last success. Resets to 0
   *  when a call succeeds. Useful for backoff / "service is degraded"
   *  signals beyond a single bad call. */
  consecutiveFailures: number;
}

const initialEntry = (): ProviderHealthEntry => ({
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
});

export const providerHealth: Record<ProviderName, ProviderHealthEntry> = {
  claude:   initialEntry(),
  ollama:   initialEntry(),
  serpapi:  initialEntry(),
  searxng:  initialEntry(),
  openserp: initialEntry(),
  pdl:      initialEntry(),
  firmable: initialEntry(),
  github:   initialEntry(),
};

export function recordProviderSuccess(name: ProviderName): void {
  const entry = providerHealth[name];
  entry.lastSuccessAt = new Date().toISOString();
  entry.lastFailureReason = null;
  entry.consecutiveFailures = 0;
}

export function recordProviderFailure(name: ProviderName, reason: string): void {
  const entry = providerHealth[name];
  entry.lastFailureAt = new Date().toISOString();
  // Trim reason — these end up in tooltips, no point in 4kB stack traces.
  entry.lastFailureReason = reason.slice(0, 200);
  entry.consecutiveFailures += 1;
}

export interface ProviderHealthSnapshot {
  name: ProviderName;
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  consecutiveFailures: number;
  /** Derived UX state used directly by the badge component. */
  state: "healthy" | "degraded" | "down" | "unconfigured" | "untested";
}

/**
 * Returns whether each provider is configured. Centralised here so the
 * health endpoint and the UI agree on what "configured" means.
 */
export function isProviderConfigured(name: ProviderName): boolean {
  switch (name) {
    case "claude":   return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    case "ollama":   return process.env.ENABLE_LOCAL_MODEL_FAILOVER?.toLowerCase() === "true"
                         || process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING?.toLowerCase() === "true";
    case "serpapi":  return Boolean(process.env.SERPAPI_API_KEY?.trim());
    // Free providers are "configured" when their base URL is set AND the
    // SEARCH_PROVIDERS env opts them in. Same gate the search route uses,
    // so what we badge matches what actually fires.
    case "searxng":  return Boolean(process.env.SEARXNG_BASE_URL?.trim())
                         && (process.env.SEARCH_PROVIDERS?.toLowerCase().includes("searxng") ?? false);
    case "openserp": return Boolean(process.env.OPENSERP_BASE_URL?.trim())
                         && (process.env.SEARCH_PROVIDERS?.toLowerCase().includes("openserp") ?? false);
    case "pdl":      return Boolean(process.env.PDL_API_KEY?.trim());
    case "firmable": return Boolean(process.env.FIRMABLE_API_KEY?.trim());
    case "github":   return Boolean(process.env.GITHUB_TOKEN?.trim());
  }
}

/**
 * Map raw signals (configured? recent success? recent failure? consecutive
 * failures?) into the four UX states the badge renders. Rules:
 *
 *   unconfigured: not set up at all (gray, just shows the label)
 *   untested:     configured, never called (amber, "untested")
 *   healthy:      successful call in the last 24h AND no failures since
 *   degraded:     last call was a success but there's been a recent failure,
 *                 OR consecutive failures < 3 (still trying, not dead)
 *   down:         3+ consecutive failures since last success, OR last call
 *                 was a failure within the last hour
 */
export function deriveProviderState(
  name: ProviderName,
  entry: ProviderHealthEntry,
): ProviderHealthSnapshot["state"] {
  const configured = isProviderConfigured(name);
  if (!configured) return "unconfigured";

  if (!entry.lastSuccessAt && !entry.lastFailureAt) return "untested";

  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;
  const oneDayMs  = 24 * oneHourMs;
  const lastSuccess = entry.lastSuccessAt ? new Date(entry.lastSuccessAt).getTime() : 0;
  const lastFailure = entry.lastFailureAt ? new Date(entry.lastFailureAt).getTime() : 0;

  // The semantics we want for recruiters:
  //   - 3+ failures in a row = clearly broken (down/red).
  //   - Last call was a failure but only 1-2 in a row = trying, maybe
  //     intermittent (degraded/amber).
  //   - Last call succeeded = back to healthy/green, even if there were
  //     recent failures we recovered from (a single retry-and-succeed
  //     shouldn't keep the badge amber and confuse the recruiter).
  //   - Stale (configured but no recent activity at all) = degraded so
  //     the recruiter knows we can't confirm the provider works.

  if (entry.consecutiveFailures >= 3) return "down";

  // Last call was a failure (consecutiveFailures > 0 means no success
  // since the most recent failure) AND it was recent.
  if (entry.consecutiveFailures > 0 && now - lastFailure < oneHourMs) {
    return "degraded";
  }

  // Recent success in the last 24h = healthy. consecutiveFailures is 0
  // at this point (last call succeeded), so we don't need to check failure.
  if (lastSuccess > 0 && now - lastSuccess < oneDayMs) return "healthy";

  // Configured but no recent activity = degraded (stale, can't confirm).
  return "degraded";
}

export function snapshotProviderHealth(): ProviderHealthSnapshot[] {
  return (Object.keys(providerHealth) as ProviderName[]).map((name) => {
    const entry = providerHealth[name];
    return {
      name,
      configured: isProviderConfigured(name),
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      lastFailureReason: entry.lastFailureReason,
      consecutiveFailures: entry.consecutiveFailures,
      state: deriveProviderState(name, entry),
    };
  });
}

/** Test-only: reset every provider's health between test cases. */
export function __resetProviderHealthForTests(): void {
  for (const name of Object.keys(providerHealth) as ProviderName[]) {
    Object.assign(providerHealth[name], initialEntry());
  }
}
