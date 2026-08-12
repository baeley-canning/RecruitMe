/**
 * LinkedIn's basic people-search must be asked for TITLES ONLY.
 *
 * Its non-Recruiter search reliably matches a single OR-group but returns
 * "No results found" for `(titles) AND (skills)`. Verified on the box
 * 2026-06-15 — a 5-title OR-group returned ~33 results, the same group AND a
 * skill group returned 0 — and again live on 2026-08-12, when
 *
 *   c# AND ("senior full stack .net developer" OR … OR "software engineer")
 *          AND (.net OR react)
 *
 * completed cleanly in 38 seconds and harvested ZERO cards.
 *
 * /search/multi had always used linkedinTitleQuery for this reason; the
 * /search route was still sending the full boolean, so its LinkedIn leg could
 * only ever return nothing. These tests pin the shape the LinkedIn leg needs so
 * a future "let's just pass the boolean through" cannot silently re-break it.
 */
import { describe, it, expect } from "vitest";
import { linkedinTitleQuery } from "../emit";

describe("linkedinTitleQuery", () => {
  it("emits ONE OR-group of quoted titles — never an AND", () => {
    const out = linkedinTitleQuery(["Full Stack Engineer", "Software Engineer", ".NET Developer"]);
    expect(out).toBe('("Full Stack Engineer" OR "Software Engineer" OR ".NET Developer")');
    expect(out).not.toContain(" AND ");
  });

  it("does not wrap a single title in a pointless group", () => {
    expect(linkedinTitleQuery(["Software Engineer"])).toBe('"Software Engineer"');
  });

  it("de-duplicates case-insensitively so the group stays tight", () => {
    const out = linkedinTitleQuery(["Software Engineer", "software engineer", "SOFTWARE ENGINEER"]);
    expect(out).toBe('"Software Engineer"');
  });

  it("caps the group — an over-long OR chain is its own way of returning nothing", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Title ${i}`);
    const out = linkedinTitleQuery(many);
    expect(out.split(" OR ")).toHaveLength(6);
    expect(linkedinTitleQuery(many, 3).split(" OR ")).toHaveLength(3);
  });

  it("strips quotes and parens that would corrupt the boolean", () => {
    const out = linkedinTitleQuery(['Senior "Full Stack" (Engineer)']);
    expect(out).toBe('"Senior Full Stack Engineer"');
  });

  it("returns empty for no usable titles, so the caller can fall back", () => {
    expect(linkedinTitleQuery([])).toBe("");
    expect(linkedinTitleQuery(["", "   "])).toBe("");
  });

  it("keeps a dotted framework title intact — LinkedIn matches these literally", () => {
    expect(linkedinTitleQuery([".NET Developer"])).toBe('".NET Developer"');
  });

  it("never emits a skill-gated boolean, whatever it is handed", () => {
    // The exact failing production query's title list — the output must be a
    // single OR-group with no skill terms bolted on.
    const out = linkedinTitleQuery([
      "Senior Full Stack .NET Developer",
      "Senior .NET Developer",
      "Full Stack Engineer",
      ".NET Engineer",
      "Software Engineer",
    ]);
    expect(out).not.toMatch(/\bAND\b/);
    expect(out).not.toContain("c#");
    expect(out.startsWith("(")).toBe(true);
  });
});
