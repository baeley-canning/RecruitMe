import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    usageEvent: { findMany: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => dbMocks);

import { getOrgUsageSummary } from "@/lib/usage-summary";

describe("getOrgUsageSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates cost + calls, zero-fills the daily series, and scopes every query to the org", async () => {
    const now = Date.now();
    dbMocks.prisma.usageEvent.findMany.mockResolvedValue([
      { costUsd: 0.5, createdAt: new Date(now - 1 * 3600_000) },
      { costUsd: 0.25, createdAt: new Date(now - 2 * 3600_000) },
      { costUsd: 0.1, createdAt: new Date(now - 26 * 3600_000) }, // yesterday
    ]);
    dbMocks.prisma.usageEvent.groupBy.mockResolvedValue([
      { type: "ai_call", _sum: { costUsd: 0.85 }, _count: { _all: 3 } },
      { type: "score", _sum: { costUsd: null }, _count: { _all: 12 } },
    ]);
    dbMocks.prisma.usageEvent.aggregate.mockResolvedValue({ _sum: { costUsd: 0.75 }, _count: { _all: 2 } });

    const s = await getOrgUsageSummary("org-A", 30);

    expect(s.totalCostUsd).toBe(0.85);
    expect(s.totalAiCalls).toBe(3);
    expect(s.last24hCostUsd).toBe(0.75);
    expect(s.last24hAiCalls).toBe(2);
    expect(s.daily).toHaveLength(30); // zero-filled window
    // byType sorted by cost desc: ai_call (0.85) before score (0)
    expect(s.byType[0].type).toBe("ai_call");
    expect(s.byType.find((t) => t.type === "score")?.count).toBe(12);
    // Every query filtered by org.
    for (const call of dbMocks.prisma.usageEvent.findMany.mock.calls) {
      expect(call[0].where.orgId).toBe("org-A");
    }
    expect(dbMocks.prisma.usageEvent.groupBy.mock.calls[0][0].where.orgId).toBe("org-A");
    expect(dbMocks.prisma.usageEvent.aggregate.mock.calls[0][0].where.orgId).toBe("org-A");
  });

  it("clamps the window to [1,120] days", async () => {
    dbMocks.prisma.usageEvent.findMany.mockResolvedValue([]);
    dbMocks.prisma.usageEvent.groupBy.mockResolvedValue([]);
    dbMocks.prisma.usageEvent.aggregate.mockResolvedValue({ _sum: { costUsd: null }, _count: { _all: 0 } });

    expect((await getOrgUsageSummary("org-A", 9999)).windowDays).toBe(120);
    expect((await getOrgUsageSummary("org-A", 0)).windowDays).toBe(1);
  });

  it("computes capUsedFraction from rolling-24h spend against the daily cap", async () => {
    dbMocks.prisma.usageEvent.findMany.mockResolvedValue([]);
    dbMocks.prisma.usageEvent.groupBy.mockResolvedValue([]);
    dbMocks.prisma.usageEvent.aggregate.mockResolvedValue({ _sum: { costUsd: 2.5 }, _count: { _all: 5 } });

    const s = await getOrgUsageSummary("org-A", 7);
    // cap default 5 → 2.5/5 = 0.5
    expect(s.capUsedFraction).toBeCloseTo(0.5, 5);
  });
});
