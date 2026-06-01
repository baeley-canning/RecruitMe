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
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
