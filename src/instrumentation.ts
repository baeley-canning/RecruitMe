/**
 * Next.js instrumentation hook (App Router, Next 15 + @sentry/nextjs v10).
 *
 * `register()` loads the runtime-appropriate Sentry init so server + edge
 * errors are captured. `onRequestError` is the piece the API-route try/catch
 * blocks can't cover: it reports errors thrown in server components, nested
 * layouts, and route segments that never reach an explicit catch — exactly
 * the App Router render errors that were previously invisible.
 */
import * as Sentry from "@sentry/nextjs";
import {
  decideAlert,
  sendOpsAlert,
  alertGraceMs,
  EMPTY_ALERT_STATE,
  type HealthLike,
} from "./lib/ops-alert";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    startSearchSweepTimer();
    startWatchSchedulerTimer();
    startProfileRefreshTimer();
    startOpsAlertTimer();
    startBackupTimer();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

/**
 * In-process Pulse scheduler. Historically the ONLY trigger for the
 * profile-update watch sweep was a box systemd timer hitting
 * /api/watches/run-due — so when the box was down, Pulse silently stopped
 * (the recurring "Pulse isn't working"). Driving it from the Railway app too
 * makes it box-outage-proof; run-due is idempotent (it stamps nextRunAfter,
 * so a watch a box tick already ran is not-yet-due here) and self-gates on
 * its feature flags (404 → no-op) so this is safe to always arm.
 * Kill switch: DISABLE_INPROC_WATCH_SCHED=1.
 */
const WATCH_SCHED_INTERVAL_MS = 15 * 60 * 1000;
function startWatchSchedulerTimer() {
  if (process.env.DISABLE_INPROC_WATCH_SCHED === "1") return;
  if (!process.env.CONTACT_SYNC_CRON_SECRET) return; // run-due auth — nothing to drive with
  const port = process.env.PORT ?? "3000";
  const tick = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/watches/run-due`, {
        method: "POST",
        headers: { "x-cron-secret": process.env.CONTACT_SYNC_CRON_SECRET as string },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) return; // feature flags off — expected no-op
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (body && body.enqueued > 0) {
        console.log(`[inproc-watch-sched] enqueued=${body.enqueued} due=${body.due} skippedForCap=${body.skippedForCap ?? 0}`);
      }
      if (!res.ok && res.status !== 404) console.warn(`[inproc-watch-sched] run-due returned ${res.status}`);
    } catch (err) {
      console.warn(`[inproc-watch-sched] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  setTimeout(tick, 90_000).unref?.(); // stagger after the sweep's first tick
  setInterval(tick, WATCH_SCHED_INTERVAL_MS).unref?.();
}

/**
 * In-process safety net for durable searches. The box worker drives the
 * stuck-run sweep every ~8 poll cycles — but when the box is DOWN, the very
 * process that reclaims zombie jobs and settles stuck SearchRuns dies with
 * it, and the recruiter stares at a spinning source pill until someone
 * notices. Running the sweep inside the Railway app makes recovery
 * box-outage-proof: it lives exactly as long as the app serving the UI.
 * Idempotent by design (reclaims only genuinely-stale work), so
 * double-driving alongside the box worker is safe.
 *
 * Deliberately calls our OWN /api/admin/search-runs/sweep over localhost
 * instead of importing src/lib/search-run: instrumentation.ts is compiled
 * for the edge runtime too, and pulling app code in drags node:crypto into
 * that bundle — a hard `next build` webpack error (hit live 2026-07-04).
 * A plain fetch has zero bundling footprint in any runtime.
 * Kill switch: DISABLE_INPROC_SWEEP=1.
 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
function startSearchSweepTimer() {
  if (process.env.DISABLE_INPROC_SWEEP === "1") return;
  if (!process.env.SCRAPER_SECRET) return; // endpoint auth — nothing to drive with
  const port = process.env.PORT ?? "3000";
  const tick = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/search-runs/sweep`, {
        method: "POST",
        headers: { "x-scraper-secret": process.env.SCRAPER_SECRET as string },
        signal: AbortSignal.timeout(60_000),
      });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (body && (body.reclaimed || body.swept)) {
        console.log(`[inproc-sweep] reclaimed=${body.reclaimed} swept=${body.swept}`);
      }
      if (!res.ok) console.warn(`[inproc-sweep] sweep endpoint returned ${res.status}`);
    } catch (err) {
      // Never let the sweep take the server down; the next tick retries.
      console.warn(`[inproc-sweep] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // First run shortly after boot (let the server start listening), then steady-state.
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, SWEEP_INTERVAL_MS).unref?.();
}

/**
 * In-process refresh_known_profile scheduler. Trickles background re-fetch jobs
 * for the stalest LinkedIn profiles already in the library so the owned library
 * stays fresh (the flywheel's return stroke). Driven from the Railway app so it
 * survives a box outage; /api/refresh/run-due is idempotent (once a profile is
 * re-fetched its profileCapturedAt updates and it drops out of the stale set)
 * and self-gates on its feature flags (404 → no-op), so this is safe to always
 * arm. Hourly — refresh is low-urgency background maintenance.
 * Kill switch: DISABLE_INPROC_REFRESH_SCHED=1.
 */
