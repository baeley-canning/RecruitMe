import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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
vi.mock("@/lib/require-capability", () => ({
  requireCapability: vi.fn(async () => null),
  getUserPermissions: vi.fn(async () => []),
}));

import { PATCH } from "./route";

describe("candidate patch route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireCandidateAccess.mockResolvedValue({ job: { id: "job-1" }, candidate: { id: "cand-1" }, error: null });
    dbMocks.prisma.candidate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cand-1",
      ...data,
    }));
  });

  it("normalizes edited LinkedIn URLs before saving", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates/cand-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        linkedinUrl: "https://nz.linkedin.com/in/ranjana-tyagi-3755b615/?trk=people",
      }),
    });

    const res = await PATCH(req, {
      params: Promise.resolve({ id: "job-1", candidateId: "cand-1" }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-1" },
        data: expect.objectContaining({
          linkedinUrl: "https://www.linkedin.com/in/ranjana-tyagi-3755b615",
        }),
      })
    );
  });
});
