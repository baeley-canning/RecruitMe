import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the two-stage capture pipeline. Stage 1 must never call AI;
// stage 2 must respect the profileTextHash concurrency gate.

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {
      code = "";
      constructor(msg: string, code: string) { super(msg); this.code = code; }
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  predictAcceptance: vi.fn(),
  extractCandidateInfo: vi.fn(),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  getJobScoringWeights: vi.fn().mockResolvedValue({
    must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10,
    title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06,
  }),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@prisma/client", () => ({ Prisma: dbMocks.Prisma }));
vi.mock("@/lib/ai", async (importActual) => {
  const actual = await importActual() as object;
  return { ...actual, ...aiMocks };
});
vi.mock("@/lib/scoring-config", async (importActual) => {
  const actual = await importActual() as object;
  return { ...actual, ...scoringConfigMocks };
});

import {
  saveCapturedProfileFast,
  applyAiEnrichmentInBackground,
} from "../linkedin-capture";
import { buildScoreCacheKey } from "../utils";

const testWeights = {
  must_have: 0.36,
  skill_fit: 0.22,
  location_fit: 0.08,
  seniority_fit: 0.10,
  title_fit: 0.08,
  domain_fit: 0.10,
  nice_to_have_fit: 0.06,
};

const PROFILE_TEXT = "Pat Lee\nSenior Software Engineer at Acme Corp\nAbout\nTen years of full-stack development. Strong distributed systems background. Wellington, New Zealand. Built and shipped a microservice platform handling 50k tps with React, TypeScript, Postgres.";

const baseJob = {
  id: "job-1",
  orgId: "org-1",
  parsedRole: JSON.stringify({
    title: "Senior Engineer",
    location: "Wellington",
    must_haves: ["distributed systems"],
    nice_to_haves: [],
    skills_required: [],
    skills_preferred: [],
  }),
  scoringWeights: null,
  salaryMin: null,
  salaryMax: null,
  isRemote: false,
  location: "Wellington",
};

describe("saveCapturedProfileFast (stage 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.prisma.job.findUnique.mockResolvedValue(baseJob);
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({
      id: "cand-1",
      jobId: "job-1",
      name: "Unknown",
      headline: null,
      location: null,
      profileText: null,
      profileTextHash: null,
    });
    dbMocks.prisma.candidate.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: "cand-1", ...data }),
    );
  });

  afterEach(() => {
    // Stage 1 must NEVER call any AI function — that's the whole point
    // of the split. If any of these were called, the test fails.
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
    expect(aiMocks.predictAcceptance).not.toHaveBeenCalled();
    expect(aiMocks.extractCandidateInfo).not.toHaveBeenCalled();
  });

  it("persists profileText synchronously without invoking AI", async () => {
    const { candidate, identity } = await saveCapturedProfileFast({
      jobId: "job-1",
      candidateId: "cand-1",
      profileText: PROFILE_TEXT,
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
    });

    expect(candidate.id).toBe("cand-1");
    expect(identity.profileTextHash).toBeTruthy();   // computed eagerly
    expect(identity.profileUnchanged).toBe(false);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledTimes(1);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-1" },
        data: expect.objectContaining({
          profileText: expect.stringContaining("Pat Lee"),
          source: "extension",
          // Stage 1 should clear stale score fields when the profile changed.
          matchScore: null,
          scoreBreakdown: null,
          // profileTextHash is set in stage 1 (concurrency token for stage 2).
          profileTextHash: expect.any(String),
        }),
      }),
    );
  });

  it("rejects profile text under the minimum length", async () => {
    await expect(
      saveCapturedProfileFast({
        jobId: "job-1",
        candidateId: "cand-1",
        profileText: "too short",
        linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      }),
    ).rejects.toThrow(/enough usable profile text/);
  });

  it("rejects the capture when the linkedinUrl collides with another candidate (P2002)", async () => {
    // Previously this path silently stripped the linkedinUrl and wrote
    // someone else's profile text into the wrong candidate row. Now it
    // refuses the write so the recruiter can route to the canonical record.
    const collision = new dbMocks.Prisma.PrismaClientKnownRequestError("dup url", "P2002");
    dbMocks.prisma.candidate.update.mockRejectedValueOnce(collision);

    await expect(
      saveCapturedProfileFast({
        jobId: "job-1",
        candidateId: "cand-1",
        profileText: PROFILE_TEXT,
        linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      }),
    ).rejects.toThrow(/DUPLICATE_LINKEDIN_URL/);
    // We must NOT retry without the URL — that's the bug the new behaviour fixes.
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledTimes(1);
  });

  it("does not preserve a stale score when a similar recapture changes the score hash", async () => {
    const oldText = `${PROFILE_TEXT}\n${"General LinkedIn boilerplate. ".repeat(80)}`;
    const newText = `${oldText}\nExperience\nTechnical Consultant / C++ Developer at ACC\nMicrosoft Visual C++ developer using Sybase DB.\nC++ Developer & Support at New Zealand Customs Service on Solaris.`;
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1",
      jobId: "job-1",
      name: "Pat Lee",
      headline: "Senior Software Engineer",
      location: "Wellington",
      profileText: oldText,
      profileTextHash: "hash-for-prior-shorter-profile",
    });

    const { identity } = await saveCapturedProfileFast({
      jobId: "job-1",
      candidateId: "cand-1",
      profileText: newText,
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
    });

    expect(identity.profileUnchanged).toBe(false);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profileText: expect.stringContaining("Technical Consultant / C++ Developer at ACC"),
          matchScore: null,
          scoreBreakdown: null,
        }),
      }),
    );
  });

  it("preserves the existing score only when the stored profileTextHash exactly matches the new score hash", async () => {
    const parsedRole = JSON.parse(baseJob.parsedRole);
    const validHash = buildScoreCacheKey({
      profileText: PROFILE_TEXT,
      parsedRole,
      salary: null,
      jobLocation: baseJob.location,
      isRemote: baseJob.isRemote,
      weights: testWeights,
    });
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-1",
      jobId: "job-1",
      name: "Pat Lee",
      headline: "Senior Software Engineer",
      location: "Wellington",
      profileText: PROFILE_TEXT,
      profileTextHash: validHash,
    });

    const { identity } = await saveCapturedProfileFast({
      jobId: "job-1",
      candidateId: "cand-1",
      profileText: PROFILE_TEXT,
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
    });

    expect(identity.profileUnchanged).toBe(true);
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          matchScore: null,
          scoreBreakdown: null,
        }),
      }),
    );
  });
});

