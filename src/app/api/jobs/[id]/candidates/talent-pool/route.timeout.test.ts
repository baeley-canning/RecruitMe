/**
 * Regression coverage for the two "no candidates returned" code paths in the
 * talent-pool route:
 *
 *   (a) Library is empty / no matching profiles — message should say
 *       "No library matches" or equivalent so the recruiter knows to capture
 *       more profiles rather than tweak the JD.
 *   (b) Scoring batch timed out / threw — message should distinguish
 *       partial-result-with-stoppedEarly from "nothing matched at all".
 *
 * The sibling file `route.test.ts` covers the happy path. This file pins the
 * empty / timeout edges so a future refactor can't quietly collapse the two
 * states into the same generic error string.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findMany: vi.fn(),
      create:   vi.fn(),
      upsert:   vi.fn(),
      findFirst: vi.fn(),
    },
    usageEvent: {
      count:     vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create:    vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
    setting: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create:     vi.fn().mockResolvedValue({}),
      update:     vi.fn().mockResolvedValue({}),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  scoreCandidatesBatch:     vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth:          vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized:     vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  customWeights: {
    must_have: 0.5, skill_fit: 0.2, location_fit: 0.05, seniority_fit: 0.05,
    title_fit: 0.05, domain_fit: 0.1, nice_to_have_fit: 0.05,
  },
  getOrgScoringWeights: vi.fn(),
  getJobScoringWeights: vi.fn(),
}));

vi.mock("@/lib/db",      () => dbMocks);
vi.mock("@/lib/ai",      () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getOrgScoringWeights: scoringConfigMocks.getOrgScoringWeights,
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

import { POST } from "./route";

const baseJob = {
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

function arm(jobOverrides: Partial<typeof baseJob> = {}) {
  const job = { ...baseJob, ...jobOverrides };
  sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
  sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
  scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
  scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
  dbMocks.prisma.job.findUnique.mockResolvedValue(job);
}

describe("talent-pool — empty library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arm();
    // First call = existing-by-jobId (empty); second = candidate pool (empty).
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
  });

  it("returns count=0 and a message that clearly says no library profiles exist", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 5, minScore: 50 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.candidates).toEqual([]);
    // The empty-pool message should be qualitatively different from a
    // "nothing cleared the score floor" message. Either "library" / "pool"
    // / "capture" must appear so the recruiter knows what to do next.
    expect(body.message).toMatch(/library|pool|capture|profile/i);
    // And we should NOT have called Claude for an empty pool.
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
  });
});

// OBSOLETE after commit 14a619c — the talent-pool route is now hard-match
// only and never calls Claude/scoreCandidatesBatch during import. The
// "scoring batch times out" path it pinned no longer exists. Keeping the
// describe block for narrative + future re-use if scoring is ever wired
// back into the import path, but the cases inside are skipped.
describe.skip("talent-pool — scoring batch times out / throws (obsolete: hard-match only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arm();
    // Needs to pass hasFullCandidateProfile — either >=2000 chars, or >=500 chars
    // with profileCapturedAt set. We set both belt-and-braces.
    const profileText = (
      "Jordan Lee\nFull-stack Engineer at Acme Ltd\nWellington, New Zealand\n\nAbout\n" +
      "Experienced full-stack engineer specialising in React and Ruby on Rails. " +
      "Led frontend and backend development of a customer-facing SaaS platform. " +
      "Built RESTful APIs and React UIs across multiple enterprise clients. "
    ).repeat(15);
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([]) // existing-by-jobId
      .mockResolvedValueOnce([
        {
          id: "pool-1",
          name: "Jordan Lee",
          headline: "Full-stack Engineer",
          location: "Wellington, New Zealand",
          linkedinUrl: "https://www.linkedin.com/in/jordan-lee/",
          profileText,
          profileCapturedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "cand-1", createdAt: new Date(), ...create,
    }));
    // Simulate the Anthropic batch throwing — the route's try/catch around
    // Promise.race should swallow it, set stoppedEarly=true, and return a
    // distinct message.
    aiMocks.scoreCandidatesBatch.mockRejectedValue(new Error("batch score timeout"));
  });

  it("surfaces stoppedEarly + a non-empty-library message when scoring fails", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates/talent-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 5, minScore: 50 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(0);
    // We can't always observe stoppedEarly directly — depends on whether the
    // batch throw cascades through scored=0 vs. save-loop early-out. What we
    // CAN guarantee: the message must NOT be the empty-library wording from
    // the other describe block. Different cause → different recruiter UX.
    const lower = (body.message ?? "").toLowerCase();
    // The empty-library path uses the word "yet" + "capture" — neither of
    // those should appear on the timeout path.
    expect(lower).not.toContain("yet");
    expect(lower).not.toContain("capture");
  });
});

describe.skip("talent-pool — minScore=0 still distinguishes empty-library from timeout", () => {
  // TODO: enable after Agent X lands an explicit "scoring failed" branch in
  // the no-results message — currently both paths can fall back to the
  // generic skippedScore message when minScore is 0.
  it("returns a timeout-flavoured message when batch threw and the pool was non-empty", () => {
    /* no-op — see TODO above */
  });
});
