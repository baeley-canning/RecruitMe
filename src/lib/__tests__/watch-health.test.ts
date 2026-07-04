import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    watchedSearch: { findMany: vi.fn(), update: vi.fn() },
    searchRun: { findMany: vi.fn() },
    searchRunResult: { findMany: vi.fn() },
    candidate: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => dbMocks);

import { deriveWatchHealth, reconcileWatchHealth } from "@/lib/watched-search";

const NOW = new Date("2026-07-04T12:00:00.000Z");

describe("deriveWatchHealth", () => {
  const base = { active: true, consecutiveFailures: 0, lastCheckAt: NOW, intervalMinutes: 60 };

  it("is 'failing' after 3+ consecutive failures, regardless of recency", () => {
    expect(deriveWatchHealth({ ...base, consecutiveFailures: 3 }, NOW)).toBe("failing");
    expect(deriveWatchHealth({ ...base, consecutiveFailures: 9, lastCheckAt: NOW }, NOW)).toBe("failing");
  });

  it("is 'pending' when the watch has never completed a check", () => {
    expect(deriveWatchHealth({ ...base, lastCheckAt: null }, NOW)).toBe("pending");
  });

  it("is 'stale' when an active watch's last check is older than 2 intervals (min 6h)", () => {
    // interval 60m → threshold = max(2h, 6h) = 6h. 7h ago → stale.
    const sevenHrsAgo = new Date(NOW.getTime() - 7 * 3600_000);
    expect(deriveWatchHealth({ ...base, lastCheckAt: sevenHrsAgo }, NOW)).toBe("stale");
    // 5h ago → still ok (under the 6h floor).
    const fiveHrsAgo = new Date(NOW.getTime() - 5 * 3600_000);
    expect(deriveWatchHealth({ ...base, lastCheckAt: fiveHrsAgo }, NOW)).toBe("ok");
  });

  it("uses 2× interval when that exceeds the 6h floor (a daily watch)", () => {
    // interval 1440m (24h) → threshold = 48h. 30h ago → still ok.
    const thirtyHrsAgo = new Date(NOW.getTime() - 30 * 3600_000);
    expect(deriveWatchHealth({ active: true, consecutiveFailures: 0, lastCheckAt: thirtyHrsAgo, intervalMinutes: 1440 }, NOW)).toBe("ok");
    const fiftyHrsAgo = new Date(NOW.getTime() - 50 * 3600_000);
    expect(deriveWatchHealth({ active: true, consecutiveFailures: 0, lastCheckAt: fiftyHrsAgo, intervalMinutes: 1440 }, NOW)).toBe("stale");
  });

  it("never flags a PAUSED watch as stale (only failing counts when paused)", () => {
    const longAgo = new Date(NOW.getTime() - 1000 * 3600_000);
    expect(deriveWatchHealth({ active: false, consecutiveFailures: 0, lastCheckAt: longAgo, intervalMinutes: 60 }, NOW)).toBe("ok");
    expect(deriveWatchHealth({ active: false, consecutiveFailures: 5, lastCheckAt: longAgo, intervalMinutes: 60 }, NOW)).toBe("failing");
  });
});

describe("reconcileWatchHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.prisma.watchedSearch.update.mockResolvedValue({});
  });

  it("a failed check increments consecutiveFailures and stores the (truncated) error", async () => {
    await reconcileWatchHealth("w-1", "failed", "x".repeat(999), 0);
    const data = dbMocks.prisma.watchedSearch.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.lastCheckStatus).toBe("failed");
    expect(data.consecutiveFailures).toEqual({ increment: 1 });
    expect((data.lastError as string).length).toBe(500);
  });

  it("a successful check resets failures, clears the error, and advances lastHitAt only when there were new hits", async () => {
    await reconcileWatchHealth("w-1", "complete", null, 2);
    let data = dbMocks.prisma.watchedSearch.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.consecutiveFailures).toBe(0);
    expect(data.lastError).toBeNull();
    expect(data.lastHitAt).toBeInstanceOf(Date);

    dbMocks.prisma.watchedSearch.update.mockClear();
    await reconcileWatchHealth("w-1", "partial", null, 0);
    data = dbMocks.prisma.watchedSearch.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.consecutiveFailures).toBe(0);
    expect(data.lastHitAt).toBeUndefined(); // no new hits → don't move it
  });

  it("never throws when the DB write fails (health is advisory)", async () => {
    dbMocks.prisma.watchedSearch.update.mockRejectedValueOnce(new Error("db down"));
    await expect(reconcileWatchHealth("w-1", "failed", "boom", 0)).resolves.toBeUndefined();
  });
});
