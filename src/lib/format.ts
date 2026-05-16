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
