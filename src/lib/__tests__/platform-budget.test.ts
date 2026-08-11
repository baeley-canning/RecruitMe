/**
 * A daily ceiling on what the scraper may do to each platform.
 *
 * Today the worker made 33 SEEK login attempts and, on a separate bug, cycled
 * profile fetches every ~7s instead of ~35s — which got the owner's LinkedIn
 * account flagged. Both were prevented only by a human noticing. A budget
 * enforced at the claim point makes them impossible by construction: the worker
 * cannot exceed what the API hands it, however broken the worker becomes.
 */
import { describe, it, expect } from "vitest";
import { applyPlatformBudget, type BudgetedJob } from "../platform-budget";

const job = (platform: string, id = Math.random().toString(36).slice(2)): BudgetedJob =>
  ({ id, platform }) as BudgetedJob;

describe("applyPlatformBudget", () => {
  it("passes everything through when well under budget", () => {
    const jobs = [job("seek"), job("seek"), job("linkedin")];
    const out = applyPlatformBudget(jobs, { seek: 0, linkedin: 0 }, { seek: 100, linkedin: 100 });
    expect(out.allowed).toHaveLength(3);
    expect(out.deferred).toHaveLength(0);
  });

  it("defers the jobs that would exceed the remaining allowance", () => {
    const jobs = [job("seek", "a"), job("seek", "b"), job("seek", "c")];
    const out = applyPlatformBudget(jobs, { seek: 98 }, { seek: 100 });
    expect(out.allowed.map((j) => j.id)).toEqual(["a", "b"]);
    expect(out.deferred.map((j) => j.id)).toEqual(["c"]);
  });

  it("defers everything for a platform already at its ceiling", () => {
    const out = applyPlatformBudget([job("seek"), job("seek")], { seek: 250 }, { seek: 250 });
    expect(out.allowed).toHaveLength(0);
    expect(out.deferred).toHaveLength(2);
  });

  it("budgets each platform independently — SEEK exhausted must not stop LinkedIn", () => {
    const jobs = [job("seek", "s1"), job("linkedin", "l1"), job("seek", "s2")];
    const out = applyPlatformBudget(jobs, { seek: 100, linkedin: 0 }, { seek: 100, linkedin: 50 });
    expect(out.allowed.map((j) => j.id)).toEqual(["l1"]);
    expect(out.deferred.map((j) => j.id)).toEqual(["s1", "s2"]);
  });

  it("treats an unbudgeted platform as unlimited rather than blocking it", () => {
    const out = applyPlatformBudget([job("jobadder"), job("jobadder")], {}, { seek: 10 });
    expect(out.allowed).toHaveLength(2);
  });

  it("a zero budget is a real stop, not 'unset'", () => {
    // This is how LinkedIn automation gets switched off on the box without a
    // code change: set its budget to 0.
    const out = applyPlatformBudget([job("linkedin")], {}, { linkedin: 0 });
    expect(out.allowed).toHaveLength(0);
    expect(out.deferred).toHaveLength(1);
  });

  it("reports which platforms were capped, so it can be surfaced rather than silent", () => {
    const out = applyPlatformBudget([job("seek"), job("linkedin")], { seek: 100 }, { seek: 100, linkedin: 50 });
    expect(out.cappedPlatforms).toEqual(["seek"]);
  });

  it("never returns a negative allowance when usage has overshot", () => {
    const out = applyPlatformBudget([job("seek")], { seek: 500 }, { seek: 100 });
    expect(out.allowed).toHaveLength(0);
  });

  it("preserves the queue's ordering — priority already decided it", () => {
    const jobs = [job("seek", "first"), job("seek", "second"), job("seek", "third")];
    const out = applyPlatformBudget(jobs, { seek: 0 }, { seek: 2 });
    expect(out.allowed.map((j) => j.id)).toEqual(["first", "second"]);
  });

  it("handles an empty claim without fuss", () => {
    const out = applyPlatformBudget([], { seek: 5 }, { seek: 10 });
    expect(out.allowed).toEqual([]);
    expect(out.cappedPlatforms).toEqual([]);
  });
});

describe("parsePlatformBudgets", () => {
  it("reads a budget spec and ignores junk rather than throwing", async () => {
    const { parsePlatformBudgets } = await import("../platform-budget");
    expect(parsePlatformBudgets("seek=250,linkedin=0")).toEqual({ seek: 250, linkedin: 0 });
    expect(parsePlatformBudgets("  seek = 40 , nonsense , = , linkedin=abc ")).toEqual({ seek: 40 });
    expect(parsePlatformBudgets("")).toEqual({});
    expect(parsePlatformBudgets(undefined)).toEqual({});
  });

  it("rejects a negative budget rather than treating it as unlimited", async () => {
    const { parsePlatformBudgets } = await import("../platform-budget");
    expect(parsePlatformBudgets("seek=-5")).toEqual({});
  });
});
