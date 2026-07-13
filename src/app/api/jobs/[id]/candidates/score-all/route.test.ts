import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

// ── Mocks ────────────────────────────────────────────────────────────────────
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
      // Conditional cooldown claim — count:1 lets the run proceed.
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
  // M1: the route now scores via scoreCandidatesBatch (one call per group of up
  // to 5), not per-candidate scoreCandidateStructured.
  scoreCandidatesBatch: vi.fn(),
  predictAcceptance: vi.fn().mockResolvedValue({
    score: 70, likelihood: "medium", headline: "Open to discussion", signals: [], summary: "Likely to consider.",
  }),
}));

// provider-health drives the outage guard. Default "healthy"; a test flips it to
// "down" to simulate a credit-out mid-run.
const healthMocks = vi.hoisted(() => ({
  deriveProviderState: vi.fn((): "healthy" | "degraded" | "down" | "unconfigured" | "untested" => "healthy"),
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const scoringConfigMocks = vi.hoisted(() => ({
  customWeights: { must_have: 0.5, skill_fit: 0.2, location_fit: 0.05, seniority_fit: 0.05, title_fit: 0.05, domain_fit: 0.1, nice_to_have_fit: 0.05 },
  getOrgScoringWeights: vi.fn(),
  getJobScoringWeights: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => ({ predictAcceptance: aiMocks.predictAcceptance }));
// Partial mock: keep the real module (finalize helpers, types) and only stub the
// batch scorer, so applyLocationFitOverride/deriveUpdateData run for real.
vi.mock("@/lib/ai/scoring", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/scoring")>()),
  scoreCandidatesBatch: aiMocks.scoreCandidatesBatch,
}));
vi.mock("@/lib/provider-health", async (orig) => ({
  ...(await orig<typeof import("@/lib/provider-health")>()),
  deriveProviderState: healthMocks.deriveProviderState,
}));
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/require-capability", () => ({
  requireCapability: vi.fn(async () => null),
  getUserPermissions: vi.fn(async () => []),
}));
vi.mock("@/lib/recruiter-memory", () => ({
  getRecruitingContext: vi.fn().mockResolvedValue(""),
  getCorrectionsVersion: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/scoring-config", () => ({
  getOrgScoringWeights: scoringConfigMocks.getOrgScoringWeights,
  getJobScoringWeights: scoringConfigMocks.getJobScoringWeights,
}));

import { POST } from "./route";

// Reads all newline-delimited JSON lines; returns [allMessages, lastMessage].
async function readStream(res: Response): Promise<[Record<string, unknown>[], Record<string, unknown>]> {
  const text = await res.text();
  const msgs = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return [msgs, msgs[msgs.length - 1]];
}

const PROFILE_TEXT = "React engineer based in Wellington with five years of experience building " +
  "production web applications. Strong skills in TypeScript and Node.js. Previously at Xero.";

function makeJob(id: string, location = "Wellington") {
  return {
    id,
    parsedRole: JSON.stringify({
      title: "Software Engineer", location, location_rules: `${location} office`,
      must_haves: ["React"], nice_to_haves: [], knockout_criteria: [], skills_required: ["React"], skills_preferred: [],
    }),
    salaryMin: 90000, salaryMax: 120000, location, isRemote: false, lastScoredAt: null,
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
    nice_to_have_coverage: [], reasons_for: ["Good fit."], reasons_against: [], missing_evidence: [],
    recruiter_summary: "Good candidate.", profileCharCount: PROFILE_TEXT.length,
  });
}

// Default batch scorer: one breakdown per input, same id.
function batchOk() {
  return async (inputs: { candidateId: string; profileText: string }[]) =>
    inputs.map((i) => ({ candidateId: i.candidateId, breakdown: makeBreakdown() }));
}

const post = (id: string) => POST(new Request("http://localhost/", { method: "POST" }), { params: Promise.resolve({ id }) });

