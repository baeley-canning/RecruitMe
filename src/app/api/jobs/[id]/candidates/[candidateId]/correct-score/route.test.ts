import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    scoreCorrection: { create: vi.fn(), findMany: vi.fn() },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireCandidateAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET, POST } from "./route";

describe("score correction route", () => {
  const job = {
    id: "job-1",
    orgId: "org-1",
    parsedRole: JSON.stringify({ title: "Software Engineer", must_haves: ["React"] }),
  };
  const candidate = {
    id: "cand-1",
    orgId: "org-1",
    matchScore: 78,
    name: "Test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireCandidateAccess.mockResolvedValue({ job, candidate, error: null });
  });

  it("POST creates a correction with clamped score + role title snapshot", async () => {
    dbMocks.prisma.scoreCorrection.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "c1", ...data,
    }));
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recruiterScore: 150, reason: "  Too senior  " }),
    }), { params: Promise.resolve({ id: "job-1", candidateId: "cand-1" }) });

    expect(res.status).toBe(200);
    const call = dbMocks.prisma.scoreCorrection.create.mock.calls[0][0];
    expect(call.data.recruiterScore).toBe(100);     // clamped down from 150
    expect(call.data.originalScore).toBe(78);       // snapshot of current score
    expect(call.data.roleTitle).toBe("Software Engineer"); // snapshot from parsedRole
    expect(call.data.candidateId).toBe("cand-1");
    expect(call.data.jobId).toBe("job-1");
    expect(call.data.reason).toBe("Too senior");    // trimmed
  });

  it("POST clamps negative scores to 0 and trims long reasons", async () => {
    dbMocks.prisma.scoreCorrection.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "c1", ...data }));
    const longReason = "x".repeat(1000);
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recruiterScore: -10, reason: longReason }),
    }), { params: Promise.resolve({ id: "job-1", candidateId: "cand-1" }) });
    expect(res.status).toBe(200);
    const call = dbMocks.prisma.scoreCorrection.create.mock.calls[0][0];
    expect(call.data.recruiterScore).toBe(0);
    expect((call.data.reason as string).length).toBe(500);
  });

  it("POST rejects missing recruiterScore", async () => {
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "no score" }),
    }), { params: Promise.resolve({ id: "job-1", candidateId: "cand-1" }) });
    expect(res.status).toBe(400);
  });

  it("GET lists corrections for the candidate", async () => {
    dbMocks.prisma.scoreCorrection.findMany.mockResolvedValue([
      { id: "c1", originalScore: 78, recruiterScore: 45, reason: "Profile is junior", createdAt: new Date() },
    ]);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1", candidateId: "cand-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(dbMocks.prisma.scoreCorrection.findMany.mock.calls[0][0].where).toEqual({ candidateId: "cand-1" });
  });

  it("returns 401 when not authed", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await POST(new Request("http://localhost/", { method: "POST", body: "{}" }), {
      params: Promise.resolve({ id: "job-1", candidateId: "cand-1" }),
    });
    expect(res.status).toBe(401);
  });
});
