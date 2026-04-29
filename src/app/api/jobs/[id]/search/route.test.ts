import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    searchSession: {
      create: vi.fn().mockResolvedValue({ id: "session-1" }),
      update: vi.fn().mockResolvedValue({ id: "session-1" }),
    },
    usageEvent: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
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

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
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
vi.mock("@/lib/session", () => sessionMocks);

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

    const job = {
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
    };
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.job.findUnique.mockResolvedValue(job);
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "cand-1",
      createdAt: new Date(),
      ...create,
    }));
    dbMocks.prisma.candidate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cand-existing",
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

  it("returns sessionId immediately and processes in background", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    // POST returns immediately with a session ID
    expect(res.status).toBe(200);
    expect(body.sessionId).toBeDefined();
    expect(body.status).toBe("running");

    // Let the background task complete
    await new Promise((r) => setTimeout(r, 50));

    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.upsert.mock.calls[0][0].create.source).toBe("serpapi");
    expect(dbMocks.prisma.candidate.upsert.mock.calls[0][0].create.scoreBreakdown).toContain("\"version\":2");
  });

  it("upgrades an existing snippet candidate when a full talent-pool profile exists", async () => {
    dbMocks.prisma.candidate.findMany.mockReset();
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "cand-existing",
        name: "Taylor Morgan",
        headline: "Full-stack Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/taylor-morgan/",
        profileText: "Short search snippet",
        profileCapturedAt: null,
      },
    ]);
    const fullProfile = "Taylor Morgan\nFull-stack Engineer\nWellington, New Zealand\nAbout\nExperienced React and Ruby on Rails engineer. ".repeat(30);
    const poolEntry = {
        candidateId: "pool-1",
        name: "Taylor Morgan",
        headline: "Full-stack Engineer",
        location: "Wellington, New Zealand",
        profileText: fullProfile,
        profileCapturedAt: new Date("2026-01-01T00:00:00.000Z"),
        isFresh: true,
      };
    talentPoolMocks.buildTalentPoolMap.mockResolvedValue(new Map([
      ["https://www.linkedin.com/in/taylor-morgan", poolEntry],
      ["https://www.linkedin.com/in/taylor-morgan/", poolEntry],
    ]));

    const req = new Request("http://localhost/api/jobs/job-1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    await new Promise((r) => setTimeout(r, 50));

    expect(res.status).toBe(200);
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cand-existing" },
      data: expect.objectContaining({
        profileText: fullProfile,
        source: "talent_pool",
        scoreBreakdown: expect.stringContaining("\"version\":2"),
        profileTextHash: expect.any(String),
      }),
    }));
  });

  it("filters broad junior/no-signal results for specialist roles before importing", async () => {
    const specialistJob = {
      id: "job-1",
      parsedRole: JSON.stringify({
        title: "Software Developer",
        location: "Wellington",
        location_rules: "Wellington office",
        search_queries: ["software developer sybase c++"],
        google_queries: [],
        synonym_titles: ["Full Stack Developer"],
        seniority_band: "Mid-level",
        must_haves: ["C++ programming experience", "Sybase database experience", "Linux scripting", "Azure cloud platform experience"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["C++", "Sybase", "Linux", "Azure"],
        skills_preferred: [],
      }),
      salaryMin: null,
      salaryMax: null,
      isRemote: false,
      location: "Wellington",
      orgId: "org-1",
    };
    sessionMocks.requireJobAccess.mockResolvedValue({ job: specialistJob, error: null });
    dbMocks.prisma.job.findUnique.mockResolvedValue(specialistJob);
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [
        {
          name: "Junior Candidate",
          headline: "Full-Stack Developer | Dev Academy | Seeking Entry-Level Programming Position",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/junior-candidate/",
          snippet: "Bootcamp graduate with React and Node.js.",
          source: "serpapi",
        },
        {
          name: "Generic Developer",
          headline: "Senior Software Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/generic-developer/",
          snippet: "React, TypeScript, AWS and web applications.",
          source: "serpapi",
        },
        {
          name: "Cloud Developer",
          headline: "Azure Microservices Developer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/cloud-developer/",
          snippet: "Azure, Linux scripting, Kubernetes and microservices, but no legacy database stack.",
          matchedQuery: "Azure microservices",
          source: "serpapi",
        },
        {
          name: "Query Matched",
          headline: "Enterprise Software Developer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/query-matched/",
          snippet: "Experienced enterprise software developer with government systems background.",
          matchedQuery: "C++ Sybase",
          source: "serpapi",
        },
        {
          name: "Relevant Developer",
          headline: "Software Developer | C++ | Sybase | Linux | Azure",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/relevant-developer/",
          snippet: "C++ developer with Sybase database, Linux scripting and Azure platform experience.",
          source: "serpapi",
        },
      ],
      sawRetryableFailure: false,
    });

    const req = new Request("http://localhost/api/jobs/job-1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    await new Promise((r) => setTimeout(r, 50));

    expect(res.status).toBe(200);
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(2);
    const importedNames = dbMocks.prisma.candidate.upsert.mock.calls.map((call) => call[0].create.name);
    expect(importedNames).toEqual(expect.arrayContaining(["Relevant Developer", "Query Matched"]));
    expect(dbMocks.prisma.searchSession.create.mock.calls[0][0].data.queries).toContain("Sybase dba");
  });
});
