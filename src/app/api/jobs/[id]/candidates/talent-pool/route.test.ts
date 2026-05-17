import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { POST } from "./route";

describe("talent-pool ingestion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const job = {
      id: "job-1",
      isRemote: false,
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
          profileText: "Jordan Lee\nFull-stack Engineer at Acme Ltd\nWellington, New Zealand\n\nAbout\nExperienced full-stack engineer with over a decade specialising in React and Ruby on Rails. Has worked across SaaS products, internal tooling, and API-driven architectures.\n\nExperience\nSenior Software Engineer — Acme Ltd (2019–present)\nLed frontend and backend development of a customer-facing SaaS platform. Migrated monolithic Rails app to modular services. Introduced React component library used across three products.\n\nSkills\nRuby on Rails, React, PostgreSQL, AWS, Docker, GraphQL\n".repeat(3),
          profileCapturedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "cand-2",
      createdAt: new Date(),
      ...create,
    }));
  });

  it("imports library profiles WITHOUT calling AI scoring (recruiter clicks Score all afterwards)", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    // Critical: zero AI spend on library imports.
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();

    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(upsertCall.create.source).toBe("talent_pool");
    expect(upsertCall.create.status).toBe("new");
    // No score fields set — score-all writes those later.
    expect(upsertCall.create.matchScore).toBeUndefined();
    expect(upsertCall.create.scoreBreakdown).toBeUndefined();
  });

  it("imports JobAdder library candidates that have CV text but no LinkedIn URL", async () => {
    dbMocks.prisma.candidate.findMany.mockReset();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pool-jobadder-1",
          name: "Ari Patel",
          headline: "Senior Full-stack Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: null,
          jobAdderUrl: "https://app.jobadder.com/candidates/123",
          source: "jobadder_import",
          profileText: "Ari Patel\nSenior Full-stack Engineer\nWellington, New Zealand\n\nExperience\nBuilt React and Ruby on Rails products, APIs, PostgreSQL integrations, and cloud deployments for product teams. ".repeat(5),
          profileCapturedAt: null,
          createdAt: new Date().toISOString(),
        },
      ]);

    const req = new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(upsertCall.where.jobId_linkedinUrl).toEqual({
      jobId: "job-1",
      linkedinUrl: "library:pool-jobadder-1",
    });
    expect(upsertCall.create.linkedinUrl).toBe("library:pool-jobadder-1");
    expect(upsertCall.create.jobAdderUrl).toBe("https://app.jobadder.com/candidates/123");
    expect(upsertCall.create.source).toBe("talent_pool");
  });

  it("REGRESSION: the SQL WHERE clause includes jobId:null so JobAdder orphans (jobId IS NULL) surface", async () => {
    // Pre-fix the route filtered with `jobId: { not: jobId }`. Prisma compiles
    // that to `jobId != X`, which is FALSE for NULL values in SQL three-valued
    // logic — silently hiding every JobAdder-imported library candidate whose
    // original job was deleted. The user reported "library search never finds
    // JobAdder candidates" and this assertion pins the fix: the WHERE clause
    // must explicitly include `{ jobId: null }` so orphans are visible.
    dbMocks.prisma.candidate.findMany.mockReset();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });
    await POST(req, { params: Promise.resolve({ id: "job-1" }) });

    // The second findMany call is the pool query. Its WHERE clause must
    // surface jobId:null as one of the acceptable jobId values.
    const calls = dbMocks.prisma.candidate.findMany.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const poolWhere = calls[1][0].where as Record<string, unknown>;
    const serialised = JSON.stringify(poolWhere);
    // The OR must contain { jobId: null } — otherwise orphan candidates are
    // silently excluded.
    expect(serialised).toContain('"jobId":null');
  });

  it("returns 401 when not authed (no AI calls fired)", async () => {
    sessionMocks.getAuth.mockResolvedValue(null);
    const res = await POST(new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
      method: "POST",
      body: "{}",
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(401);
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
  });

  // Lock removed in the JobAdder-NULL fix commit — talent-pool no longer
  // burns AI tokens so the race protection it provided isn't worth the
  // 15-min-stale-TTL 429 it inflicted on real users after any crashed run.
  // The (jobId, linkedinUrl) unique constraint still race-protects upserts.

  it("rejects pool candidates lacking any distinctive anchor on a specialist role", async () => {
    // ≥2 distinctive must-haves → strict specialist mode. Profile must mention
    // at least one role-distinctive term.
    const specialistJob = {
      id: "job-specialist",
      isRemote: false,
      parsedRole: JSON.stringify({
        title: "Senior SAFe Scrum Master",
        location: "Wellington",
        location_rules: "Wellington office",
        must_haves: ["SAFe certification", "Scrum Master experience", "PI planning facilitation"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["SAFe", "Scrum Master", "PI Planning"],
        skills_preferred: [],
      }),
      salaryMin: null,
      salaryMax: null,
    };
    sessionMocks.requireJobAccess.mockResolvedValue({ job: specialistJob, error: null });
    dbMocks.prisma.candidate.findMany.mockReset();
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "pool-off-domain",
          name: "Sam Off-Domain",
          headline: "Full-stack Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/sam-fs/",
          profileText: "Sam Off-Domain\nFull-stack Engineer\nWellington, New Zealand\n\nExperience\nBuilds web applications with React and PostgreSQL. No agile certifications, no scrum facilitation, no PI planning experience.\n".repeat(3),
          profileCapturedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]);

    const req = new Request("http://localhost/api/jobs/job-specialist/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 1 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-specialist" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(0);
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
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
    dbMocks.prisma.job.findUnique.mockResolvedValue(thinRole);
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])  // existing for job
      .mockResolvedValueOnce([]); // pool rows (we only care about the WHERE call args)
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
