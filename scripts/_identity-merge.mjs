/**
 * JS mirror of src/lib/identity-merge.ts for use by .mjs scripts.
 *
 * The TS version is the source of truth (it has the vitest suite). This
 * file MUST stay in sync — keep the function shapes and key precedence
 * identical so a single fix-up doesn't drift between paths.
 *
 * Why duplicate? The scripts are plain ESM .mjs (no ts-node / tsx loader
 * standardised in this repo), and the helpers are small enough that a port
 * is cheaper than wiring a TS runner into one-off backfill tooling.
 *
 * If you change one, change both, and re-run:
 *   vitest run src/lib/__tests__/identity-merge
 */

const LIBRARY_SYNTHETIC_PREFIX = "library:";

export function isSyntheticLibraryKey(value) {
  if (!value) return false;
  return value.startsWith(LIBRARY_SYNTHETIC_PREFIX);
}

export function normaliseLinkedInUrl(raw) {
  const match = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = match ? match[1] : raw.replace(/[?#].*$/, "").replace(/\/$/, "");
  return `https://www.linkedin.com/in/${slug.toLowerCase()}`;
}

export function normaliseJobAdderUrl(raw) {
  const trimmed = raw.trim();
  const noQuery = trimmed.replace(/[?#].*$/, "");
  const noTrailing = noQuery.replace(/\/$/, "");
  return noTrailing.replace(/^(https?:\/\/[^/]+)/i, (match) => match.toLowerCase());
}

// Mirror of normaliseSeekUrl from src/lib/seek.ts — keep byte-identical
// behaviour; the parity test pins them together.
export function normaliseSeekUrl(raw) {
  const trimmed = raw.trim();
  const noQuery = trimmed.replace(/[?#].*$/, "");
  const noTrailing = noQuery.replace(/\/$/, "");
  return noTrailing.replace(/^(https?:\/\/[^/]+)/i, (match) => match.toLowerCase());
}

/**
 * Tier 1 merge-key extraction. Precedence: LinkedIn URL > JobAdder URL >
 * SEEK URL. Synthetic `library:<srcId>` LinkedIn placeholders are rejected —
 * they identify a source library row, not a person.
 */
export function identityMergeKey(row) {
  const link = (row.linkedinUrl ?? "").trim();
  if (link && !isSyntheticLibraryKey(link)) {
    return { kind: "linkedinUrl", value: normaliseLinkedInUrl(link) };
  }
  const ja = (row.jobAdderUrl ?? "").trim();
  if (ja) {
    return { kind: "jobAdderUrl", value: normaliseJobAdderUrl(ja) };
  }
  const seek = (row.seekUrl ?? "").trim();
  if (seek) {
    return { kind: "seekUrl", value: normaliseSeekUrl(seek) };
  }
  return null;
}

export function mergeKeyToString(key) {
  if (!key) return null;
  return `${key.kind}:${key.value}`;
}
