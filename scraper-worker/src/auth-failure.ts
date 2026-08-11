/**
 * Pure auth-failure classification + a per-platform circuit breaker.
 *
 * No Patchright / browser / IO imports — this module is deliberately pure so it
 * can be unit-tested deterministically (time is injected as `nowMs`).
 *
 * Why it exists: ensureSession() used to call authenticate() on every expired
 * session with no memory. A genuinely-broken login (Turnstile it can't solve,
 * wrong creds, a changed login wall) would fail authenticate(), the job would
 * fail, and the *next* job would immediately try again — an infinite re-auth
 * spam loop that effectively hangs the worker on that platform with no signal.
 * The breaker remembers consecutive failures per platform and "opens" after a
 * threshold (or immediately on a hard failure), so re-auth pauses for a cooldown
 * instead of spamming. A success resets it.
 */

export type AuthFailureKind = "soft" | "hard";

/**
 * Consecutive failures before a SOFT-failure streak opens the circuit.
 *
 * Raised from 3 after watching this in production: the SEEK warm-up
 * (/account/select -> /oauth/callback -> /dashboard) intermittently exceeds its
 * 30s budget on a cold chain, and a timeout is classified "soft". Three of those
 * — with a perfectly valid session — locked SEEK out for two hours. Observed
 * repeatedly: scrape one or two profiles successfully, then lock out.
 *
 * A genuinely dead session fails EVERY attempt, so it still trips, just after
 * more evidence. Flakiness needs more than three data points to be called an
 * outage.
 */
export const BREAKER_THRESHOLD = 8;
/**
 * How long the circuit stays open once tripped.
 *
 * Cut from 2h. The cost of being wrong here is asymmetric and was badly
 * mispriced: a false trip idles the box for two hours, while a real outage just
 * re-trips after a few cheap probes. 15 minutes is long enough to stop hammering
 * a genuinely broken login and short enough that a false positive is a hiccup
 * rather than a lost morning.
 */
export const BREAKER_COOLDOWN_MS = 15 * 60 * 1000; // 15m

/**
 * Does an error message signal a scraper-detected auth wall (the "_challenge:"
 * convention the scrapers raise)? The scrapers throw messages that START with
 * "<platform>_challenge:" (and ensureSession's circuit-open error now does too),
 * so we anchor to the START of the string. A word-boundary anchor (\b) was too
 * loose: it matched "foo seek_challenge:" mid-string, which a candidate's
 * profile text or a wrapped error could legitimately contain. Start-anchoring
 * means only a genuine platform-prefixed message flips needs-reauth / no-retry.
 */
export function isAuthChallengeMessage(message: string): boolean {
  return /^(linkedin|seek|jobadder)_challenge:/i.test(message ?? "");
}

/**
 * Classify a FAILED authenticate() attempt as recoverable (soft — transient
 * timeout / navigation / network, worth retrying on the next job) vs
 * unrecoverable (hard — wrong creds, login wall, missing auth flow, manual
 * re-login required; retrying is pointless and should open the circuit now).
 * Unknown errors default to soft (the breaker still caps the streak).
 *
 * MFA/OTP walls are HARD. No amount of retrying answers a one-time passcode, and
 * retrying is not free: 33 failed SEEK logins were attempted in a single day
 * because an MFA timeout read as "soft" and kept its place in the retry budget.
 * Repeated failed logins are what gets an account flagged — the same way the
 * owner's LinkedIn was. One attempt, then stop and ask for a human.
 */
export function classifyAuthFailure(err: unknown): AuthFailureKind {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  const HARD =
    /(invalid|incorrect|wrong)\s+(password|credentials|email|username)|re-?run\b.*login\.ts|no authentication flow|account.*(locked|disabled|suspended)|login wall|sign[- ]?in failed|missing\b.*(password|credentials)|_email\/password not set|mfa|otp[- ]?challenge|authenticate\.seek\.com/i;
  if (HARD.test(msg)) return "hard";
  return "soft";
}

/** Per-platform breaker state. Plain data so it's trivially serialisable/testable. */
export interface BreakerEntry {
  consecutiveFailures: number;
  /** epoch ms until which the circuit is open; 0 = closed. */
  openUntilMs: number;
}
export type BreakerState = Record<string, BreakerEntry>;

export function createBreakerState(): BreakerState {
  return {};
}

/** Is the circuit currently open (within cooldown) for this platform? */
export function isCircuitOpen(state: BreakerState, platform: string, nowMs: number): boolean {
  const e = state[platform];
  return !!e && e.openUntilMs > nowMs;
}

/**
 * Record a failed auth attempt. A `hard` failure opens the circuit immediately;
 * a `soft` failure increments the streak and opens once it reaches the
 * threshold. Returns a NEW state (pure).
 */
export function recordAuthFailure(
  state: BreakerState,
  platform: string,
  kind: AuthFailureKind,
  nowMs: number,
): BreakerState {
  const prev = state[platform] ?? { consecutiveFailures: 0, openUntilMs: 0 };
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const trip = kind === "hard" || consecutiveFailures >= BREAKER_THRESHOLD;
  return {
    ...state,
    [platform]: {
      consecutiveFailures,
      openUntilMs: trip ? nowMs + BREAKER_COOLDOWN_MS : prev.openUntilMs,
    },
  };
}

/** Record a successful auth / valid session — closes the circuit, resets the streak. */
export function recordAuthSuccess(state: BreakerState, platform: string): BreakerState {
  if (!state[platform]) return state;
  const next = { ...state };
  delete next[platform];
  return next;
}
