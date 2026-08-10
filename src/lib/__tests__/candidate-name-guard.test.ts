/**
 * The first SEEK profile ever backfilled came back named "SEEK" — the scraper's
 * fallback reads the page <title>/h1, which on that app is branding. Left
 * unchecked, the backfill would have renamed every candidate it touched.
 */
import { describe, it, expect } from "vitest";
import { isUsableCandidateName } from "../scraper-ingestion";

describe("isUsableCandidateName", () => {
  it("rejects the platform's own branding — the observed failure", () => {
    expect(isUsableCandidateName("SEEK", "seek")).toBe(false);
    expect(isUsableCandidateName("seek", "seek")).toBe(false);
    expect(isUsableCandidateName("LinkedIn", "linkedin")).toBe(false);
    // Branding from ANY platform, not just the one being scraped.
    expect(isUsableCandidateName("LinkedIn", "seek")).toBe(false);
  });

  it("rejects generic page chrome", () => {
    for (const junk of ["Sign in", "View profile", "Profile", "Dashboard", "Talent Search"]) {
      expect(isUsableCandidateName(junk, "seek")).toBe(false);
    }
  });

  it("rejects something too short to be a name", () => {
    expect(isUsableCandidateName("A", "seek")).toBe(false);
    expect(isUsableCandidateName("  ", "seek")).toBe(false);
  });

  it("accepts real candidate names from the live job", () => {
    for (const name of ["Chinthana Dilhan", "Zhou Bo", "Mariusz Drozdowski", "Rachael Rossiter"]) {
      expect(isUsableCandidateName(name, "seek")).toBe(true);
    }
  });
});
