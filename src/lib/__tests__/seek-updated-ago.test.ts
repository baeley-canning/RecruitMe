import { describe, expect, it } from "vitest";

import { parseUpdatedAgo } from "../seek-updated-ago";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 370 * DAY_MS;

// A fixed reference instant for the relative-bucket cases.
const NOW = new Date("2026-06-15T13:30:00.000Z");

// Every bucket floors to the UTC calendar day of (now − offset).
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const flooredFrom = (now: Date, offsetMs: number) => startOfUtcDay(new Date(now.getTime() - offsetMs)).toISOString();
const floored = (offsetMs: number) => flooredFrom(NOW, offsetMs);

describe("parseUpdatedAgo — every bucket floors to its UTC calendar day", () => {
  it('"today" → UTC start-of-day of now', () => {
    const r = parseUpdatedAgo("Updated today", NOW);
    expect(r).not.toBeNull();
    expect(r!.bucket.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it('"3 hours ago" → UTC day of now−3h (same day here)', () => {
    const r = parseUpdatedAgo("Updated 3 hours ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(3 * HOUR_MS));
    expect(r!.bucket.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it('compact "2h ago" → UTC day of now−2h', () => {
    const r = parseUpdatedAgo("Updated 2h ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(2 * HOUR_MS));
  });

  it('"an hour ago" → UTC day of now−1h', () => {
    const r = parseUpdatedAgo("Updated an hour ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(HOUR_MS));
  });

  it('"5 days ago" → UTC day of now−5d', () => {
    const r = parseUpdatedAgo("Updated 5 days ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(5 * DAY_MS));
    expect(r!.bucket.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it('"yesterday" → UTC day of now−1d', () => {
    const r = parseUpdatedAgo("Updated yesterday", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(DAY_MS));
    expect(r!.bucket.toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it('"last week" → UTC day of now−7d', () => {
    const r = parseUpdatedAgo("Updated last week", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(7 * DAY_MS));
  });

  it('"2 weeks ago" → UTC day of now−14d', () => {
    const r = parseUpdatedAgo("Updated 2 weeks ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(14 * DAY_MS));
  });

  it('"3 months ago" → UTC day of now−90d', () => {
    const r = parseUpdatedAgo("Updated 3 months ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(90 * DAY_MS));
  });

  it('"over a year ago" → UTC day of now−~370d', () => {
    const r = parseUpdatedAgo("Updated over a year ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(YEAR_MS));
  });

  it('"2 years ago" → UTC day of now−2×370d', () => {
    const r = parseUpdatedAgo("Updated 2 years ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(2 * YEAR_MS));
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    const r = parseUpdatedAgo("  UPDATED   4   DAYS   AGO  ", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(4 * DAY_MS));
  });

  it("parses without the optional 'Updated' prefix", () => {
    const r = parseUpdatedAgo("6 hours ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(6 * HOUR_MS));
  });
});

describe("parseUpdatedAgo — bucket is stable across a drifting `now` within a day (dedupe)", () => {
  it('"3 hours ago" yields the SAME bucket whether parsed at 13:30 or 13:30:05 (no flood)', () => {
    const a = parseUpdatedAgo("Updated 3 hours ago", new Date("2026-06-15T13:30:00.000Z"));
    const b = parseUpdatedAgo("Updated 3 hours ago", new Date("2026-06-15T13:30:05.000Z"));
    expect(a!.bucket.toISOString()).toBe(b!.bucket.toISOString());
  });

  it('"2 days ago" is identical across two same-day detections hours apart', () => {
    const a = parseUpdatedAgo("Updated 2 days ago", new Date("2026-06-15T08:00:00.000Z"));
    const b = parseUpdatedAgo("Updated 2 days ago", new Date("2026-06-15T20:00:00.000Z"));
    expect(a!.bucket.toISOString()).toBe(b!.bucket.toISOString());
    expect(a!.bucket.toISOString()).toBe("2026-06-13T00:00:00.000Z");
  });
});

describe("parseUpdatedAgo — unparseable → null", () => {
  it.each([
    "",
    "   ",
    "Updated",
    "Active recently",
    "some random label",
  ])("returns null for %p", (input) => {
    expect(parseUpdatedAgo(input, NOW)).toBeNull();
  });

  it("returns null for null/undefined text", () => {
    // Defensive: scraper card text can be missing.
    expect(parseUpdatedAgo(undefined as unknown as string, NOW)).toBeNull();
    expect(parseUpdatedAgo(null as unknown as string, NOW)).toBeNull();
  });
});

describe("parseUpdatedAgo — JobAdder-synced combined label takes the SEEK date", () => {
  // SEEK renders "Updated JobAdder <sync>, SEEK <profile-update>" for candidates
  // synced from JobAdder. The watch is about SEEK profile updates, so the SEEK
  // part wins and the JobAdder sync date is ignored (else "...JobAdder today..."
  // would misbucket a stale profile as updated today — a false positive).
  it('"Updated JobAdder 6 months ago, SEEK today" → today (not 6 months)', () => {
    const r = parseUpdatedAgo("Updated JobAdder 6 months ago, SEEK today", NOW);
    expect(r!.bucket.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it('"Updated JobAdder today, SEEK 8 days ago" → 8 days ago (not today)', () => {
    const r = parseUpdatedAgo("Updated JobAdder today, SEEK 8 days ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(8 * DAY_MS));
    expect(r!.bucket.toISOString()).toBe("2026-06-07T00:00:00.000Z");
  });

  it('"Updated JobAdder 11 months ago, SEEK 3 weeks ago" → 3 weeks ago', () => {
    const r = parseUpdatedAgo("Updated JobAdder 11 months ago, SEEK 3 weeks ago", NOW);
    expect(r!.bucket.toISOString()).toBe(floored(3 * 7 * DAY_MS));
  });

  it("JobAdder-only sync date (no SEEK part) → null (not a SEEK update)", () => {
    expect(parseUpdatedAgo("Updated JobAdder 4 months ago", NOW)).toBeNull();
    expect(parseUpdatedAgo("Updated JobAdder today", NOW)).toBeNull();
  });

  it('plain SEEK-only "Updated today" still parses (no regression)', () => {
    const r = parseUpdatedAgo("Updated today", NOW);
    expect(r!.bucket.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });
});

describe("parseUpdatedAgo — relative buckets are ordered newest→oldest", () => {
  it("today ≥ days ≥ week ≥ year", () => {
    const today = parseUpdatedAgo("Updated today", NOW)!.bucket.getTime();
    const days = parseUpdatedAgo("Updated 5 days ago", NOW)!.bucket.getTime();
    const week = parseUpdatedAgo("Updated last week", NOW)!.bucket.getTime();
    const year = parseUpdatedAgo("Updated over a year ago", NOW)!.bucket.getTime();
    expect(today).toBeGreaterThan(days);
    expect(days).toBeGreaterThan(week);
    expect(week).toBeGreaterThan(year);
  });
});

describe("parseUpdatedAgo — NZ-midnight boundary (UTC floor)", () => {
  // NZST is UTC+12. NZ-local midnight on 2026-06-15 is 2026-06-14T12:00:00Z.
  // The "today" bucket must floor to the UTC calendar day of `now` (2026-06-14),
  // proving start-of-day is UTC and deterministic regardless of the runner's tz.
  const NZ_MIDNIGHT_AS_UTC = new Date("2026-06-14T12:00:00.000Z");

  it('"today" at NZ-midnight floors to that instant\'s UTC day', () => {
    const r = parseUpdatedAgo("Updated today", NZ_MIDNIGHT_AS_UTC);
    expect(r!.bucket.toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it("one second before NZ-midnight still floors to its own UTC day", () => {
    const justBefore = new Date("2026-06-14T11:59:59.000Z");
    const r = parseUpdatedAgo("Updated today", justBefore);
    expect(r!.bucket.toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it("relative buckets floor in UTC regardless of timezone", () => {
    const r = parseUpdatedAgo("Updated 2 days ago", NZ_MIDNIGHT_AS_UTC);
    expect(r!.bucket.toISOString()).toBe(flooredFrom(NZ_MIDNIGHT_AS_UTC, 2 * DAY_MS));
    expect(r!.bucket.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });
});

describe("granularity — the frozen-label drift that caused duplicate Pulse hits", () => {
  // INCIDENT 2026-07-28: one unchanged profile was flagged 6 times. SEEK kept
  // saying "1 month ago" while `now` advanced, so the derived bucket slid a day
  // per check and the (watch, person, bucket) dedupe key never matched.
  it("reports coarse labels as coarse and fine labels as day-granular", () => {
    const now = new Date("2026-07-28T00:00:00Z");
    expect(parseUpdatedAgo("Updated today", now)?.granularity).toBe("day");
    expect(parseUpdatedAgo("Updated yesterday", now)?.granularity).toBe("day");
    expect(parseUpdatedAgo("Updated 3 days ago", now)?.granularity).toBe("day");
    expect(parseUpdatedAgo("Updated 5 hours ago", now)?.granularity).toBe("day");
    expect(parseUpdatedAgo("Updated last week", now)?.granularity).toBe("week");
    expect(parseUpdatedAgo("Updated 2 weeks ago", now)?.granularity).toBe("week");
    expect(parseUpdatedAgo("Updated 1 month ago", now)?.granularity).toBe("month");
    expect(parseUpdatedAgo("Updated over a year ago", now)?.granularity).toBe("year");
  });

  it("DEMONSTRATES the drift: a frozen coarse label yields a DIFFERENT bucket each day", () => {
    const d1 = parseUpdatedAgo("Updated 1 month ago", new Date("2026-07-28T00:00:00Z"))!;
    const d2 = parseUpdatedAgo("Updated 1 month ago", new Date("2026-07-29T00:00:00Z"))!;
    expect(d1.bucket.getTime()).not.toBe(d2.bucket.getTime()); // ← why dedupe failed
    expect(d1.granularity).toBe("month"); // ← the flag detectHits guards on
  });

  it("a FINE label does NOT drift — it self-increments, so the bucket is stable", () => {
    // A profile updated on 2026-07-25 reads "3 days ago" on the 28th and
    // "4 days ago" on the 29th → both resolve to the same absolute day.
    const d1 = parseUpdatedAgo("Updated 3 days ago", new Date("2026-07-28T00:00:00Z"))!;
    const d2 = parseUpdatedAgo("Updated 4 days ago", new Date("2026-07-29T00:00:00Z"))!;
    expect(d1.bucket.toISOString()).toBe(d2.bucket.toISOString());
  });
});
