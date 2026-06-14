/**
 * Sentry PII scrubber (audit Phase 1.3).
 *
 * RecruitMe handles candidate PII (names, emails, phones, full profile text,
 * recruiter notes). `reportError` is called on capture/score/upload paths with
 * context that can carry that data, and exception messages can embed it too.
 * Without scrubbing, that PII ships to Sentry — an NZ Privacy Act exposure.
 *
 * This `beforeSend` walks the event and:
 *   - redacts values whose KEY looks sensitive (profileText, notes, email,
 *     phone, name, linkedinUrl, auth/cookie/token/secret) in extra, contexts,
 *     tags, and request data/headers/cookies;
 *   - masks email + NZ/E.164-ish phone patterns inside free-text strings
 *     (exception messages, breadcrumb messages).
 *
 * It is deliberately conservative: better to over-redact a debugging field than
 * to leak a candidate's contact details. Paired with `sendDefaultPii: false`.
 */

import type { ErrorEvent } from "@sentry/nextjs";

const SENSITIVE_KEY = /(profile.?text|cleaned.?profile|head?line|\bnotes?\b|interview.?notes|email|phone|mobile|\bname\b|firstname|lastname|fullname|linkedin|authorization|cookie|set-cookie|password|secret|token|api.?key|x-scraper-secret|salary)/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// E.164 / NZ-style numbers: + or 0 prefix, 7+ digits with optional spaces/dashes.
const PHONE_RE = /(?:\+?\d[\d ().-]{6,}\d)/g;

function maskText(s: string): string {
  return s.replace(EMAIL_RE, "[email]").replace(PHONE_RE, (m) =>
    // Only mask runs with enough digits to be a real phone number (avoid
    // nuking timestamps / ids that happen to have separators).
    (m.replace(/\D/g, "").length >= 7 ? "[phone]" : m),
  );
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * `beforeSend` hook. Accepts Sentry's `ErrorEvent` (same shape on
 * server/client/edge) and returns the same object mutated in place.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const e = event as unknown as Record<string, unknown>;

  // Exception + log messages.
  if (typeof e.message === "string") e.message = maskText(e.message);
  const exception = e.exception as { values?: Array<{ value?: string }> } | undefined;
  if (exception?.values) {
    for (const v of exception.values) {
      if (typeof v.value === "string") v.value = maskText(v.value);
    }
  }

  // Structured context that may carry PII.
  if (e.extra) e.extra = scrub(e.extra) as Record<string, unknown>;
  if (e.contexts) e.contexts = scrub(e.contexts) as Record<string, unknown>;
  if (e.tags) e.tags = scrub(e.tags) as Record<string, unknown>;

  // Request data / headers / cookies / query.
  const request = e.request as Record<string, unknown> | undefined;
  if (request) {
    if (request.data) request.data = scrub(request.data);
    if (request.headers) request.headers = scrub(request.headers);
    if (request.cookies) request.cookies = scrub(request.cookies);
    if (typeof request.query_string === "string") request.query_string = maskText(request.query_string);
  }

  // Breadcrumb messages.
  const breadcrumbs = e.breadcrumbs as { values?: Array<{ message?: string }> } | Array<{ message?: string }> | undefined;
  const crumbs = Array.isArray(breadcrumbs) ? breadcrumbs : breadcrumbs?.values;
  if (crumbs) {
    for (const c of crumbs) {
      if (typeof c.message === "string") c.message = maskText(c.message);
    }
  }

  return event;
}
