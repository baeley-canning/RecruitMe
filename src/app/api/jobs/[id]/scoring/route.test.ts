import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: { job: { update: vi.fn() } },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  customWeights: {
    must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10,
    title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06,
  },
  customJobWeights: {
    must_have: 0.50, skill_fit: 0.20, location_fit: 0.05, seniority_fit: 0.05,
    title_fit: 0.05, domain_fit: 0.10, nice_to_have_fit: 0.05,
  },
  defaults: {
    must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10,
    title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06,
  },
  getOrgScoringWeights: vi.fn(),
  getJobScoringWeights: vi.fn(),
  normaliseWeights:     (w: Record<string, number>) => w,
  DEFAULT_SCORING_WEIGHTS: {
    must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10,
    title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06,
  },
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => scoringConfigMocks);

import { GET, PUT, DELETE } from "./route";

describe("per-job scoring weights route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({
      job: { id: "job-1", scoringWeights: null },
      error: null,
    });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
  });

  it("GET reflects no-override state", async () => {
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasOverride).toBe(false);
    expect(body.weights).toEqual(scoringConfigMocks.customWeights);
    expect(body.orgDefaults).toEqual(scoringConfigMocks.customWeights);
  });

  it("GET reflects existing override", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({
      job: { id: "job-1", scoringWeights: JSON.stringify(scoringConfigMocks.customJobWeights) },
      error: null,
    });
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customJobWeights);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json();
    expect(body.hasOverride).toBe(true);
    expect(body.weights).toEqual(scoringConfigMocks.customJobWeights);
  });

  it("PUT persists per-job weights", async () => {
    const res = await PUT(new Request("http://localhost/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scoringConfigMocks.customJobWeights),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);
    const call = dbMocks.prisma.job.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "job-1" });
    expect(JSON.parse(call.data.scoringWeights as string)).toEqual(scoringConfigMocks.customJobWeights);
  });

  it("PUT rejects malformed bodies", async () => {
    const res = await PUT(new Request("http://localhost/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ not: "valid" }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(422);
  });

  it("DELETE clears override and returns org defaults", async () => {
    const res = await DELETE(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.prisma.job.update.mock.calls[0][0].data).toEqual({ scoringWeights: null });
    const body = await res.json();
    expect(body.weights).toEqual(scoringConfigMocks.customWeights);
  });

  it("returns 401 when not authed", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(401);
  });
});
