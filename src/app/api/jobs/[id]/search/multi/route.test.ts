/**
 * Integration tests for POST /api/jobs/[id]/search/multi.
 *
 * Mocks all sources + auth + rate limit. Tests the orchestration:
 *   • Auth chain (unauthenticated / forbidden)
 *   • Body validation (missing query / bad sources)
 *   • Source selection (library only / linkedin only / both)
 *   • Scraper-only LinkedIn/SEEK discovery (Phase K — SerpAPI removed):
 *       - enqueueSearchJob fired at priority=100 when discovery enabled
 *       - errors.linkedin when discovery disabled
 *   • Partial failure tolerance (library throws → still 200)
 *   • Rate limit
 *   • Aggregation + counts pass-through (fromLibrary / fromScraper)
 *   • recordUsage fire-and-forget call
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  requireJobAccess: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

const orgAccessMocks = vi.hoisted(() => ({
  getAccessibleOrgIds: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  recordUsage: vi.fn(),
}));

const libraryMocks = vi.hoisted(() => ({
  searchLibrary: vi.fn(),
}));

const flagMocks = vi.hoisted(() => ({
  isScraperDiscoveryEnabled: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  enqueueSearchJob: vi.fn(),
}));

vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/org-access", () => orgAccessMocks);
vi.mock("@/lib/usage", () => usageMocks);
vi.mock("@/lib/talent-search/library", () => libraryMocks);
vi.mock("@/lib/feature-flags", () => flagMocks);
vi.mock("@/lib/scrape-queue", () => queueMocks);
vi.mock("@/lib/error-reporting", () => ({
  reportError: vi.fn(),
}));

import { POST } from "@/app/api/jobs/[id]/search/multi/route";

let scraperJobSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  scraperJobSeq = 0;
  // Sensible defaults — each test overrides what it cares about.
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-A", isOwner: false });
  sessionMocks.requireJobAccess.mockResolvedValue({ job: { id: "job-1" }, error: null });
  orgAccessMocks.getAccessibleOrgIds.mockResolvedValue(["org-A"]);
  usageMocks.checkRateLimit.mockResolvedValue({ allowed: true });
  usageMocks.recordUsage.mockResolvedValue(undefined);
  libraryMocks.searchLibrary.mockResolvedValue([]);
  // Discovery enabled by default — most tests exercise the live scraper path.
  flagMocks.isScraperDiscoveryEnabled.mockReturnValue(true);
  // Each enqueue returns a fresh job id so liveJobs entries are distinguishable.
  queueMocks.enqueueSearchJob.mockImplementation(async () => ({
    id: `scrape-${++scraperJobSeq}`,
  }));
});

function makeReq(body: unknown): Request {
  return new Request("http://test/api/jobs/job-1/search/multi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ id: "job-1" }) };

// Helper: build a library result row matching the LibrarySearchResult shape.
function lib(over: Record<string, unknown> = {}) {
  return {
    id: "lib-1",
    name: "Library Person",
    headline: "Senior Engineer",
    location: "Wellington",
    linkedinUrl: "https://www.linkedin.com/in/lib-person",
    jobAdderUrl: null,
    photoFileId: null,
    matchScore: 80,
    source: "talent_pool",
    profileTextSnippet: "Snippet",
    candidateIdentityId: "ident-1",
    createdAt: new Date(),
    ...over,
  };
}

describe("POST /search/multi — auth", () => {
  it("returns 401 when not authenticated", async () => {
    sessionMocks.getAuth.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(401);
  });

  it("returns the requireJobAccess error when job is forbidden", async () => {
    sessionMocks.requireJobAccess.mockResolvedValueOnce({
      job: null,
      error: new Response(null, { status: 403 }),
    });
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(403);
    expect(libraryMocks.searchLibrary).not.toHaveBeenCalled();
  });
});

describe("POST /search/multi — body validation", () => {
  it("422 when query missing", async () => {
    const res = await POST(makeReq({}), PARAMS);
    expect(res.status).toBe(422);
  });

  it("422 when sources is empty array", async () => {
    const res = await POST(makeReq({ query: "react", sources: [] }), PARAMS);
    expect(res.status).toBe(422);
  });

  it("422 when source is an unknown value", async () => {
    const res = await POST(makeReq({ query: "react", sources: ["library", "twitter"] }), PARAMS);
    expect(res.status).toBe(422);
  });

  it("accepts empty query string (returns recent rows from library)", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(makeReq({ query: "", sources: ["library"] }), PARAMS);
    expect(res.status).toBe(200);
  });
});

describe("POST /search/multi — rate limit", () => {
  it("429 when rate-limited; sources NOT called", async () => {
    usageMocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 120_000 });
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/2 minutes/);
    expect(libraryMocks.searchLibrary).not.toHaveBeenCalled();
    expect(queueMocks.enqueueSearchJob).not.toHaveBeenCalled();
  });
});

describe("POST /search/multi — library results", () => {
  it("returns library rows from searchLibrary in the response", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; counts: { fromLibrary: number } };
    expect(body.results).toHaveLength(1);
    expect(body.counts.fromLibrary).toBe(1);
  });
});

describe("POST /search/multi — live scraper discovery (LinkedIn)", () => {
  it("enqueues a priority=100 linkedin scraper job + returns it in liveJobs", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(
      makeReq({ query: "react", sources: ["library", "linkedin"] }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(queueMocks.enqueueSearchJob).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueueSearchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-A",
        platform: "linkedin",
        searchQuery: "react",
        priority: 100,
      }),
    );
    const body = (await res.json()) as {
      liveJobs: Array<{ id: string; platform: string }>;
    };
    expect(body.liveJobs).toEqual([{ id: "scrape-1", platform: "linkedin" }]);
  });

  it("linkedin only: library not called, scraper job enqueued", async () => {
    const res = await POST(makeReq({ query: "react", sources: ["linkedin"] }), PARAMS);
    expect(res.status).toBe(200);
    expect(libraryMocks.searchLibrary).not.toHaveBeenCalled();
    expect(queueMocks.enqueueSearchJob).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as {
      liveJobs: Array<{ platform: string }>;
    };
    expect(body.liveJobs).toEqual([{ id: "scrape-1", platform: "linkedin" }]);
  });

  it("default sources = [library, linkedin] when omitted from body", async () => {
    await POST(makeReq({ query: "react" }), PARAMS);
    expect(libraryMocks.searchLibrary).toHaveBeenCalled();
    expect(queueMocks.enqueueSearchJob).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "linkedin", priority: 100 }),
    );
  });
});

describe("POST /search/multi — live scraper discovery (SEEK)", () => {
  it("seek requested + enabled: enqueues a seek job + seek entry in liveJobs", async () => {
    const res = await POST(
      makeReq({ query: "react", sources: ["library", "linkedin", "seek"] }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(queueMocks.enqueueSearchJob).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "linkedin", priority: 100 }),
    );
    expect(queueMocks.enqueueSearchJob).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "seek", priority: 100 }),
    );
    const body = (await res.json()) as {
      liveJobs: Array<{ id: string; platform: string }>;
    };
    expect(body.liveJobs).toContainEqual(
      expect.objectContaining({ platform: "linkedin" }),
    );
    expect(body.liveJobs).toContainEqual(
      expect.objectContaining({ platform: "seek" }),
    );
  });
});

describe("POST /search/multi — discovery disabled", () => {
  it("linkedin requested + discovery disabled → errors.linkedin set, no enqueue", async () => {
    flagMocks.isScraperDiscoveryEnabled.mockReturnValue(false);
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(
      makeReq({ query: "react", sources: ["library", "linkedin"] }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors?: { linkedin?: string };
      results: unknown[];
      liveJobs: unknown[];
    };
    expect(body.errors?.linkedin).toMatch(/offline/i);
    expect(queueMocks.enqueueSearchJob).not.toHaveBeenCalled();
    expect(body.liveJobs).toHaveLength(0);
    // Library still returned its result.
    expect(body.results).toHaveLength(1);
  });
});

describe("POST /search/multi — library-only search", () => {
  it("library only: no enqueue, no liveJobs", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    expect(res.status).toBe(200);
    expect(libraryMocks.searchLibrary).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueueSearchJob).not.toHaveBeenCalled();
    const body = (await res.json()) as { liveJobs: unknown[] };
    expect(body.liveJobs).toHaveLength(0);
  });
});

describe("POST /search/multi — counts", () => {
  it("response counts include fromLibrary and fromScraper", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    const body = (await res.json()) as {
      counts: { fromLibrary: number; fromScraper: number };
    };
    expect(body.counts).toHaveProperty("fromLibrary", 1);
    expect(body.counts).toHaveProperty("fromScraper", 0);
  });
});

describe("POST /search/multi — partial failure tolerance", () => {
  it("library throws → 200 with errors.library + still enqueues scraper job", async () => {
    libraryMocks.searchLibrary.mockRejectedValueOnce(new Error("DB down"));
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors?: { library?: string };
      counts: { total: number };
    };
    expect(body.errors?.library).toBe("DB down");
    // LinkedIn discovery still fires because the library shortfall is full.
    expect(queueMocks.enqueueSearchJob).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "linkedin", priority: 100 }),
    );
  });

  it("no errors → response omits the errors field", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    const body = (await res.json()) as { errors?: unknown };
    expect(body.errors).toBeUndefined();
  });
});

describe("POST /search/multi — query parsing + aggregation", () => {
  it("parsed query echoes back in response", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([]);
    const res = await POST(
      makeReq({ query: `"CTO" OR "VP Eng" -"junior"`, sources: ["library"] }),
      PARAMS,
    );
    const body = (await res.json()) as { query: { anyOf: unknown; mustNot: string[] } };
    expect(body.query.anyOf).toEqual([["cto", "vp eng"]]);
    expect(body.query.mustNot).toEqual(["junior"]);
  });
});

describe("POST /search/multi — limit propagation", () => {
  it("default library limit 100", async () => {
    await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    const libCall = libraryMocks.searchLibrary.mock.calls[0][0] as { limit: number };
    expect(libCall.limit).toBe(100);
  });

  it("override library limit respected", async () => {
    await POST(makeReq({ query: "react", sources: ["library"], libraryLimit: 25 }), PARAMS);
    const libCall = libraryMocks.searchLibrary.mock.calls[0][0] as { limit: number };
    expect(libCall.limit).toBe(25);
  });
});

describe("POST /search/multi — recordUsage", () => {
  it("fires recordUsage with counts after successful search", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    await POST(makeReq({ query: "react", sources: ["library", "linkedin"] }), PARAMS);
    expect(usageMocks.recordUsage).toHaveBeenCalledWith(
      "org-A",
      "u1",
      "search",
      expect.objectContaining({
        route: "search/multi",
        jobId: "job-1",
        libraryCount: 1,
        hasErrors: false,
      }),
    );
  });

  it("recordUsage hasErrors=true when the library source failed", async () => {
    libraryMocks.searchLibrary.mockRejectedValueOnce(new Error("DB down"));
    await POST(makeReq({ query: "react" }), PARAMS);
    const call = usageMocks.recordUsage.mock.calls[0];
    expect(call[3]).toMatchObject({ hasErrors: true });
  });
});

describe("POST /search/multi — passes accessibleOrgIds through", () => {
  it("owner (null orgIds) → library called with null", async () => {
    orgAccessMocks.getAccessibleOrgIds.mockResolvedValueOnce(null);
    await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    const call = libraryMocks.searchLibrary.mock.calls[0][0] as { accessibleOrgIds: string[] | null };
    expect(call.accessibleOrgIds).toBeNull();
  });

  it("user-org → library called with that org's accessible list", async () => {
    orgAccessMocks.getAccessibleOrgIds.mockResolvedValueOnce(["org-A", "org-B"]);
    await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    const call = libraryMocks.searchLibrary.mock.calls[0][0] as { accessibleOrgIds: string[] };
    expect(call.accessibleOrgIds).toEqual(["org-A", "org-B"]);
  });
});
