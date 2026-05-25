/**
 * Integration tests for POST /api/jobs/[id]/search/multi.
 *
 * Mocks all sources + auth + rate limit. Tests the orchestration:
 *   • Auth chain (unauthenticated / forbidden)
 *   • Body validation (missing query / bad sources)
 *   • Source selection (library only / linkedin only / both)
 *   • SerpAPI key resolution (env vs Setting vs missing)
 *   • Partial failure tolerance (one source throws → other still returns)
 *   • Rate limit
 *   • Aggregation + counts pass-through
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

const settingsMocks = vi.hoisted(() => ({
  getServerSetting: vi.fn(),
}));

const libraryMocks = vi.hoisted(() => ({
  searchLibrary: vi.fn(),
}));

const linkedinMocks = vi.hoisted(() => ({
  searchLinkedIn: vi.fn(),
}));

vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/org-access", () => orgAccessMocks);
vi.mock("@/lib/usage", () => usageMocks);
vi.mock("@/lib/settings", () => settingsMocks);
vi.mock("@/lib/talent-search/library", () => libraryMocks);
vi.mock("@/lib/talent-search/linkedin", () => linkedinMocks);
vi.mock("@/lib/error-reporting", () => ({
  reportError: vi.fn(),
}));

import { POST } from "@/app/api/jobs/[id]/search/multi/route";

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults — each test overrides what it cares about.
  sessionMocks.getAuth.mockResolvedValue({ userId: "u1", orgId: "org-A", isOwner: false });
  sessionMocks.requireJobAccess.mockResolvedValue({ job: { id: "job-1" }, error: null });
  orgAccessMocks.getAccessibleOrgIds.mockResolvedValue(["org-A"]);
  usageMocks.checkRateLimit.mockResolvedValue({ allowed: true });
  usageMocks.recordUsage.mockResolvedValue(undefined);
  settingsMocks.getServerSetting.mockResolvedValue(null);
  libraryMocks.searchLibrary.mockResolvedValue([]);
  linkedinMocks.searchLinkedIn.mockResolvedValue([]);
  delete process.env.SERPAPI_API_KEY;
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

function li(over: Record<string, unknown> = {}) {
  return {
    linkedinUrl: "https://www.linkedin.com/in/linkedin-person",
    name: "LinkedIn Person",
    headline: "Tech Lead",
    location: "Auckland",
    snippet: "From SerpAPI",
    page: 1,
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
    expect(linkedinMocks.searchLinkedIn).not.toHaveBeenCalled();
  });
});

describe("POST /search/multi — source selection", () => {
  it("library only: linkedin not called", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    expect(res.status).toBe(200);
    expect(libraryMocks.searchLibrary).toHaveBeenCalledTimes(1);
    expect(linkedinMocks.searchLinkedIn).not.toHaveBeenCalled();
  });

  it("linkedin only: library not called", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([li()]);
    const res = await POST(makeReq({ query: "react", sources: ["linkedin"] }), PARAMS);
    expect(res.status).toBe(200);
    expect(libraryMocks.searchLibrary).not.toHaveBeenCalled();
    expect(linkedinMocks.searchLinkedIn).toHaveBeenCalledTimes(1);
  });

  it("both sources: both called in parallel", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([li()]);
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(200);
    expect(libraryMocks.searchLibrary).toHaveBeenCalledTimes(1);
    expect(linkedinMocks.searchLinkedIn).toHaveBeenCalledTimes(1);
  });

  it("default sources = [library, linkedin] when omitted from body", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    await POST(makeReq({ query: "react" }), PARAMS);
    expect(libraryMocks.searchLibrary).toHaveBeenCalled();
    expect(linkedinMocks.searchLinkedIn).toHaveBeenCalled();
  });
});

describe("POST /search/multi — SerpAPI key resolution", () => {
  it("uses env var when SERPAPI_API_KEY is set", async () => {
    process.env.SERPAPI_API_KEY = "env-key";
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([]);
    await POST(makeReq({ query: "react", sources: ["linkedin"] }), PARAMS);
    const call = linkedinMocks.searchLinkedIn.mock.calls[0][0] as { serpApiKey: string };
    expect(call.serpApiKey).toBe("env-key");
    expect(settingsMocks.getServerSetting).not.toHaveBeenCalled();
  });

  it("falls through to Setting when no env var", async () => {
    settingsMocks.getServerSetting.mockResolvedValueOnce("setting-key");
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([]);
    await POST(makeReq({ query: "react", sources: ["linkedin"] }), PARAMS);
    expect(settingsMocks.getServerSetting).toHaveBeenCalledWith("SERPAPI_API_KEY");
    const call = linkedinMocks.searchLinkedIn.mock.calls[0][0] as { serpApiKey: string };
    expect(call.serpApiKey).toBe("setting-key");
  });

  it("does NOT load Setting when linkedin source is not requested", async () => {
    await POST(makeReq({ query: "react", sources: ["library"] }), PARAMS);
    expect(settingsMocks.getServerSetting).not.toHaveBeenCalled();
  });

  it("returns 200 with error.linkedin when key is missing AND linkedin requested", async () => {
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    const res = await POST(makeReq({ query: "react", sources: ["library", "linkedin"] }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors?: { linkedin?: string }; results: unknown[] };
    expect(body.errors?.linkedin).toMatch(/SerpAPI key not configured/);
    // Library still returned its result
    expect(body.results.length).toBe(1);
    // LinkedIn search function was NOT called (key missing)
    expect(linkedinMocks.searchLinkedIn).not.toHaveBeenCalled();
  });
});

describe("POST /search/multi — partial failure tolerance", () => {
  it("library throws, linkedin succeeds → 200 with errors.library + linkedin results", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockRejectedValueOnce(new Error("DB down"));
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([li()]);
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors?: { library?: string }; results: unknown[]; counts: { total: number } };
    expect(body.errors?.library).toBe("DB down");
    expect(body.counts.total).toBe(1);
  });

  it("linkedin throws, library succeeds → 200 with errors.linkedin + library results", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    linkedinMocks.searchLinkedIn.mockRejectedValueOnce(new Error("SerpAPI down"));
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors?: { linkedin?: string }; counts: { total: number } };
    expect(body.errors?.linkedin).toBe("SerpAPI down");
    expect(body.counts.total).toBe(1);
  });

  it("both sources throw → 200 with both errors and empty results", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockRejectedValueOnce(new Error("DB down"));
    linkedinMocks.searchLinkedIn.mockRejectedValueOnce(new Error("SerpAPI down"));
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      errors?: { library?: string; linkedin?: string };
      results: unknown[];
      counts: { total: number };
    };
    expect(body.errors?.library).toBe("DB down");
    expect(body.errors?.linkedin).toBe("SerpAPI down");
    expect(body.results).toHaveLength(0);
  });

  it("no errors → response omits the errors field", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([li()]);
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

  it("library row + linkedin row with same URL → deduped to one row, sources=both", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockResolvedValueOnce([
      lib({ linkedinUrl: "https://www.linkedin.com/in/shared" }),
    ]);
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([
      li({ linkedinUrl: "https://linkedin.com/in/shared" }),
    ]);
    const res = await POST(makeReq({ query: "react" }), PARAMS);
    const body = (await res.json()) as {
      results: Array<{ sources: string[] }>;
      counts: { deduped: number; total: number };
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].sources).toEqual(["library", "linkedin"]);
    expect(body.counts.deduped).toBe(1);
    expect(body.counts.total).toBe(1);
  });
});

describe("POST /search/multi — limit propagation", () => {
  it("default limits: library 100, linkedin 30", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    await POST(makeReq({ query: "react" }), PARAMS);
    const libCall = libraryMocks.searchLibrary.mock.calls[0][0] as { limit: number };
    const liCall = linkedinMocks.searchLinkedIn.mock.calls[0][0] as { limit: number };
    expect(libCall.limit).toBe(100);
    expect(liCall.limit).toBe(30);
  });

  it("override limits respected", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    await POST(makeReq({ query: "react", libraryLimit: 25, linkedinLimit: 10 }), PARAMS);
    const libCall = libraryMocks.searchLibrary.mock.calls[0][0] as { limit: number };
    const liCall = linkedinMocks.searchLinkedIn.mock.calls[0][0] as { limit: number };
    expect(libCall.limit).toBe(25);
    expect(liCall.limit).toBe(10);
  });
});

describe("POST /search/multi — recordUsage", () => {
  it("fires recordUsage with counts after successful search", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    linkedinMocks.searchLinkedIn.mockResolvedValueOnce([li()]);
    await POST(makeReq({ query: "react", sources: ["library", "linkedin"] }), PARAMS);
    expect(usageMocks.recordUsage).toHaveBeenCalledWith(
      "org-A",
      "u1",
      "search",
      expect.objectContaining({
        route: "search/multi",
        jobId: "job-1",
        libraryCount: 1,
        linkedinCount: 1,
        hasErrors: false,
      }),
    );
  });

  it("recordUsage hasErrors=true when a source failed", async () => {
    process.env.SERPAPI_API_KEY = "test-key";
    libraryMocks.searchLibrary.mockResolvedValueOnce([lib()]);
    linkedinMocks.searchLinkedIn.mockRejectedValueOnce(new Error("SerpAPI down"));
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
