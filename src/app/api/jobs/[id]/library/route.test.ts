import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: { findMany: vi.fn(), upsert: vi.fn() },
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

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scoring-config", () => ({
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

import { GET, POST } from "./route";

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

  it("GET applies q= text filter", async () => {
    dbMocks.prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "lib-1", name: "Alice React",  headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/a/", matchScore: 60, createdAt: new Date(), job: null, archivedJobTitle: null },
        { id: "lib-2", name: "Bob Sales",    headline: null, location: null, linkedinUrl: "https://www.linkedin.com/in/b/", matchScore: 40, createdAt: new Date(), job: null, archivedJobTitle: null },
      ]);
    const res = await GET(new Request("http://localhost/api/jobs/job-1/library?q=react"), {
      params: Promise.resolve({ id: "job-1" }),
    });
    const body = await res.json();
    expect(body.candidates.map((c: { id: string }) => c.id)).toEqual(["lib-1"]);
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

  it("POST rejects empty candidateIds", async () => {
    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: [] }),
    }), { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(422);
  });

  it("POST records failures from the scorer without aborting the batch", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "src-good", name: "Good", linkedinUrl: "https://www.linkedin.com/in/good/", profileText: "x".repeat(2500), location: "Wellington" },
      { id: "src-bad",  name: "Bad",  linkedinUrl: "https://www.linkedin.com/in/bad/",  profileText: "x".repeat(2500), location: "Wellington" },
    ]);
    aiMocks.scoreCandidateStructured
      .mockResolvedValueOnce(makeBreakdown())
      .mockRejectedValueOnce(new Error("AI failed"));
    dbMocks.prisma.candidate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: "new", ...create }));

    const res = await POST(new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateIds: ["src-good", "src-bad"] }),
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.failed).toEqual(["src-bad"]);
  });
});
