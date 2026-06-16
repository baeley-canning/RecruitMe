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
