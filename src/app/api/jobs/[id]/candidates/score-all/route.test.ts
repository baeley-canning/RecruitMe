import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ screeningData: null }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    job: {
      update: vi.fn().mockResolvedValue({}),
      // updateMany is the new conditional cooldown claim — return count: 1
      // by default so the run proceeds; tests that simulate "another run is
      // already in flight" can override to count: 0.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    usageEvent: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({
  scoreCandidateStructured: vi.fn(),
  buildScorePrompt: vi.fn(),
  predictAcceptance: vi.fn().mockResolvedValue({
    score: 70,
    likelihood: "medium",
    headline: "Open to discussion",
    signals: [],
    summary: "Likely to consider a suitable role.",
  }),
}));

const queueMocks = vi.hoisted(() => ({ enqueueScoreJob: vi.fn().mockResolvedValue({ id: "score-job-1" }) }));
const flagMocks = vi.hoisted(() => ({ isLlamaScoreOffloadEnabled: vi.fn().mockReturnValue(false) }));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
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
vi.mock("@/lib/ai", () => ({
  ...aiMocks,
  // withRetry is a pass-through in tests — just call the function directly
  withRetry: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/scrape-queue", () => queueMocks);
vi.mock("@/lib/feature-flags", () => flagMocks);
vi.mock("@/lib/recruiter-memory", () => ({
  getRecruitingContext: vi.fn().mockResolvedValue(""),
  getCorrectionsVersion: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/scoring-config", () => ({
  getOrgScoringWeights: scoringConfigMocks.getOrgScoringWeights,
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

// AllProvidersFailedError is NOT mocked — the route uses `instanceof`.
import { AllProvidersFailedError } from "@/lib/ai/chat-with-failover";
import { POST } from "./route";

// Reads all newline-delimited JSON lines from a streaming Response and returns the last one.
async function readStreamResult(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const PROFILE_TEXT = "React engineer based in Wellington with five years of experience building " +
  "production web applications. Strong skills in TypeScript and Node.js. Previously at Xero.";

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
      domain_fit: { score: 62, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Some domain overlap." },
      nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Neutral." },
    },
    must_have_coverage: [{ requirement: "React", status: "confirmed", evidence: "Listed." }],
    nice_to_have_coverage: [],
    reasons_for: ["Good fit."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Good candidate.",
    profileCharCount: PROFILE_TEXT.length,
  });
}

describe("score-all route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    aiMocks.scoreCandidateStructured.mockResolvedValue(makeBreakdown());
    dbMocks.prisma.candidate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(false);
    queueMocks.enqueueScoreJob.mockResolvedValue({ id: "score-job-1" });
  });

  it("always rescores every candidate regardless of cache key", async () => {
    const job = makeJob("job-always-rescore");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-1", profileText: PROFILE_TEXT, profileTextHash: "old-hash", matchScore: 82, location: "Wellington" },
    ]);

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-always-rescore" }),
    });

    expect(res.status).toBe(200);
    const result = await readStreamResult(res);
    expect(result).toMatchObject({ scored: 1, total: 1, done: true });
    expect(aiMocks.scoreCandidateStructured).toHaveBeenCalledWith(
      PROFILE_TEXT,
      expect.any(Object),
      { min: 90000, max: 120000 },
      scoringConfigMocks.customWeights,
      "org-1",
      ""
    );
  });

  it("streams progress updates — scored count increments before final done message", async () => {
    const job = makeJob("job-stream-progress");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-a", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
      { id: "cand-b", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-stream-progress" }),
    });

    const text = await res.text();
    const messages = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));

    // First message announces total before any scoring starts.
    expect(messages[0]).toMatchObject({ scored: 0, total: 2 });
    // Last message has done flag.
    expect(messages[messages.length - 1]).toMatchObject({ done: true, total: 2 });
  });

  it("skips candidates with profile text under 100 chars", async () => {
    const job = makeJob("job-short-profile");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-short", profileText: "Too short.", profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-short-profile" }),
    });

    const result = await readStreamResult(res);
    expect(result).toMatchObject({ scored: 0, total: 1, done: true });
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });

  it("returns 400 when job has no parsedRole", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { ...makeJob("j"), parsedRole: null }, error: null });

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "j" }),
    });

    expect(res.status).toBe(400);
  });

  it("flags scoringError on screeningData when scoring rejects (per-candidate failure trail)", async () => {
    // Before the fix: a failed candidate was only pushed into `failed: []`
    // and the row was untouched — so "Imported 30 / Scored 0" left no
    // per-candidate trail. After the fix the row gets {matchScore: null,
    // screeningData.scoringError} written via updateMany so the card shows
    // why each candidate didn't score.
    const job = makeJob("job-score-failure");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-fail", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);
    aiMocks.scoreCandidateStructured.mockRejectedValueOnce(new Error("Ollama 502 fallback also failed"));
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({ screeningData: null });

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-score-failure" }),
    });

    const result = await readStreamResult(res);
    expect(result).toMatchObject({ scored: 0, total: 1, done: true, failedIds: ["cand-fail"] });

    // Find the updateMany call that wrote the failure flag (NOT the cooldown
    // claim on job.updateMany).
    const flagWrite = dbMocks.prisma.candidate.updateMany.mock.calls.find(
      (call) => (call[0].data as Record<string, unknown>)?.matchScore === null,
    );
    expect(flagWrite).toBeTruthy();
    const flagData = (flagWrite![0].data) as Record<string, unknown>;
    expect(flagData.matchScore).toBeNull();
    const screening = JSON.parse(flagData.screeningData as string);
    expect(screening.scoringError).toContain("Ollama 502");
  });

  it("returns 400 when stored parsedRole JSON is invalid", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { ...makeJob("j"), parsedRole: "{broken" }, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-1", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "j" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/parse data is invalid/i);
    expect(aiMocks.scoreCandidateStructured).not.toHaveBeenCalled();
  });

  // ── Llama scoring offload ──────────────────────────────────────────────────

  it("offload ON: per-candidate AllProvidersFailedError → enqueues, counts queued (not failed)", async () => {
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(true);
    const job = makeJob("job-offload");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-off", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);
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

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-offload" }),
    });

    const result = await readStreamResult(res);
    expect(result).toMatchObject({ scored: 0, queued: 1, total: 1, done: true });
    // Not flagged as failed.
    expect(result.failedIds).toBeUndefined();
    expect(queueMocks.enqueueScoreJob).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueueScoreJob.mock.calls[0][0]).toMatchObject({ orgId: "org-1", candidateId: "cand-off" });
  });

  it("offload OFF: per-candidate AllProvidersFailedError → flagged failed, no enqueue (unchanged)", async () => {
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(false);
    const job = makeJob("job-no-offload");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-fail2", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);
    aiMocks.scoreCandidateStructured.mockRejectedValue(new AllProvidersFailedError(new Error("Claude 401")));
    dbMocks.prisma.candidate.findUnique.mockResolvedValueOnce({ screeningData: null });

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-no-offload" }),
    });

    const result = await readStreamResult(res);
    expect(result).toMatchObject({ scored: 0, total: 1, done: true, failedIds: ["cand-fail2"] });
    expect(queueMocks.enqueueScoreJob).not.toHaveBeenCalled();
  });

  it("offload OFF: every candidate fails with AllProvidersFailedError → summary says AI unavailable", async () => {
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(false);
    const job = makeJob("job-all-down");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-x", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
      { id: "cand-y", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);
    aiMocks.scoreCandidateStructured.mockRejectedValue(new AllProvidersFailedError(new Error("Claude 401")));
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ screeningData: null });

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-all-down" }),
    });

    const result = await readStreamResult(res);
    expect(result).toMatchObject({ scored: 0, total: 2, done: true, aiUnavailable: true });
    expect(result.message).toMatch(/AI scoring unavailable \(Claude out of credits\)/i);
    expect(result.failedIds).toEqual(["cand-x", "cand-y"]);
    // No uncaught 500 — the stream completed with a done message.
    expect(res.status).toBe(200);
  });

  it("does NOT label as AI-unavailable when only some candidates fail on provider outage", async () => {
    // One scores fine, one hits AllProvidersFailedError → this is a partial
    // run, not a full outage; the summary must stay generic (no aiUnavailable).
    flagMocks.isLlamaScoreOffloadEnabled.mockReturnValue(false);
    const job = makeJob("job-partial-down");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "cand-ok", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
      { id: "cand-down", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, location: "Wellington" },
    ]);
    aiMocks.scoreCandidateStructured
      .mockResolvedValueOnce(makeBreakdown())
      .mockRejectedValueOnce(new AllProvidersFailedError(new Error("Claude 401")));
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ screeningData: null });

    const res = await POST(new Request("http://localhost/", { method: "POST" }), {
      params: Promise.resolve({ id: "job-partial-down" }),
    });

    const result = await readStreamResult(res);
    expect(result).toMatchObject({ scored: 1, total: 2, done: true });
    expect(result.aiUnavailable).toBeUndefined();
  });
});
