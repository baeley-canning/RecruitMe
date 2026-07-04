import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared with vi.hoisted so they exist at module-init time
// (vi.mock factories execute before regular `import`s due to hoisting).
const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    job: { findUnique: vi.fn() },
    fetchSession: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const aiMocks = vi.hoisted(() => ({
  extractCandidateInfo: vi.fn().mockResolvedValue({ name: "Alex Chen", headline: "Engineer", location: "Wellington" }),
  predictAcceptance:    vi.fn().mockResolvedValue({ score: 70, likelihood: "medium", headline: "", signals: [], summary: "" }),
  scoreCandidateStructured: vi.fn(),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  weights: {
    must_have: 0.5,
    skill_fit: 0.2,
    location_fit: 0.05,
    seniority_fit: 0.05,
    title_fit: 0.05,
    domain_fit: 0.1,
    nice_to_have_fit: 0.05,
  },
  getJobScoringWeights: vi.fn(),
}));

const errorReportingMocks = vi.hoisted(() => ({
  reportError: vi.fn(),
}));

vi.mock("../db", () => dbMocks);
vi.mock("../ai", () => aiMocks);
vi.mock("../scoring-config", () => ({
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));
vi.mock("../error-reporting", () => errorReportingMocks);

import {
  applyAiEnrichmentInBackground,
  importCapturedLinkedInProfileFast,
  mergeScoringError,
} from "../linkedin-capture";

// Profile text long enough to clear the 200-char sanity gate in stage 1.
const PROFILE_TEXT = `Alex Chen
Senior Software Engineer
Wellington, New Zealand
About
Full-stack engineer with eight years of production experience building Ruby on Rails and React applications. Strong TypeScript, AWS, and observability background. Wellington-based, hybrid-only.
Top skills
TypeScript • React • Ruby on Rails • AWS`;

describe("linkedin-capture scoring failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.prisma.candidate.updateMany.mockResolvedValue({ count: 1 });
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.weights);
    dbMocks.prisma.job.findUnique.mockResolvedValue({
      id: "job-1",
      orgId: "org-1",
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
      location: "Wellington",
      location2: null,
      isRemote: false,
      scoringWeights: null,
    });
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ screeningData: null });
  });

  it("stage 2 writes the deterministic heuristic score — no AI scorer/acceptance, hash cleared", async () => {
    // Stage 1: import path — creates the candidate row, returns identity.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]);
    dbMocks.prisma.candidate.create.mockResolvedValueOnce({
      id: "cand-1",
      profileTextHash: "hash-stage-1",
    });

    const { candidate, identity } = await importCapturedLinkedInProfileFast({
      jobId: "job-1",
      linkedinUrl: "https://www.linkedin.com/in/alex-chen",
      profileText: PROFILE_TEXT,
    });
    expect(candidate.id).toBe("cand-1");

    await applyAiEnrichmentInBackground("cand-1", identity);

    // Scoring judgment is on demand now: capture never calls the paid
    // structured scorer or acceptance prediction (extractCandidateInfo, a
    // parsing call, still runs).
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
    expect(aiMocks.predictAcceptance).not.toHaveBeenCalled();

    // The heuristic score landed via the hash-gated updateMany…
    const scoreWrite = dbMocks.prisma.candidate.updateMany.mock.calls.find(
      (call) => typeof (call[0].data as Record<string, unknown>)?.matchScore === "number",
    );
    expect(scoreWrite, "expected updateMany carrying the heuristic matchScore").toBeTruthy();
    const data = scoreWrite![0].data as Record<string, unknown>;
    expect(data.scoreBreakdown).toContain("\"scoredBy\":\"heuristic\"");
    // …with the React must-have found in the full captured text (receipts).
    expect(data.scoreBreakdown).toContain("\"status\":\"likely\"");
    // CRITICAL: stage 1 stamped the real cache key; the heuristic write must
    // null it, or score-all would treat this row as already-AI-scored and
    // cache-skip it forever.
    expect(data.profileTextHash).toBeNull();
  });

  it("writes matchScore: null + screeningData.scoringError when stage-2 scoring throws", async () => {
    // A parsedRole with neither must_haves nor skills_required makes the
    // heuristic throw (nothing to score against) — the realistic breakage
    // shape now that scoring is deterministic.
    dbMocks.prisma.job.findUnique.mockResolvedValue({
      id: "job-1",
      orgId: "org-1",
      parsedRole: JSON.stringify({ title: "Software Engineer", location: "Wellington" }),
      salaryMin: null,
      salaryMax: null,
      location: "Wellington",
      location2: null,
      isRemote: false,
      scoringWeights: null,
    });
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([]);
    dbMocks.prisma.candidate.create.mockResolvedValueOnce({
      id: "cand-1",
      profileTextHash: "hash-stage-1",
    });

    const { identity } = await importCapturedLinkedInProfileFast({
      jobId: "job-1",
      linkedinUrl: "https://www.linkedin.com/in/alex-chen",
      profileText: PROFILE_TEXT,
    });

    await applyAiEnrichmentInBackground("cand-1", identity);

    // Find the updateMany call that wrote {matchScore: null, screeningData: <json>}.
    const flagWrite = dbMocks.prisma.candidate.updateMany.mock.calls.find(
      (call) => (call[0].data as Record<string, unknown>)?.matchScore === null,
    );
    expect(flagWrite, "expected updateMany({matchScore:null, screeningData:...}) call").toBeTruthy();
    const flagData = flagWrite![0].data as Record<string, unknown>;
    expect(flagData.matchScore).toBeNull();
    const screening = JSON.parse(flagData.screeningData as string);
    expect(screening.scoringError).toBeTruthy();
    expect(screening.scoringErrorAt).toBeTruthy();

    // reportError was called so Sentry / structured logs get the trail.
    expect(errorReportingMocks.reportError).toHaveBeenCalled();
  });
});

describe("mergeScoringError", () => {
  it("adds scoringError + scoringErrorAt onto an empty screeningData blob", () => {
    const merged = mergeScoringError(null, "Claude 503");
    const parsed = JSON.parse(merged);
    expect(parsed.scoringError).toBe("Claude 503");
    expect(parsed.scoringErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves existing screeningData fields when merging", () => {
    const existing = JSON.stringify({ availability: "4 weeks", notes: "Strong React." });
    const merged = mergeScoringError(existing, "Ollama 502");
    const parsed = JSON.parse(merged);
    expect(parsed.availability).toBe("4 weeks");
    expect(parsed.notes).toBe("Strong React.");
    expect(parsed.scoringError).toBe("Ollama 502");
  });

  it("survives malformed existing screeningData (falls back to empty base)", () => {
    const merged = mergeScoringError("{this is not json", "Boom");
    const parsed = JSON.parse(merged);
    expect(parsed.scoringError).toBe("Boom");
  });
});

