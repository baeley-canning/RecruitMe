import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => dbMocks);

const queueMocks = vi.hoisted(() => ({ enqueueScrapeJob: vi.fn() }));
vi.mock("@/lib/scrape-queue", () => queueMocks);

import { enqueueStaleProfileRefresh, DEFAULT_STALE_AFTER_DAYS } from "@/lib/profile-refresh";

const LI = (n: number) => `https://www.linkedin.com/in/person-${n}`;

beforeEach(() => {
  vi.clearAllMocks();
  queueMocks.enqueueScrapeJob.mockResolvedValue({ id: "job-1" });
});

describe("enqueueStaleProfileRefresh", () => {
  it("selects stale, LinkedIn-only, org-scoped profiles: stalest-first + DISTINCT per (orgId, linkedinUrl)", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([]);
    await enqueueStaleProfileRefresh();

    const args = dbMocks.prisma.candidate.findMany.mock.calls[0][0];
    expect(args.where.orgId).toEqual({ not: null });
    expect(args.where.linkedinUrl).toEqual({ not: null });
    // captured once (not null) AND older than the cutoff (a Date in the past).
    expect(args.where.profileCapturedAt.not).toBeNull();
    expect(args.where.profileCapturedAt.lt).toBeInstanceOf(Date);
    expect(args.where.profileCapturedAt.lt.getTime()).toBeLessThan(Date.now());
    expect(args.orderBy).toEqual({ profileCapturedAt: "asc" });
    expect(args.distinct).toEqual(["orgId", "linkedinUrl"]);
  });

  it("enqueues one BACKGROUND LinkedIn re-fetch per selected profile (tagged refresh:auto)", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "c1", orgId: "org-1", linkedinUrl: LI(1) },
      { id: "c2", orgId: "org-1", linkedinUrl: LI(2) },
    ]);

    const summary = await enqueueStaleProfileRefresh();

    expect(queueMocks.enqueueScrapeJob).toHaveBeenCalledTimes(2);
    expect(queueMocks.enqueueScrapeJob).toHaveBeenCalledWith({
      orgId: "org-1",
      platform: "linkedin",
      profileUrl: LI(1),
      candidateId: "c1",
      requestedBy: "refresh:auto",
    });
    // Profile jobs carry NO priority → they default to background (0), so a
    // refresh sweep can never jump ahead of a live recruiter search.
    expect(queueMocks.enqueueScrapeJob.mock.calls[0][0]).not.toHaveProperty("priority");
    expect(summary).toEqual({ candidates: 2, enqueued: 2, staleAfterDays: DEFAULT_STALE_AFTER_DAYS, limit: 25 });
  });

  it("skips rows whose linkedinUrl isn't a genuine profile URL (e.g. library: placeholder)", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "c1", orgId: "org-1", linkedinUrl: "library:c1" },
      { id: "c2", orgId: "org-1", linkedinUrl: LI(2) },
    ]);

    const summary = await enqueueStaleProfileRefresh();

    expect(queueMocks.enqueueScrapeJob).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueueScrapeJob).toHaveBeenCalledWith(expect.objectContaining({ profileUrl: LI(2) }));
    expect(summary.candidates).toBe(2);
    expect(summary.enqueued).toBe(1);
  });

  it("counts only NEW jobs as enqueued — a dedup hit (enqueue returns null) doesn't inflate the count", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "c1", orgId: "org-1", linkedinUrl: LI(1) },
      { id: "c2", orgId: "org-1", linkedinUrl: LI(2) },
    ]);
    queueMocks.enqueueScrapeJob
      .mockResolvedValueOnce({ id: "job-1" })
      .mockResolvedValueOnce(null); // already in-flight — deduped

    const summary = await enqueueStaleProfileRefresh();
    expect(summary).toEqual({ candidates: 2, enqueued: 1, staleAfterDays: DEFAULT_STALE_AFTER_DAYS, limit: 25 });
  });

  it("LIBRARY-SAFE: never updates or deletes a Candidate — it only enqueues", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "c1", orgId: "org-1", linkedinUrl: LI(1) },
    ]);

    await enqueueStaleProfileRefresh();

    expect(dbMocks.prisma.candidate.update).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.updateMany).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.delete).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.deleteMany).not.toHaveBeenCalled();
  });

  it("honours an explicit staleAfterDays override in the cutoff", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([]);
    const before = Date.now();
    await enqueueStaleProfileRefresh({ staleAfterDays: 30 });
    const args = dbMocks.prisma.candidate.findMany.mock.calls[0][0];
    const cutoffMs = args.where.profileCapturedAt.lt.getTime();
    // ~30 days back (allow a small execution window).
    const expected = before - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(5000);
  });
});
