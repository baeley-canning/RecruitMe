/**
 * Integration tests for PR 3 — library route bug fixes + dryRun preview.
 *
 * Pins three invariants:
 *  (1) POST /api/jobs/[id]/library writes a SearchSession row on every
 *      pull, regardless of outcome. Pre-PR-3 this was a silent regression:
 *      library imports never reached the "Analysis History" panel, so a
 *      user who only ever used the modal saw the panel frozen on their
 *      last LinkedIn search date.
 *
 *  (2) ?dryRun=1 short-circuits before any AI calls and any DB writes.
 *      Returns enough information for the UI to warn the recruiter about
 *      skipped IDs + projected cost vs daily-remaining budget. Critical
 *      because the dryRun preview is the user-facing replacement for the
 *      mid-pull cost-cap abort that Critic B §4 rejected.
 *
 *  (3) signalMatchesText (now used at the talent-pool specialist gate,
 *      route.ts:346) is word-boundary-aware. "sql" in profileText "mssql
 *      DBA" does NOT count as a SQL anchor hit for a "SQL Developer"
 *      specialist role — fixes the substring-bleed bug Critic B §1.a
 *      called out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
    org:            { findMany: vi.fn().mockResolvedValue([]) },
    searchSession:  { create: vi.fn().mockResolvedValue({ id: "ss-1" }) },
    usageEvent: {
      count:     vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create:    vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
    setting: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create:     vi.fn().mockResolvedValue({}),
      update:     vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert:     vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
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
  getJobScoringWeights: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkSpendCap:  vi.fn().mockResolvedValue({ allowed: true, spentUsd: 0, capUsd: 5 }),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));
vi.mock("@/lib/usage", () => usageMocks);

import { POST as LibraryPOST } from "@/app/api/jobs/[id]/library/route";
import { invalidateAccessCache } from "@/lib/org-access";
import { signalMatchesText } from "@/lib/requirement-signals";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit:        { score: 80,  weight: CATEGORY_WEIGHTS_V2.skill_fit,        evidence: "x" },
      location_fit:     { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit,     evidence: "x" },
      seniority_fit:    { score: 75,  weight: CATEGORY_WEIGHTS_V2.seniority_fit,    evidence: "x" },
      title_fit:        { score: 70,  weight: CATEGORY_WEIGHTS_V2.title_fit,        evidence: "x" },
      domain_fit:       { score: 60,  weight: CATEGORY_WEIGHTS_V2.domain_fit,       evidence: "x" },
      nice_to_have_fit: { score: 40,  weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "x" },
    },
    must_have_coverage:  [{ requirement: "TypeScript", status: "confirmed", evidence: "Listed" }],
    nice_to_have_coverage: [],
    reasons_for:    ["Good"],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "x",
    profileCharCount: 1000,
  });
}

const LONG_PROFILE = "Senior TypeScript Engineer at Acme. " + "Lorem ipsum ".repeat(60);

function baseJobFixture() {
  return {
    id: "job-1",
    orgId: "org-1",
    scoringWeights: null,
    salaryMin: null,
    salaryMax: null,
    location: "Wellington",
    location2: null,
    isRemote: false,
    parsedRole: JSON.stringify({
      title: "Software Engineer",
      location: "Wellington",
      location_rules: "Wellington",
      must_haves: ["TypeScript"],
      nice_to_haves: [],
      knockout_criteria: [],
      skills_required: ["TypeScript"],
      skills_preferred: [],
    }),
  };
}

function resetCommonMocks() {
  vi.clearAllMocks();
  invalidateAccessCache("org-1");
  usageMocks.checkRateLimit.mockResolvedValue({ allowed: true });
  usageMocks.checkSpendCap.mockResolvedValue({ allowed: true, spentUsd: 0, capUsd: 5 });
  dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValue([]);
  dbMocks.prisma.org.findMany.mockResolvedValue([]);
  dbMocks.prisma.searchSession.create.mockResolvedValue({ id: "ss-1" });
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1", isOwner: false });
  sessionMocks.requireJobAccess.mockResolvedValue({ job: baseJobFixture(), error: null });
  scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
  aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
}

describe("PR 3 — library POST writes SearchSession (regression fix)", () => {
  beforeEach(() => {
    resetCommonMocks();
  });

  it("writes one SearchSession row on a successful import", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "src-1",
        name: "Jane Doe",
        headline: "Senior TS Engineer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/jane",
        profileText: LONG_PROFILE,
        profileCapturedAt: new Date(),
      },
    ]);
    dbMocks.prisma.candidate.upsert.mockResolvedValue({ id: "imp-1" });

    const req = new Request("http://test/api/jobs/job-1/library", {
      method: "POST",
      body: JSON.stringify({ candidateIds: ["src-1"] }),
    });
    const res = await LibraryPOST(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);

    // SearchSession.create called exactly once with library_modal_import.
    expect(dbMocks.prisma.searchSession.create).toHaveBeenCalledTimes(1);
    const sessionCall = dbMocks.prisma.searchSession.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(sessionCall.data.evaluation).toBe("library_modal_import");
    expect(sessionCall.data.status).toBe("complete");
    expect(sessionCall.data.orgId).toBe("org-1");
    expect(sessionCall.data.jobId).toBe("job-1");
    expect(sessionCall.data.collected).toBe(1);
  });

  it("writes a SearchSession row even when every candidate fails the empty-profile gate", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "src-empty",
        name: "Bede Skinner-Vennell",
        headline: "Canoe Polo Coach",
        location: "Wellington, New Zealand",
        linkedinUrl: null,
        profileText: "", // empty — fails the 500-char gate
        profileCapturedAt: null,
      },
    ]);

    const req = new Request("http://test/api/jobs/job-1/library", {
      method: "POST",
      body: JSON.stringify({ candidateIds: ["src-empty"] }),
    });
    const res = await LibraryPOST(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);

    // Even with 0 imports, the session row MUST be written so the history
    // panel sees this pull happened. The pre-PR-3 regression was zero
    // history activity for library-only users.
    expect(dbMocks.prisma.searchSession.create).toHaveBeenCalledTimes(1);
    const sessionCall = dbMocks.prisma.searchSession.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(sessionCall.data.collected).toBe(0);
    expect(sessionCall.data.candidatesRejected).toBe(1);
  });
});

describe("PR 3 — dryRun=1 preview", () => {
  beforeEach(() => {
    resetCommonMocks();
  });

  it("returns the estimate without calling AI or writing anything", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "src-1",
        name: "Jane Doe",
        headline: "x",
        location: "Wellington",
        linkedinUrl: null,
        profileText: LONG_PROFILE,
        profileCapturedAt: new Date(),
      },
      {
        id: "src-2",
        name: "John Doe",
        headline: "x",
        location: "Wellington",
        linkedinUrl: null,
        profileText: LONG_PROFILE,
        profileCapturedAt: new Date(),
      },
    ]);

    const req = new Request("http://test/api/jobs/job-1/library?dryRun=1", {
      method: "POST",
      body: JSON.stringify({ candidateIds: ["src-1", "src-2"] }),
    });
    const res = await LibraryPOST(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dryRun).toBe(true);
    expect(body.requestedIds).toBe(2);
    expect(body.eligibleFinalists).toBe(2);
    expect(body.skippedEmpty).toBe(0);
    expect(typeof body.estimatedCostUsd).toBe("number");
    expect(body.dailyBudgetCapUsd).toBe(5);
    expect(typeof body.dailyBudgetRemainingUsd).toBe("number");

    // No AI work, no writes — the cost-preview contract.
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.upsert).not.toHaveBeenCalled();
    expect(dbMocks.prisma.searchSession.create).not.toHaveBeenCalled();
  });

  it("flags wouldExceedCap=true when projected cost > remaining budget", async () => {
    usageMocks.checkSpendCap.mockResolvedValue({ allowed: true, spentUsd: 4.9, capUsd: 5 });
    // Mock 50 candidates so the projected cost (~$1.00) overshoots the
    // $0.10 daily budget remaining.
    dbMocks.prisma.candidate.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        id: `src-${i}`,
        name: `Person ${i}`,
        headline: "x",
        location: "Wellington",
        linkedinUrl: null,
        profileText: LONG_PROFILE,
        profileCapturedAt: new Date(),
      })),
    );

    const req = new Request("http://test/api/jobs/job-1/library?dryRun=1", {
      method: "POST",
      body: JSON.stringify({ candidateIds: Array.from({ length: 50 }, (_, i) => `src-${i}`) }),
    });
    const res = await LibraryPOST(req, { params: Promise.resolve({ id: "job-1" }) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.wouldExceedCap).toBe(true);
    expect(body.dailyBudgetRemainingUsd).toBeCloseTo(0.1, 1);
  });

  it("dryRun=1 still surfaces the rate-limit state instead of 429ing the recruiter out", async () => {
    usageMocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 60000 });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "src-1",
        name: "Jane Doe",
        headline: "x",
        location: "Wellington",
        linkedinUrl: null,
        profileText: LONG_PROFILE,
        profileCapturedAt: new Date(),
      },
    ]);
    const req = new Request("http://test/api/jobs/job-1/library?dryRun=1", {
      method: "POST",
      body: JSON.stringify({ candidateIds: ["src-1"] }),
    });
    const res = await LibraryPOST(req, { params: Promise.resolve({ id: "job-1" }) });
    // 200 with rateLimitAllowed=false — UI can render "rate limited; try
    // later" without us having to short-circuit on rate at preview-time.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dryRun).toBe(true);
    expect(body.rateLimitAllowed).toBe(false);
    expect(typeof body.rateRetryAfterMs).toBe("number");
  });
});

describe("PR 3 — signalMatchesText word-boundary protection (pins the bug fix at talent-pool route.ts:346)", () => {
  it("does NOT match 'sql' inside 'mssql' (was the Critic B §1.a substring-bleed bug)", () => {
    const profile = "Senior MSSQL DBA. 10 years of mssql production experience.";
    expect(signalMatchesText(profile, "sql")).toBe(false);
  });

  it("does NOT match 'php' inside 'phpipam-admin'", () => {
    const profile = "Operated a phpipam-admin instance for IP allocation.";
    expect(signalMatchesText(profile, "php")).toBe(false);
  });

  it("DOES match 'sql' when it appears as a standalone token", () => {
    const profile = "10 years experience with SQL, PostgreSQL, and analytics.";
    expect(signalMatchesText(profile, "sql")).toBe(true);
  });

  it("does NOT match 'css' inside 'access'", () => {
    const profile = "Microsoft Access database administration.";
    expect(signalMatchesText(profile, "css")).toBe(false);
  });

  it("DOES match 'css' as a standalone word", () => {
    const profile = "Frontend stack: HTML, CSS, JavaScript.";
    expect(signalMatchesText(profile, "css")).toBe(true);
  });

  it("handles 'c++' with explicit boundary regex", () => {
    expect(signalMatchesText("Embedded C++ developer for ARM Cortex", "c++")).toBe(true);
    // Without the c++ special case, the regex would not match the '+' chars.
  });

  it("long tokens (>4 chars) still use simple includes (no perf cost)", () => {
    expect(signalMatchesText("Senior TypeScript engineer", "typescript")).toBe(true);
    expect(signalMatchesText("React TypeScript Next.js", "react")).toBe(true);
  });
});
