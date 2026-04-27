import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";
import { buildScoreCacheKey } from "@/lib/utils";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    job: {
      update: vi.fn().mockResolvedValue({}),
    },
    usageEvent: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  predictAcceptance: vi.fn().mockResolvedValue({
    score: 70,
    likelihood: "medium",
    headline: "Open to discussion",
    signals: [],
    summary: "Likely to consider a suitable role.",
  }),
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

function makeJob(id: string, location = "Wellington") {
  return {
    id,
    parsedRole: JSON.stringify({
      title: "Software Engineer",
      location,
      location_rules: `${location} office`,
      must_haves: ["React"],
      nice_to_haves: [],
      knockout_criteria: [],
      skills_required: ["React"],
      skills_preferred: [],
    }),
    salaryMin: 90000,
    salaryMax: 120000,
    location,
    isRemote: false,
    lastScoredAt: null,
  };
}

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "React confirmed." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Location fits." },
      seniority_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Seniority fits." },
      title_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Title fits." },
      industry_fit: { score: 55, weight: CATEGORY_WEIGHTS_V2.industry_fit, evidence: "Some overlap." },
      nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Neutral." },
      keyword_alignment: { score: 70, weight: CATEGORY_WEIGHTS_V2.keyword_alignment, evidence: "Aligned." },
    },
    must_have_coverage: [{ requirement: "React", status: "confirmed", evidence: "Listed." }],
    nice_to_have_coverage: [],
    reasons_for: ["Good fit."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Good candidate.",
    profileCharCount: 1200,
  });
}

describe("score-all route cache freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    dbMocks.prisma.candidate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
  });

  it("skips candidates only when the full score context is unchanged", async () => {
    const job = makeJob("job-cache-skip");
    const parsedRole = JSON.parse(job.parsedRole);
    const profileText = "React engineer based in Wellington.";
    const scoreCacheKey = buildScoreCacheKey({
      profileText,
      parsedRole,
      salary: { min: 90000, max: 120000 },
      jobLocation: job.location,
      isRemote: false,
    });

    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-1", profileText, profileTextHash: scoreCacheKey, matchScore: 82, location: "Wellington" },
    ]);

    const res = await POST(new Request("http://localhost/api/jobs/job-cache-skip/candidates/score-all", { method: "POST" }), {
      params: Promise.resolve({ id: "job-cache-skip" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ scored: 0, skipped: 1, total: 1 });
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.update).not.toHaveBeenCalled();
  });

  it("re-scores when job context changes even if profile text is unchanged", async () => {
    const job = makeJob("job-cache-refresh", "Wellington");
    const currentRole = JSON.parse(job.parsedRole);
    const profileText = "React engineer based in Wellington.";
    const staleCacheKey = buildScoreCacheKey({
      profileText,
      parsedRole: currentRole,
      salary: { min: 90000, max: 120000 },
      jobLocation: "Auckland",
      isRemote: false,
    });

    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-2", profileText, profileTextHash: staleCacheKey, matchScore: 82, location: "Wellington" },
    ]);

    const res = await POST(new Request("http://localhost/api/jobs/job-cache-refresh/candidates/score-all", { method: "POST" }), {
      params: Promise.resolve({ id: "job-cache-refresh" }),
    });

    expect(res.status).toBe(200);
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cand-2" },
      data: expect.objectContaining({
        profileTextHash: expect.not.stringMatching(staleCacheKey),
      }),
    }));
  });
});
