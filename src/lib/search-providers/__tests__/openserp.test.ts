import { describe, expect, it, afterEach, vi } from "vitest";
import { OpenserpProvider, _internal } from "../openserp";

describe("openserp — query URL builder", () => {
  it("builds a /google/search query with text + lang", () => {
    const url = _internal.buildOpenserpUrl("http://localhost:7000", { query: "Senior PM", location: "Wellington" });
    const u = new URL(url);
    expect(u.host).toBe("localhost:7000");
    expect(u.pathname).toBe("/google/search");
    expect(u.searchParams.get("text")).toContain("site:linkedin.com/in");
    expect(u.searchParams.get("text")).toContain("Senior PM");
    expect(u.searchParams.get("text")).toContain("Wellington");
    expect(u.searchParams.get("lang")).toBe("en");
  });

  it("respects maxResults via limit param", () => {
    const url = _internal.buildOpenserpUrl("http://localhost:7000", { query: "Dev", maxResults: 25 });
    expect(new URL(url).searchParams.get("limit")).toBe("25");
  });
});

describe("openserp — response parser", () => {
  it("parses a bare array (canonical OpenSERP shape)", () => {
    const body = [
      { rank: 1, url: "https://linkedin.com/in/a", title: "A", description: "Snip A" },
      { rank: 2, url: "https://linkedin.com/in/b", title: "B", description: "Snip B" },
    ];
    const hits = _internal.parseOpenserpResponse(body);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      url: "https://linkedin.com/in/a",
      title: "A",
      snippet: "Snip A",
      provider: "openserp",
      rank: 0,  // rank: 1 normalized to 0-indexed
    });
    expect(hits[1].rank).toBe(1);
  });

  it("parses a wrapped { results: [...] } shape (some forks)", () => {
    const body = { results: [{ url: "https://linkedin.com/in/x", title: "X", snippet: "S" }] };
    const hits = _internal.parseOpenserpResponse(body);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBe("S");
  });

  it("falls back to `link` when `url` is missing", () => {
    const body = [{ link: "https://linkedin.com/in/legacy", title: "L" }];
    const hits = _internal.parseOpenserpResponse(body);
    expect(hits[0].url).toBe("https://linkedin.com/in/legacy");
  });

  it("falls back to array index when rank is absent", () => {
    const body = [{ url: "https://linkedin.com/in/a", title: "A" }];
    expect(_internal.parseOpenserpResponse(body)[0].rank).toBe(0);
  });

  it("returns empty for null / unrecognized shape", () => {
    expect(_internal.parseOpenserpResponse(null)).toEqual([]);
    expect(_internal.parseOpenserpResponse({})).toEqual([]);
    expect(_internal.parseOpenserpResponse("not json")).toEqual([]);
  });
});

describe("OpenserpProvider — search() with mocked fetch", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns parsed hits on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ url: "https://linkedin.com/in/a", title: "A", description: "S" }]), { status: 200 }),
    );
    const provider = new OpenserpProvider("http://localhost:7000");
    const hits = await provider.search({ query: "Senior Engineer" });
    expect(hits).toHaveLength(1);
    expect(hits[0].provider).toBe("openserp");
  });

  it("returns empty array on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    expect(await new OpenserpProvider("http://localhost:7000").search({ query: "x" })).toEqual([]);
  });

  it("handles network errors gracefully (returns empty after fetch rejects)", async () => {
    // OpenserpProvider doesn't catch — the manager catches. Direct fetch
    // rejection should propagate as a throw, and that's what we test.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(new OpenserpProvider("http://localhost:7000").search({ query: "x" })).rejects.toThrow("ECONNREFUSED");
  });
});
