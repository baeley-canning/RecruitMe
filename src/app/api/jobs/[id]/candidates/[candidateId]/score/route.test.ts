import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    usageEvent: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  predictAcceptance: vi.fn().mockResolvedValue({
    score: 65,
    likelihood: "medium",
    headline: "May consider",
    signals: [],
    summary: "Mock acceptance prediction.",
  }),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireCandidateAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  customWeights: {
    must_have: 0.5,
    skill_fit: 0.2,
    location_fit: 0.05,
    seniority_fit: 0.05,
    title_fit: 0.05,
    domain_fit: 0.1,
    nice_to_have_fit: 0.05,
  },
  getOrgScoringWeights: vi.fn(),
  getJobScoringWeights: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getOrgScoringWeights: scoringConfigMocks.getOrgScoringWeights,
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

import { POST } from "./route";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 78, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Relevant stack overlap." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Correct level." },
      title_fit: { score: 72, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Matching titles." },
      domain_fit: { score: 62, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Some domain overlap, good keyword alignment." },
      nice_to_have_fit: { score: 35, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Limited nice-to-haves." },
    },
    must_have_coverage: [
      { requirement: "React", status: "confirmed", evidence: "Explicitly listed." },
    ],
    nice_to_have_coverage: [],
    reasons_for: ["Useful re-score regression check."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Solid re-score candidate.",
    profileCharCount: 2400,
  });
}

describe("candidate re-score route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const job = {
      id: "job-1",
      parsedRole: JSON.stringify({
        title: "Software Engineer",
        location: "Wellington",
        location_rules: "Wellington office",
        must_haves: ["React"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["React"],
        skills_preferred: [],
      }),
      salaryMin: null,
      salaryMax: null,
    };
    const candidate = {
      id: "cand-5",
      jobId: "job-1",
      location: "Wellington, New Zealand",
      profileText: "Candidate profile text",
      profileTextHash: null,
      status: "new",
    };
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireCandidateAccess.mockResolvedValue({ job, candidate, error: null });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    dbMocks.prisma.job.findUnique.mockResolvedValue(job);
    // Track the last updateMany data so tests can assert on the score that
    // was written, then return it from findUnique to simulate the post-write
    // re-read. Default: updateMany succeeds (count: 1) so the hash gate
    // doesn't trip in the happy path.
    let lastWrite: Record<string, unknown> | null = null;
    dbMocks.prisma.candidate.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      lastWrite = data;
      return { count: 1 };
    });
    dbMocks.prisma.candidate.findUnique.mockImplementation(async () => ({
      ...candidate,
      ...(lastWrite ?? {}),
    }));
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
  });

  it("rebuilds structured score data for an existing candidate", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(dbMocks.prisma.candidate.updateMany).toHaveBeenCalledTimes(1);
    // Hash gate: write should be conditioned on profileTextHash === oldHash.
    expect(dbMocks.prisma.candidate.updateMany.mock.calls[0][0].where).toMatchObject({
      id: "cand-5",
      profileTextHash: null,
    });
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledWith(
      "Candidate profile text",
      expect.any(Object),
      null,
      scoringConfigMocks.customWeights,
      "org-1",
      undefined,
      expect.anything() // candidateLocation
    );
    expect(body.scoreBreakdown).toContain("\"version\":2");
  });

  it("skips the write when another scorer landed first (hash mismatch)", async () => {
    // Simulate the row's profileTextHash having advanced between our read
    // and our write. updateMany returns count: 0 — the route should log
    // and surface the existing row, NOT 500.
    dbMocks.prisma.candidate.updateMany.mockResolvedValueOnce({ count: 0 });
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-5",
      profileTextHash: "newer-hash-from-concurrent-write",
      matchScore: 88,
    });

    const res = await POST(
      new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", { method: "POST" }),
      { params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // We return the row as-is (the concurrent writer's score), not an error.
    expect(body.matchScore).toBe(88);
  });

  it("returns 400 for invalid stored job parse data", async () => {
    sessionMocks.requireCandidateAccess.mockResolvedValue({
      job: { id: "job-1", parsedRole: "{broken", salaryMin: null, salaryMax: null },
      candidate: { id: "cand-5", location: "Wellington", profileText: "Candidate profile text" },
      error: null,
    });

    const res = await POST(new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", { method: "POST" }), {
      params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/parse data is invalid/i);
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });
});
