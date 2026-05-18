import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: { savedSearch: { deleteMany: vi.fn() } },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { DELETE } from "./route";

describe("saved-searches delete route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { id: "job-1" }, error: null });
  });

  it("returns 401 when not authed", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1", savedId: "s1" }),
    });
    expect(res.status).toBe(401);
  });

  it("deletes when found and scoped to job", async () => {
    dbMocks.prisma.savedSearch.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1", savedId: "s1" }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.prisma.savedSearch.deleteMany.mock.calls[0][0].where).toEqual({
      id: "s1",
      jobId: "job-1",
    });
  });

  it("returns 404 when nothing matched (id from another job)", async () => {
    dbMocks.prisma.savedSearch.deleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1", savedId: "s-other-job" }),
    });
    expect(res.status).toBe(404);
  });
});
