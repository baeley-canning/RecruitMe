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
  searchTalentPoolForRole: vi.fn(),
  POOL_SEARCH_DEFAULT_SHORTLIST: 30,
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
  // Mock matches the real signature: classifies JD text into permanent /
  // contract / unknown. Default to "unknown" in tests — they don't care
  // about this signal unless they explicitly opt in.
  inferEmploymentType: vi.fn(() => "unknown"),
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
    talentPoolMocks.searchTalentPoolForRole.mockReset();
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: [],
      examined: 0,
      preRankPool: 0,
      shortlisted: 0,
      scored: 0,
      returned: 0,
    });
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
    // findMany call sequence after pool-first wiring:
    //   1. Phase 0: existingForJob (URLs already on this job, for pool-first exclusion)
    //   2. Post-LinkedIn: existingCandidates (full row, used for url-reuse upgrade path)
    //   3. Final merge: pool candidates by id (only fires if poolFirstSaved > 0)
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([]) // existingForJob
      .mockResolvedValueOnce([]) // existingCandidates
      .mockResolvedValueOnce([]); // poolSavedFull
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
    // existingForJob (Phase 0) — return the existing snippet so it's excluded from pool-first
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { linkedinUrl: "https://www.linkedin.com/in/taylor-morgan/" },
    ]);
    // existingCandidates (post-LinkedIn) — the same candidate row in full
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
    // poolSavedFull — empty (pool-first didn't import)
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]);
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

