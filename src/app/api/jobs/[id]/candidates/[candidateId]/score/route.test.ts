import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    job: { findUnique: vi.fn() },
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    usageEvent: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  buildScorePrompt: vi.fn(),
  predictAcceptance: vi.fn().mockResolvedValue({
    score: 65,
    likelihood: "medium",
    headline: "May consider",
    signals: [],
    summary: "Mock acceptance prediction.",
  }),
}));

const queueMocks = vi.hoisted(() => ({ enqueueScoreJob: vi.fn().mockResolvedValue({ id: "score-job-1" }) }));
const flagMocks = vi.hoisted(() => ({ isLlamaScoreOffloadEnabled: vi.fn().mockReturnValue(false) }));
const memoryMocks = vi.hoisted(() => ({
  getCorrectionsVersion: vi.fn().mockResolvedValue(0),
  getRecruitingContext: vi.fn().mockResolvedValue(""),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireCandidateAccess: vi.fn(),
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
vi.mock("@/lib/scrape-queue", () => queueMocks);
vi.mock("@/lib/feature-flags", () => flagMocks);
vi.mock("@/lib/recruiter-memory", () => memoryMocks);
vi.mock("@/lib/scoring-config", () => ({
  getOrgScoringWeights: scoringConfigMocks.getOrgScoringWeights,
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

// AllProvidersFailedError is NOT mocked — the route uses `instanceof`, so the
// test must throw the real class for the offload branch to fire.
import { AllProvidersFailedError } from "@/lib/ai/chat-with-failover";
import { POST } from "./route";

function makeBreakdown() {
  return buildScoreBreakdown({
    categories: {
      skill_fit: { score: 78, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "Relevant stack overlap." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington-based." },
      seniority_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Correct level." },
      title_fit: { score: 72, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Matching titles." },
      domain_fit: { score: 62, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Some domain overlap, good keyword alignment." },
      nice_to_have_fit: { score: 35, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Limited nice-to-haves." },
    },
    must_have_coverage: [
      { requirement: "React", status: "confirmed", evidence: "Explicitly listed." },
    ],
    nice_to_have_coverage: [],
    reasons_for: ["Useful re-score regression check."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Solid re-score candidate.",
    profileCharCount: 2400,
  });
}

describe("candidate re-score route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const job = {
      id: "job-1",
      parsedRole: JSON.stringify({
        title: "Software Engineer",
        location: "Wellington",
        location_rules: "Wellington office",
        must_haves: ["React"],
        nice_to_haves: [],
        knockout_criteria: [],
        skills_required: ["React"],
        skills_preferred: [],
      }),
      salaryMin: null,
      salaryMax: null,
    };
    const candidate = {
      id: "cand-5",
      jobId: "job-1",
      location: "Wellington, New Zealand",
      profileText: "Candidate profile text",
      profileTextHash: null,
      status: "new",
    };
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireCandidateAccess.mockResolvedValue({ job, candidate, error: null });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    dbMocks.prisma.job.findUnique.mockResolvedValue(job);
    // Track the last updateMany data so tests can assert on the score that
    // was written, then return it from findUnique to simulate the post-write
    // re-read. Default: updateMany succeeds (count: 1) so the hash gate
    // doesn't trip in the happy path.
    let lastWrite: Record<string, unknown> | null = null;
    dbMocks.prisma.candidate.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      lastWrite = data;
      return { count: 1 };
    });
    dbMocks.prisma.candidate.findUnique.mockImplementation(async () => ({
      ...candidate,
      ...(lastWrite ?? {}),
    }));
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(false);
    memoryMocks.getRecruitingContext.mockResolvedValue("");
    queueMocks.enqueueScoreJob.mockResolvedValue({ id: "score-job-1" });
  });

  it("rebuilds structured score data for an existing candidate", async () => {
    const req = new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", {
      method: "POST",
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(dbMocks.prisma.candidate.updateMany).toHaveBeenCalledTimes(1);
    // Hash gate: write should be conditioned on profileTextHash === oldHash.
    expect(dbMocks.prisma.candidate.updateMany.mock.calls[0][0].where).toMatchObject({
      id: "cand-5",
      profileTextHash: null,
    });
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledWith(
      "Candidate profile text",
      expect.any(Object),
      null,
      scoringConfigMocks.customWeights,
      "org-1",
      undefined,
      true, // 22-char stub profile is < 100 chars → scored as a thin estimate
    );
    expect(body.scoreBreakdown).toContain("\"version\":2");
  });

  it("scores a snippet candidate with no profileText (SEEK card) as an estimate, not a 400", async () => {
    const job = {
      id: "job-1",
      parsedRole: JSON.stringify({
        title: "Software Engineer", location: "Wellington", location_rules: "Wellington office",
        must_haves: ["React"], nice_to_haves: [], knockout_criteria: [], skills_required: ["React"], skills_preferred: [],
      }),
      salaryMin: null, salaryMax: null,
    };
    const snippet = {
      id: "cand-seek", jobId: "job-1",
      name: "Ada Lovelace", headline: "Senior Android Engineer", location: "Wellington, New Zealand",
      profileText: "", profileTextHash: null, status: "new",
    };
    sessionMocks.requireCandidateAccess.mockResolvedValue({ job, candidate: snippet, error: null });
    dbMocks.prisma.job.findUnique.mockResolvedValue(job);
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ ...snippet, matchScore: 38 });

    const req = new Request("http://localhost/api/jobs/job-1/candidates/cand-seek/score", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ id: "job-1", candidateId: "cand-seek" }) });

    expect(res.status).toBe(200); // not 400 — the SEEK dead-end is gone
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledWith(
      "Ada Lovelace\nSenior Android Engineer\nWellington, New Zealand",
      expect.any(Object),
      null,
      scoringConfigMocks.customWeights,
      "org-1",
      undefined,
      true,
    );
  });

  it("skips the write when another scorer landed first (hash mismatch)", async () => {
    // Simulate the row's profileTextHash having advanced between our read
    // and our write. updateMany returns count: 0 — the route should log
    // and surface the existing row, NOT 500.
    dbMocks.prisma.candidate.updateMany.mockResolvedValueOnce({ count: 0 });
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({
      id: "cand-5",
      profileTextHash: "newer-hash-from-concurrent-write",
      matchScore: 88,
    });

    const res = await POST(
      new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", { method: "POST" }),
      { params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // We return the row as-is (the concurrent writer's score), not an error.
    expect(body.matchScore).toBe(88);
  });

  it("returns 400 for invalid stored job parse data", async () => {
    sessionMocks.requireCandidateAccess.mockResolvedValue({
      job: { id: "job-1", parsedRole: "{broken", salaryMin: null, salaryMax: null },
      candidate: { id: "cand-5", location: "Wellington", profileText: "Candidate profile text" },
      error: null,
    });

    const res = await POST(new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", { method: "POST" }), {
      params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/parse data is invalid/i);
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });

  // ── Llama scoring offload ──────────────────────────────────────────────────

  it("offload ON: AllProvidersFailedError → enqueues score job + returns 202 queued", async () => {
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(true);
    aiMocks.scoreCandidateStructured.mockRejectedValue(new AllProvidersFailedError(new Error("Claude 401")));
    aiMocks.buildScorePrompt.mockReturnValue({
      kind: "prompt",
      system: "sys",
      userPrompt: "user prompt",
      temperature: 0.1,
      maxTokens: 4096,
      chatOpts: {},
      finalizeCtx: { mustHaves: ["React"], niceToHaves: [], parsedRoleLocation: "Wellington", parsedRoleTitle: "Software Engineer" },
    });

    const res = await POST(
      new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", { method: "POST" }),
      { params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }) },
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ queued: true });
    expect(queueMocks.enqueueScoreJob).toHaveBeenCalledTimes(1);
    const arg = queueMocks.enqueueScoreJob.mock.calls[0][0];
    expect(arg).toMatchObject({ orgId: "org-1", candidateId: "cand-5" });
    expect(arg.scorePayload).toMatchObject({
      system: "sys",
      prompt: "user prompt",
      temperature: 0.1,
      maxTokens: 4096,
      finalizeCtx: expect.objectContaining({ mustHaves: ["React"] }),
    });
    // No candidate score write happened — it's deferred to the box.
    expect(dbMocks.prisma.candidate.updateMany).not.toHaveBeenCalled();
  });

  it("offload OFF: AllProvidersFailedError → graceful 503 + code, no enqueue", async () => {
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(false);
    aiMocks.scoreCandidateStructured.mockRejectedValue(new AllProvidersFailedError(new Error("Claude 401")));

    const res = await POST(
      new Request("http://localhost/api/jobs/job-1/candidates/cand-5/score", { method: "POST" }),
      { params: Promise.resolve({ id: "job-1", candidateId: "cand-5" }) },
    );

    // Graceful AI-down: provider outage with offload off → clean 503, not 500.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("ai_unavailable");
    expect(body.error).toMatch(/temporarily unavailable/i);
    // Offload path must NOT have fired (flag off): no enqueue, no prompt build.
    expect(queueMocks.enqueueScoreJob).not.toHaveBeenCalled();
    expect(aiMocks.buildScorePrompt).not.toHaveBeenCalled();
  });
});
