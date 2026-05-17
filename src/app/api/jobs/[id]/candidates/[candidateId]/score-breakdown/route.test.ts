import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findUnique: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireCandidateAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET } from "./route";

function makeRequest() {
  return new Request("http://localhost/api/jobs/job-1/candidates/cand-1/score-breakdown");
}

const params = Promise.resolve({ id: "job-1", candidateId: "cand-1" });

describe("score-breakdown lazy-load route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1", isOwner: false });
    sessionMocks.requireCandidateAccess.mockResolvedValue({
      job: { id: "job-1" },
      candidate: { id: "cand-1" },
      error: null,
    });
  });

  it("returns 401 when there is no session", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), { params });

    expect(res.status).toBe(401);
    // We never touch the DB before auth — important for keeping anonymous
    // probes off the candidate table.
    expect(dbMocks.prisma.candidate.findUnique).not.toHaveBeenCalled();
  });

  it("propagates the candidate-access error (e.g. 404 / 403)", async () => {
    sessionMocks.requireCandidateAccess.mockResolvedValueOnce({
      job: null,
      candidate: null,
      error: new Response(null, { status: 404 }),
    });

    const res = await GET(makeRequest(), { params });

    expect(res.status).toBe(404);
    expect(dbMocks.prisma.candidate.findUnique).not.toHaveBeenCalled();
  });

  it("returns the breakdown JSON string for an existing candidate", async () => {
    const breakdown = JSON.stringify({ overall: 82, version: 2 });
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({ scoreBreakdown: breakdown });

    const res = await GET(makeRequest(), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ scoreBreakdown: breakdown });
    // Only the one column should be selected — the whole point of this
    // route is to keep the payload tiny.
    expect(dbMocks.prisma.candidate.findUnique).toHaveBeenCalledWith({
      where: { id: "cand-1" },
      select: { scoreBreakdown: true },
    });
  });

  it("returns null when the candidate has no breakdown yet (unscored)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({ scoreBreakdown: null });

    const res = await GET(makeRequest(), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ scoreBreakdown: null });
  });

  it("returns 404 when the row vanished between auth and read (race)", async () => {
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), { params });

    expect(res.status).toBe(404);
  });
});
