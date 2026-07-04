import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: { findMany: vi.fn(), upsert: vi.fn() },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
    // PR 3: library POST now writes a SearchSession on every pull
    // (regression fix — analysis history was missing library activity).
    // Default-mock so existing tests don't need to set this per case.
    searchSession: { create: vi.fn().mockResolvedValue({ id: "ss-1" }) },
    // $queryRaw is now the gate for the GET handler — it pre-filters
    // candidate IDs by `char_length(profileText) >= 500` (the "Bede problem"
    // fix). Tests stub the array of `{ id }` rows the SQL would return.
    $queryRaw: vi.fn(),
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
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
  checkSpendCap: vi.fn().mockResolvedValue({ allowed: true, spentUsd: 0, capUsd: 5 }),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));
vi.mock("@/lib/usage", () => usageMocks);

import { GET, POST } from "./route";
import { invalidateAccessCache } from "@/lib/org-access";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "x" },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "x" },
      seniority_fit: { score: 75, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "x" },
      title_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "x" },
      domain_fit: { score: 60, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "x" },
      nice_to_have_fit: { score: 40, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "x" },
    },
    must_have_coverage: [{ requirement: "React", status: "confirmed", evidence: "Listed" }],
    nice_to_have_coverage: [],
    reasons_for: ["Good"],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Library import.",
    profileCharCount: 2400,
  });
}

