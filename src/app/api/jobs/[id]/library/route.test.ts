import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: { findMany: vi.fn(), upsert: vi.fn() },
    orgAccessGrant: { findMany: vi.fn().mockResolvedValue([]) },
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
    dbMocks.prisma.candidate.findMany
      // first call: existing URLs in this job
      .mockResolvedValueOnce([{ linkedinUrl: "https://www.linkedin.com/in/a/" }])
      // second call: library candidates (one already in this job, one new)
      .mockResolvedValueOnce([
        { id: "lib-1", name: "A", headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/a/", matchScore: 60, createdAt: new Date(), job: { title: "Old role" }, archivedJobTitle: null },
        { id: "lib-2", name: "B", headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/b/", matchScore: 40, createdAt: new Date(), job: { title: "Older role" }, archivedJobTitle: null },
      ]);

    const res = await GET(new Request("http://localhost/api/jobs/job-1/library"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // A is filtered out (already in this job); B remains
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].id).toBe("lib-2");
  });

  it("GET pushes q= into the SQL where clause", async () => {
    // The route now applies q at SQL (OR contains across name/headline/location)
    // instead of post-filtering in JS, so older candidates aren't hidden by
    // a recent bulk import filling the 500-row cap. We assert the where
    // clause was built correctly and that returned rows pass through.
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "lib-1", name: "Alice React",  headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/a/", matchScore: 60, createdAt: new Date(), job: null, archivedJobTitle: null },
      ]);
    const res = await GET(new Request("http://localhost/api/jobs/job-1/library?q=react"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json();
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["lib-1"]);

    const libraryCall = dbMocks.prisma.candidate.findMany.mock.calls[1][0] as { where: Record<string, unknown> };
    const orClause = libraryCall.where.OR as Array<Record<string, unknown>>;
    expect(orClause).toEqual(expect.arrayContaining([
      expect.objectContaining({ name:     { contains: "react", mode: "insensitive" } }),
      expect.objectContaining({ headline: { contains: "react", mode: "insensitive" } }),
      expect.objectContaining({ location: { contains: "react", mode: "insensitive" } }),
    ]));
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

    const res = await GET(new Request("http://localhost/api/jobs/job-1/library"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(res.status).toBe(200);
    // The library findMany must be invoked with a where clause that lists
    // BOTH org-1 (viewer's own) and org-2 (granted) — proving the cross-org
    // wiring made it through to Prisma rather than being dropped at the route.
    const libCall = dbMocks.prisma.candidate.findMany.mock.calls[1][0];
    const whereClause = JSON.stringify(libCall.where);
    expect(whereClause).toContain("org-1");
    expect(whereClause).toContain("org-2");
  });

  it("POST rejects empty candidateIds", async () => {
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: [] }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(422);
  });

  it("POST short-circuits with 429 when the score rate limit is exhausted", async () => {
    // Mirrors the score-all guard — without this, a single click on Browse
    // Library could fire 50 paid Claude calls past the per-org cap.
    usageMocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-1"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(429);
    // Pool/source fetch must NOT have run — the guard fires before we hit Prisma.
    expect(dbMocks.prisma.candidate.findMany).not.toHaveBeenCalled();
  });

  it("POST short-circuits with 429 when the daily AI spend cap is tripped", async () => {
    usageMocks.checkSpendCap.mockResolvedValueOnce({ allowed: false, spentUsd: 5.12, capUsd: 5.0 });

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-1"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("AI spend cap");
  });

  it("GET honours the ?limit= query param via the Prisma take field", async () => {
    // Old behaviour: Prisma always pulled 500 rows regardless of limit.
    // New behaviour: take = max(limit * 4, limit), capped at 500.
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([]) // existing URLs in this job
      .mockResolvedValueOnce([]); // library candidates

    await GET(new Request("http://localhost/api/jobs/job-1/library?limit=25"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const libraryCall = dbMocks.prisma.candidate.findMany.mock.calls[1][0] as { take: number };
    expect(libraryCall.take).toBe(100); // 25 * 4
  });

  it("POST still imports when scoring fails (retry both attempts), surfaces unscoredIds", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "src-good", name: "Good", linkedinUrl: "https://www.linkedin.com/in/good/", profileText: "x".repeat(2500), location: "Wellington" },
      { id: "src-bad",  name: "Bad",  linkedinUrl: "https://www.linkedin.com/in/bad/",  profileText: "x".repeat(2500), location: "Wellington" },
    ]);
    aiMocks.scoreCandidateStructured
      .mockResolvedValueOnce(makeBreakdown())
      // Both the first attempt AND the retry fail for src-bad.
      .mockRejectedValueOnce(new Error("AI failed"))
      .mockRejectedValueOnce(new Error("AI failed"));
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "new", ...create }));

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-good", "src-bad"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Both candidates are added — scoring failure no longer blocks import.
    expect(body.added).toBe(2);
    expect(body.failed).toEqual([]);
    // The one that couldn't be scored is flagged separately so the UI can warn.
    expect(body.unscoredIds).toEqual(["src-bad"]);
  });
});