describe("applyAiEnrichmentInBackground (stage 2 — concurrency gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.scoreCandidateStructured.mockResolvedValue({
      overall: 78,
      categories: {
        skill_fit:        { score: 80, weight: 0.22, evidence: "Distributed systems experience confirmed" },
        location_fit:     { score: 95, weight: 0.08, evidence: "Wellington" },
        seniority_fit:    { score: 75, weight: 0.10, evidence: "Senior" },
        title_fit:        { score: 85, weight: 0.08, evidence: "Senior engineer match" },
        domain_fit:       { score: 70, weight: 0.10, evidence: "Strong" },
        nice_to_have_fit: { score: 60, weight: 0.06, evidence: "" },
      },
      must_have_coverage: [{ requirement: "distributed systems", status: "confirmed", evidence: "Built microservice platform handling 50k tps" }],
      nice_to_have_coverage: [],
      reasons_for: ["distributed systems"],
      reasons_against: [],
      recruiter_summary: "Strong fit",
      confidence: { level: "high", score: 80, reasons: [] },
      confidence_label: "high",
      data_quality: "full_profile",
      must_have_pct: 100,
    });
    aiMocks.predictAcceptance.mockResolvedValue({
      score: 70, likelihood: "medium", headline: "May consider", signals: [], summary: "Open",
    });
    aiMocks.extractCandidateInfo.mockResolvedValue({ name: "Pat Lee", headline: "Senior Software Engineer", location: "Wellington" });
  });

  it("applies the score update when profileTextHash matches (no race)", async () => {
    dbMocks.prisma.candidate.updateMany.mockResolvedValue({ count: 1 });
    const result = await applyAiEnrichmentInBackground("cand-1", {
      cleanedProfileText: PROFILE_TEXT,
      name: "Pat Lee", headline: null, location: null,
      currentStatus: "new",
      hasDirectName: true, hasDirectHeadline: false, hasDirectLocation: false,
      orgId: "org-1",
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      profileCapturedAt: new Date(),
      profileTextHash: "hash-1",
      profileUnchanged: false,
      job: baseJob as unknown as Awaited<ReturnType<typeof dbMocks.prisma.job.findUnique>>,
      parsedRole: JSON.parse(baseJob.parsedRole),
      salary: null,
      weights: { must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10, title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06 },
    });

    expect(result.applied).toBe(true);
    expect(dbMocks.prisma.candidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-1", profileTextHash: "hash-1" },
        data: expect.objectContaining({
          matchScore: expect.any(Number),
        }),
      }),
    );
  });

  it("auto-rejects early-stage candidates when the full fetched profile proves they are out of area", async () => {
    dbMocks.prisma.candidate.updateMany.mockResolvedValue({ count: 1 });
    aiMocks.extractCandidateInfo.mockResolvedValueOnce({
      name: "Pat Lee",
      headline: "Senior Software Engineer",
      location: "Auckland, New Zealand",
    });

    const result = await applyAiEnrichmentInBackground("cand-1", {
      cleanedProfileText: PROFILE_TEXT,
      name: "Pat Lee", headline: null, location: null,
      currentStatus: "new",
      hasDirectName: true, hasDirectHeadline: false, hasDirectLocation: false,
      orgId: "org-1",
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      profileCapturedAt: new Date(),
      profileTextHash: "hash-1",
      profileUnchanged: false,
      job: baseJob as unknown as Awaited<ReturnType<typeof dbMocks.prisma.job.findUnique>>,
      parsedRole: JSON.parse(baseJob.parsedRole),
      salary: null,
      weights: { must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10, title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06 },
    });

    expect(result.applied).toBe(true);
    // applyAiEnrichment now splits the write: non-status fields use the
    // profileTextHash gate; status="rejected" is applied in a SECOND call
    // with a stricter where clause so manual recruiter status moves don't
    // get clobbered. Verify both calls landed.
    const calls = dbMocks.prisma.candidate.updateMany.mock.calls;
    const dataCall = calls[0][0].data;
    expect(dataCall).toMatchObject({ location: "Auckland, New Zealand" });
    expect(dataCall.matchScore).toBeLessThan(78);
    expect(JSON.parse(dataCall.scoreBreakdown).categories.location_fit.score).toBe(20);
    // Second call sets the rejection.
    const statusCall = calls[1][0];
    expect(statusCall.data).toEqual({ status: "rejected" });
    expect(statusCall.where.status).toEqual({ in: ["new", "reviewing"] });
  });

  it("does not auto-reject candidates already moved beyond initial review", async () => {
    dbMocks.prisma.candidate.updateMany.mockResolvedValue({ count: 1 });
    aiMocks.extractCandidateInfo.mockResolvedValueOnce({
      name: "Pat Lee",
      headline: "Senior Software Engineer",
      location: "Auckland, New Zealand",
    });

    await applyAiEnrichmentInBackground("cand-1", {
      cleanedProfileText: PROFILE_TEXT,
      name: "Pat Lee", headline: null, location: null,
      currentStatus: "shortlisted",
      hasDirectName: true, hasDirectHeadline: false, hasDirectLocation: false,
      orgId: "org-1",
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      profileCapturedAt: new Date(),
      profileTextHash: "hash-1",
      profileUnchanged: false,
      job: baseJob as unknown as Awaited<ReturnType<typeof dbMocks.prisma.job.findUnique>>,
      parsedRole: JSON.parse(baseJob.parsedRole),
      salary: null,
      weights: { must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10, title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06 },
    });

    const update = dbMocks.prisma.candidate.updateMany.mock.calls[0][0].data;
    expect(update.status).toBeUndefined();
    expect(update.location).toBe("Auckland, New Zealand");
  });

  it("skips silently when profileTextHash has changed (race lost — recruiter re-scored manually)", async () => {
    // Simulates: between stage 1 and stage 2, recruiter manually re-scored
    // the candidate, which bumped profileTextHash to a different value.
    dbMocks.prisma.candidate.updateMany.mockResolvedValue({ count: 0 });
    const result = await applyAiEnrichmentInBackground("cand-1", {
      cleanedProfileText: PROFILE_TEXT,
      name: "Pat Lee", headline: null, location: null,
      currentStatus: "new",
      hasDirectName: true, hasDirectHeadline: false, hasDirectLocation: false,
      orgId: "org-1",
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      profileCapturedAt: new Date(),
      profileTextHash: "hash-1-stale",
      profileUnchanged: false,
      job: baseJob as unknown as Awaited<ReturnType<typeof dbMocks.prisma.job.findUnique>>,
      parsedRole: JSON.parse(baseJob.parsedRole),
      salary: null,
      weights: { must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10, title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06 },
    });

    expect(result.applied).toBe(false);
    // updateMany was called but matched 0 rows due to hash mismatch.
    expect(dbMocks.prisma.candidate.updateMany).toHaveBeenCalledTimes(1);
  });

  it("no-op when profileUnchanged (stale-skip optimization preserved)", async () => {
    const result = await applyAiEnrichmentInBackground("cand-1", {
      cleanedProfileText: PROFILE_TEXT,
      name: "Pat Lee", headline: null, location: null,
      currentStatus: "new",
      hasDirectName: true, hasDirectHeadline: false, hasDirectLocation: false,
      orgId: "org-1",
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      profileCapturedAt: new Date(),
      profileTextHash: "hash-1",
      profileUnchanged: true, // ← short-circuit
      job: baseJob as unknown as Awaited<ReturnType<typeof dbMocks.prisma.job.findUnique>>,
      parsedRole: JSON.parse(baseJob.parsedRole),
      salary: null,
      weights: { must_have: 0.36, skill_fit: 0.22, location_fit: 0.08, seniority_fit: 0.10, title_fit: 0.08, domain_fit: 0.10, nice_to_have_fit: 0.06 },
    });

    expect(result.applied).toBe(false);
    // No AI calls, no DB write.
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
    expect(aiMocks.predictAcceptance).not.toHaveBeenCalled();
    expect(dbMocks.prisma.candidate.updateMany).not.toHaveBeenCalled();
  });
});
