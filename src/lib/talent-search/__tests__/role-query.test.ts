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

  it("title + anchor_terms → (titles) AND anchors", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "PHP Developer", synonym_titles: [], anchor_terms: ["Laravel", "SilverStripe"] }));
    expect(q).toMatch(/\bAND\b/);
    expect(q).toContain("Laravel");
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("falls back to must_haves when anchor_terms is absent", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Developer", must_haves: ["React", "TypeScript", "Node"] }));
    expect(q).toContain("React");
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("caps the title OR-group at 5 and anchors at 3 (no runaway query)", () => {
    const q = parsedRoleToBooleanQuery(role({
      title: "T0",
      synonym_titles: ["T1", "T2", "T3", "T4", "T5", "T6"],
      anchor_terms: ["A1", "A2", "A3", "A4"],
    }));
    expect((q.match(/ OR /g) ?? []).length).toBe(4); // 5 titles → 4 ORs
    expect((q.match(/ AND /g) ?? []).length).toBe(3); // titlegroup + 3 anchors → 3 ANDs
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("empty role → empty string (caller falls back to manual entry)", () => {
    expect(parsedRoleToBooleanQuery(role({ title: "" }))).toBe("");
  });

  it("strips internal quotes so the query never breaks the parser", () => {
    const q = parsedRoleToBooleanQuery(role({ title: 'Senior "Rockstar" Engineer', anchor_terms: ["C#"] }));
    expect(q).not.toContain('""');
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("soft-skill JD (generic title) still produces a parseable query", () => {
    // Quoting Specialist / Office Manager class — see the soft-skill-jd memo.
    const q = parsedRoleToBooleanQuery(role({ title: "Quoting Specialist", synonym_titles: ["Estimator"], must_haves: ["quoting"] }));
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });
});
