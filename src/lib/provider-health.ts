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

import { readSearchProvidersConfig } from "./search-providers/config";

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
  // Decrement rather than reset. This makes recovery from FATAL failures
  // require multiple successes (3+) before the badge reads healthy again,
  // avoiding the Anthropic grace-period flap: when credits run out, one
  // request occasionally slips through, but the next dozen will fail. If
  // we reset to 0 on the first lucky success the badge oscillates green/red.
  // Transient single-failure recovery still works (1 → 0 → healthy).
  entry.consecutiveFailures = Math.max(0, entry.consecutiveFailures - 1);
}

/**
 * Failure messages that mean "this won't recover by retrying — the
 * provider is fundamentally broken right now": expired credits, exhausted
 * quotas, invalid auth, suspended account. Recording one of these flips
 * the badge straight to red instead of waiting for 3 consecutive
 * failures, because retrying with the same broken state will fail
 * exactly the same way.
 *
 * Each alternation is anchored to AVOID known false positives:
 *   ❌ "load balancer timeout"  bare "balance" used to match
 *   ❌ "credit card declined"   bare "credit" used to match
 *   ❌ "401-byte response"      bare "401" used to match
 *
 * Genuine patterns covered (case-insensitive):
 *   credit balance|insufficient credit|credit (?:exhausted|limit reached)
 *   quota (?:exceeded|exhausted|limit)|insufficient quota
 *   HTTP 401|HTTP 403|status[:= ]+40[13]|\bHTTP/1\.[01]\s+40[13]\b
 *   unauthorized|forbidden|unauthenticated
 *   invalid api[ _]?key|api[ _]?key (?:expired|revoked|invalid|disabled)
 *   account (?:suspended|disabled|deactivated|terminated)
 *   subscription (?:expired|cancelled)|payment (?:required|failed)
 */
const FATAL_FAILURE_REGEX = new RegExp(
  [
    // Credit / quota — only when explicitly paired with a fatal word
    "credit\\s*balance",                  // "credit balance is too low"
    "insufficient\\s*credit",             // "insufficient credit"
    "credit\\s*(?:exhausted|limit\\s*reached)",
    "quota\\s*(?:exceeded|exhausted|limit)",
    "insufficient\\s*quota",
    "balance\\s*(?:too\\s*low|exhausted)",
    // HTTP auth / forbidden — must be HTTP-flavoured, not bare "401"
    "HTTP\\s*40[13]\\b",
    "status[:= ]\\s*40[13]\\b",
    "\\b(?:401|403)\\s*(?:unauthorized|forbidden|unauthenticated)",
    "unauthorized",
    "forbidden",
    "unauthenticated",
    // Key-level fatal
    "invalid\\s*api[\\s_]*key",
    "api[\\s_]*key\\s*(?:expired|revoked|invalid|disabled|missing)",
    // Account-level fatal
    "account\\s*(?:suspended|disabled|deactivated|terminated|banned)",
    "subscription\\s*(?:expired|cancelled|canceled)",
    "payment\\s*(?:required|failed|declined)",
  ].join("|"),
  "i",
);

export function recordProviderFailure(name: ProviderName, reason: string): void {
  const entry = providerHealth[name];
  entry.lastFailureAt = new Date().toISOString();
  // Trim reason — these end up in tooltips, no point in 4kB stack traces.
  entry.lastFailureReason = reason.slice(0, 200);

  // Bump the running counter. If the failure is fatal (won't self-recover),
  // skip ahead to 3 so the state derivation classifies the provider as
  // "down" immediately — the recruiter shouldn't wait for two more wasted
  // calls to confirm what we already know.
  const isFatal = FATAL_FAILURE_REGEX.test(reason);
  entry.consecutiveFailures = isFatal
    ? Math.max(entry.consecutiveFailures + 1, 3)
    : entry.consecutiveFailures + 1;
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
    // Free providers are "configured" only when the search route ACTUALLY
    // recognises them in SEARCH_PROVIDERS — defer to the route's own
    // parser instead of doing a substring check. This catches:
    //   - SEARCH_PROVIDERS using a space instead of comma → route parses to []
    //     while substring check still passes ("searxng openserp".includes
    //     "searxng") → badge falsely shows configured
    //   - Typos like "searcxng" or "opensrp" that wouldn't pass
    //     parseProviderList's ALL_PROVIDERS filter
    // The base URL must also be present — without it the route can't call
    // the provider even if the name parses.
    case "searxng":  return Boolean(process.env.SEARXNG_BASE_URL?.trim())
                         && readSearchProvidersConfig().enabled.includes("searxng");
    case "openserp": return Boolean(process.env.OPENSERP_BASE_URL?.trim())
                         && readSearchProvidersConfig().enabled.includes("openserp");
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
