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
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
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
vi.mock("@/lib/search", () => ({
  searchLinkedInProfiles: vi.fn(),
  searchBingLinkedInProfiles: vi.fn(),
  searchPDLProfiles: vi.fn(),
}));
vi.mock("@/lib/search-collection", () => searchCollectionMocks);
vi.mock("@/lib/talent-pool", () => talentPoolMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getOrgScoringWeights: scoringConfigMocks.getOrgScoringWeights,
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

import { POST } from "./route";
import { buildSearchEvaluation } from "@/lib/search-evaluation";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 88, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Strong stack fit." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 82, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Relevant seniority." },
      title_fit: { score: 78, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Close title match." },
      domain_fit: { score: 67, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Relevant domain, aligned wording." },
      nice_to_have_fit: { score: 45, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Some nice-to-haves." },
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
    // Hard-reset the mocks whose implementations are overridden inside specific
    // tests — clearAllMocks only clears call history, so a `mockResolvedValue`
    // set by one test would otherwise leak into the next.
    talentPoolMocks.buildTalentPoolMap.mockReset();
    dbMocks.prisma.candidate.findMany.mockReset();
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
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
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
          snippet: "Taylor Morgan - Full-stack Engineer - Wellington, New Zealand. React and Ruby on Rails delivery experience.",
          // fullText pushes the candidate over the full_profile threshold (≥ 2000 chars),
          // which is what triggers the structured-scoring path the mock validates.
          fullText: "Taylor Morgan\nFull-stack Engineer\nWellington, New Zealand\nAbout\nExperienced React and Ruby on Rails engineer with 8 years building production web apps. ".repeat(20),
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
    expect(dbMocks.prisma.candidate.upsert.mock.calls[0][0].create.fetchPriorityScore).toBeGreaterThanOrEqual(45);
    expect(dbMocks.prisma.candidate.upsert.mock.calls[0][0].create.fetchPriorityReason).toContain("fetch");
    expect(scoringConfigMocks.getJobScoringWeights).toHaveBeenCalled();
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
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledWith(
      fullProfile,
      expect.any(Object),
      null,
      scoringConfigMocks.customWeights,
      "org-1"
    );
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cand-existing" },
      data: expect.objectContaining({
        profileText: fullProfile,
        source: "talent_pool",
        fetchPriorityScore: expect.any(Number),
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
          // fullText pushes this candidate over the full_profile threshold so the route
          // uses the structured (mocked) score, isolating the gating logic under test.
          fullText: "Relevant Developer\nSoftware Developer\nWellington, New Zealand\nAbout\nC++ developer with Sybase database, Linux scripting and Azure platform experience. ".repeat(20),
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
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const importedNames = dbMocks.prisma.candidate.upsert.mock.calls.map((call) => call[0].create.name);
    expect(importedNames).toEqual(["Relevant Developer"]);
    expect(dbMocks.prisma.searchSession.create.mock.calls[0][0].data.queries).toContain("Sybase dba");
  });
});

describe("buildSearchEvaluation — distinctive-anchor warning hint", () => {
  // Locks the recruiter-visible warning string. If a future regex/prompt
  // change drops the "Looking for: SCADA, RTU, metering" hint, these
  // tests fail and the gap surfaces in CI.

  it("includes distinctive anchors in the WARNING when rejection rate is high", () => {
    const msg = buildSearchEvaluation({
      collected: 1,
      avgScore: 35,
      totalExamined: 20,
      candidatesRejected: 18,
      totalFiltered: 18,  // 90% rejected
      sawRetryableSearchFailure: false,
      distinctiveAnchors: ["SCADA", "RTU", "metering", "industrial controls"],
    });
    expect(msg).toMatch(/^WARNING/);
    expect(msg).toContain("Looking for: SCADA, RTU, metering, industrial controls");
    expect(msg).toContain("none found in most snippets");
  });

  it("truncates to 4 anchors when more are passed (UX cap)", () => {
    const msg = buildSearchEvaluation({
      collected: 1,
      avgScore: 35,
      totalExamined: 20,
      candidatesRejected: 18,
      totalFiltered: 18,
      sawRetryableSearchFailure: false,
      distinctiveAnchors: ["SCADA", "RTU", "metering", "industrial controls", "power distribution", "HV"],
    });
    expect(msg).toContain("SCADA, RTU, metering, industrial controls");
    expect(msg).not.toContain("power distribution");
    expect(msg).not.toContain("HV"); // truncated
  });

  it("OMITS the anchor hint when no distinctive anchors are passed", () => {
    const msg = buildSearchEvaluation({
      collected: 1,
      avgScore: 35,
      totalExamined: 20,
      candidatesRejected: 18,
      totalFiltered: 18,
      sawRetryableSearchFailure: false,
      distinctiveAnchors: [],
    });
    expect(msg).toMatch(/^WARNING/);
    expect(msg).not.toContain("Looking for:");
    expect(msg).not.toContain("none found in most snippets");
  });

  it("OMITS the anchor hint when rejection rate is low (no high-rejection warning)", () => {
    const msg = buildSearchEvaluation({
      collected: 15,
      avgScore: 60,
      totalExamined: 20,
      candidatesRejected: 5,
      totalFiltered: 5,  // 25% rejected — under 80% threshold
      sawRetryableSearchFailure: false,
      distinctiveAnchors: ["SCADA", "RTU"],
    });
    // Should be the OK message, not the warning — anchor hint isn't relevant
    expect(msg).toMatch(/^OK/);
    expect(msg).not.toContain("Looking for:");
  });
});
