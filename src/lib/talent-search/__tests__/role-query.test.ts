import { describe, expect, it } from "vitest";
import { parsedRoleToBooleanQuery } from "@/lib/talent-search/role-query";
import { parseBooleanQuery } from "@/lib/boolean-query";
import type { ParsedRole } from "@/lib/ai";

// The function only reads title/synonym_titles/anchor_terms/must_haves — cast a
// partial fixture rather than constructing the whole ParsedRole.
const role = (o: Partial<ParsedRole>): ParsedRole => o as ParsedRole;

describe("parsedRoleToBooleanQuery", () => {
  it("titles-only role → an OR-group of quoted titles that parses clean", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Senior Software Engineer", synonym_titles: ["Full Stack Developer", "Backend Engineer"] }));
    expect(q).toContain('"Senior Software Engineer"');
    expect(q).toContain(" OR ");
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("title + anchors → (titles) AND (anchors OR-grouped, not all AND'd)", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "PHP Developer", synonym_titles: [], anchor_terms: ["Laravel", "SilverStripe", "AWS"] }));
    // Exactly ONE AND (between the two groups); anchors are OR'd so the FTS
    // doesn't require all three simultaneously (the over-narrowing bug).
    expect((q.match(/ AND /g) ?? []).length).toBe(1);
    expect(q).toContain('"Laravel" OR "SilverStripe"');
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("falls back to must_haves when anchor_terms is absent", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Developer", must_haves: ["React", "TypeScript", "Node"] }));
    expect(q).toContain('"React"');
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("caps the title OR-group at 5 and anchors at 3, joined by a single AND", () => {
    const q = parsedRoleToBooleanQuery(role({
      title: "T0",
      synonym_titles: ["T1", "T2", "T3", "T4", "T5", "T6"],
      anchor_terms: ["A0", "A1", "A2", "A3"],
    }));
    expect((q.match(/ OR /g) ?? []).length).toBe(6); // 5 titles → 4 ORs, 3 anchors → 2 ORs
    expect((q.match(/ AND /g) ?? []).length).toBe(1); // one AND between the two groups
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("empty role → empty string (caller falls back to manual entry)", () => {
    expect(parsedRoleToBooleanQuery(role({ title: "" }))).toBe("");
  });

  it("preserves 'years' and 'location' inside terms (per-term, not whole-query, cleaning)", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Location Manager", anchor_terms: ["5+ years React"] }));
    expect(q).toContain("Location Manager"); // NOT gutted to "Manager"
    expect(q).toContain("5+ years React");   // NOT gutted to "React"
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("a leading-dash term is quoted, never negated into a mustNot", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Engineer", anchor_terms: ["-experience"] }));
    expect(parseBooleanQuery(q).mustNot).toHaveLength(0); // not negated
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("an operator-word term (OR/AND/NOT) is quoted as a literal, not parsed as an operator", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Nurse", anchor_terms: ["OR"] })); // Operating Room
    expect(q).toContain('"OR"');
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("strips internal quotes so the query never breaks the parser", () => {
    const q = parsedRoleToBooleanQuery(role({ title: 'Senior "Rockstar" Engineer', anchor_terms: ["C#"] }));
    expect(q).not.toContain('""');
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("soft-skill JD (generic title) still produces a parseable query", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Quoting Specialist", synonym_titles: ["Estimator"], must_haves: ["quoting"] }));
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });
});
