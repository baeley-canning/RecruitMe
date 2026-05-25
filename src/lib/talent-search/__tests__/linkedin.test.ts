/**
 * Tests for src/lib/talent-search/linkedin.ts — the multi-source search
 * feature's SerpAPI/LinkedIn backend. Mocks searchLinkedInProfiles from
 * @/lib/search so we can assert (a) the Google-style query string we
 * build from ParsedQuery, and (b) the page/dedup/normalisation logic on
 * top of the underlying SerpAPI client.
 *
 * What we pin:
 *  • Empty parsedQuery → returns [] with no SerpAPI call (cost discipline)
 *  • Query string construction (mustHave, anyOf, mustNot, location, site:)
 *  • Pagination — limit=30 ⇒ up to 3 pages, limit=10 ⇒ 1 page
 *  • Dedup across pages
 *  • Stop-early when a page returns less than a full page
 *  • Result normalisation (empty headline / location → null, page 1-indexed)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBooleanQuery } from "../../boolean-query";
import type { SearchResult } from "../../search";

const searchMocks = vi.hoisted(() => ({
  searchLinkedInProfiles: vi.fn(),
  // Re-export the rest so importers of @/lib/search don't trip over
  // missing names if anything in the import chain reaches for them.
  searchPDLProfiles: vi.fn(),
  inferEmploymentType: vi.fn(),
  parseLinkedInResults: vi.fn(),
  inferLocationFromSearchText: vi.fn(),
}));

vi.mock("@/lib/search", () => searchMocks);

import { buildLinkedInQueryString, searchLinkedIn } from "../linkedin";

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    name: "Jane Doe",
    headline: "Tech Lead at Acme",
    location: "Wellington, New Zealand",
    linkedinUrl: "https://www.linkedin.com/in/jane-doe",
    snippet: "Tech Lead at Acme — Wellington, New Zealand",
    source: "serpapi",
    ...overrides,
  };
}

beforeEach(() => {
  searchMocks.searchLinkedInProfiles.mockReset();
  searchMocks.searchLinkedInProfiles.mockResolvedValue([]);
});

// ─── Query string construction ──────────────────────────────────────────────

describe("buildLinkedInQueryString", () => {
  it("single bareword mustHave → '<term> site:linkedin.com/in/'", () => {
    const q = buildLinkedInQueryString(parseBooleanQuery("developer"));
    expect(q).toBe("developer site:linkedin.com/in/");
  });

  it("quoted multi-word phrase → wrapped in quotes", () => {
    const q = buildLinkedInQueryString(parseBooleanQuery(`"tech lead"`));
    expect(q).toBe(`"tech lead" site:linkedin.com/in/`);
  });

  it("OR group of single-word terms wraps as (A OR B), no quotes", () => {
    const q = buildLinkedInQueryString(
      parseBooleanQuery(`"CTO" OR "VPEngineering"`),
    );
    expect(q).toBe(`(cto OR vpengineering) site:linkedin.com/in/`);
  });

  it("OR group with multi-word phrase quotes the phrase", () => {
    const q = buildLinkedInQueryString(
      parseBooleanQuery(`"CTO" OR "VP Engineering"`),
    );
    expect(q).toBe(`(cto OR "vp engineering") site:linkedin.com/in/`);
  });

  it("NOT term prepends -\"term\" (always quoted)", () => {
    const q = buildLinkedInQueryString(
      parseBooleanQuery(`"engineer" NOT "intern"`),
    );
    expect(q).toBe(`engineer -"intern" site:linkedin.com/in/`);
  });

  it("location adds +\"location\" before the site: scope", () => {
    const q = buildLinkedInQueryString(
      parseBooleanQuery(`"engineer"`),
      "Wellington",
    );
    expect(q).toBe(`engineer +"Wellington" site:linkedin.com/in/`);
  });

  it("combined boolean preserves order: mustHave, anyOf, mustNot, location, site:", () => {
    const q = buildLinkedInQueryString(
      parseBooleanQuery(`("CTO" OR "VP Eng") AND "saas" -"junior"`),
      "Wellington",
    );
    expect(q).toBe(
      `saas (cto OR "vp eng") -"junior" +"Wellington" site:linkedin.com/in/`,
    );
  });
});

// ─── Empty-query short-circuit ──────────────────────────────────────────────

describe("searchLinkedIn — empty parsedQuery", () => {
  it("returns [] without calling SerpAPI", async () => {
    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery(""),
      serpApiKey: "test-key",
    });
    expect(out).toEqual([]);
    expect(searchMocks.searchLinkedInProfiles).not.toHaveBeenCalled();
  });
});

// ─── SerpAPI call args ──────────────────────────────────────────────────────

describe("searchLinkedIn — SerpAPI call args", () => {
  it("passes the built query string + empty location + caller key to searchLinkedInProfiles", async () => {
    searchMocks.searchLinkedInProfiles.mockResolvedValue([]);
    await searchLinkedIn({
      parsedQuery: parseBooleanQuery("tech lead"),
      location: "Wellington",
      serpApiKey: "my-serpapi-key",
    });
    expect(searchMocks.searchLinkedInProfiles).toHaveBeenCalledWith(
      `tech lead +"Wellington" site:linkedin.com/in/`,
      "",
      0,
      "my-serpapi-key",
    );
  });
});

// ─── Pagination ─────────────────────────────────────────────────────────────

describe("searchLinkedIn — pagination", () => {
  it("limit=10 → fetches exactly 1 page (offset 0)", async () => {
    // Return a full page so the loop doesn't bail early.
    searchMocks.searchLinkedInProfiles.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        makeSearchResult({
          linkedinUrl: `https://www.linkedin.com/in/person-${i}`,
        }),
      ),
    );

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("developer"),
      limit: 10,
      serpApiKey: "k",
    });

    expect(out).toHaveLength(10);
    expect(searchMocks.searchLinkedInProfiles).toHaveBeenCalledTimes(1);
    expect(searchMocks.searchLinkedInProfiles.mock.calls[0][2]).toBe(0);
  });

  it("limit=30 → fetches up to 3 pages with offsets 0, 10, 20", async () => {
    let call = 0;
    searchMocks.searchLinkedInProfiles.mockImplementation(async () => {
      const base = call * 10;
      call++;
      return Array.from({ length: 10 }, (_, i) =>
        makeSearchResult({
          linkedinUrl: `https://www.linkedin.com/in/person-${base + i}`,
        }),
      );
    });

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("developer"),
      limit: 30,
      serpApiKey: "k",
    });

    expect(out).toHaveLength(30);
    expect(searchMocks.searchLinkedInProfiles).toHaveBeenCalledTimes(3);
    expect(searchMocks.searchLinkedInProfiles.mock.calls.map((c) => c[2])).toEqual([0, 10, 20]);
  });

  it("limit>30 still capped at 3 pages (cost discipline)", async () => {
    let call = 0;
    searchMocks.searchLinkedInProfiles.mockImplementation(async () => {
      const base = call * 10;
      call++;
      return Array.from({ length: 10 }, (_, i) =>
        makeSearchResult({
          linkedinUrl: `https://www.linkedin.com/in/p-${base + i}`,
        }),
      );
    });

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("developer"),
      limit: 100,
      serpApiKey: "k",
    });

    expect(searchMocks.searchLinkedInProfiles).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(30);
  });

  it("short page stops pagination early (no wasted next-page call)", async () => {
    searchMocks.searchLinkedInProfiles
      .mockResolvedValueOnce(
        Array.from({ length: 4 }, (_, i) =>
          makeSearchResult({
            linkedinUrl: `https://www.linkedin.com/in/p-${i}`,
          }),
        ),
      );

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("rare niche term"),
      limit: 30,
      serpApiKey: "k",
    });

    expect(out).toHaveLength(4);
    expect(searchMocks.searchLinkedInProfiles).toHaveBeenCalledTimes(1);
  });
});

// ─── Dedup ──────────────────────────────────────────────────────────────────

describe("searchLinkedIn — dedup", () => {
  it("dedupes URLs that appear on adjacent pages", async () => {
    // Page 1 returns 10 unique. Page 2 returns 5 dupes + 5 new.
    searchMocks.searchLinkedInProfiles
      .mockResolvedValueOnce(
        Array.from({ length: 10 }, (_, i) =>
          makeSearchResult({
            linkedinUrl: `https://www.linkedin.com/in/p-${i}`,
          }),
        ),
      )
      .mockResolvedValueOnce([
        // 5 dupes
        ...Array.from({ length: 5 }, (_, i) =>
          makeSearchResult({
            linkedinUrl: `https://www.linkedin.com/in/p-${i}`,
          }),
        ),
        // 5 new
        ...Array.from({ length: 5 }, (_, i) =>
          makeSearchResult({
            linkedinUrl: `https://www.linkedin.com/in/p-${10 + i}`,
          }),
        ),
      ]);

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("developer"),
      limit: 30,
      serpApiKey: "k",
    });

    expect(out).toHaveLength(15);
    const urls = out.map((r) => r.linkedinUrl);
    expect(new Set(urls).size).toBe(15);
  });
});

// ─── Normalisation ──────────────────────────────────────────────────────────

describe("searchLinkedIn — result normalisation", () => {
  it("page number is 1-indexed", async () => {
    searchMocks.searchLinkedInProfiles
      .mockResolvedValueOnce([
        makeSearchResult({
          linkedinUrl: "https://www.linkedin.com/in/a",
        }),
        ...Array.from({ length: 9 }, (_, i) =>
          makeSearchResult({
            linkedinUrl: `https://www.linkedin.com/in/p1-${i}`,
          }),
        ),
      ])
      .mockResolvedValueOnce([
        makeSearchResult({
          linkedinUrl: "https://www.linkedin.com/in/b",
        }),
      ]);

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("developer"),
      limit: 30,
      serpApiKey: "k",
    });

    const first = out.find((r) => r.linkedinUrl === "https://www.linkedin.com/in/a");
    const second = out.find((r) => r.linkedinUrl === "https://www.linkedin.com/in/b");
    expect(first?.page).toBe(1);
    expect(second?.page).toBe(2);
  });

  it("empty headline / location coerced to null; populated fields preserved", async () => {
    searchMocks.searchLinkedInProfiles.mockResolvedValueOnce([
      makeSearchResult({
        name: "Alice",
        headline: "",
        location: "",
        snippet: "no headline here",
        linkedinUrl: "https://www.linkedin.com/in/alice",
      }),
      makeSearchResult({
        name: "Bob",
        headline: "Senior Engineer",
        location: "Auckland",
        snippet: "snippet text",
        linkedinUrl: "https://www.linkedin.com/in/bob",
      }),
    ]);

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("developer"),
      limit: 10,
      serpApiKey: "k",
    });

    expect(out[0]).toEqual({
      linkedinUrl: "https://www.linkedin.com/in/alice",
      name: "Alice",
      headline: null,
      location: null,
      snippet: "no headline here",
      page: 1,
    });
    expect(out[1]).toEqual({
      linkedinUrl: "https://www.linkedin.com/in/bob",
      name: "Bob",
      headline: "Senior Engineer",
      location: "Auckland",
      snippet: "snippet text",
      page: 1,
    });
  });

  it("URL filtering / normalisation is delegated to searchLinkedInProfiles — non-LinkedIn results never reach us", async () => {
    // searchLinkedInProfiles → parseLinkedInResults already drops non-
    // linkedin.com/in/ links + normalises URLs. We just verify we trust
    // whatever URLs come back — our dedup uses them as-is.
    searchMocks.searchLinkedInProfiles.mockResolvedValueOnce([
      makeSearchResult({
        linkedinUrl: "https://www.linkedin.com/in/already-normalised",
      }),
    ]);

    const out = await searchLinkedIn({
      parsedQuery: parseBooleanQuery("developer"),
      limit: 10,
      serpApiKey: "k",
    });

    expect(out).toHaveLength(1);
    expect(out[0].linkedinUrl).toBe(
      "https://www.linkedin.com/in/already-normalised",
    );
  });
});
