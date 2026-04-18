import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);

import { POST } from "./route";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Relevant stack." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 72, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Solid seniority fit." },
      title_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Adjacent title." },
      industry_fit: { score: 60, weight: CATEGORY_WEIGHTS_V2.industry_fit, evidence: "Relevant product domain." },
      nice_to_have_fit: { score: 40, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Some bonus skills." },
      keyword_alignment: { score: 68, weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Reasonable language match." },
    },
    must_have_coverage: [
      { requirement: "React", status: "confirmed", evidence: "Listed explicitly." },
      { requirement: "Ruby on Rails", status: "likely", evidence: "Strong Rails-adjacent evidence." },
    ],
    nice_to_have_coverage: [],
    reasons_for: ["Useful talent-pool overlap."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Good talent-pool candidate.",
    profileCharCount: 2400,
  });
}

describe("talent-pool ingestion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.prisma.job.findUnique.mockResolvedValue({
      id: "job-1",
      parsedRole: JSON.stringify({
        title: "Software Engineer",
        location: "Wellington",
        location_rules: "Wellington office",
        must_haves: ["React", "Ruby on Rails"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["React", "Ruby on Rails"],
        skills_preferred: [],
      }),
      salaryMin: null,
      salaryMax: null,
    });
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pool-1",
          name: "Jordan Lee",
          headline: "Full-stack Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/jordan-lee/",
          profileText: "Jordan Lee\nFull-stack Engineer at Acme Ltd\nWellington, New Zealand\n\nAbout\nExperienced full-stack engineer with over a decade specialising in React and Ruby on Rails. Has worked across SaaS products, internal tooling, and API-driven architectures. Comfortable leading small teams and working closely with product managers to deliver robust features on schedule. Strong communication skills and a pragmatic approach to software design and delivery.\n\nExperience\nSenior Software Engineer — Acme Ltd (2019–present)\nLed frontend and backend development of a customer-facing SaaS platform. Migrated monolithic Rails app to modular services. Introduced React component library used across three products.\n\nSoftware Engineer — BetaCorp (2015–2019)\nBuilt RESTful APIs and React UIs for enterprise clients. Contributed to open-source Rails tooling.\n\nSkills\nRuby on Rails, React, PostgreSQL, AWS, Docker, GraphQL",
          profileCapturedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]);
    dbMocks.prisma.candidate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cand-2",
      createdAt: new Date(),
      ...data,
    }));
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
  });

  it("imports scored talent-pool profiles into the current job", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1, minScore: 0, radiusKm: 25 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(dbMocks.prisma.candidate.create).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.create.mock.calls[0][0].data.source).toBe("talent_pool");
  });
});
