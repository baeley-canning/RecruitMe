import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { SearxngProvider, _internal } from "../searxng";

describe("searxng — query URL builder", () => {
  it("builds a site:linkedin.com/in query with the user query and location", () => {
    const url = _internal.buildSearxngUrl("http://localhost:8080", { query: "Senior .NET Developer", location: "Wellington" });
    const u = new URL(url);
    expect(u.host).toBe("localhost:8080");
    expect(u.pathname).toBe("/search");
    expect(u.searchParams.get("q")).toContain("site:linkedin.com/in");
    expect(u.searchParams.get("q")).toContain("Senior .NET Developer");
    expect(u.searchParams.get("q")).toContain("Wellington");
    expect(u.searchParams.get("format")).toBe("json");
  });

  it("appends contractor-exclusion clauses when excludeContractTitles is true", () => {
    const url = _internal.buildSearxngUrl("http://localhost:8080", {
      query: "Project Manager",
      excludeContractTitles: true,
    });
    expect(new URL(url).searchParams.get("q")).toContain("-intitle:\"contract\"");
    expect(new URL(url).searchParams.get("q")).toContain("-intitle:\"freelancer\"");
  });
});

describe("searxng — response parser", () => {
  it("maps SearXNG result objects to ProviderSearchHit", () => {
    const body = {
      results: [
        { title: "Jane Smith - Senior Engineer at Xero", url: "https://linkedin.com/in/jane-smith", content: "Wellington, NZ" },
        { title: "John Doe", url: "https://linkedin.com/in/john-doe", snippet: "Mid-level Dev" },
      ],
    };
    const hits = _internal.parseSearxngResponse(body);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      title: "Jane Smith - Senior Engineer at Xero",
      url: "https://linkedin.com/in/jane-smith",
      snippet: "Wellington, NZ",
      provider: "searxng",
      rank: 0,
    });
    // Tolerates `snippet` field in place of `content`.
    expect(hits[1].snippet).toBe("Mid-level Dev");
  });

  it("returns empty array on missing results field", () => {
    expect(_internal.parseSearxngResponse({})).toEqual([]);
    expect(_internal.parseSearxngResponse({ results: null })).toEqual([]);
    expect(_internal.parseSearxngResponse({ results: "not array" })).toEqual([]);
  });

  it("skips entries with no URL", () => {
    const body = { results: [{ title: "No URL", content: "..." }] };
    expect(_internal.parseSearxngResponse(body)).toEqual([]);
  });

  it("returns empty array on null / undefined / non-object body", () => {
    expect(_internal.parseSearxngResponse(null)).toEqual([]);
    expect(_internal.parseSearxngResponse(undefined)).toEqual([]);
    expect(_internal.parseSearxngResponse("not json")).toEqual([]);
    expect(_internal.parseSearxngResponse(42)).toEqual([]);
  });
});

describe("SearxngProvider — search() with mocked fetch", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns parsed hits on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [{ title: "T", url: "https://linkedin.com/in/a", content: "S" }] }), { status: 200 }),
    );
    const provider = new SearxngProvider("http://localhost:8080");
    const hits = await provider.search({ query: "Software Engineer" });
    expect(hits).toHaveLength(1);
    expect(hits[0].provider).toBe("searxng");
  });

  it("returns empty array on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const provider = new SearxngProvider("http://localhost:8080");
    expect(await provider.search({ query: "x" })).toEqual([]);
  });

  it("returns empty array when the response body is unparseable JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));
    const provider = new SearxngProvider("http://localhost:8080");
    expect(await provider.search({ query: "x" })).toEqual([]);
  });
});

describe("SearxngProvider.fromEnv", () => {
  const prevProviders = process.env.SEARCH_PROVIDERS;
  const prevBase      = process.env.SEARXNG_BASE_URL;
  afterEach(() => {
    process.env.SEARCH_PROVIDERS = prevProviders;
    process.env.SEARXNG_BASE_URL  = prevBase;
  });
  beforeEach(() => {
    delete process.env.SEARCH_PROVIDERS;
    delete process.env.SEARXNG_BASE_URL;
  });

  it("returns null when SEARCH_PROVIDERS doesn't include searxng", () => {
    process.env.SEARCH_PROVIDERS = "openserp";
    process.env.SEARXNG_BASE_URL  = "http://localhost:8080";
    expect(SearxngProvider.fromEnv()).toBeNull();
  });

  it("returns null when SEARXNG_BASE_URL is unset", () => {
    process.env.SEARCH_PROVIDERS = "searxng";
    expect(SearxngProvider.fromEnv()).toBeNull();
  });

  it("returns a configured provider when both env vars are set", () => {
    process.env.SEARCH_PROVIDERS = "searxng,openserp";
    process.env.SEARXNG_BASE_URL  = "http://localhost:8080";
    const provider = SearxngProvider.fromEnv();
    expect(provider).not.toBeNull();
    expect(provider?.enabled()).toBe(true);
  });
});
