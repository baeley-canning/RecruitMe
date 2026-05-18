/**
 * Unit tests for the cost guards in src/lib/usage.ts.
 *
 * Pins two recent policy changes:
 *  1) checkSpendCap applies a 5× multiplier for owner accounts (orgId null),
 *     mirroring checkRateLimit's ownerMultiplier — admin/bulk ops need headroom.
 *  2) insight_extract is guarded by BOTH a 24h ceiling (existing) and a 1h
 *     burst ceiling (new). Either breach short-circuits to allowed: false.
 *
 * No real DB. Mocks Prisma via the established vi.hoisted pattern.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const usageEvent = {
    count: vi.fn(),
    findFirst: vi.fn(),
    aggregate: vi.fn(),
    create: vi.fn(),
  };
  const prisma = { usageEvent };
  return { prisma };
});

vi.mock("@/lib/db", () => dbMocks);

import { checkRateLimit, checkSpendCap } from "../usage";

beforeEach(() => {
  dbMocks.prisma.usageEvent.count.mockReset();
  dbMocks.prisma.usageEvent.findFirst.mockReset();
  dbMocks.prisma.usageEvent.aggregate.mockReset();
  dbMocks.prisma.usageEvent.create.mockReset();
});

describe("checkSpendCap — owner multiplier", () => {
  it("(a) owner account (orgId null) gets 5× effective cap and capUsd reflects it", async () => {
    // Spent $20 — under 5× the $5 default ($25) but over $5.
    dbMocks.prisma.usageEvent.aggregate.mockResolvedValueOnce({ _sum: { costUsd: 20 } });
    const r = await checkSpendCap(null, 5);
    expect(r.allowed).toBe(true);
    expect(r.spentUsd).toBe(20);
    expect(r.capUsd).toBe(25); // 5 × 5
  });

  it("(b) user org gets the unmodified cap", async () => {
    dbMocks.prisma.usageEvent.aggregate.mockResolvedValueOnce({ _sum: { costUsd: 4 } });
    const r = await checkSpendCap("org-A", 5);
    expect(r.allowed).toBe(true);
    expect(r.capUsd).toBe(5);

    // And spending over the user-org cap blocks even though it would be fine
    // for an owner.
    dbMocks.prisma.usageEvent.aggregate.mockResolvedValueOnce({ _sum: { costUsd: 6 } });
    const blocked = await checkSpendCap("org-A", 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.capUsd).toBe(5);
  });

  it("owner spend over the 5× cap still blocks", async () => {
    dbMocks.prisma.usageEvent.aggregate.mockResolvedValueOnce({ _sum: { costUsd: 26 } });
    const r = await checkSpendCap(null, 5);
    expect(r.allowed).toBe(false);
    expect(r.capUsd).toBe(25);
  });
});

describe("checkRateLimit — insight_extract burst protection", () => {
  it("(c) hourly burst ceiling triggers below the daily limit", async () => {
    // Daily count under 200, but hourly count at/over 30.
    // count() is called once per window in order: daily (24h) then hourly (1h).
    dbMocks.prisma.usageEvent.count
      .mockResolvedValueOnce(50)  // 24h window: 50 < 200, allowed
      .mockResolvedValueOnce(30); // 1h window: 30 >= 30, breach
    dbMocks.prisma.usageEvent.findFirst.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
    });
    const r = await checkRateLimit("org-A", "insight_extract");
    expect(r.allowed).toBe(false);
    // retry-after is from the hourly window: ~50 minutes (3_000_000ms).
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs!).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("(d) when BOTH windows are breached, retryAfterMs is the longer of the two", async () => {
    dbMocks.prisma.usageEvent.count
      .mockResolvedValueOnce(200)  // daily: at cap
      .mockResolvedValueOnce(30);  // hourly: at cap
    const dailyOldest = new Date(Date.now() - 23 * 60 * 60 * 1000); // 23h ago → ~1h until retry
    const hourlyOldest = new Date(Date.now() - 10 * 60 * 1000);     // 10m ago  → ~50m until retry
    dbMocks.prisma.usageEvent.findFirst
      .mockResolvedValueOnce({ createdAt: dailyOldest })
      .mockResolvedValueOnce({ createdAt: hourlyOldest });
    const r = await checkRateLimit("org-A", "insight_extract");
    expect(r.allowed).toBe(false);
    // Daily retry ≈ 1h (3_600_000ms), hourly ≈ 50m. Longer wins.
    expect(r.retryAfterMs!).toBeGreaterThan(50 * 60 * 1000);
  });

  it("both windows under their ceilings → allowed", async () => {
    dbMocks.prisma.usageEvent.count
      .mockResolvedValueOnce(10)  // daily
      .mockResolvedValueOnce(5);  // hourly
    const r = await checkRateLimit("org-A", "insight_extract");
    expect(r.allowed).toBe(true);
    expect(dbMocks.prisma.usageEvent.findFirst).not.toHaveBeenCalled();
  });

  it("types without a burst entry only consult the primary window", async () => {
    // "score" has no BURST_LIMITS entry → count() invoked exactly once.
    dbMocks.prisma.usageEvent.count.mockResolvedValueOnce(5);
    const r = await checkRateLimit("org-A", "score");
    expect(r.allowed).toBe(true);
    expect(dbMocks.prisma.usageEvent.count).toHaveBeenCalledTimes(1);
  });
});
