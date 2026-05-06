import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: { scoringWeightPreset: { deleteMany: vi.fn() } },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { DELETE } from "./route";

describe("scoring preset delete route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1", isOwner: false });
  });

  it("scopes the delete to the caller's org", async () => {
    dbMocks.prisma.scoringWeightPreset.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ presetId: "p1" }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.prisma.scoringWeightPreset.deleteMany.mock.calls[0][0].where).toEqual({
      id: "p1",
      orgId: "org-1",
    });
  });

  it("owner can delete any preset (no org scope)", async () => {
    sessionMocks.getAuth.mockResolvedValue({ userId: "owner", orgId: null, isOwner: true });
    dbMocks.prisma.scoringWeightPreset.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ presetId: "p1" }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.prisma.scoringWeightPreset.deleteMany.mock.calls[0][0].where).toEqual({ id: "p1" });
  });

  it("returns 404 when not found / not in caller's org", async () => {
    dbMocks.prisma.scoringWeightPreset.deleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ presetId: "p-other" }),
    });
    expect(res.status).toBe(404);
  });
});