describe("library browse / add route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks() wipes the implementations on every mock — re-apply
    // the "allowed" defaults so the POST guard added in the maxDuration fix
    // doesn't 429 every test that doesn't explicitly opt into a denial.
    usageMocks.checkRateLimit.mockResolvedValue({ allowed: true });
    usageMocks.checkSpendCap.mockResolvedValue({ allowed: true, spentUsd: 0, capUsd: 5 });
    // The org-access cache is module-level and persists across tests; clear
    // it so each test sees the orgAccessGrant.findMany mock it sets up.
    invalidateAccessCache("org-1");
    sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-1", isOwner: false });
    sessionMocks.requireJobAccess.mockResolvedValue({
      job: {
        id: "job-1",
        orgId: "org-1",
        scoringWeights: null,
        salaryMin: null,
        salaryMax: null,
        location: "Wellington",
        isRemote: false,
        parsedRole: JSON.stringify({
          title: "Software Engineer",
          location: "Wellington",
          location_rules: "Wellington",
          must_haves: ["React"],
          nice_to_haves: [],
          skills_required: ["React"],
          skills_preferred: [],
        }),
      },
      error: null,
    });
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
  });

  it("GET excludes candidates already in this job", async () => {
    // GET pipeline: first findMany returns existing URLs in this job; then
    // $queryRaw returns the IDs that pass the length gate; then findMany
    // returns the column shape for those IDs.
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([{ linkedinUrl: "https://www.linkedin.com/in/a/" }])
      .mockResolvedValueOnce([
        { id: "lib-1", name: "A", headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/a/", matchScore: 60, createdAt: new Date(), job: { title: "Old role" }, archivedJobTitle: null },
        { id: "lib-2", name: "B", headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/b/", matchScore: 40, createdAt: new Date(), job: { title: "Older role" }, archivedJobTitle: null },
      ]);
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "lib-1" }, { id: "lib-2" }]);

    const res = await GET(new Request("http://localhost/api/jobs/job-1/library"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // A is filtered out (already in this job); B remains
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].id).toBe("lib-2");
  });

  it("GET passes q= into the SQL length-gated query", async () => {
    // The route now applies q at SQL inside a $queryRaw call that also
    // enforces char_length(profileText) >= 500. We assert the SQL params
    // include the like-pattern and a row that passes the gate flows through.
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "lib-1", name: "Alice React",  headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/a/", matchScore: 60, createdAt: new Date(), job: null, archivedJobTitle: null },
      ]);
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "lib-1" }]);
    const res = await GET(new Request("http://localhost/api/jobs/job-1/library?q=react"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json();
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["lib-1"]);

    // Prisma's tagged-template $queryRaw is called with (stringsArray, ...params).
    // We assert the like pattern "%react%" is one of the bound params.
    const rawCall = dbMocks.prisma.$queryRaw.mock.calls[0];
    const params = rawCall.slice(1);
    expect(params).toContain("%react%");
  });

  it("POST scores + upserts each selected candidate as talent_pool", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "src-1", name: "Source A", headline: "Eng", location: "Wellington", linkedinUrl: "https://www.linkedin.com/in/src-a/", profileText: "x".repeat(2500), profileCapturedAt: null },
    ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "new-1", ...create,
    }));

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-1"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.failed).toEqual([]);
    const upsertCall = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    expect(upsertCall.create.source).toBe("talent_pool");
    expect(upsertCall.create.jobId).toBe("job-1");
  });

  it("GET surfaces candidates from a granted partner org (cross-org library_read)", async () => {
    // Viewer org-1 has been granted library_read on org-2.
    dbMocks.prisma.orgAccessGrant.findMany.mockResolvedValueOnce([
      { providerOrgId: "org-2", scope: "library_read" },
    ]);
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([]) // existing URLs in this job
      .mockResolvedValueOnce([
        // partner candidate from org-2 — should be returned
        { id: "lib-partner", name: "From Org 2", headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/p2/", matchScore: 60, createdAt: new Date(), job: { title: "Other role" }, archivedJobTitle: null },
      ]);
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "lib-partner" }]);

    const res = await GET(new Request("http://localhost/api/jobs/job-1/library"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    // The $queryRaw call must include BOTH org-1 (viewer's own) and org-2
    // (granted) in its bound params, proving cross-org wiring made it through
    // to SQL rather than being dropped at the route.
    const rawCall = dbMocks.prisma.$queryRaw.mock.calls[0];
    const params = rawCall.slice(1);
    const orgArrayParam = params.find((p: unknown) => Array.isArray(p)) as string[] | undefined;
    expect(orgArrayParam).toEqual(expect.arrayContaining(["org-1", "org-2"]));
  });

  it("POST rejects empty candidateIds", async () => {
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: [] }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(422);
  });

  it("POST is NOT blocked by the score rate limit (import scoring is heuristic — no AI)", async () => {
    // Import scoring is the deterministic heuristic now. An exhausted AI
    // rate limit (or a credit-out) must never stop a recruiter adding
    // candidates to a job; the cap state is surfaced for UI warnings only.
    usageMocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "src-1", name: "Source A", headline: "Eng", location: "Wellington", linkedinUrl: "https://www.linkedin.com/in/src-a/", profileText: "x".repeat(2500), profileCapturedAt: null },
    ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "new-1", ...create }));

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-1"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(1);
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });

  it("POST is NOT blocked by the daily AI spend cap (import scoring is heuristic — no AI)", async () => {
    usageMocks.checkSpendCap.mockResolvedValue({ allowed: false, spentUsd: 5.12, capUsd: 5.0 });
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "src-1", name: "Source A", headline: "Eng", location: "Wellington", linkedinUrl: "https://www.linkedin.com/in/src-a/", profileText: "x".repeat(2500), profileCapturedAt: null },
    ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "new-1", ...create }));

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-1"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(1);
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });

  it("GET honours the ?limit= query param via the SQL LIMIT param", async () => {
    // Old behaviour: Prisma always pulled 500 rows regardless of limit.
    // New behaviour: SQL LIMIT = max(limit * 4, limit), capped at 500.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]); // existing URLs in this job
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([]); // no eligible IDs

    await GET(new Request("http://localhost/api/jobs/job-1/library?limit=25"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const rawCall = dbMocks.prisma.$queryRaw.mock.calls[0];
    const params = rawCall.slice(1);
    expect(params).toContain(100); // 25 * 4
  });

  it("GET hides candidates with empty profileText (the Bede problem)", async () => {
    // The $queryRaw length-gate must return ONLY rows with
    // char_length(profileText) >= 500. Simulate Postgres doing its job:
    // raw query returns the long-profile row but not the empty one. The
    // route should pass only the long row through.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]); // existing URLs in this job
    // SQL pre-filter drops the empty-profileText row before its ID reaches Node.
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "lib-long" }]);
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "lib-long", name: "Long", headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/long/", matchScore: 70, createdAt: new Date(), job: null, archivedJobTitle: null },
    ]);

    const res = await GET(new Request("http://localhost/api/jobs/job-1/library"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["lib-long"]);

    // Sanity: the raw SQL was invoked with the 500-char threshold.
    const rawCall = dbMocks.prisma.$queryRaw.mock.calls[0];
    const params = rawCall.slice(1);
    expect(params).toContain(500);
  });

  it("GET hides candidates with null profileText", async () => {
    // When the SQL gate returns no eligible IDs (profileText IS NULL fails
    // the WHERE), the route short-circuits to an empty response without
    // calling the second findMany at all.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]); // existing URLs in this job
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([]); // length+null gate drops everything

    const res = await GET(new Request("http://localhost/api/jobs/job-1/library"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toEqual([]);
    expect(body.total).toBe(0);
    // The column-fetch findMany must NOT have been called — short-circuit on empty.
    expect(dbMocks.prisma.candidate.findMany).toHaveBeenCalledTimes(1);
  });

  it("GET surfaces candidates with profileText of length 600", async () => {
    // A row well above the 500-char floor must flow through normally.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]); // existing URLs in this job
    dbMocks.prisma.$queryRaw.mockResolvedValueOnce([{ id: "lib-600" }]);
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "lib-600", name: "Six Hundred", headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/six/", matchScore: 55, createdAt: new Date(), job: null, archivedJobTitle: null },
    ]);

    const res = await GET(new Request("http://localhost/api/jobs/job-1/library"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].id).toBe("lib-600");
  });

  it("POST scores imports with the deterministic heuristic — no AI call, no cache hash, receipts present", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "src-good", name: "Good", headline: "React developer", linkedinUrl: "https://www.linkedin.com/in/good/", profileText: `${"filler ".repeat(300)}Extensive React experience building SPAs in Wellington.`, location: "Wellington" },
    ]);
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "new", ...create }));

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-good"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.failed).toEqual([]);
    expect(body.unscoredIds ?? []).toEqual([]);
    // No AI ran.
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
    const { create, update } = dbMocks.prisma.candidate.upsert.mock.calls[0][0];
    // Heuristic score landed, tagged scoredBy=heuristic, with the React
    // must-have found in the full profile text (the receipts).
    expect(create.matchScore).toBeGreaterThan(0);
    const breakdown = JSON.parse(create.scoreBreakdown as string);
    expect(breakdown.scoredBy).toBe("heuristic");
    expect(breakdown.must_have_coverage[0].status).toBe("likely");
    // CRITICAL invariant: heuristic writes never stamp profileTextHash, so a
    // later AI "Re-score all" is never cache-skipped.
    expect(create.profileTextHash).toBeUndefined();
    // Re-import of an existing row must keep its existing (possibly AI) score.
    expect(update).toEqual({});
  });
});