describe("score-all route (batched / M1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    scoringConfigMocks.getOrgScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    aiMocks.scoreCandidatesBatch.mockImplementation(batchOk());
    healthMocks.deriveProviderState.mockReturnValue("healthy");
    dbMocks.prisma.candidate.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({ screeningData: null });
  });

  it("scores multiple candidates in ONE batch call (the M1 call-count cut)", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: makeJob("job-batch"), error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "c1", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
      { id: "c2", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
    ]);

    const res = await post("job-batch");
    const [, last] = await readStream(res);

    expect(res.status).toBe(200);
    expect(last).toMatchObject({ scored: 2, total: 2, done: true });
    // Both candidates went through a SINGLE scoreCandidatesBatch call.
    expect(aiMocks.scoreCandidatesBatch).toHaveBeenCalledTimes(1);
    const inputs = aiMocks.scoreCandidatesBatch.mock.calls[0][0];
    expect(inputs.map((i: { candidateId: string }) => i.candidateId)).toEqual(["c1", "c2"]);
    // Both candidate rows written with a score.
    expect(dbMocks.prisma.candidate.update).toHaveBeenCalledTimes(2);
  });

  it("streams progress — total first, done last", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: makeJob("job-stream"), error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "a", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
      { id: "b", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
    ]);

    const [msgs, last] = await readStream(await post("job-stream"));
    expect(msgs[0]).toMatchObject({ scored: 0, total: 2 });
    expect(last).toMatchObject({ done: true, total: 2 });
  });

  it("cache hit (hash + score + breakdown present) is skipped — not sent to the batch", async () => {
    const job = makeJob("job-cache");
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    // Run once to discover the cache key the route computes, then feed it back.
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      { id: "warm", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
    ]);
    await readStream(await post("job-cache"));
    const writtenHash = (dbMocks.prisma.candidate.update.mock.calls[0][0].data as { profileTextHash: string }).profileTextHash;
    vi.clearAllMocks();
    aiMocks.scoreCandidatesBatch.mockImplementation(batchOk());
    healthMocks.deriveProviderState.mockReturnValue("healthy");
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
    sessionMocks.requireJobAccess.mockResolvedValue({ job, error: null });
    scoringConfigMocks.getJobScoringWeights.mockResolvedValue(scoringConfigMocks.customWeights);
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "warm", profileText: PROFILE_TEXT, profileTextHash: writtenHash, matchScore: 80, scoreBreakdown: "{}", location: "Wellington" },
    ]);

    const [, last] = await readStream(await post("job-cache"));
    expect(last).toMatchObject({ scored: 0, cached: 1, total: 1, done: true });
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
  });

  it("scores thin snippet finds (no profileText) by synthesising text and sending it to the batch", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: makeJob("job-thin"), error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "snip", profileText: null, name: "Jane Dev", headline: "Senior React Engineer at Acme", profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
    ]);

    const [, last] = await readStream(await post("job-thin"));
    expect(last).toMatchObject({ scored: 1, total: 1, done: true });
    const inputs = aiMocks.scoreCandidatesBatch.mock.calls[0][0];
    expect(inputs[0].profileText).toContain("Senior React Engineer at Acme");
  });

  it("skips a candidate with nothing to score (no profileText/headline/location)", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: makeJob("job-empty"), error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "empty", profileText: null, name: null, headline: null, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: null },
    ]);

    const [, last] = await readStream(await post("job-empty"));
    expect(last).toMatchObject({ scored: 0, total: 1, done: true });
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
  });

  it("OUTAGE: Claude down after the batch → candidates flagged re-scoreable (NO cache key) + aiUnavailable", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: makeJob("job-outage"), error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "x", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
      { id: "y", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
    ]);
    // The batch returns stubs (it never throws), but provider-health reports a
    // fatal Claude outage → the route must NOT persist stub scores with a cache key.
    healthMocks.deriveProviderState.mockReturnValue("down");

    const [, last] = await readStream(await post("job-outage"));
    expect(last).toMatchObject({ scored: 0, total: 2, done: true, aiUnavailable: true });
    expect(last.failedIds).toEqual(["x", "y"]);
    // Flagged via updateMany {matchScore:null} — NEVER candidate.update with a hash
    // (which would cache the stub and skip it forever on non-force runs).
    expect(dbMocks.prisma.candidate.update).not.toHaveBeenCalled();
    const flag = dbMocks.prisma.candidate.updateMany.mock.calls.find(
      (c) => (c[0].data as Record<string, unknown>)?.matchScore === null,
    );
    expect(flag).toBeTruthy();
    expect((flag![0].data as Record<string, unknown>).profileTextHash).toBeUndefined();
  });

  it("a DB write failure flags that candidate (re-scoreable) without aborting the rest", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: makeJob("job-writefail"), error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "good", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
      { id: "bad", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
    ]);
    dbMocks.prisma.candidate.update
      .mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => data) // good
      .mockRejectedValueOnce(new Error("DB write blew up")); // bad

    const [, last] = await readStream(await post("job-writefail"));
    expect(last).toMatchObject({ scored: 1, total: 2, done: true });
    expect(last.failedIds).toContain("bad");
  });

  it("returns 400 when the job has no parsedRole", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { ...makeJob("j"), parsedRole: null }, error: null });
    const res = await post("j");
    expect(res.status).toBe(400);
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
  });

  it("returns 400 when stored parsedRole JSON is invalid", async () => {
    sessionMocks.requireJobAccess.mockResolvedValue({ job: { ...makeJob("j"), parsedRole: "{broken" }, error: null });
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      { id: "c", profileText: PROFILE_TEXT, profileTextHash: null, matchScore: null, scoreBreakdown: null, location: "Wellington" },
    ]);
    const res = await post("j");
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/parse data is invalid/i);
    expect(aiMocks.scoreCandidatesBatch).not.toHaveBeenCalled();
  });
});
