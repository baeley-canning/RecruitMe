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
    const parsed = parseBooleanQuery(q);
    // The AI-certified dominant anchor is hard-required; the remaining anchors
    // stay optional (OR'd) so we don't over-narrow to all three at once.
    expect(parsed.mustHave).toContain("laravel");
    expect(q).toContain('"SilverStripe" OR "AWS"');
    // titles-group AND "Laravel" AND (rest) = two ANDs.
    expect((q.match(/ AND /g) ?? []).length).toBe(2);
    expect(parsed.hasErrors).toBe(false);
  });

  it("falls back to must_haves (ALL OR'd, none required) when anchor_terms is absent", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Developer", must_haves: ["React", "TypeScript", "Node"] }));
    // No anchor_terms → the skills stay an OR-group; none is promoted to a hard
    // requirement (hybrid/ambiguous roles AND-to-zero). The single title is a
    // bare mustHave as it always was, but no SKILL is required.
    expect(q).toContain('"React" OR "TypeScript" OR "Node"');
    expect(parseBooleanQuery(q).mustHave).not.toContain("react");
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("caps titles at 5 and anchors at 3; promotes the top anchor to a hard AND", () => {
    const q = parsedRoleToBooleanQuery(role({
      title: "T0",
      synonym_titles: ["T1", "T2", "T3", "T4", "T5", "T6"],
      anchor_terms: ["A0", "A1", "A2", "A3"],
    }));
    // 5 titles → 4 ORs; remaining anchors A1,A2 → 1 OR = 5 ORs total.
    expect((q.match(/ OR /g) ?? []).length).toBe(5);
    // titles-group AND "A0" AND (A1 OR A2) = two ANDs.
    expect((q.match(/ AND /g) ?? []).length).toBe(2);
    expect(parseBooleanQuery(q).mustHave).toContain("a0");
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("drops PROSE must_haves (full sentences) → title-only, so the search isn't 0 everywhere", () => {
    // The ITSM-role "no results at all" bug: must_haves came back as sentences and
    // got quoted as FTS/SEEK phrases that match nothing.
    const q = parsedRoleToBooleanQuery(role({
      title: "Service Transition Manager",
      synonym_titles: ["IT Service Manager", "IT Operations Specialist"],
      anchor_terms: [],
      must_haves: [
        "Experience with ITSM tools",
        "Understanding of ITIL service management practices",
        "Proven track record in ITIL service transition, IT operations, or enterprise endpoint management",
      ],
    }));
    expect(q).not.toMatch(/understanding of|experience with|track record/i);
    expect(q).toContain('"Service Transition Manager"');
    // Title-only — no AND constraint, so it returns people instead of nothing.
    expect((q.match(/ AND /g) ?? []).length).toBe(0);
    expect(parseBooleanQuery(q).hasErrors).toBe(false);
  });

  it("keeps real keyword anchors (short skills) — only prose is filtered", () => {
    const q = parsedRoleToBooleanQuery(role({ title: "Developer", anchor_terms: ["Silverstripe", "service transition", "ITIL"] }));
    expect(q).toContain('"Silverstripe"');
    expect(q).toContain('"ITIL"');
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
