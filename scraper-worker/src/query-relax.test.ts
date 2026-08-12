/**
 * A live search that returns nothing should try a wider query before giving up.
 *
 * The library path already does this — when a query with required terms returns
 * no rows it demotes them to optional and retries. The live SEEK path has no
 * such fallback, so a narrow boolean silently reads as "no such candidates
 * exist". Observed 2026-08-12: SEEK's own page reported `0 matching candidates`
 * for
 *
 *   c# AND ("senior full stack .net developer" OR "senior .net developer"
 *           OR "full stack engineer" OR ".net engineer" OR "software engineer")
 *       AND (.net OR react)
 *
 * — a correct scrape of a query nobody satisfies. Three hard-ANDed groups on a
 * country-sized candidate pool is a query that cannot match.
 *
 * Relaxing to the TITLE group alone is the same rule already proven for
 * LinkedIn: titles find people, skills rank them afterwards.
 */
import { describe, it, expect } from "vitest";
import { relaxToTitleGroup } from "./query-relax";

describe("relaxToTitleGroup", () => {
  it("keeps the title OR-group and drops the skill gates (the real failing query)", () => {
    const q =
      'c# AND ("senior full stack .net developer" OR "senior .net developer" OR "full stack engineer" OR ".net engineer" OR "software engineer") AND (.net OR react)';
    expect(relaxToTitleGroup(q)).toBe(
      '("senior full stack .net developer" OR "senior .net developer" OR "full stack engineer" OR ".net engineer" OR "software engineer")',
    );
  });

  it("picks the group with the most quoted phrases when several OR-groups exist", () => {
    const q = '(python OR java) AND ("data engineer" OR "analytics engineer" OR "etl developer")';
    expect(relaxToTitleGroup(q)).toBe('("data engineer" OR "analytics engineer" OR "etl developer")');
  });

  it("returns null when there is nothing to relax — a single group is already as wide as it gets", () => {
    expect(relaxToTitleGroup('("software engineer" OR "developer")')).toBeNull();
    expect(relaxToTitleGroup("software engineer")).toBeNull();
  });

  it("returns null when no group has quoted phrases — we would be guessing", () => {
    expect(relaxToTitleGroup("c# AND (.net OR react)")).toBeNull();
  });

  it("ignores AND inside a quoted phrase", () => {
    const q = '("research and development lead" OR "r&d manager") AND (python OR sql)';
    expect(relaxToTitleGroup(q)).toBe('("research and development lead" OR "r&d manager")');
  });

  it("is a no-op on an already-relaxed query, so a retry cannot loop", () => {
    const relaxed = relaxToTitleGroup(
      'c# AND ("full stack engineer" OR "software engineer") AND (.net OR react)',
    );
    expect(relaxed).toBe('("full stack engineer" OR "software engineer")');
    expect(relaxToTitleGroup(relaxed!)).toBeNull();
  });

  it("handles empty, whitespace and junk without throwing", () => {
    for (const junk of ["", "   ", "AND", "()", "(((", '"'.repeat(5)]) {
      expect(() => relaxToTitleGroup(junk)).not.toThrow();
    }
  });

  it("does not treat lowercase 'and' as an operator", () => {
    // SEEK booleans use uppercase AND; "cat and dog" is one term, not two groups.
    expect(relaxToTitleGroup('"cat and dog" and "bird"')).toBeNull();
  });
});
