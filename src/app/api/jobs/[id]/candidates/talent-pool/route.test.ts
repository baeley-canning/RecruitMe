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
    // tryAcquireLock / releaseLock target the Setting table via db-lock.ts
    setting: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }), // claims the lock
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
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
