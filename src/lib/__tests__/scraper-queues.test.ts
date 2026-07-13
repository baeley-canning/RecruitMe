import { describe, it, expect } from "vitest";
import { buildQueueStats, type CurrentGroup, type RecentGroup } from "@/lib/scraper-queues";

const NOW = new Date("2026-07-13T12:00:00.000Z").getTime();
const minsAgo = (m: number) => new Date(NOW - m * 60_000);

function cur(platform: string, kind: string, status: string, count: number, oldest: Date | null): CurrentGroup {
  return { platform, kind, status, _count: { _all: count }, _min: { createdAt: oldest } };
}
function rec(platform: string, kind: string, status: string, at: Date | null): RecentGroup {
  return { platform, kind, status, _max: { updatedAt: at } };
}

describe("buildQueueStats", () => {
  it("folds pending/processing counts per (platform, kind) and totals them", () => {
    const s = buildQueueStats(
      [
        cur("linkedin", "search", "pending", 3, minsAgo(5)),
        cur("linkedin", "search", "processing", 1, null),
        cur("seek", "search", "pending", 2, minsAgo(2)),
      ],
      [],
      NOW,
    );
    expect(s.totalPending).toBe(5);
    expect(s.totalProcessing).toBe(1);
    const li = s.queues.find((q) => q.platform === "linkedin" && q.kind === "search")!;
    expect(li.pending).toBe(3);
    expect(li.processing).toBe(1);
  });

  it("computes oldest-pending age from the min createdAt", () => {
    const s = buildQueueStats([cur("linkedin", "profile", "pending", 4, minsAgo(30))], [], NOW);
    expect(s.queues[0].oldestPendingMs).toBe(30 * 60_000);
  });

  it("maps last completed → lastOkAt and last failed → lastFailAt", () => {
    const s = buildQueueStats(
      [],
      [
        rec("linkedin", "profile", "completed", minsAgo(4)),
        rec("linkedin", "profile", "failed", minsAgo(90)),
      ],
      NOW,
    );
    const q = s.queues[0];
    expect(q.lastOkAt).toBe(minsAgo(4).toISOString());
    expect(q.lastFailAt).toBe(minsAgo(90).toISOString());
  });

  it("merges current + recent rows for the same queue into one row", () => {
    const s = buildQueueStats(
      [cur("seek", "profile", "pending", 1, minsAgo(1))],
      [rec("seek", "profile", "completed", minsAgo(3))],
      NOW,
    );
    const seek = s.queues.filter((q) => q.platform === "seek" && q.kind === "profile");
    expect(seek).toHaveLength(1);
    expect(seek[0].pending).toBe(1);
    expect(seek[0].lastOkAt).toBe(minsAgo(3).toISOString());
  });

  it("sorts busiest (most pending) first", () => {
    const s = buildQueueStats(
      [
        cur("seek", "search", "pending", 1, minsAgo(1)),
        cur("linkedin", "search", "pending", 9, minsAgo(1)),
      ],
      [],
      NOW,
    );
    expect(s.queues[0].platform).toBe("linkedin");
  });

  it("null oldest / empty inputs are handled without NaN", () => {
    const s = buildQueueStats([], [], NOW);
    expect(s.queues).toEqual([]);
    expect(s.totalPending).toBe(0);
    expect(s.totalProcessing).toBe(0);
  });
});
