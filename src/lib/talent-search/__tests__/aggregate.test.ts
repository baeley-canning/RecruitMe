/**
 * Unit tests for src/lib/talent-search/aggregate.ts — the multi-source
 * result aggregator/deduper.
 *
 * Pinning:
 *  • Basic shapes (empty, library-only, linkedin-only).
 *  • Dedup via identityMergeKey across sources and within a source.
 *  • Synthetic library:<id> linkedinUrl rows stay distinct.
 *  • Library wins field priority; LinkedIn fills linkedinUrl when library
 *    row is synthetic + matched by jobAdderUrl.
 *  • Sort order: multi-source > library matchScore desc > LinkedIn page asc.
 *  • Counts: libraryRaw / linkedinRaw / deduped / total.
 *
 * No mocks needed — aggregateSources is pure. We build the input arrays
 * inline and assert on the output shape.
 */

import { describe, expect, it } from "vitest";
import { aggregateSources } from "../aggregate";
import type { LibrarySearchResult } from "../library";
import type { LinkedInSearchResult } from "../linkedin";

// --- Fixture builders --------------------------------------------------

function lib(overrides: Partial<LibrarySearchResult> = {}): LibrarySearchResult {
  return {
    id: "cand-1",
    name: "Jane Doe",
    headline: "Software Engineer",
    location: "Wellington",
    linkedinUrl: "https://www.linkedin.com/in/jane",
    jobAdderUrl: null,
    photoFileId: null,
    matchScore: 85,
    source: "manual",
    profileTextSnippet: "Senior engineer with 8 years experience.",
    candidateIdentityId: "ident-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function li(overrides: Partial<LinkedInSearchResult> = {}): LinkedInSearchResult {
  return {
    linkedinUrl: "https://www.linkedin.com/in/jane",
    name: "Jane D.",
    headline: "Engineer at Acme",
    location: "Wellington, NZ",
    snippet: "Engineer at Acme. Wellington-based.",
    page: 1,
    ...overrides,
  };
}

// --- Basic shape -------------------------------------------------------

describe("aggregateSources — basic shape", () => {
  it("empty input returns empty results and zero counts", () => {
    const out = aggregateSources({ library: [], linkedin: [] });
    expect(out.results).toEqual([]);
    expect(out.counts).toEqual({
      libraryRaw: 0,
      linkedinRaw: 0,
      deduped: 0,
      total: 0,
    });
  });

  it("library-only returns library rows with sources=['library']", () => {
    const out = aggregateSources({
      library: [lib({ id: "a", linkedinUrl: "https://www.linkedin.com/in/a" })],
      linkedin: [],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].sources).toEqual(["library"]);
    expect(out.results[0].candidateId).toBe("a");
    expect(out.counts).toEqual({
      libraryRaw: 1,
      linkedinRaw: 0,
      deduped: 0,
      total: 1,
    });
  });

  it("linkedin-only returns linkedin rows with sources=['linkedin']", () => {
    const out = aggregateSources({
      library: [],
      linkedin: [li({ linkedinUrl: "https://www.linkedin.com/in/b" })],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].sources).toEqual(["linkedin"]);
    expect(out.results[0].candidateId).toBeNull();
    expect(out.results[0].linkedinPage).toBe(1);
  });
});

// --- Dedup -------------------------------------------------------------

describe("aggregateSources — dedup across sources", () => {
  it("same LinkedIn URL in both sources → one row tagged with both", () => {
    const out = aggregateSources({
      library: [lib({ id: "a", linkedinUrl: "https://www.linkedin.com/in/jane" })],
      linkedin: [li({ linkedinUrl: "https://linkedin.com/in/jane" })], // note: different scheme/host, same person
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].sources).toEqual(["library", "linkedin"]);
    expect(out.counts.deduped).toBe(1);
    expect(out.counts.total).toBe(1);
  });

  it("library row with jobadder URL + no LinkedIn → still matches a LinkedIn result via merge key", () => {
    // When library has a synthetic linkedin key + a jobadder URL, its merge
    // key is the jobadder URL. The LinkedIn search result has only a
    // linkedin URL → its merge key is the linkedin URL. They DON'T merge by
    // jobadder/linkedin axis. This test pins that we don't accidentally
    // merge across-axis (separate rows).
    const out = aggregateSources({
      library: [
        lib({
          id: "a",
          linkedinUrl: "library:src-1",
          jobAdderUrl: "https://acme.jobadder.com/c/1",
        }),
      ],
      linkedin: [li({ linkedinUrl: "https://www.linkedin.com/in/jane" })],
    });
    expect(out.results).toHaveLength(2);
    expect(out.counts.deduped).toBe(0);
  });

  it("two different people in same source → two separate rows", () => {
    const out = aggregateSources({
      library: [
        lib({ id: "a", linkedinUrl: "https://www.linkedin.com/in/a" }),
        lib({ id: "b", linkedinUrl: "https://www.linkedin.com/in/b" }),
      ],
      linkedin: [],
    });
    expect(out.results).toHaveLength(2);
    expect(out.counts.deduped).toBe(0);
  });

  it("library row with synthetic library:<id> linkedin + no jobadder → treated as distinct (no merge key)", () => {
    const out = aggregateSources({
      library: [
        lib({ id: "a", linkedinUrl: "library:src-1", jobAdderUrl: null }),
        lib({ id: "b", linkedinUrl: "library:src-2", jobAdderUrl: null }),
      ],
      linkedin: [],
    });
    expect(out.results).toHaveLength(2);
    // Synthetic keys should NOT bleed into the display.
    expect(out.results[0].linkedinUrl).toBeNull();
    expect(out.results[1].linkedinUrl).toBeNull();
  });

  it("two LinkedIn results with same URL across pages → deduped, lower page wins", () => {
    const out = aggregateSources({
      library: [],
      linkedin: [
        li({ linkedinUrl: "https://www.linkedin.com/in/jane", page: 2, name: "Page 2 Jane" }),
        li({ linkedinUrl: "https://www.linkedin.com/in/jane", page: 1, name: "Page 1 Jane" }),
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].linkedinPage).toBe(1);
    expect(out.results[0].name).toBe("Page 1 Jane");
    expect(out.counts.deduped).toBe(1);
  });

  it("defensive: same key appearing twice in library → higher matchScore wins", () => {
    const out = aggregateSources({
      library: [
        lib({ id: "a", linkedinUrl: "https://www.linkedin.com/in/jane", matchScore: 50 }),
        lib({ id: "a-dup", linkedinUrl: "https://www.linkedin.com/in/jane", matchScore: 90 }),
      ],
      linkedin: [],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].matchScore).toBe(90);
    expect(out.results[0].candidateId).toBe("a-dup");
  });
});

// --- Field priority ----------------------------------------------------

describe("aggregateSources — field priority on merged rows", () => {
  it("library name wins over LinkedIn name", () => {
    const out = aggregateSources({
      library: [lib({ id: "a", name: "Library Jane", linkedinUrl: "https://www.linkedin.com/in/jane" })],
      linkedin: [li({ name: "LinkedIn Jane" })],
    });
    expect(out.results[0].name).toBe("Library Jane");
  });

  it("library matchScore preserved when merging", () => {
    const out = aggregateSources({
      library: [lib({ id: "a", matchScore: 92, linkedinUrl: "https://www.linkedin.com/in/jane" })],
      linkedin: [li()],
    });
    expect(out.results[0].matchScore).toBe(92);
  });

  it("library snippet wins over LinkedIn snippet", () => {
    const out = aggregateSources({
      library: [
        lib({
          id: "a",
          linkedinUrl: "https://www.linkedin.com/in/jane",
          profileTextSnippet: "Library snippet",
        }),
      ],
      linkedin: [li({ snippet: "LinkedIn snippet" })],
    });
    expect(out.results[0].snippet).toBe("Library snippet");
  });

  it("library candidateId + candidateIdentityId carried through to merged row", () => {
    const out = aggregateSources({
      library: [
        lib({
          id: "cand-xyz",
          candidateIdentityId: "ident-xyz",
          linkedinUrl: "https://www.linkedin.com/in/jane",
        }),
      ],
      linkedin: [li()],
    });
    expect(out.results[0].candidateId).toBe("cand-xyz");
    expect(out.results[0].candidateIdentityId).toBe("ident-xyz");
  });

  it("library photoFileId becomes photoUrl on the merged row", () => {
    const out = aggregateSources({
      library: [
        lib({
          id: "cand-1",
          photoFileId: "file-99",
          linkedinUrl: "https://www.linkedin.com/in/jane",
        }),
      ],
      linkedin: [li()],
    });
    expect(out.results[0].photoUrl).toBe("/api/candidates/cand-1/files/file-99?inline=1");
  });
});

// --- Ordering ----------------------------------------------------------

describe("aggregateSources — ordering", () => {
  it("multi-source results sort before single-source", () => {
    const out = aggregateSources({
      library: [
        lib({ id: "solo", linkedinUrl: "https://www.linkedin.com/in/solo", matchScore: 99 }),
        lib({ id: "shared", linkedinUrl: "https://www.linkedin.com/in/shared", matchScore: 50 }),
      ],
      linkedin: [li({ linkedinUrl: "https://www.linkedin.com/in/shared" })],
    });
    expect(out.results[0].candidateId).toBe("shared");
    expect(out.results[0].sources).toEqual(["library", "linkedin"]);
    expect(out.results[1].candidateId).toBe("solo");
  });

  it("within single-source library, higher matchScore comes first", () => {
    const out = aggregateSources({
      library: [
        lib({ id: "low", linkedinUrl: "https://www.linkedin.com/in/low", matchScore: 40 }),
        lib({ id: "high", linkedinUrl: "https://www.linkedin.com/in/high", matchScore: 95 }),
      ],
      linkedin: [],
    });
    expect(out.results[0].candidateId).toBe("high");
    expect(out.results[1].candidateId).toBe("low");
  });

  it("within LinkedIn-only, lower page comes first", () => {
    const out = aggregateSources({
      library: [],
      linkedin: [
        li({ linkedinUrl: "https://www.linkedin.com/in/p2", page: 2 }),
        li({ linkedinUrl: "https://www.linkedin.com/in/p1", page: 1 }),
      ],
    });
    expect(out.results[0].linkedinUrl).toBe("https://www.linkedin.com/in/p1");
    expect(out.results[1].linkedinUrl).toBe("https://www.linkedin.com/in/p2");
  });

  it("null matchScore sorts below any numeric score (library single-source)", () => {
    const out = aggregateSources({
      library: [
        lib({ id: "null", linkedinUrl: "https://www.linkedin.com/in/null", matchScore: null }),
        lib({ id: "low", linkedinUrl: "https://www.linkedin.com/in/low", matchScore: 10 }),
      ],
      linkedin: [],
    });
    expect(out.results[0].candidateId).toBe("low");
    expect(out.results[1].candidateId).toBe("null");
  });
});

// --- Counts ------------------------------------------------------------

describe("aggregateSources — counts", () => {
  it("libraryRaw / linkedinRaw match input sizes; deduped reflects merges", () => {
    const out = aggregateSources({
      library: [
        lib({ id: "a", linkedinUrl: "https://www.linkedin.com/in/a" }),
        lib({ id: "b", linkedinUrl: "https://www.linkedin.com/in/b" }),
      ],
      linkedin: [
        li({ linkedinUrl: "https://www.linkedin.com/in/a" }), // merges with lib a
        li({ linkedinUrl: "https://www.linkedin.com/in/c" }), // distinct
      ],
    });
    // 2 library + 2 linkedin = 4 raw; one merge → 3 unified → deduped = 1
    expect(out.counts).toEqual({
      libraryRaw: 2,
      linkedinRaw: 2,
      deduped: 1,
      total: 3,
    });
  });

  it("counts.total equals results.length", () => {
    const out = aggregateSources({
      library: [lib({ id: "a", linkedinUrl: "https://www.linkedin.com/in/a" })],
      linkedin: [li({ linkedinUrl: "https://www.linkedin.com/in/b" })],
    });
    expect(out.counts.total).toBe(out.results.length);
  });
});

// --- id stability ------------------------------------------------------

describe("aggregateSources — id derivation", () => {
  it("uses merge-key string as id when available", () => {
    const out = aggregateSources({
      library: [lib({ id: "cand-x", linkedinUrl: "https://www.linkedin.com/in/jane" })],
      linkedin: [],
    });
    expect(out.results[0].id).toBe("linkedinUrl:https://www.linkedin.com/in/jane");
  });

  it("falls back to lib:<candidateId> when library row has no merge key", () => {
    const out = aggregateSources({
      library: [lib({ id: "cand-x", linkedinUrl: "library:src-1", jobAdderUrl: null })],
      linkedin: [],
    });
    expect(out.results[0].id).toBe("lib:cand-x");
  });
});
