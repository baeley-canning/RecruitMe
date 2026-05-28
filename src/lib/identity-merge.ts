/**
 * Identity-merge primitives. Used by the clustering script + future
 * recruiter-merge UI to recognise that multiple Candidate rows belong to one
 * real person.
 *
 * Design notes:
 *
 *  • Tier 1 (auto-merge, no recruiter prompt): linkedinUrl + jobAdderUrl
 *    exact matches inside a single orgId. These keys are recruiter-truth —
 *    LinkedIn URLs from the chrome extension and JobAdder URLs from the ATS.
 *
 *  • Tier 2 (review queue, NOT auto-applied): email + phone matches. False
 *    positives are too easy — old-employer emails, household landlines,
 *    role-based aliases — so PR 5 will surface these for recruiter
 *    confirmation. Not used by the clustering script.
 *
 *  • Tier 3 (manual only): fuzzy name + employer. Never auto-applied.
 *
 *  • Synthetic `library:<srcId>` keys (talent-pool route's placeholder when
 *    a JobAdder candidate has no LinkedIn URL) are NOT merged by linkedinUrl.
 *    They identify a single source library row, not a person. If they have a
 *    real jobAdderUrl, that's the merge axis instead.
 *
 *  • Multi-org isolation: every merge key is scoped to one orgId. Two real
 *    people in different orgs that happen to share a key DO NOT merge.
 *
 *  • Tombstones (CandidateIdentityMerge.isTombstone) override auto-merge.
 *    The clustering script must look up tombstones before merging — see
 *    scripts/cluster-identities.mjs.
 */

import { normaliseLinkedInUrl } from "./linkedin";

/** Synthetic key the talent-pool route writes into Candidate.linkedinUrl
 *  when a JobAdder row has no real LinkedIn URL. Format: `library:<srcId>`. */
const LIBRARY_SYNTHETIC_PREFIX = "library:";

export function isSyntheticLibraryKey(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.startsWith(LIBRARY_SYNTHETIC_PREFIX);
}

/** Identity-merge keys the Tier 1 auto-merger considers. */
export type IdentityMergeKey =
  | { kind: "linkedinUrl"; value: string }
  | { kind: "seekUrl"; value: string }
  | { kind: "jobAdderUrl"; value: string };

/**
 * Tier 1 merge-key extraction. Returns null for rows that have neither a
 * real LinkedIn URL nor a JobAdder URL — those candidates go straight to a
 * fresh CandidateIdentity row and are NOT eligible for auto-merge.
 *
 * Precedence: LinkedIn URL beats JobAdder URL. Reason: LinkedIn URLs are
 * cross-platform and stable across ATS migrations; JobAdder URLs are
 * tenant-local. A row with both keys should cluster on its LinkedIn URL so
 * a future re-import via a different ATS still matches.
 *
 * Synthetic `library:<srcId>` keys are rejected — see module docstring.
 */
export function identityMergeKey(row: {
  linkedinUrl: string | null | undefined;
  seekUrl?: string | null | undefined;
  jobAdderUrl: string | null | undefined;
}): IdentityMergeKey | null {
  const link = row.linkedinUrl?.trim() ?? "";
  if (link && !isSyntheticLibraryKey(link)) {
    return { kind: "linkedinUrl", value: normaliseLinkedInUrl(link) };
  }
  const seek = row.seekUrl?.trim() ?? "";
  if (seek) {
    return { kind: "seekUrl", value: normaliseSeekUrl(seek) };
  }
  const ja = row.jobAdderUrl?.trim() ?? "";
  if (ja) {
    return { kind: "jobAdderUrl", value: normaliseJobAdderUrl(ja) };
  }
  return null;
}

/**
 * Normalise a SEEK Talent profile URL — strip query/fragment, collapse
 * trailing slash, lowercase scheme+host (NOT the path, since SEEK candidate
 * IDs may be case-sensitive in some tenants).
 */
export function normaliseSeekUrl(raw: string): string {
  const trimmed = raw.trim();
  const noQuery = trimmed.replace(/[?#].*$/, "");
  const noTrailing = noQuery.replace(/\/$/, "");
  return noTrailing.replace(/^(https?:\/\/[^/]+)/i, (match) => match.toLowerCase());
}

/**
 * Normalise a JobAdder URL — strip query/fragment, collapse trailing slash,
 * lowercase scheme+host (NOT the path, since some JobAdder tenants use
 * mixed-case candidate IDs).
 */
export function normaliseJobAdderUrl(raw: string): string {
  const trimmed = raw.trim();
  // Strip query + fragment so trk= parameters and recruiter-specific deep
  // links collapse to the same key.
  const noQuery = trimmed.replace(/[?#].*$/, "");
  // Collapse trailing slash.
  const noTrailing = noQuery.replace(/\/$/, "");
  // Lowercase scheme + host. Don't lowercase the rest of the path since
  // JobAdder candidate IDs are case-sensitive in some tenants.
  return noTrailing.replace(/^(https?:\/\/[^/]+)/i, (match) => match.toLowerCase());
}

/**
 * Normalise an email for Tier 2 review-queue matching. Lowercase the whole
 * thing; preserve plus-tags (`jane+jobs@example.com` ≠ `jane+other@…`) and
 * dots (treating Gmail's plus-tag/dot rules as case-by-case would require
 * domain awareness we don't have here). Trim only.
 *
 * Returns `null` for strings that don't look like emails — the caller can
 * decide whether to skip or to surface a recruiter-facing warning.
 */
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Bare-minimum shape: something@something.something. We're not validating
  // RFC 5322 — we're guarding against "foo" being treated as an email key.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Normalise a phone number to E.164. NZ-default: numbers without a leading
 * `+` are assumed NZ (+64) and a leading `0` is stripped. This is a
 * heuristic; recruiters can correct it in the merge-review UI.
 *
 * Returns `null` for strings that don't normalise to a sensible E.164
 * shape (≥7 digits after country code).
 */
export function normalisePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip everything except digits and a leading +
  let cleaned = trimmed.replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  // If a `+` appears mid-string, treat as malformed.
  if (cleaned.indexOf("+", 1) !== -1) return null;
  if (cleaned.startsWith("+")) {
    // Already an international form — keep as-is.
  } else {
    // NZ-default. Strip a leading 0 (NZ trunk prefix), then prefix +64.
    if (cleaned.startsWith("0")) cleaned = cleaned.slice(1);
    cleaned = `+64${cleaned}`;
  }
  // Sanity bound: minimum 8 chars total (`+` + 1-3 country digits + 7 subscriber)
  if (cleaned.length < 8) return null;
  // Cap absurdly long inputs (paste-of-the-whole-CV class of bug).
  if (cleaned.length > 16) return null;
  return cleaned;
}

/**
 * Normalise a person's display name for fuzzy comparisons (Tier 3 only).
 * Lowercase, collapse whitespace, strip non-letter characters except spaces
 * and apostrophes (so "O'Brien" still has its apostrophe). Returns the
 * empty string for inputs that have no letters after normalisation.
 */
export function normaliseName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .replace(/[^a-z'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convenience: stringify an IdentityMergeKey to a sortable, persistable
 * form. Used by the clustering script when keying an in-memory map.
 */
export function mergeKeyToString(key: IdentityMergeKey | null): string | null {
  if (!key) return null;
  return `${key.kind}:${key.value}`;
}
