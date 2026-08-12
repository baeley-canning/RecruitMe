/**
 * A search that timed out after finding people has still found people.
 *
 * Observed live on the box 2026-08-12:
 *
 *   00:00:01.577 ERROR job ... failed: linkedin-search timed out after 240000ms
 *   00:00:02.457 INFO  linkedin-search: harvested 4 cards (4 with names)
 *
 * LinkedIn was authenticated and page 1 returned four real candidates. The
 * outer wedge-guard timeout fired during pagination, the promise was killed,
 * and the harvest — which lives in a Map local to the scraper — went with it.
 * The job was posted as FAILED and the recruiter saw nothing.
 *
 * Salvaging is only correct for a TIMEOUT. An auth challenge must still fail
 * the job loudly: it needs the no-retry/no-backoff path and a human re-login,
 * and quietly reporting a handful of cards would hide that the session is gone.
 */
import { describe, it, expect } from "vitest";
import { shouldSalvagePartialHarvest } from "./partial-harvest";

const timeout = (label: string, ms = 240000) => new Error(`${label} timed out after ${ms}ms`);

describe("shouldSalvagePartialHarvest", () => {
  it("salvages a timeout that already found candidates", () => {
    expect(shouldSalvagePartialHarvest(timeout("linkedin-search"), 4, "linkedin-search")).toBe(true);
  });

  it("does NOT salvage a timeout that found nothing — there is nothing to report", () => {
    expect(shouldSalvagePartialHarvest(timeout("linkedin-search"), 0, "linkedin-search")).toBe(false);
  });

  it("does NOT salvage an auth challenge, even with cards in hand", () => {
    const err = new Error("linkedin_challenge: session expired (run login.ts linkedin)");
    expect(shouldSalvagePartialHarvest(err, 12, "linkedin-search")).toBe(false);
  });

  it("does NOT salvage a challenge that also mentions a timeout", () => {
    const err = new Error("seek_challenge: auth wall during sort — timed out after 6000ms");
    expect(shouldSalvagePartialHarvest(err, 5, "seek-search")).toBe(false);
  });

  it("does NOT salvage an unrelated error — only the wedge guard is recoverable", () => {
    for (const err of [
      new Error("page.evaluate: Target page, context or browser has been closed"),
      new Error("net::ERR_CONNECTION_RESET"),
      new Error("linkedin-search: harvested 0 cards and no \"No results found\" marker"),
    ]) {
      expect(shouldSalvagePartialHarvest(err, 4, "linkedin-search")).toBe(false);
    }
  });

  it("only salvages the timeout belonging to THIS operation", () => {
    // A profile-fetch timeout surfacing inside a search must not be read as
    // "the search timed out", or we would report a search as partially complete
    // on the strength of an unrelated failure.
    expect(shouldSalvagePartialHarvest(timeout("linkedin-profile"), 4, "linkedin-search")).toBe(false);
  });

  it("handles non-Error throws without crashing", () => {
    for (const junk of ["timed out", null, undefined, 42, { message: "timed out after 1ms" }]) {
      expect(() => shouldSalvagePartialHarvest(junk, 4, "linkedin-search")).not.toThrow();
    }
  });

  it("never salvages a negative or nonsense count", () => {
    expect(shouldSalvagePartialHarvest(timeout("linkedin-search"), -1, "linkedin-search")).toBe(false);
    expect(shouldSalvagePartialHarvest(timeout("linkedin-search"), NaN, "linkedin-search")).toBe(false);
  });
});
