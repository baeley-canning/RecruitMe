/**
 * Unit tests for enqueueScoreJob (Llama scoring offload).
 *
 * The offload enqueue must (a) dedup against any in-flight score job for the
 * same (orgId, candidateId) so re-score mashing / score-all re-runs enqueue
 * once, and (b) otherwise create a kind="score" ScrapeJob with the serialized
 * scorePayload at priority 0 (so live scrapes win the box's claim ordering).
 * Never throws — callers fire-and-forget.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    scrapeJob: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const errorMocks = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/error-reporting", () => errorMocks);

import { enqueueScoreJob } from "@/lib/scrape-queue";

const SCORE_PAYLOAD = {
  system: "You are a scoring assistant.",
  prompt: "Role: Engineer\nCandidate: ...",
  temperature: 0.1,
  maxTokens: 4096,
  finalizeCtx: {
    mustHaves: ["React"],
    niceToHaves: [],
    parsedRoleLocation: "Wellington",
    parsedRoleTitle: "Software Engineer",
  },
};

describe("enqueueScoreJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dedups an in-flight score job for the same candidate (returns null, no create)", async () => {
    dbMocks.prisma.scrapeJob.findFirst.mockResolvedValue({ id: "existing-score-job" });

    const res = await enqueueScoreJob({
      orgId: "org-1",
      candidateId: "cand-1",
      scorePayload: SCORE_PAYLOAD,
    });

    expect(res).toBeNull();
    expect(dbMocks.prisma.scrapeJob.create).not.toHaveBeenCalled();
    // Dedup is scoped to kind="score" + this candidate + in-flight statuses.
    expect(dbMocks.prisma.scrapeJob.findFirst.mock.calls[0][0].where).toMatchObject({
      orgId: "org-1",
      candidateId: "cand-1",
      kind: "score",
      status: { in: ["pending", "processing"] },
    });
  });

  it("creates a kind=score job with serialized scorePayload, priority 0, default platform", async () => {
    dbMocks.prisma.scrapeJob.findFirst.mockResolvedValue(null);
    dbMocks.prisma.scrapeJob.create.mockResolvedValue({ id: "new-score-job" });

    const res = await enqueueScoreJob({
      orgId: "org-1",
      candidateId: "cand-1",
      scorePayload: SCORE_PAYLOAD,
    });

    expect(res).toEqual({ id: "new-score-job" });
    const data = dbMocks.prisma.scrapeJob.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      orgId: "org-1",
      platform: "linkedin", // default
      kind: "score",
      candidateId: "cand-1",
      profileUrl: null,
      status: "pending",
      priority: 0, // live scrapes (100) win claim ordering
    });
    // scorePayload is JSON-serialized and round-trips back to the input object.
    expect(JSON.parse(data.scorePayload as string)).toEqual(SCORE_PAYLOAD);
  });

  it("honours an explicit platform override", async () => {
    dbMocks.prisma.scrapeJob.findFirst.mockResolvedValue(null);
    dbMocks.prisma.scrapeJob.create.mockResolvedValue({ id: "j" });

    await enqueueScoreJob({ orgId: "o", candidateId: "c", platform: "seek", scorePayload: SCORE_PAYLOAD });

    const data = dbMocks.prisma.scrapeJob.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.platform).toBe("seek");
  });

  it("never throws — returns null and reports on DB error", async () => {
    dbMocks.prisma.scrapeJob.findFirst.mockRejectedValue(new Error("db down"));

    const res = await enqueueScoreJob({ orgId: "org-1", candidateId: "cand-1", scorePayload: SCORE_PAYLOAD });

    expect(res).toBeNull();
    expect(errorMocks.reportError).toHaveBeenCalled();
  });
});
