import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
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

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { POST } from "./route";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 78, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Relevant stack overlap." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Correct level." },
      title_fit: { score: 72, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Matching titles." },
      industry_fit: { score: 58, weight: CATEGORY_WEIGHTS_V2.industry_fit, evidence: "Some domain overlap." },
      nice_to_have_fit: { score: 35, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Limited nice-to-haves." },
      keyword_alignment: { score: 66, weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Good keyword overlap." },
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
    };
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireCandidateAccess.mockResolvedValue({ job, candidate, error: null });
    dbMocks.prisma.job.findUnique.mockResolvedValue(job);
    dbMocks.prisma.candidate.findUnique.mockResolvedValue(candidate);
    dbMocks.prisma.candidate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cand-5",
      ...data,
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
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledTimes(1);
    expect(body.scoreBreakdown).toContain("\"version\":2");
  });
});