// ───────────────────────────────────────────────────────────────────────────
//  Pool-first search — 9 required scenarios
// ───────────────────────────────────────────────────────────────────────────
describe("search route — pool-first integration scenarios", () => {
  function makePoolResult(overrides: {
    candidateId: string;
    name?: string;
    headline?: string;
    location?: string;
    linkedinUrl: string;
    overall?: number;
  }) {
    return {
      hit: {
        candidateId: overrides.candidateId,
        name: overrides.name ?? "Pool Candidate",
        headline: overrides.headline ?? "Senior SCADA Engineer",
        location: overrides.location ?? "Wellington, New Zealand",
        linkedinUrl: overrides.linkedinUrl,
        profileText: "SCADA RTU substation profile. ".repeat(50),
        profileCapturedAt: new Date(),
        isFresh: true,
        matchedAnchors: ["scada", "rtu"],
        signalDensity: 2,
      },
      scoreBreakdown: makeBreakdown(),
      candidateLocation: overrides.location ?? "Wellington, New Zealand",
    };
  }

  function setupBaselineMocks() {
    process.env.SERPAPI_API_KEY = "test";
    delete process.env.BING_API_KEY;
    delete process.env.PDL_API_KEY;
    const job = {
      id: "job-power",
      orgId: "org-1",
      isRemote: false,
      location: "Wellington",
      parsedRole: JSON.stringify({
        title: "Senior SCADA Engineer",
        location: "Wellington",
        location_rules: "Wellington office",
        search_queries: ["scada engineer wellington"],
        google_queries: [],
        synonym_titles: [],
        seniority_band: "senior",
        must_haves: ["SCADA systems", "RTU configuration", "Smart metering"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["SCADA", "RTU", "metering"],
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
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    talentPoolMocks.buildTalentPoolMap.mockResolvedValue(new Map());
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create, where }) => ({
      id: `cand-${(where as { jobId_linkedinUrl: { linkedinUrl: string } }).jobId_linkedinUrl.linkedinUrl.split("/").pop() || "x"}`,
      createdAt: new Date(),
      ...create,
    }));
    return job;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    talentPoolMocks.buildTalentPoolMap.mockReset();
    talentPoolMocks.searchTalentPoolForRole.mockReset();
    dbMocks.prisma.candidate.findMany.mockReset();
  });

  it("Scenario 1 — pool fills maxResults: LinkedIn search NOT called, source=talent_pool, session says skipped", async () => {
    setupBaselineMocks();
    const poolResults = [
      makePoolResult({ candidateId: "p-1", linkedinUrl: "https://www.linkedin.com/in/p1" }),
      makePoolResult({ candidateId: "p-2", linkedinUrl: "https://www.linkedin.com/in/p2" }),
      makePoolResult({ candidateId: "p-3", linkedinUrl: "https://www.linkedin.com/in/p3" }),
    ];
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]); // existingForJob
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: poolResults,
      examined: 3,
      preRankPool: 3,
      shortlisted: 3,
      scored: 3,
      returned: 3,
    });

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    expect(res.status).toBe(200);
    expect(searchCollectionMocks.collectPagedSearchResults).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(3);
    for (const call of dbMocks.prisma.candidate.upsert.mock.calls) {
      expect((call[0] as { create: { source: string } }).create.source).toBe("talent_pool");
    }
    const sessionUpdates = dbMocks.prisma.searchSession.update.mock.calls;
    const finalUpdate = sessionUpdates[sessionUpdates.length - 1][0] as { data: { message: string; evaluation?: string } };
    expect(finalUpdate.data.message).toMatch(/talent pool/i);
    expect(finalUpdate.data.message).toMatch(/LinkedIn (search )?skipped/i);
  });

  it("Scenario 2 — pool partially fills: LinkedIn called with reduced budget; both counts in message", async () => {
    setupBaselineMocks();
    const poolResults = [
      makePoolResult({ candidateId: "p-1", linkedinUrl: "https://www.linkedin.com/in/p1" }),
      makePoolResult({ candidateId: "p-2", linkedinUrl: "https://www.linkedin.com/in/p2" }),
    ];
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // existingForJob
      .mockResolvedValueOnce([])  // existingCandidates (post-LinkedIn)
      .mockResolvedValueOnce(poolResults.map((r) => ({  // poolSavedFull
        id: `cand-${r.hit.linkedinUrl.split("/").pop()}`,
        matchScore: r.scoreBreakdown.overall,
        linkedinUrl: r.hit.linkedinUrl,
        name: r.hit.name,
        headline: r.hit.headline,
        location: r.hit.location,
      })));
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: poolResults,
      examined: 2,
      preRankPool: 2,
      shortlisted: 2,
      scored: 2,
      returned: 2,
    });
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [
        {
          name: "LinkedIn Cand",
          headline: "Senior SCADA Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/linkedin-cand/",
          snippet: "Strong SCADA RTU metering experience.",
          fullText: "Senior SCADA Engineer with extensive RTU and substation experience. ".repeat(40),
          source: "serpapi",
        },
      ],
      sawRetryableFailure: false,
    });

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    // LinkedIn DID run, but with reduced target (remainingSlots = 1).
    expect(searchCollectionMocks.collectPagedSearchResults).toHaveBeenCalledTimes(1);
    const call = searchCollectionMocks.collectPagedSearchResults.mock.calls[0][0] as { targetCount: number };
    // remainingSlots=1 → targetRaw = min(max(1*3, 1+15), 120) = 16, NOT the original 60.
    expect(call.targetCount).toBeLessThanOrEqual(16);

    const finalMessage = (dbMocks.prisma.searchSession.update.mock.calls.at(-1)?.[0] as { data: { message: string } }).data.message;
    expect(finalMessage).toMatch(/2 from talent pool/);
    expect(finalMessage).toMatch(/from LinkedIn/);
  });

  it("Scenario 3 — pool empty: LinkedIn search behaves as before", async () => {
    setupBaselineMocks();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // existingForJob
      .mockResolvedValueOnce([])  // existingCandidates
      .mockResolvedValueOnce([]); // poolSavedFull
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: [],
      examined: 0,
      preRankPool: 0,
      shortlisted: 0,
      scored: 0,
      returned: 0,
    });
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [
        {
          name: "LinkedIn Only",
          headline: "Senior SCADA Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/linkedin-only/",
          snippet: "SCADA RTU experience.",
          fullText: "SCADA Engineer profile with extensive RTU and substation experience. ".repeat(40),
          source: "serpapi",
        },
      ],
      sawRetryableFailure: false,
    });

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    expect(searchCollectionMocks.collectPagedSearchResults).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalled();
  });

  it("Scenario 4 — pool error: LinkedIn fallback runs, search does not fail", async () => {
    setupBaselineMocks();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    talentPoolMocks.searchTalentPoolForRole.mockRejectedValue(new Error("DB timeout"));
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [
        {
          name: "LinkedIn Cand",
          headline: "Senior SCADA Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/linkedin-cand/",
          fullText: "SCADA profile. ".repeat(150),
          source: "serpapi",
        },
      ],
      sawRetryableFailure: false,
    });

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    // Search did NOT fail — POST returns 200 and LinkedIn fallback runs.
    expect(res.status).toBe(200);
    expect(searchCollectionMocks.collectPagedSearchResults).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalled();
  });

  it("Scenario 5 — pool candidate must be re-scored: saved matchScore comes from the FRESH ScoreBreakdown, not any stored field", async () => {
    setupBaselineMocks();
    // The pool function (mocked) returns a freshly-computed ScoreBreakdown
    // from the CURRENT JD. The route persists it via deriveUpdateData. We
    // prove the route is reading from THAT breakdown (not from any stale
    // candidate row) by passing a known overall and asserting it round-trips.
    const fresh = makeBreakdown();
    const expectedOverall = fresh.overall;
    const poolResult = {
      hit: {
        candidateId: "p-stale",
        name: "Stale Pat",
        headline: "Senior SCADA Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/stale",
        profileText: "SCADA RTU substation profile. ".repeat(50),
        profileCapturedAt: new Date(),
        isFresh: true,
        matchedAnchors: ["scada", "rtu"],
        signalDensity: 2,
      },
      scoreBreakdown: fresh,
      candidateLocation: "Wellington, New Zealand",
    };
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]);
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: [poolResult],
      examined: 1, preRankPool: 1, shortlisted: 1, scored: 1, returned: 1,
    });

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = dbMocks.prisma.candidate.upsert.mock.calls[0][0] as { create: { matchScore: number; source: string; scoreBreakdown?: string } };
    expect(upsertCall.create.matchScore).toBe(expectedOverall);
    expect(upsertCall.create.source).toBe("talent_pool");
    // The persisted scoreBreakdown JSON must serialise the fresh breakdown
    // (proving deriveUpdateData ran on the new score, not a stored value).
    expect(upsertCall.create.scoreBreakdown).toContain('"version":2');
  });

  it("Scenario 6 — existing attached candidate is excluded from pool-first import", async () => {
    setupBaselineMocks();
    // Phase 0 returns the URL as already attached → pool-first must skip it.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { linkedinUrl: "https://www.linkedin.com/in/already-here/" },
    ]);
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: [], examined: 0, preRankPool: 0, shortlisted: 0, scored: 0, returned: 0,
    });
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [],
      sawRetryableFailure: false,
    });
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([]) // existingCandidates
      .mockResolvedValueOnce([]); // poolSavedFull

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    // Pool function was called WITH the already-attached URL in the
    // exclude set. (We mocked the function so the impl test is the
    // unit-test layer; here we verify the route passes the right input.)
    const poolCall = talentPoolMocks.searchTalentPoolForRole.mock.calls[0][0] as { excludeLinkedInUrls: Set<string> };
    // The route normalises URLs before adding to the exclude set — accept
    // either form here (with/without trailing slash) since both should
    // collide on the same canonical key.
    const urls = [...poolCall.excludeLinkedInUrls];
    expect(urls.some((u) => u.includes("already-here"))).toBe(true);
  });

  it("Scenario 7 — location: Auckland pool candidate excluded from Wellington-onsite role", async () => {
    setupBaselineMocks();
    // Verifies the route passes job.isRemote=false to the pool function.
    // The pool function (unit-tested separately) drops overseas candidates
    // and applies location-fit override; the route's responsibility is
    // simply to forward job.isRemote correctly.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]);
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: [], examined: 0, preRankPool: 0, shortlisted: 0, scored: 0, returned: 0,
    });
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [],
      sawRetryableFailure: false,
    });
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    const poolCall = talentPoolMocks.searchTalentPoolForRole.mock.calls[0][0] as {
      job: { isRemote: boolean };
      targetLocation: string;
      parsedRole: { location_rules: string };
    };
    expect(poolCall.job.isRemote).toBe(false);
    expect(poolCall.targetLocation).toContain("Wellington");
    expect(poolCall.parsedRole.location_rules).toContain("Wellington");
  });

  it("Scenario 8 — specialist role: pool result with rich SCADA profile passes via Claude full-profile path", async () => {
    setupBaselineMocks();
    // The pool function (unit-tested separately) only returns candidates
    // it pre-ranked + Claude-scored. Here we verify the ROUTE saves them
    // with full Claude scoring intact (source=talent_pool, matchScore from
    // breakdown, scoreBreakdown JSON persisted).
    const poolResult = {
      hit: {
        candidateId: "scada-1",
        name: "SCADA Sam",
        headline: "Senior SCADA Engineer at Transpower",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/scada-sam",
        profileText: "Senior SCADA engineer. Strong RTU and substation experience. ".repeat(40),
        profileCapturedAt: new Date(),
        isFresh: true,
        matchedAnchors: ["scada", "rtu"],
        signalDensity: 2,
      },
      scoreBreakdown: makeBreakdown(),
      candidateLocation: "Wellington, New Zealand",
    };
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]);
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: [poolResult],
      examined: 1, preRankPool: 1, shortlisted: 1, scored: 1, returned: 1,
    });

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const upsert = dbMocks.prisma.candidate.upsert.mock.calls[0][0] as {
      create: { source: string; matchScore: number; scoreBreakdown?: string; profileText?: string };
    };
    expect(upsert.create.source).toBe("talent_pool");
    expect(upsert.create.matchScore).toBeGreaterThan(0);
    expect(upsert.create.scoreBreakdown).toContain('"version":2');
    expect(upsert.create.profileText).toContain("Senior SCADA engineer");
    // LinkedIn was NOT called because pool filled maxResults.
    expect(searchCollectionMocks.collectPagedSearchResults).not.toHaveBeenCalled();
  });

  it("Scenario 9 — URL enrichment still works: LinkedIn URL with pool match uses stored full text", async () => {
    setupBaselineMocks();
    // Pool profile MUST contain the role's distinctive anchors (SCADA / RTU
    // / metering) — otherwise the source-gate filter rejects the candidate
    // before the score loop and Claude is never called.
    const fullProfile = "Senior SCADA engineer with strong RTU and smart metering experience across substation rollout. ".repeat(40);
    const poolEntry = {
      candidateId: "pool-1",
      name: "Reuse Sam",
      headline: "Senior SCADA Engineer",
      location: "Wellington, New Zealand",
      profileText: fullProfile,
      profileCapturedAt: new Date(),
      isFresh: true,
    };
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // existingForJob
      .mockResolvedValueOnce([])  // existingCandidates
      .mockResolvedValueOnce([]); // poolSavedFull
    talentPoolMocks.searchTalentPoolForRole.mockResolvedValue({
      results: [], examined: 0, preRankPool: 0, shortlisted: 0, scored: 0, returned: 0,
    });
    talentPoolMocks.buildTalentPoolMap.mockResolvedValue(new Map([
      ["https://www.linkedin.com/in/reuse-sam", poolEntry],
      ["https://www.linkedin.com/in/reuse-sam/", poolEntry],
    ]));
    searchCollectionMocks.collectPagedSearchResults.mockResolvedValue({
      items: [
        {
          name: "Reuse Sam",
          headline: "Senior SCADA Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/reuse-sam/",
          snippet: "SCADA RTU metering experience",
          source: "serpapi",
        },
      ],
      sawRetryableFailure: false,
    });

    const req = new Request("http://localhost/api/jobs/job-power/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 3 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    await new Promise((r) => setTimeout(r, 50));

    // Claude was called with the FULL pool profile text — proving URL
    // enrichment from the existing buildTalentPoolMap path still operates.
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalled();
    const profileTextArg = aiMocks.scoreCandidateStructured.mock.calls[0][0] as string;
    expect(profileTextArg).toContain("Senior SCADA engineer with strong RTU");
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
