/**
 * Centralised error reporting for API routes.
 *
 * Use this in catch blocks instead of bare console.error so that errors are:
 *   - Logged with structured context
 *   - Forwarded to Sentry (when SENTRY_DSN is set)
 *   - Tagged with the route + auth context for triage
 *
 * Example:
 *   } catch (err) {
 *     reportError(err, { route: "score-all", jobId, orgId });
 *     return NextResponse.json({ error: "Internal error" }, { status: 500 });
 *   }
 */

import * as Sentry from "@sentry/nextjs";

export type ErrorContext = {
  route?: string;
  orgId?: string | null;
  userId?: string;
  jobId?: string;
  candidateId?: string;
  /** Correlation id from middleware (x-request-id) — ties a Sentry event back
   *  to the structured log line for the same request. */
  requestId?: string;
  // Free-form extra fields
  [key: string]: unknown;
};

export function reportError(err: unknown, context: ErrorContext = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? err.stack   : undefined;

  // Always log structured to stdout for Railway/grep visibility.
  console.error(JSON.stringify({
    level: "error",
    message,
    ...context,
    stack: stack?.split("\n").slice(0, 4).join(" | "),
  }));

  // Forward to Sentry. Safe to call even if DSN isn't set — the SDK no-ops.
  try {
    Sentry.captureException(err, {
      tags: {
        route: context.route ?? "unknown",
        requestId: context.requestId ?? undefined,
      },
      contexts: {
        request: {
          orgId:       context.orgId ?? undefined,
          userId:      context.userId,
          jobId:       context.jobId,
          candidateId: context.candidateId,
        },
      },
      extra: context,
    });
  } catch {
    // Don't let error-reporting failures cascade.
  }
}
