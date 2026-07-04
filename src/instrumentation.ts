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
      if (body && (body.reclaimed || body.swept || body.scoreTimedOut)) {
        console.log(`[inproc-sweep] reclaimed=${body.reclaimed} swept=${body.swept} scoreTimedOut=${body.scoreTimedOut ?? 0}`);
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

export const onRequestError = Sentry.captureRequestError;
