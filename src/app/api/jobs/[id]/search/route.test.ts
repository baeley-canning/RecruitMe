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

const searchCollectionMocks = vi.hoisted(() => ({
  collectPagedSearchResults: vi.fn(),
}));

const talentPoolMocks = vi.hoisted(() => ({
  buildTalentPoolMap: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/search", () => ({
  searchLinkedInProfiles: vi.fn(),
  searchBingLinkedInProfiles: vi.fn(),
  searchPDLProfiles: vi.fn(),
}));
vi.mock("@/lib/search-collection", () => searchCollectionMocks);
vi.mock("@/lib/talent-pool", () => talentPoolMocks);

import { POST } from "./route";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 88, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Strong stack fit." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 82, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Relevant seniority." },
      title_fit: { score: 78, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Close title match." },
      industry_fit: { score: 65, weight: CATEGORY_WEIGHTS_V2.industry_fit, evidence: "Relevant domain." },
      nice_to_have_fit: { score: 45, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Some nice-to-haves." },
      keyword_alignment: { score: 70, weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Aligned wording." },
    },
    must_have_coverage: [
      { requirement: "React", status: "confirmed", evidence: "Listed in current role." },
      { requirement: "Ruby on Rails", status: "likely", evidence: "Rails-adjacent evidence present." },
    ],
    nice_to_have_coverage: [],
    reasons_for: ["Strong full-stack overlap."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Strong search-import candidate.",
    profileCharCount: 1800,
  });
}

describe("search import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERPAPI_API_KEY = "test";
    delete process.env.BING_API_KEY;
    delete process.env.PDL_API_KEY;

    dbMocks.prisma.job.findUnique.mockResolvedValue({
      id: "job-1",
      parsedRole: JSON.stringify({
        title: "Software Engineer",
        location: "Wellington",
        location_rules: "Wellington office, 3 days in office",
        search_queries: ["react rails"],
        google_queries: [],
        synonym_titles: [],
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
      .mockResolvedValueOnce([]);
    dbMocks.prisma.candidate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cand-1",
      createdAt: new Date(),
      ...data,
    }));
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [
        {
          name: "Taylor Morgan",
          headline: "Full-stack Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/taylor-morgan/",
          snippet: "Taylor Morgan - Full-stack Engineer - Wellington, New Zealand",
          source: "serpapi",
        },
      ],
      sawRetryableFailure: false,
    });
    talentPoolMocks.buildTalentPoolMap.mockResolvedValue(new Map());
  });

  it("imports and scores search results into the job", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1, minScore: 0, radiusKm: 25 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(dbMocks.prisma.candidate.create).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.create.mock.calls[0][0].data.source).toBe("serpapi");
    expect(dbMocks.prisma.candidate.create.mock.calls[0][0].data.scoreBreakdown).toContain("\"version\":2");
  });
});
