/**
 * Integration tests for src/lib/talent-search/library.ts — the multi-source
 * search feature's library backend. Mocks Prisma to assert the WHERE clause
 * shape that gets sent to the DB.
 *
 * What we pin:
 *  • Empty parsedQuery → no term clauses, still returns recent rows
 *  • mustHave terms → AND-joined `contains` predicates
 *  • anyOf groups → OR within group, AND across groups
 *  • mustNot terms → NOT-contains chain
 *  • Owner (accessibleOrgIds=null) → no orgId scope clause
 *  • User org (accessibleOrgIds=[a]) → OR-joined orgId scope
 *  • Empty org list → returns empty (no DB call, or a no-match clause)
 *  • Location filter → contains predicate on Candidate.location
 *  • profileText snippet trimmed at 400 chars + "…" suffix when truncated
 *
 * Pattern mirrors src/lib/__tests__/insight-cache.test.ts — vi.hoisted +
 * vi.mock("@/lib/db") + assert on the mock call args.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBooleanQuery } from "../../boolean-query";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => dbMocks);

import { searchLibrary } from "../library";

beforeEach(() => {
  dbMocks.prisma.candidate.findMany.mockReset();
  dbMocks.prisma.candidate.findMany.mockResolvedValue([]);
});

// Helper: pluck the `where` clause out of the findMany mock call
function whereOf(): Record<string, unknown> {
  expect(dbMocks.prisma.candidate.findMany).toHaveBeenCalledTimes(1);
  const call = dbMocks.prisma.candidate.findMany.mock.calls[0][0] as {
    where: Record<string, unknown>;
  };
  return call.where;
}

describe("searchLibrary — empty query returns recent rows", () => {
  it("no term clauses, still passes the profileText-not-null gate + orgScope", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.profileText).toEqual({ not: null });
    expect(where.OR).toEqual([
      { orgId: { in: ["org-A"] } },
      { job: { orgId: { in: ["org-A"] } } },
    ]);
    expect(where.AND).toBeUndefined();
  });
});

describe("searchLibrary — mustHave terms", () => {
  it("single mustHave → one contains predicate in AND", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("typescript"),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      { profileText: { contains: "typescript", mode: "insensitive" } },
    ]);
  });

  it("two mustHave (implicit AND) → two contains predicates", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("react typescript"),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      { profileText: { contains: "react", mode: "insensitive" } },
      { profileText: { contains: "typescript", mode: "insensitive" } },
    ]);
  });

  it("quoted phrase preserved as single term", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(`"tech lead"`),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      { profileText: { contains: "tech lead", mode: "insensitive" } },
    ]);
  });
});

describe("searchLibrary — anyOf groups", () => {
  it("OR group → single OR clause inside AND", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(`"CTO" OR "VP Engineering"`),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      {
        OR: [
          { profileText: { contains: "cto", mode: "insensitive" } },
          { profileText: { contains: "vp engineering", mode: "insensitive" } },
        ],
      },
    ]);
  });

  it("multiple OR groups combine with AND across, OR within", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(`("A" OR "B") AND ("C" OR "D")`),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      {
        OR: [
          { profileText: { contains: "a", mode: "insensitive" } },
          { profileText: { contains: "b", mode: "insensitive" } },
        ],
      },
      {
        OR: [
          { profileText: { contains: "c", mode: "insensitive" } },
          { profileText: { contains: "d", mode: "insensitive" } },
        ],
      },
    ]);
  });
});

describe("searchLibrary — mustNot terms", () => {
  it("single NOT becomes NOT-contains clause", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(`"engineer" NOT "intern"`),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      { profileText: { contains: "engineer", mode: "insensitive" } },
      { NOT: { profileText: { contains: "intern", mode: "insensitive" } } },
    ]);
  });

  it("-term shorthand also becomes NOT-contains", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(`"manager" -"junior"`),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      { profileText: { contains: "manager", mode: "insensitive" } },
      { NOT: { profileText: { contains: "junior", mode: "insensitive" } } },
    ]);
  });
});

describe("searchLibrary — combined boolean", () => {
  it(`("CTO" OR "VP Eng") AND "saas" -"junior"`, async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(`("CTO" OR "VP Eng") AND "saas" -"junior"`),
      accessibleOrgIds: ["org-A"],
    });
    const where = whereOf();
    expect(where.AND).toEqual([
      // mustHave first
      { profileText: { contains: "saas", mode: "insensitive" } },
      // anyOf next
      {
        OR: [
          { profileText: { contains: "cto", mode: "insensitive" } },
          { profileText: { contains: "vp eng", mode: "insensitive" } },
        ],
      },
      // mustNot last
      { NOT: { profileText: { contains: "junior", mode: "insensitive" } } },
    ]);
  });
});

describe("searchLibrary — org scoping", () => {
  it("owner (null accessibleOrgIds) → no orgId scope clause", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("typescript"),
      accessibleOrgIds: null,
    });
    const where = whereOf();
    expect(where.OR).toBeUndefined();
    expect(where.AND).toEqual([
      { profileText: { contains: "typescript", mode: "insensitive" } },
    ]);
  });

  it("user org → OR-joined orgId scope (own org + via job)", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A", "org-B"],
    });
    const where = whereOf();
    expect(where.OR).toEqual([
      { orgId: { in: ["org-A", "org-B"] } },
      { job: { orgId: { in: ["org-A", "org-B"] } } },
    ]);
  });

  it("empty accessibleOrgIds array → no-match clause (in: []) so caller sees zero rows", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: [],
    });
    const where = whereOf();
    expect(where.AND).toEqual([{ orgId: { in: [] } }]);
  });
});

describe("searchLibrary — location filter", () => {
  it("trimmed non-empty location → contains predicate", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("react"),
      accessibleOrgIds: ["org-A"],
      location: "Wellington",
    });
    const where = whereOf();
    const andArr = where.AND as Array<Record<string, unknown>>;
    expect(andArr).toContainEqual({
      location: { contains: "Wellington", mode: "insensitive" },
    });
  });

  it("empty/whitespace location ignored", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("react"),
      accessibleOrgIds: ["org-A"],
      location: "   ",
    });
    const where = whereOf();
    const andArr = where.AND as Array<Record<string, unknown>>;
    expect(andArr).toEqual([
      { profileText: { contains: "react", mode: "insensitive" } },
    ]);
  });

  it("null location ignored", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("react"),
      accessibleOrgIds: ["org-A"],
      location: null,
    });
    const where = whereOf();
    const andArr = where.AND as Array<Record<string, unknown>>;
    expect(andArr).toEqual([
      { profileText: { contains: "react", mode: "insensitive" } },
    ]);
  });
});

describe("searchLibrary — result shape", () => {
  it("trims profileText to 400-char snippet with ellipsis when over", async () => {
    const longText = "x".repeat(500);
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "c-1", name: "Test", headline: null, location: null,
        linkedinUrl: null, jobAdderUrl: null, photoFileId: null,
        matchScore: null, source: "manual", profileText: longText,
        candidateIdentityId: null, createdAt: new Date(),
      },
    ]);
    const results = await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A"],
    });
    expect(results).toHaveLength(1);
    expect(results[0].profileTextSnippet).toBe("x".repeat(400) + "…");
  });

  it("returns full text when under 400 chars (no ellipsis)", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "c-1", name: "Test", headline: null, location: null,
        linkedinUrl: null, jobAdderUrl: null, photoFileId: null,
        matchScore: null, source: "manual", profileText: "short text",
        candidateIdentityId: null, createdAt: new Date(),
      },
    ]);
    const results = await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A"],
    });
    expect(results[0].profileTextSnippet).toBe("short text");
  });

  it("returns null snippet when profileText is null", async () => {
    dbMocks.prisma.candidate.findMany.mockResolvedValueOnce([
      {
        id: "c-1", name: "Test", headline: null, location: null,
        linkedinUrl: null, jobAdderUrl: null, photoFileId: null,
        matchScore: null, source: "manual", profileText: null,
        candidateIdentityId: null, createdAt: new Date(),
      },
    ]);
    const results = await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A"],
    });
    expect(results[0].profileTextSnippet).toBeNull();
  });
});

describe("searchLibrary — defaults + ordering", () => {
  it("limit defaults to 100", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A"],
    });
    const call = dbMocks.prisma.candidate.findMany.mock.calls[0][0] as { take: number };
    expect(call.take).toBe(100);
  });

  it("limit override honoured", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A"],
      limit: 50,
    });
    const call = dbMocks.prisma.candidate.findMany.mock.calls[0][0] as { take: number };
    expect(call.take).toBe(50);
  });

  it("orders by createdAt desc", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org-A"],
    });
    const call = dbMocks.prisma.candidate.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(call.orderBy).toEqual({ createdAt: "desc" });
  });
});
