import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      findFirst: vi.fn(),
    },
    usageEvent: {
      count:  vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
    // tryAcquireLock / releaseLock target the Setting table via db-lock.ts,
    // and getCorrectionsVersion (audit SC4) reads cv.corrections.version.<orgId>.
    setting: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }), // claims the lock
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null), // no corrections recorded
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  scoreCandidatesBatch: vi.fn(),
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
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getOrgScoringWeights: scoringConfigMocks.getOrgScoringWeights,
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

import { POST } from "./route";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Relevant stack." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 72, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Solid seniority fit." },
      title_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Adjacent title." },
      domain_fit: { score: 64, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Relevant product domain, reasonable language match." },
      nice_to_have_fit: { score: 40, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Some bonus skills." },
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
    const job = {
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
    };
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    dbMocks.prisma.job.findUnique.mockResolvedValue(job);
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pool-1",
          name: "Jordan Lee",
          headline: "Full-stack Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/jordan-lee/",
          profileText: "Jordan Lee\nFull-stack Engineer at Acme Ltd\nWellington, New Zealand\n\nAbout\nExperienced full-stack engineer with over a decade specialising in React and Ruby on Rails. Has worked across SaaS products, internal tooling, and API-driven architectures. Comfortable leading small teams and working closely with product managers to deliver robust features on schedule. Strong communication skills and a pragmatic approach to software design and delivery.\n\nExperience\nSenior Software Engineer — Acme Ltd (2019–present)\nLed frontend and backend development of a customer-facing SaaS platform. Migrated monolithic Rails app to modular services. Introduced React component library used across three products.\n\nSoftware Engineer — BetaCorp (2015–2019)\nBuilt RESTful APIs and React UIs for enterprise clients. Contributed to open-source Rails tooling.\n\nSkills\nRuby on Rails, React, PostgreSQL, AWS, Docker, GraphQL\n".repeat(3),
          profileCapturedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "cand-2",
      createdAt: new Date(),
      ...create,
    }));
    aiMocks.scoreCandidatesBatch.mockImplementation(async (inputs: Array<{ candidateId: string }>) =>
      inputs.map((i) => ({ candidateId: i.candidateId, breakdown: makeBreakdown() })),
    );
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
    expect(aiMocks.scoreCandidatesBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ candidateId: expect.any(String), profileText: expect.any(String) })]),
      expect.any(Object),
      null,
      scoringConfigMocks.customWeights,
      "org-1",
    );
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.upsert.mock.calls[0][0].create.source).toBe("talent_pool");
  });
});

