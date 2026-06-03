/**
 * PATCH /api/scraper/jobs/[id] — kind="score" branch (Llama scoring offload).
 *
 * The box runs the prompt Railway built against its local Ollama and POSTs
 * back the raw text. Railway finalizes that text into a ScoreBreakdown
 * (finalizeScoreFromText, scoredBy="ollama") and writes matchScore +
 * scoreBreakdown to the candidate, then marks the job completed. Missing
 * text / candidateId / scorePayload → 422; missing candidate → 404; job
 * failed in each guard case.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScoreBreakdown, CATEGORY_WEIGHTS_V2 } from "@/lib/scoring";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    scrapeJob: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    candidate: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

const aiMocks = vi.hoisted(() => ({ finalizeScoreFromText: vi.fn() }));

// The route imports these at module load; stub so the import graph resolves
// without a DB. The score branch doesn't call them.
const ingestionMocks = vi.hoisted(() => ({ ingestScraperResult: vi.fn() }));
const searchRunMocks = vi.hoisted(() => ({
  attachScraperHits: vi.fn(),
  attachIngestedProfile: vi.fn(),
  settleRunIfDone: vi.fn(),
  setSourceStatus: vi.fn(),
  scraperMergeKey: vi.fn(),
  platformToSource: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/ai", () => aiMocks);
vi.mock("@/lib/scraper-ingestion", () => ingestionMocks);
vi.mock("@/lib/search-run", () => searchRunMocks);
vi.mock("@/lib/error-reporting", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/feature-flags", () => ({ isScraperEnabled: () => true }));

import { PATCH } from "./route";

const SECRET = "test-scraper-secret";

function makeBreakdown(overall = 73) {
  const b = buildScoreBreakdown({
    categories: {
      skill_fit: { score: 80, weight: CATEGORY_WEIGHTS_V2.skill_fit, evidence: "React confirmed." },
      location_fit: { score: 100, weight: CATEGORY_WEIGHTS_V2.location_fit, evidence: "Wellington." },
      seniority_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.seniority_fit, evidence: "Level fits." },
      title_fit: { score: 70, weight: CATEGORY_WEIGHTS_V2.title_fit, evidence: "Title fits." },
      domain_fit: { score: 60, weight: CATEGORY_WEIGHTS_V2.domain_fit, evidence: "Overlap." },
      nice_to_have_fit: { score: 50, weight: CATEGORY_WEIGHTS_V2.nice_to_have_fit, evidence: "Neutral." },
    },
    must_have_coverage: [{ requirement: "React", status: "confirmed", evidence: "Listed." }],
    nice_to_have_coverage: [],
    reasons_for: ["Good fit."],
    reasons_against: [],
    missing_evidence: [],
    recruiter_summary: "Strong candidate.",
    profileCharCount: 2000,
  });
  // Override the formula overall so the test can assert a known value, and tag
  // the provider as the route does (scoredBy="ollama").
  return { ...b, overall, scoredBy: "ollama" as const };
}

const SCORE_PAYLOAD = JSON.stringify({
  system: "sys",
  prompt: "user prompt",
  temperature: 0.1,
  maxTokens: 4096,
  finalizeCtx: { mustHaves: ["React"], niceToHaves: [], parsedRoleLocation: "Wellington", parsedRoleTitle: "Engineer" },
  // Race guards captured at enqueue time. The happy-path candidate mock below
  // still carries "hash-at-enqueue", so the guarded write matches (count 1).
  expectedProfileTextHash: "hash-at-enqueue",
  scoreCacheKey: "fresh-cache-key",
});

function scoreJob(over: Record<string, unknown> = {}) {
  return {
    id: "job-score-1",
    orgId: "org-1",
    platform: "linkedin",
    kind: "score",
    profileUrl: null,
    searchQuery: null,
    searchRunId: null,
    retryCount: 0,
    status: "processing",
    candidateId: "cand-1",
    scorePayload: SCORE_PAYLOAD,
    ...over,
  };
}

function patchReq(body: unknown) {
  return new Request("http://localhost/api/scraper/jobs/job-score-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-scraper-secret": SECRET },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "job-score-1" }) };

function searchJob(over: Record<string, unknown> = {}) {
  return {
    id: "job-search-1",
    orgId: "org-1",
    platform: "seek",
    kind: "search",
    profileUrl: null,
    searchQuery: "android kotlin",
    searchRunId: null,
    retryCount: 0,
    status: "processing",
    candidateId: null,
    scorePayload: null,
    ...over,
  };
}

function searchReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/scraper/jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-scraper-secret": SECRET },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/scraper/jobs/[id] — kind=search SEEK card ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SCRAPER_SECRET = SECRET;
  });

  const cards = [
    { url: "https://nz.employer.seek.com/talentsearch/profile/1", name: "Ada Lovelace", headline: "Senior Android Engineer", location: "Wellington, NZ" },
    { url: "https://nz.employer.seek.com/talentsearch/profile/2", name: "Alan Turing", headline: "Kotlin Developer", location: "Auckland, NZ" },
  ];

  it("ingests each harvested SEEK card as a snippet candidate (no searchRunId needed)", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob());
    const res = await PATCH(
      searchReq("job-search-1", { status: "completed", result: { urls: cards.map((c) => c.url), cards } }),
      { params: Promise.resolve({ id: "job-search-1" }) },
    );
    expect(res.status).toBe(200);
    expect(ingestionMocks.ingestScraperResult).toHaveBeenCalledTimes(2);
    expect(ingestionMocks.ingestScraperResult).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        platform: "seek",
        profileUrl: "https://nz.employer.seek.com/talentsearch/profile/1",
        headline: "Senior Android Engineer",
        location: "Wellington, NZ",
      }),
    );
  });

  it("does NOT ingest cards for a LinkedIn search (LinkedIn deep-scrapes profile children instead)", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob({ id: "job-search-li", platform: "linkedin" }));
    const res = await PATCH(
      searchReq("job-search-li", { status: "completed", result: { urls: ["https://linkedin.com/in/x"], cards: [{ url: "https://linkedin.com/in/x", name: "X", headline: "Dev", location: "NZ" }] } }),
      { params: Promise.resolve({ id: "job-search-li" }) },
    );
    expect(res.status).toBe(200);
    expect(ingestionMocks.ingestScraperResult).not.toHaveBeenCalled();
  });

  it("one malformed card does not fail the whole job", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(searchJob());
    ingestionMocks.ingestScraperResult
      .mockRejectedValueOnce(new Error("bad card"))
      .mockResolvedValueOnce(undefined);
    const res = await PATCH(
      searchReq("job-search-1", { status: "completed", result: { urls: cards.map((c) => c.url), cards } }),
      { params: Promise.resolve({ id: "job-search-1" }) },
    );
    expect(res.status).toBe(200);
    expect(ingestionMocks.ingestScraperResult).toHaveBeenCalledTimes(2);
  });
});

describe("PATCH /api/scraper/jobs/[id] — kind=score", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SCRAPER_SECRET = SECRET;
    aiMocks.finalizeScoreFromText.mockReturnValue(makeBreakdown(73));
    dbMocks.prisma.candidate.updateMany.mockResolvedValue({ count: 1 });
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({
      id: "cand-1",
      profileText: "React engineer in Wellington with 5 years experience.",
      orgId: "org-1",
      profileTextHash: "hash-at-enqueue",
    });
  });

  it("valid {text}: finalizes, updates candidate (matchScore + scoredBy=ollama), completes job", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(scoreJob());

    const res = await PATCH(patchReq({ status: "completed", result: { text: '{"overall_score":73}' } }), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "score", candidateId: "cand-1", matchScore: 73 });

    // finalize ran with the box's raw text + source "ollama" + the payload's finalizeCtx.
    expect(aiMocks.finalizeScoreFromText).toHaveBeenCalledWith(
      '{"overall_score":73}',
      "ollama",
      expect.objectContaining({ mustHaves: ["React"], parsedRoleLocation: "Wellington" }),
    );

    // Candidate written via the concurrency-guarded updateMany (gated on the
    // profileTextHash captured at enqueue time).
    const upd = dbMocks.prisma.candidate.updateMany.mock.calls[0][0];
    // Guard uses the ENQUEUE-time hash from the payload (not the re-read one).
    expect(upd.where).toMatchObject({ id: "cand-1", profileTextHash: "hash-at-enqueue" });
    expect(upd.data.matchScore).toBe(73);
    // Stamps the intended cache key so a later same-context re-score cache-hits.
    expect(upd.data.profileTextHash).toBe("fresh-cache-key");
    // scoredBy="ollama" lives inside the serialized scoreBreakdown JSON.
    expect(JSON.parse(upd.data.scoreBreakdown).scoredBy).toBe("ollama");

    // Job marked completed.
    const jobUpdate = dbMocks.prisma.scrapeJob.update.mock.calls.at(-1)![0];
    expect(jobUpdate.data.status).toBe("completed");
  });

  it("missing result.text → 422 + job failed", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(scoreJob());

    const res = await PATCH(patchReq({ status: "completed", result: {} }), params);

    expect(res.status).toBe(422);
    expect(aiMocks.finalizeScoreFromText).not.toHaveBeenCalled();
    expect(dbMocks.prisma.scrapeJob.update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("missing candidateId → 422 + job failed", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(scoreJob({ candidateId: null }));

    const res = await PATCH(patchReq({ status: "completed", result: { text: "{}" } }), params);

    expect(res.status).toBe(422);
    expect(dbMocks.prisma.scrapeJob.update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("missing scorePayload → 422 + job failed", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(scoreJob({ scorePayload: null }));

    const res = await PATCH(patchReq({ status: "completed", result: { text: "{}" } }), params);

    expect(res.status).toBe(422);
    expect(dbMocks.prisma.scrapeJob.update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("candidate not found → 404 + job failed", async () => {
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(scoreJob());
    dbMocks.prisma.candidate.findUnique.mockResolvedValue(null);

    const res = await PATCH(patchReq({ status: "completed", result: { text: "{}" } }), params);

    expect(res.status).toBe(404);
    expect(dbMocks.prisma.scrapeJob.update.mock.calls[0][0].data.status).toBe("failed");
    expect(dbMocks.prisma.candidate.updateMany).not.toHaveBeenCalled();
  });

  it("does NOT overwrite a fresher score — guards on enqueue-time hash, completes job, leaves candidate untouched", async () => {
    // The box was slow; while it worked, a fresher Claude/Ollama score landed
    // and advanced the candidate's profileTextHash to "new-hash". The offload
    // job carries expectedProfileTextHash="old-hash". The guarded write MUST
    // target "old-hash" (matching 0 rows), NOT the candidate's current
    // "new-hash" — otherwise it clobbers the fresher score (the bug).
    dbMocks.prisma.scrapeJob.findUnique.mockResolvedValue(
      scoreJob({
        scorePayload: JSON.stringify({
          system: "sys",
          prompt: "p",
          temperature: 0.1,
          maxTokens: 4096,
          finalizeCtx: { mustHaves: ["React"], niceToHaves: [], parsedRoleLocation: "Wellington", parsedRoleTitle: "Engineer" },
          expectedProfileTextHash: "old-hash",
          scoreCacheKey: "fresh-cache-key",
        }),
      }),
    );
    // Candidate has since been re-scored → its hash moved on.
    dbMocks.prisma.candidate.findUnique.mockResolvedValue({
      id: "cand-1",
      profileText: "React engineer in Wellington with 5 years experience.",
      orgId: "org-1",
      profileTextHash: "new-hash",
    });
    // The guarded updateMany matches 0 rows (old-hash != current new-hash).
    dbMocks.prisma.candidate.updateMany.mockResolvedValue({ count: 0 });

    const res = await PATCH(patchReq({ status: "completed", result: { text: '{"overall_score":73}' } }), params);

    expect(res.status).toBe(200);

    // The guard targeted the ENQUEUE-time hash, not the candidate's current one.
    const upd = dbMocks.prisma.candidate.updateMany.mock.calls[0][0];
    expect(upd.where.profileTextHash).toBe("old-hash");
    expect(upd.where.profileTextHash).not.toBe("new-hash");
    // Only one write was attempted, and it matched nothing → no overwrite path.
    expect(dbMocks.prisma.candidate.updateMany).toHaveBeenCalledTimes(1);

    // Job still marked completed (the offload did its part).
    const jobUpdate = dbMocks.prisma.scrapeJob.update.mock.calls.at(-1)![0];
    expect(jobUpdate.data.status).toBe("completed");
  });
});
