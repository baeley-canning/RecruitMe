import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: { scoringWeightPreset: { findMany: vi.fn(), create: vi.fn() } },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  normaliseWeights: (w: Record<string, number>) => w,
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => scoringConfigMocks);

import { GET, POST } from "./route";

const validWeights = {
  must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10,
  title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06,
};

describe("scoring presets list/create route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1", isOwner: false });
  });

  it("GET filters by orgId for non-owners", async () => {
    dbMocks.prisma.scoringWeightPreset.findMany.mockResolvedValue([]);
    await GET();
    expect(dbMocks.prisma.scoringWeightPreset.findMany.mock.calls[0][0].where).toEqual({ orgId: "org-1" });
  });

  it("GET shows everything for owners", async () => {
    sessionMocks.getAuth.mockResolvedValue({ userId: "owner", orgId: null, isOwner: true });
    dbMocks.prisma.scoringWeightPreset.findMany.mockResolvedValue([]);
    await GET();
    expect(dbMocks.prisma.scoringWeightPreset.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("POST creates a preset", async () => {
    dbMocks.prisma.scoringWeightPreset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "p1", ...data,
    }));
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sales-heavy", weights: validWeights }),
    }));
    expect(res.status).toBe(200);
    const call = dbMocks.prisma.scoringWeightPreset.create.mock.calls[0][0];
    expect(call.data.name).toBe("Sales-heavy");
    expect(call.data.orgId).toBe("org-1");
    expect(JSON.parse(call.data.weights as string)).toEqual(validWeights);
  });

  it("POST rejects malformed bodies", async () => {
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    }));
    expect(res.status).toBe(422);
  });

  it("POST returns 409 on duplicate name (P2002)", async () => {
    dbMocks.prisma.scoringWeightPreset.create.mockRejectedValue({ code: "P2002" });
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup", weights: validWeights }),
    }));
    expect(res.status).toBe(409);
  });
});
