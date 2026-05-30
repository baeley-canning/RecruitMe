/**
 * Integration tests for src/lib/talent-search/library.ts — the multi-source
 * search feature's library backend.
 *
 * Phase F rewrite: searchLibrary now uses `$queryRaw` against the searchTsv
 * tsvector column instead of Prisma's findMany. The behaviour these tests
 * pin is:
 *  • Empty parsedQuery → recency path (no `searchTsv @@ q` predicate)
 *  • Non-empty parsedQuery → FTS path with a built tsquery string
 *  • Owner / per-org / empty-org scoping
 *  • Location filter applied as ILIKE
 *
 * The shape of the SQL is asserted via the tagged-template strings the
 * Prisma client receives — that's the public contract of $queryRaw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBooleanQuery } from "../../boolean-query";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => dbMocks);

import { searchLibrary } from "../library";

beforeEach(() => {
  dbMocks.prisma.$queryRaw.mockReset();
  dbMocks.prisma.$queryRaw.mockResolvedValue([]);
});

// Prisma's $queryRaw receives a TemplateStringsArray as the first arg and the
// interpolated values as the rest — same shape as String.raw. We read both
// to assert which branch ran and what bound params were passed.
function lastSqlText(): string {
  const calls = dbMocks.prisma.$queryRaw.mock.calls;
  if (calls.length === 0) return "";
  const tpl = calls[calls.length - 1][0] as TemplateStringsArray;
  return Array.from(tpl).join(" ");
}

function lastSqlValues(): unknown[] {
  const calls = dbMocks.prisma.$queryRaw.mock.calls;
  if (calls.length === 0) return [];
  return calls[calls.length - 1].slice(1) as unknown[];
}

describe("searchLibrary — empty query falls back to recency path", () => {
  it("no terms → no tsvector predicate", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: null,
    });
    expect(dbMocks.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = lastSqlText();
    expect(sql).not.toContain("@@");
    expect(sql).toContain("ORDER BY");
  });
});

describe("searchLibrary — non-empty query takes the FTS path", () => {
  it("simple term → searchTsv @@ to_tsquery", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("typescript"),
      accessibleOrgIds: null,
    });
    const sql = lastSqlText();
    expect(sql).toContain('"searchTsv" @@ q');
    expect(sql).toContain("to_tsquery");
    expect(sql).toContain("ts_rank_cd");
    expect(lastSqlValues()).toContain("typescript");
  });

  it("OR group emits | inside parens", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery('"react" OR "vue"'),
      accessibleOrgIds: null,
    });
    expect(lastSqlValues()).toContain("(react | vue)");
  });

  it("must-not emits leading !", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery("senior NOT junior"),
      accessibleOrgIds: null,
    });
    const values = lastSqlValues();
    expect(values.some((v) => typeof v === "string" && v.includes("!junior"))).toBe(true);
  });
});

describe("searchLibrary — org scoping", () => {
  it("empty accessibleOrgIds → short-circuits to []", async () => {
    const out = await searchLibrary({
      parsedQuery: parseBooleanQuery("anything"),
      accessibleOrgIds: [],
    });
    expect(out).toEqual([]);
    expect(dbMocks.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("populated accessibleOrgIds → passes the array as a bound param", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: ["org_a", "org_b"],
    });
    expect(lastSqlValues()).toContainEqual(["org_a", "org_b"]);
  });
});

describe("searchLibrary — location filter", () => {
  it("trimmed location passed as ILIKE bound param", async () => {
    await searchLibrary({
      parsedQuery: parseBooleanQuery(""),
      accessibleOrgIds: null,
      location: "  Wellington  ",
    });
    expect(lastSqlValues()).toContain("Wellington");
  });
});
