import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  getOrgScoringWeights: vi.fn(),
  saveOrgScoringWeights: vi.fn(),
  normaliseWeights: vi.fn((weights) => weights),
  DEFAULT_SCORING_WEIGHTS: {
    must_have: 0.36,
    skill_fit: 0.22,
    location_fit: 0.08,
    seniority_fit: 0.1,
    title_fit: 0.08,
    domain_fit: 0.1,
    nice_to_have_fit: 0.06,
  },
}));

vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => scoringConfigMocks);

import { GET, PUT } from "./route";

describe("scoring settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue({
      must_have: 0.5,
      skill_fit: 0.2,
      location_fit: 0.05,
      seniority_fit: 0.05,
      title_fit: 0.05,
      domain_fit: 0.1,
      nice_to_have_fit: 0.05,
    });
  });

  it("loads org scoring weights", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(scoringConfigMocks.getOrgScoringWeights).toHaveBeenCalledWith("org-1");
    expect(body.weights.must_have).toBe(0.5);
  });

  it("saves normalized org scoring weights", async () => {
    const weights = {
      must_have: 0.5,
      skill_fit: 0.2,
      location_fit: 0.05,
      seniority_fit: 0.05,
      title_fit: 0.05,
      domain_fit: 0.1,
      nice_to_have_fit: 0.05,
    };

    const res = await PUT(new Request("http://localhost/api/settings/scoring", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(weights),
    }));

    expect(res.status).toBe(200);
    expect(scoringConfigMocks.normaliseWeights).toHaveBeenCalledWith(weights);
    expect(scoringConfigMocks.saveOrgScoringWeights).toHaveBeenCalledWith("org-1", weights);
  });
});
