// Shared formatting / text helpers. Keep these dependency-light so they can
// be imported from server and client modules alike.

import { signalMatchesText } from "./requirement-signals";

/**
 * Word-boundary aware substring check. Delegates to `signalMatchesText`
 * which treats short tokens (<=4 chars) as whole-word matches so e.g.
 * "sql" doesn't match "nosql". Re-exported here under the legacy
 * `textHasTerm` name used across the search / fetch-priority code.
 */
export function textHasTerm(value: string, term: string): boolean {
  return signalMatchesText(value, term);
}

/** Human-readable byte size — used in file-list UIs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact single-value salary, e.g. `$120k` / `$80`. Used by salary sliders. */
export function fmtSalary(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`;
}

/** NZD salary range as prose, e.g. `$120k-$160k NZD`. Used in AI ad prompts. */
export function formatSalaryRange(min?: number | null, max?: number | null): string {
  if (min && max) return `$${Math.round(min / 1000)}k-$${Math.round(max / 1000)}k NZD`;
  if (min) return `From $${Math.round(min / 1000)}k NZD`;
  if (max) return `Up to $${Math.round(max / 1000)}k NZD`;
  return "";
}

/**
 * Flatten an API error payload into a user-readable string.
 *
 * Server routes that fail Zod validation return `{ error: "Invalid body",
 * issues: [{path, message}, ...] }`. Without this helper UI surfaces
 * collapse to the useless top-level "Invalid body" string and discard the
 * field-level detail. Use this wherever a JSON error response feeds an
 * `error` setter.
 */
export function formatApiError(
  data: unknown,
  fallback = "Something went wrong",
): string {
  if (!data || typeof data !== "object") return fallback;
  const d = data as { error?: unknown; issues?: unknown };
  if (Array.isArray(d.issues) && d.issues.length > 0) {
    return d.issues
      .map((issue) => {
        if (!issue || typeof issue !== "object") return null;
        const i = issue as { path?: unknown; message?: unknown };
        const path = Array.isArray(i.path) ? i.path.join(".") : "";
        const msg = typeof i.message === "string" ? i.message : "invalid";
        return path ? `${path}: ${msg}` : msg;
      })
      .filter((s): s is string => Boolean(s))
      .join("; ");
  }
  if (typeof d.error === "string") return d.error;
  return fallback;
}
