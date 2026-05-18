import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate:      { findMany: vi.fn() },
    job:            { findMany: vi.fn() },
    contactEvent:   { findMany: vi.fn().mockResolvedValue([]) },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  verifyExtensionAuth: vi.fn(),
  jobsWhere: vi.fn((auth: { isOwner: boolean; orgId: string | null }) =>
    auth.isOwner ? {} : { OR: [{ orgId: auth.orgId }, { orgId: null }] }),
}));

const corsMocks = vi.hoisted(() => ({
  extensionCorsHeaders: vi.fn(() => ({ "Access-Control-Allow-Origin": "*" })),
}));

const usageMocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/extension-cors", () => corsMocks);
vi.mock("@/lib/usage", () => usageMocks);

import { GET, OPTIONS } from "./route";

describe("extension profile-match route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.verifyExtensionAuth.mockResolvedValue({ userId: "u1", orgId: "org-1", isOwner: false });
    usageMocks.checkRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns 401 without auth", async () => {
    sessionMocks.verifyExtensionAuth.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/?url=https://www.linkedin.com/in/x/"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when url query missing", async () => {
    const res = await GET(new Request("http://localhost/"));
    expect(res.status).toBe(400);
  });

  it("returns onActiveJobs + suggestedJobs for known candidate", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "c1",
        name: "Alex",
        matchScore: 82,
        status: "shortlisted",
        jobId: "job-1",
        profileText: "x".repeat(500),
        job: { id: "job-1", title: "Senior Engineer", company: "Acme", status: "active" },
      },
    ]);
    dbMocks.prisma.job.findMany.mockResolvedValue([
      { id: "job-1", title: "Senior Engineer", company: "Acme" },
      { id: "job-2", title: "Sales Lead",      company: "Acme" },
    ]);

    const res = await GET(new Request("http://localhost/?url=https://www.linkedin.com/in/alex/"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.onActiveJobs).toHaveLength(1);
    expect(body.onActiveJobs[0].jobId).toBe("job-1");
    expect(body.onActiveJobs[0].matchScore).toBe(82);
    expect(body.inLibrary).toBe(true);
    // job-2 is the only one the candidate isn't on yet
    expect(body.suggestedJobs.map((j: { id: string }) => j.id)).toEqual(["job-2"]);
  });

  it("OPTIONS replies 204 with CORS headers", async () => {
    const res = await OPTIONS(new Request("http://localhost/"));
    expect(res.status).toBe(204);
  });
});
