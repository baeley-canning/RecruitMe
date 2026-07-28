/**
 * Ops alerting — turn /api/health into a message that reaches a human.
 *
 * WHY: every subsystem already reports its truth (db / scraper / pulse / ai /
 * blob / cv), and the Admin page renders it — but nobody stares at an admin page.
 * On 2026-07-28 a dead SEEK session left every Pulse watch failing for NINE DAYS
 * while the app happily served traffic. The signal existed; nothing carried it
 * to a person. This does.
 *
 * DESIGN:
 *  - Alerts on `degraded` as well as `!ok`. Degraded IS the failure mode that
 *    actually bit us — the app was up the whole time.
 *  - A grace period (default 15 min) so a transient blip during a deploy or a
 *    box reboot doesn't page anyone.
 *  - De-duplicated by SIGNATURE (which checks are unhealthy), so an ongoing
 *    outage alerts ONCE, not every poll. A *changing* signature re-alerts,
 *    because "scraper down" becoming "scraper + db down" is new information.
 *  - Sends a recovery notice, so a silent inbox means "fine", not "forgotten".
 *  - Webhook, not email: Slack/Telegram/Discord all accept a `{text}` POST.
 *
 * The decision is a PURE function over explicit state so the whole state machine
 * is unit-tested without a network or a clock.
 */

export interface HealthCheckLike {
  ok: boolean;
  degraded?: boolean;
  detail?: string;
  skipped?: boolean;
}

export interface HealthLike {
  ok: boolean;
  degraded?: boolean;
  checks: Record<string, HealthCheckLike>;
}

export interface AlertState {
  /** When the CURRENT signature was first observed (ms), or null when healthy. */
  problemSince: number | null;
  /** Signature currently being observed. */
  signature: string | null;
  /** Signature we've already sent an alert for (suppresses repeats). */
  alertedSignature: string | null;
}

export const EMPTY_ALERT_STATE: AlertState = {
  problemSince: null,
  signature: null,
  alertedSignature: null,
};

export const DEFAULT_ALERT_GRACE_MS = 15 * 60 * 1000;

export type AlertAction = "none" | "fire" | "recover";

export interface AlertDecision {
  action: AlertAction;
  state: AlertState;
  /** Human-readable message — only meaningful for fire/recover. */
  message: string | null;
}

/**
 * Which checks are unhealthy right now. A check counts as unhealthy when it's
 * failing OR flagged degraded. `skipped` checks (a dependency this deployment
 * doesn't use, e.g. Ollama) are never alerts.
 */
export function unhealthyChecks(health: HealthLike): string[] {
  const bad: string[] = [];
  for (const [name, c] of Object.entries(health.checks ?? {})) {
    if (!c || c.skipped) continue;
    if (!c.ok || c.degraded) bad.push(name);
  }
  return bad.sort();
}

function describe(health: HealthLike, names: string[]): string {
  return names
    .map((n) => {
      const d = health.checks[n]?.detail;
      return d ? `• ${n}: ${d}` : `• ${n}`;
    })
    .join("\n");
}

/**
 * Advance the alert state machine one tick. Pure: same inputs → same outputs.
 *
 * @param prev   state from the previous tick
 * @param health parsed /api/health payload
 * @param nowMs  current time
 * @param graceMs how long a problem must persist before it's worth a human
 */
export function decideAlert(
  prev: AlertState,
  health: HealthLike,
  nowMs: number,
  graceMs: number = DEFAULT_ALERT_GRACE_MS,
): AlertDecision {
  const bad = unhealthyChecks(health);
  const healthy = bad.length === 0 && health.ok !== false;

  if (healthy) {
    // Only announce recovery if we actually told someone there was a problem.
    if (prev.alertedSignature) {
      return {
        action: "recover",
        state: { ...EMPTY_ALERT_STATE },
        message: `✅ RecruitMe recovered — all checks healthy again (was: ${prev.alertedSignature}).`,
      };
    }
    return { action: "none", state: { ...EMPTY_ALERT_STATE }, message: null };
  }

  // Unhealthy. Include the fatal flag in the signature so "degraded" escalating
  // to "down" is treated as new information worth a second alert.
  const signature = `${health.ok === false ? "DOWN:" : "DEGRADED:"}${bad.join(",")}`;
  const changed = signature !== prev.signature;
  const problemSince = changed ? nowMs : prev.problemSince ?? nowMs;
  // A changed signature supersedes what we alerted on — allow a fresh alert.
  const alertedSignature = changed ? null : prev.alertedSignature;
  const next: AlertState = { problemSince, signature, alertedSignature };

  if (alertedSignature === signature) return { action: "none", state: next, message: null };
  if (nowMs - problemSince < graceMs) return { action: "none", state: next, message: null };

  const mins = Math.round((nowMs - problemSince) / 60000);
  const head = health.ok === false ? "🔴 RecruitMe is DOWN" : "🟠 RecruitMe degraded";
  return {
    action: "fire",
    state: { ...next, alertedSignature: signature },
    message: `${head} (${mins}m)\n${describe(health, bad)}`,
  };
}

/**
 * POST the message to ALERT_WEBHOOK_URL (Slack/Discord/Telegram-compatible
 * `{ text }` body). Never throws — a failed alert must not crash the timer that
 * produced it. Returns whether it was delivered.
 */
export async function sendOpsAlert(message: string): Promise<boolean> {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Grace period from env (ALERT_GRACE_MINUTES), falling back to the default. */
export function alertGraceMs(): number {
  const n = Number.parseInt(process.env.ALERT_GRACE_MINUTES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : DEFAULT_ALERT_GRACE_MS;
}