const REFRESH_SCHED_INTERVAL_MS = 60 * 60 * 1000;
function startProfileRefreshTimer() {
  if (process.env.DISABLE_INPROC_REFRESH_SCHED === "1") return;
  if (!process.env.CONTACT_SYNC_CRON_SECRET) return; // run-due auth — nothing to drive with
  const port = process.env.PORT ?? "3000";
  const tick = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/refresh/run-due`, {
        method: "POST",
        headers: { "x-cron-secret": process.env.CONTACT_SYNC_CRON_SECRET as string },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) return; // feature flags off — expected no-op
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (body && body.enqueued > 0) {
        console.log(`[inproc-refresh-sched] enqueued=${body.enqueued} candidates=${body.candidates}`);
      }
      if (!res.ok && res.status !== 404) console.warn(`[inproc-refresh-sched] run-due returned ${res.status}`);
    } catch (err) {
      console.warn(`[inproc-refresh-sched] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  setTimeout(tick, 120_000).unref?.(); // stagger after the sweep + watch first ticks
  setInterval(tick, REFRESH_SCHED_INTERVAL_MS).unref?.();
}

/**
 * Ops watchdog. Polls our OWN /api/health and pushes a webhook when something
 * stays unhealthy past the grace period — the missing link that let a dead SEEK
 * session run for NINE DAYS while the app served traffic happily (2026-07-28).
 *
 * Scope, honestly: this catches "app up, subsystem broken", which is the failure
 * class that actually bit us. It CANNOT report "app is down" — a dead process
 * sends no alerts. That needs an external pinger (Railway's healthcheck already
 * restarts on failure; an uptime monitor hitting /api/health covers the rest).
 *
 * Deliberately calls over localhost rather than importing app code: this module
 * is compiled for the edge runtime too, and pulling in node:crypto via the app
 * graph is a hard `next build` failure (hit live 2026-07-04).
 * Kill switch: DISABLE_OPS_ALERTS=1. No-ops entirely without ALERT_WEBHOOK_URL.
 */
const OPS_ALERT_INTERVAL_MS = 5 * 60 * 1000;
function startOpsAlertTimer() {
  if (process.env.DISABLE_OPS_ALERTS === "1") return;
  // Runs whenever we have SOMEWHERE to send: an explicit webhook, or Sentry
  // (already configured). Previously this required ALERT_WEBHOOK_URL and so
  // stayed dormant — an alerting system nobody turned on is the same as none.
  if (!process.env.ALERT_WEBHOOK_URL && !process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const port = process.env.PORT ?? "3000";
  // Module-scoped state: a restart re-arms the grace period, which errs toward
  // re-alerting on a still-broken system rather than going quiet. That's the
  // safe direction.
  let state = EMPTY_ALERT_STATE;
  const tick = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => null)) as HealthLike | null;
      if (!body || !body.checks) return;
      const decision = decideAlert(state, body, Date.now(), alertGraceMs());
      state = decision.state;
      if (decision.action !== "none" && decision.message) {
        const sent = await sendOpsAlert(decision.message);
        if (!sent) {
          // No webhook configured (or delivery failed) — fall back to Sentry,
          // which is already wired and has its own notification rules. An alert
          // that only reaches a log file is not an alert.
          Sentry.captureMessage(decision.message, decision.action === "fire" ? "error" : "info");
        }
        console.log(`[ops-alert] ${decision.action} — ${sent ? "webhook delivered" : "sent to Sentry"}`);
      }
    } catch (err) {
      console.warn(`[ops-alert] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  setTimeout(tick, 150_000).unref?.(); // stagger behind the other boot timers
  setInterval(tick, OPS_ALERT_INTERVAL_MS).unref?.();
}

/**
 * Daily database backup. Railway's own volume backups are gated for this
 * account and the volume was found with ZERO snapshots (2026-07-28), so the app
 * takes its own and writes it to the object store that already holds the CVs.
 *
 * Failure is ALERTED, not logged-and-forgotten — a silently failing backup is
 * indistinguishable from no backup until the day you need it.
 * Kill switch: DISABLE_AUTO_BACKUP=1.
 */
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
function startBackupTimer() {
  if (process.env.DISABLE_AUTO_BACKUP === "1") return;
  if (!process.env.CONTACT_SYNC_CRON_SECRET) return; // route auth — nothing to drive with
  const port = process.env.PORT ?? "3000";
  const tick = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/backup/run`, {
        method: "POST",
        headers: { "x-cron-secret": process.env.CONTACT_SYNC_CRON_SECRET as string },
        signal: AbortSignal.timeout(600_000),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        console.log(`[auto-backup] ok — ${body.rows} rows, ${Math.round((body.bytes ?? 0) / 1048576)}MB`);
      } else {
        const detail = body?.error ?? body?.skipped ?? `HTTP ${res.status}`;
        console.error(`[auto-backup] FAILED — ${detail}`);
        Sentry.captureMessage(`\u{1F534} RecruitMe database backup FAILED — ${detail}`, "error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[auto-backup] FAILED — ${msg}`);
      Sentry.captureMessage(`\u{1F534} RecruitMe database backup FAILED — ${msg}`, "error");
    }
  };
  setTimeout(tick, 300_000).unref?.(); // 5 min after boot, behind the other timers
  setInterval(tick, BACKUP_INTERVAL_MS).unref?.();
}

export const onRequestError = Sentry.captureRequestError;
