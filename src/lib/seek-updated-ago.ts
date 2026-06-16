/**
 * Profile-Update Alerts — pure parser for SEEK Talent-Search card "Updated X
 * ago" / "Updated today" relative-time strings.
 *
 * SEEK renders a candidate's last-profile-update as a fuzzy relative label
 * (e.g. "Updated today", "Updated 3 hours ago", "Updated 2 days ago",
 * "Updated last week", "Updated over a year ago"). `parseUpdatedAgo` maps that
 * label to a single bucketed JS Date so hit-detection can JS-threshold it
 * against a watch's `notifyFrom` (NEVER bind a Date in $queryRaw — known box
 * tz-trap; this returns a JS Date for in-TS comparison).
 *
 * Pure: no I/O, no `new Date()` of its own — the caller passes `now`, which
 * makes every bucket deterministic and unit-testable (including the
 * NZ-midnight boundary).
 *
 * EVERY bucket is floored to its UTC calendar day (issue I3 + the dedupe-flood
 * fix): the offset is computed from `now`, then floored to UTC midnight.
 *   • "today" / "N hours ago" / "an hour ago" / "N minutes ago" → UTC day of now
 *   • "yesterday"                                               → UTC day of now−1d
 *   • "N days ago"                                              → UTC day of now−Nd
 *   • "last week" / "N weeks ago"                               → UTC day of now−N×7d
 *   • "N months ago"                                            → UTC day of now−N×30d
 *   • "over a year ago" / "a year ago" / "N years ago"          → UTC day of now−N×370d
 *   • unparseable                                               → null
 *
 * WHY floor everything to the day (not just "today"): the bucket is the dedupe
 * discriminator in `ProfileUpdateHit @@unique([watchId, seekId, updatedAtBucket])`.
 * A relative label like "3 hours ago" parsed against a fresh `now` on each
 * re-detection (every SSE tick) would otherwise yield a DRIFTING instant → the
 * unique key never matches → the feed floods the same person on every tick.
 * Flooring to the UTC calendar day makes the bucket stable across re-runs within
 * a day, so a candidate is flagged once per (person, update-day). UTC (not local)
 * so it's independent of the box's non-UTC timezone — pinned by the NZ-midnight test.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// "over a year ago" is the coarsest SEEK label — treat as ~370 days (just over
// a year) so it always sorts as older than any finer-grained recent bucket.
const YEAR_MS = 370 * DAY_MS;

/** Floor a Date to UTC midnight (start of its UTC calendar day). */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function numberWord(word: string): number | null {
  const w = word.trim().toLowerCase();
  if (w === "a" || w === "an") return 1;
  const n = Number(w);
  if (Number.isFinite(n) && n >= 0) return n;
  return null;
}

/**
 * Parse a SEEK "Updated X ago" label into a single bucketed Date.
 * @param text  Raw card text (may include the "Updated" prefix and surrounding noise).
 * @param now   Reference instant; all relative buckets are computed against it.
 * @returns `{ bucket }` Date floor, or `null` when the text can't be parsed.
 */
export function parseUpdatedAgo(text: string, now: Date): { bucket: Date } | null {
  if (text == null) return null;
  // JobAdder-synced SEEK cards render a COMBINED label: "Updated JobAdder 6
  // months ago, SEEK today" / "Updated JobAdder today, SEEK 8 days ago". This is
  // a SEEK profile-update signal, so isolate the SEEK recency and DROP the
  // JobAdder sync date — otherwise the "...JobAdder today..." part would match
  // the /\btoday\b/ branch below and misbucket a months-stale profile as updated
  // today (a false-positive alert). The scraper now sends the SEEK date directly
  // (extractSeekCards), but guard here too so the threshold can never be polluted
  // by a combined string from a historical row or a SEEK format tweak.
  const seekPart = text.match(/(?:^|[,\s])SEEK\s+(.+?\s+ago|today|yesterday)/i);
  if (!seekPart && /jobadder/i.test(text)) return null; // JobAdder-only sync date — not a SEEK update
  const source = seekPart ? seekPart[1] : text;
  // Normalise: lowercase, strip the optional "updated" prefix, collapse space.
  const s = source
    .toLowerCase()
    .replace(/^\s*updated\b/, "")
    .replace(/\bago\b/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (s === "") return null;

  // Compute the offset from `now`, then floor to the UTC calendar day. `day(ms)`
  // makes every bucket a stable per-day value so the dedupe key doesn't drift
  // across re-detections (see the header comment).
  const t = now.getTime();
  const day = (ms: number) => ({ bucket: startOfUtcDay(new Date(ms)) });

  // "today" / sub-day ("N hours ago", "N minutes ago") → the UTC day of now.
  if (/\btoday\b/.test(s)) return day(t);

  // "yesterday" → now − 1 day.
  if (/\byesterday\b/.test(s)) return day(t - DAY_MS);

  // "over a year ago" / "a year ago" / "N years ago" → now − N×370d.
  let m = s.match(/(\d+|a|an)\s*years?\b/);
  if (m) {
    const n = numberWord(m[1]);
    if (n != null) return day(t - Math.max(1, n) * YEAR_MS);
  }
  // Bare "year" with no count (e.g. "over a year") → 1 year.
  if (/\byear\b/.test(s)) return day(t - YEAR_MS);

  // "last week" → now − 7 days.
  if (/\blast week\b/.test(s)) return day(t - 7 * DAY_MS);

  // "N months ago" / "a month ago" → now − N×30 days.
  m = s.match(/(\d+|a|an)\s*months?\b/);
  if (m) {
    const n = numberWord(m[1]);
    if (n != null) return day(t - Math.max(1, n) * 30 * DAY_MS);
  }

  // "N weeks ago" / "a week ago" → now − N×7 days.
  m = s.match(/(\d+|a|an)\s*weeks?\b/);
  if (m) {
    const n = numberWord(m[1]);
    if (n != null) return day(t - Math.max(1, n) * 7 * DAY_MS);
  }

  // "N days ago" / "a day ago" → now − N days.
  m = s.match(/(\d+|a|an)\s*days?\b/);
  if (m) {
    const n = numberWord(m[1]);
    if (n != null) return day(t - Math.max(0, n) * DAY_MS);
  }

  // "N hours ago" / "Nh ago" / "an hour ago" → the UTC day of (now − N hours).
  m = s.match(/(\d+|a|an)\s*(?:hours?|h)\b/);
  if (m) {
    const n = numberWord(m[1]);
    if (n != null) return day(t - Math.max(0, n) * HOUR_MS);
  }

  // "N minutes ago" / "Nm ago" → the UTC day of (now − N minutes).
  m = s.match(/(\d+|a|an)\s*(?:minutes?|mins?|m)\b/);
  if (m) {
    const n = numberWord(m[1]);
    if (n != null) return day(t - Math.max(0, n) * 60 * 1000);
  }

  return null;
}
