import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  extractCandidateInfo: vi.fn(),
  predictAcceptance: vi.fn(),
  scoreCandidateStructured: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);

import { POST } from "./route";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 84, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Strong Rails and React evidence." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 76, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Right experience band." },
      title_fit: { score: 78, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Relevant title history." },
      industry_fit: { score: 62, weight: CATEGORY_WEIGHTS_V2.industry_fit, evidence: "Good SaaS overlap." },
      nice_to_have_fit: { score: 40, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Some nice-to-haves." },
      keyword_alignment: { score: 70, weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Aligned wording." },
    },
    must_have_coverage: [
      { requirement: "Ruby on Rails", status: "confirmed", evidence: "Listed explicitly." },
      { requirement: "React", status: "confirmed", evidence: "Listed explicitly." },
    ],
    nice_to_have_coverage: [],
    reasons_for: ["Strong manual-import fit."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Strong manual candidate.",
    profileCharCount: 3600,
  });
}

describe("manual candidate ingestion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.prisma.job.findUnique.mockResolvedValue({
      id: "job-1",
      parsedRole: JSON.stringify({
        title: "Software Engineer",
        location: "Wellington",
        location_rules: "Wellington office",
        must_haves: ["Ruby on Rails", "React"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["Ruby on Rails", "React"],
        skills_preferred: [],
      }),
      salaryMin: null,
      salaryMax: null,
    });
    dbMocks.prisma.candidate.create.mockResolvedValue({
      id: "cand-3",
      name: "Unknown",
    });
    dbMocks.prisma.candidate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cand-3",
      ...data,
    }));
    aiMocks.extractCandidateInfo.mockResolvedValue({
      name: "Alex Chen",
      headline: "Software Engineer",
      location: "Wellington, New Zealand",
    });
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    aiMocks.predictAcceptance.mockResolvedValue({
      score: 66,
      likelihood: "medium",
      headline: "Open to the right move",
      signals: [{ label: "Recent tenure supports mobility.", positive: true }],
      summary: "Likely open to a good role.",
    });
  });

  it("scores manual CV/profile adds with the structured scorer", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileText: "Alex Chen\nSoftware Engineer\nAbout\nFull-stack engineer with 8 years of experience building Ruby on Rails and React applications. Strong background in SaaS product development, API design, and front-end architecture. Currently based in Wellington, New Zealand. Led multiple high-traffic product teams and delivered end-to-end features across the stack.",
        autoScore: true,
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.update.mock.calls[0][0].data.scoreBreakdown).toContain("\"version\":2");
    expect(dbMocks.prisma.candidate.update.mock.calls[0][0].data.acceptanceScore).toBe(66);
    expect(body.scoreBreakdown).toContain("\"version\":2");
  });
});