// ── Cap-bypass regression: pool candidates must use FULL-PROFILE Claude scoring
//    even on specialist hybrid roles. The snippet-only specialist cap
//    (SPECIALIST_SNIPPET_NO_ANCHOR_CAP=25) MUST NOT apply to pool candidates.
//    If a future refactor accidentally wires buildProvisionalSearchScore into
//    this path, this test catches it.
describe("talent-pool ingestion route — full-profile Claude bypass on specialist roles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // POWER role with distinctive must-haves (SCADA / RTU / metering). The
    // snippet specialist cap WOULD fire if a candidate's *snippet* lacked
    // those anchors. We're proving full-profile pool candidates dodge it.
    const powerRole = {
      id: "job-power",
      isRemote: false,
      parsedRole: JSON.stringify({
        title: "Senior POWER Systems Engineer",
        location: "Christchurch",
        location_rules: "Christchurch office",
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
    sessionMocks.requireJobAccess.mockResolvedValue({ job: powerRole, error: null });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    dbMocks.prisma.job.findUnique.mockResolvedValue(powerRole);
    // Pool candidate has a SCADA-heavy full profile (passes the pre-score
    // distinctive-term filter). The point of THIS test is the bypass: the
    // route uses Claude full-profile scoring, not a snippet cap.
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // existing-by-job
      .mockResolvedValueOnce([
        {
          id: "pool-2",
          name: "Sam Engineer",
          headline: "Senior SCADA Engineer at Mercury NZ",
          location: "Christchurch, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/sam-engineer/",
          profileText: "Sam Engineer\nSenior SCADA Engineer\nChristchurch, New Zealand\n\nAbout\nLed SCADA migration projects across Mercury NZ generation assets. RTU configuration for substation telemetry. Smart metering rollout across the Lower South Island. ".repeat(8),
          profileCapturedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "cand-power",
      createdAt: new Date(),
      ...create,
    }));
    // Claude returns 65 — well above the snippet cap (25). If snippet-mode
    // scoring leaked in, the result would be 25 (or below the 30 cutoff).
    const fullProfileBreakdown = buildScoreBreakdown({
      categories: {
        skill_fit: { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "SCADA stack." },
        location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Christchurch." },
        seniority_fit: { score: 65, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Senior." },
        title_fit: { score: 75, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "SCADA engineer." },
        domain_fit: { score: 60, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Energy." },
        nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Some bonus." },
      },
      must_have_coverage: [
        { requirement: "SCADA systems", status: "confirmed", evidence: "SCADA migration." },
        { requirement: "RTU configuration", status: "confirmed", evidence: "RTU rollout." },
        { requirement: "Smart metering", status: "confirmed", evidence: "Metering project." },
      ],
      nice_to_have_coverage: [],
      reasons_for: ["Strong SCADA spine."],
      reasons_against: [],
      missing_evidence: [],
      recruiter_summary: "Strong specialist match.",
      profileCharCount: 4000,
      claudeOverallScore: 65,
    });
    aiMocks.scoreCandidatesBatch.mockImplementation(async (inputs: Array<{ candidateId: string }>) =>
      inputs.map((i) => ({ candidateId: i.candidateId, breakdown: fullProfileBreakdown })),
    );
  });

  it("scores a pool candidate via Claude full-profile path (NOT snippet cap) on a specialist role", async () => {
    const req = new Request("http://localhost/api/jobs/job-power/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1, minScore: 0, radiusKm: 25 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-power" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    // Proof point #1: Claude full-profile scoring was called via batch.
    expect(aiMocks.scoreCandidatesBatch).toHaveBeenCalledTimes(1);
    // Proof point #2: the saved score is Claude's verdict (65), not the
    // snippet cap (25). If buildProvisionalSearchScore leaked in, the
    // overall would be 25 (or filtered below the 30 cutoff).
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(upsertCall.create.matchScore).toBe(65);
    // Source flag still set so the UI knows this is a pool import.
    expect(upsertCall.create.source).toBe("talent_pool");
  });
});

// ── Prefilter widening (Critic A extra #1) — when the must-have signal list
//    is thin (3-5 distinct terms), the WHERE clause widens to also include
//    nice-to-haves so the 12k take cap doesn't accidentally drop candidates
//    who match only one must-have but have strong nice-to-have coverage.
describe("talent-pool prefilter widens when must-have signals are thin (3-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 3 must-have phrases producing 3-5 total signals after stop-word
    // filtering — so the widening path fires. "management" is stop-listed
    // so "vendor management" + "risk management" each yield ONE token.
    // (We confirmed empirically that the must-signal count lands at 4 for
    // this fixture; the threshold for widening is < 6.)
    const thinRole = {
      id: "job-thin",
      isRemote: false,
      parsedRole: JSON.stringify({
        title: "Project Coordinator",
        location: "Wellington",
        location_rules: "Wellington",
        must_haves: ["vendor management", "risk management", "budget tracking"],
        nice_to_haves: ["procurement", "governance reporting", "PRINCE2 framework", "MSP", "contract negotiation"],
        knockout_criteria: [],
        skills_required: ["vendor management", "risk management", "budget tracking"],
        skills_preferred: ["procurement", "governance reporting", "PRINCE2 framework", "MSP", "contract negotiation"],
      }),
      salaryMin: null,
      salaryMax: null,
    };
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job: thinRole, error: null });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    dbMocks.prisma.job.findUnique.mockResolvedValue(thinRole);
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // existing for job
      .mockResolvedValueOnce([]); // pool rows (we only care about the WHERE call args)
    aiMocks.scoreCandidatesBatch.mockResolvedValue([]);
  });

  it("includes nice-to-haves in the prefilter OR-set when must-have signals are 3-5", async () => {
    const req = new Request("http://localhost/api/jobs/job-thin/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1, minScore: 0, radiusKm: 25 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-thin" }) });
    expect(res.status).toBe(200);

    // The pool-row findMany is the SECOND findMany call (first is "existing for job").
    const findManyCalls = dbMocks.prisma.candidate.findMany.mock.calls;
    expect(findManyCalls.length).toBeGreaterThanOrEqual(2);
    const poolQuery = findManyCalls[1][0] as { where: { OR?: Array<{ profileText: { contains: string } }> } };
    const orClause = poolQuery.where.OR ?? [];
    // Pull out the contains terms (lowercased for stable comparison).
    const terms = orClause
      .map((c) => c.profileText.contains.toLowerCase())
      // Filter out anything that isn't a string (defensive — the WHERE
      // shape can include nested OR/AND if the org-scope is non-null).
      .filter((t): t is string => typeof t === "string");

    // Must-have token signals still present.
    expect(terms).toEqual(expect.arrayContaining(["vendor", "budget"]));
    // Nice-to-have token signals also present — the widening behaviour.
    expect(terms).toEqual(expect.arrayContaining(["procurement", "governance"]));
    // Total term count exceeds the bare 3-term floor and stays under the cap.
    expect(terms.length).toBeGreaterThanOrEqual(6);
    expect(terms.length).toBeLessThanOrEqual(12);
  });

  it("does NOT widen when the must-have signal list is already broad (>=6 terms)", async () => {
    // 6 must-have noun phrases without alias expansion → 6 raw token signals,
    // hitting the "broad enough" threshold so the widening doesn't kick in.
    const broadRole = {
      id: "job-broad",
      isRemote: false,
      parsedRole: JSON.stringify({
        title: "Project Manager",
        location: "Wellington",
        location_rules: "Wellington",
        must_haves: [
          "vendor coordination",
          "budget tracking",
          "risk reporting",
          "schedule oversight",
          "contract negotiation",
          "PRINCE2 facilitation",
        ],
        nice_to_haves: ["procurement", "MSP"],
        knockout_criteria: [],
        skills_required: [
          "vendor coordination",
          "budget tracking",
          "risk reporting",
          "schedule oversight",
          "contract negotiation",
          "PRINCE2 facilitation",
        ],
        skills_preferred: ["procurement", "MSP"],
      }),
      salaryMin: null,
      salaryMax: null,
    };
    sessionMocks.requireJobAccess.mockResolvedValue({ job: broadRole, error: null });
    dbMocks.prisma.job.findUnique.mockResolvedValue(broadRole);
    dbMocks.prisma.candidate.findMany.mockReset();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = new Request("http://localhost/api/jobs/job-broad/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1, minScore: 0, radiusKm: 25 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-broad" }) });
    expect(res.status).toBe(200);

    const findManyCalls = dbMocks.prisma.candidate.findMany.mock.calls;
    const poolQuery = findManyCalls[1][0] as { where: { OR?: Array<{ profileText: { contains: string } }> } };
    const orClause = poolQuery.where.OR ?? [];
    const terms = orClause
      .map((c) => c.profileText.contains.toLowerCase())
      .filter((t): t is string => typeof t === "string");

    // Must-have signals present.
    expect(terms).toEqual(expect.arrayContaining(["vendor", "budget"]));
    // Nice-to-haves should NOT appear — broad must-have list skips widening.
    expect(terms).not.toContain("procurement");
  });
});
