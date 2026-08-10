/**
 * Tests for the fetch planner — written BEFORE and INDEPENDENTLY of the
 * implementation (which was delegated). A model's own tests assert the
 * behaviour it believed it wrote; these assert the behaviour we want.
 */
import { describe, it, expect } from "vitest";
import { planProfileFetches, type FetchCandidate } from "../fetch-planner";

function cand(over: Partial<FetchCandidate> & { id: string }): FetchCandidate {
  return {
    id: over.id,
    platform: over.platform ?? "seek",
    profileChars: over.profileChars ?? 0,
    matchScore: over.matchScore ?? null,
    fetchPriorityScore: over.fetchPriorityScore ?? null,
    status: over.status ?? "new",
    hasProfileUrl: over.hasProfileUrl ?? true,
  };
}

describe("planProfileFetches", () => {
  it("spends nothing when the budget is zero — SEEK fetches cost real credits", () => {
    const plan = planProfileFetches([cand({ id: "a" }), cand({ id: "b" })], { budget: 0 });
    expect(plan.selected).toEqual([]);
    expect(plan.estimatedCredits).toBe(0);
  });

  it("never exceeds the budget", () => {
    const pool = Array.from({ length: 50 }, (_, i) => cand({ id: `c${i}` }));
    const plan = planProfileFetches(pool, { budget: 7 });
    expect(plan.selected).toHaveLength(7);
    expect(plan.estimatedCredits).toBe(7);
  });

  it("skips candidates that already have a full profile", () => {
    const plan = planProfileFetches(
      [cand({ id: "thin", profileChars: 120 }), cand({ id: "full", profileChars: 5000 })],
      { budget: 10 },
    );
    expect(plan.selected).toEqual(["thin"]);
  });

  it("skips candidates with no profile URL to fetch", () => {
    const plan = planProfileFetches(
      [cand({ id: "nourl", hasProfileUrl: false }), cand({ id: "ok" })],
      { budget: 10 },
    );
    expect(plan.selected).toEqual(["ok"]);
  });

  it("prefers candidates the recruiter has already acted on", () => {
    // Someone shortlisted is worth confirming before someone untouched, even
    // when the untouched one scores higher on a thin snippet.
    const plan = planProfileFetches(
      [
        cand({ id: "untouched", status: "new", matchScore: 70 }),
        cand({ id: "shortlisted", status: "shortlisted", matchScore: 40 }),
      ],
      { budget: 1 },
    );
    expect(plan.selected).toEqual(["shortlisted"]);
  });

  it("does not spend on candidates already rejected", () => {
    const plan = planProfileFetches(
      [cand({ id: "rejected", status: "rejected", matchScore: 95 }), cand({ id: "live" })],
      { budget: 10 },
    );
    expect(plan.selected).toEqual(["live"]);
  });

  it("among untouched candidates, prefers the higher provisional score", () => {
    const plan = planProfileFetches(
      [cand({ id: "low", matchScore: 20 }), cand({ id: "high", matchScore: 65 })],
      { budget: 1 },
    );
    expect(plan.selected).toEqual(["high"]);
  });

  it("falls back to fetchPriorityScore when there is no match score yet", () => {
    const plan = planProfileFetches(
      [
        cand({ id: "lowprio", matchScore: null, fetchPriorityScore: 10 }),
        cand({ id: "hiprio", matchScore: null, fetchPriorityScore: 90 }),
      ],
      { budget: 1 },
    );
    expect(plan.selected).toEqual(["hiprio"]);
  });

  it("only counts credit-charging platforms toward estimatedCredits", () => {
    // Opening a SEEK profile costs a credit. LinkedIn does not.
    const plan = planProfileFetches(
      [cand({ id: "s", platform: "seek" }), cand({ id: "l", platform: "linkedin" })],
      { budget: 10 },
    );
    expect(plan.selected).toHaveLength(2);
    expect(plan.estimatedCredits).toBe(1);
  });

  it("budget limits credit-charging fetches, not free ones", () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => cand({ id: `s${i}`, platform: "seek" })),
      ...Array.from({ length: 5 }, (_, i) => cand({ id: `l${i}`, platform: "linkedin" })),
    ];
    const plan = planProfileFetches(pool, { budget: 2 });
    const seek = plan.selected.filter((id) => id.startsWith("s"));
    const linkedin = plan.selected.filter((id) => id.startsWith("l"));
    expect(seek).toHaveLength(2);
    expect(linkedin).toHaveLength(5);
    expect(plan.estimatedCredits).toBe(2);
  });

  it("is deterministic — same input, same plan", () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      cand({ id: `c${i}`, matchScore: i % 7, status: i % 3 === 0 ? "shortlisted" : "new" }),
    );
    const a = planProfileFetches(pool, { budget: 5 });
    const b = planProfileFetches(pool, { budget: 5 });
    expect(a.selected).toEqual(b.selected);
  });

  it("reports how many were skipped for budget so the UI can say so", () => {
    const pool = Array.from({ length: 10 }, (_, i) => cand({ id: `c${i}` }));
    const plan = planProfileFetches(pool, { budget: 3 });
    expect(plan.skippedForBudget).toBe(7);
  });

  it("handles an empty pool without throwing", () => {
    const plan = planProfileFetches([], { budget: 5 });
    expect(plan.selected).toEqual([]);
    expect(plan.skippedForBudget).toBe(0);
  });
});
