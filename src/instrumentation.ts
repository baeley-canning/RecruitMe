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

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    startSearchSweepTimer();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
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
 * Kill switch: DISABLE_INPROC_SWEEP=1.
 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
function startSearchSweepTimer() {
  if (process.env.DISABLE_INPROC_SWEEP === "1") return;
  const tick = async () => {
    try {
      // Dynamic import keeps Prisma out of the instrumentation module graph
      // until first tick (register() also runs in `next build` workers).
      const { sweepStuckRuns } = await import("./lib/search-run");
      const r = await sweepStuckRuns();
      if (r.reclaimed || r.swept || r.scoreTimedOut) {
        console.log(`[inproc-sweep] reclaimed=${r.reclaimed} swept=${r.swept} scoreTimedOut=${r.scoreTimedOut}`);
      }
    } catch (err) {
      // Never let the sweep take the server down; the next tick retries.
      console.warn(`[inproc-sweep] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // First run shortly after boot (let the DB pool settle), then steady-state.
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, SWEEP_INTERVAL_MS).unref?.();
}

export const onRequestError = Sentry.captureRequestError;
