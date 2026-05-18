import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    searchSession: { aggregate: vi.fn() },
    candidate:     { findMany: vi.fn(), count: vi.fn() },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
  // The route is now wrapped with withJobAuth — reproduce that behaviour
  // here so we can still test the inner handler in isolation.
  withJobAuth: <R>(handler: (args: { auth: { userId: string; orgId: string | null; isOwner: boolean }; req: Request; params: { id: string }; job: unknown }) => Promise<R>) =>
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
      const auth = await sessionMocks.getAuth();
      if (!auth) return sessionMocks.unauthorized();
      const params = await ctx.params;
      const { job, error } = await sessionMocks.requireJobAccess(params.id, auth);
      if (error) return error;
      return handler({ auth, req, params, job });
    },
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET } from "./route";

describe("search-funnel route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { id: "job-1" }, error: null });
  });

  it("aggregates session totals + candidate buckets correctly", async () => {
    dbMocks.prisma.searchSession.aggregate.mockResolvedValue({
      _sum:   { totalExamined: 50, candidatesRejected: 30, collected: 12 },
      _count: { id: 3 },
    });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { status: "shortlisted", matchScore: 80 },
      { status: "shortlisted", matchScore: 70 },
      { status: "rejected",    matchScore: 25 },
      { status: "new",         matchScore: null },
      { status: "new",         matchScore: 60 },
    ]);
    // 4 of 5 rows have profileText; the route now derives this from a
    // dedicated count() query rather than scanning the result set.
    dbMocks.prisma.candidate.count.mockResolvedValue(4);

    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.searchRuns).toBe(3);
    expect(body.surfaced).toBe(50);
    expect(body.filteredAtSource).toBe(30);
    expect(body.imported).toBe(12);
    expect(body.totalCandidates).toBe(5);
    expect(body.fetched).toBe(4);          // 4 candidates with profileText
    expect(body.scored).toBe(4);            // 4 with matchScore
    expect(body.shortlisted).toBe(2);
    expect(body.rejectedByRecruiter).toBe(1);
    expect(body.avgScore).toBe(Math.round((80 + 70 + 25 + 60) / 4));
  });

  it("returns sensible zeros for an empty job", async () => {
    dbMocks.prisma.searchSession.aggregate.mockResolvedValue({
      _sum: { totalExamined: null, candidatesRejected: null, collected: null },
      _count: { id: 0 },
    });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([]);
    dbMocks.prisma.candidate.count.mockResolvedValue(0);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json();
    expect(body.searchRuns).toBe(0);
    expect(body.totalCandidates).toBe(0);
    expect(body.avgScore).toBeNull();
  });

  it("returns 401 when not authed", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(401);
  });
});
