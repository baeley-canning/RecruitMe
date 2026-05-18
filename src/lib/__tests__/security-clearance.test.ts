import { describe, expect, it } from "vitest";
import { enrichRoleWithSecurityClearance, inferSecurityClearanceContext } from "../security-clearance";
import type { ParsedRole } from "../ai";

function makeRole(overrides: Partial<ParsedRole> = {}): ParsedRole {
  return {
    title: "Software Developer",
    title_source: "explicit",
    company: "New Zealand Customs Service",
    company_source: "explicit",
    location: "Wellington",
    location_source: "explicit",
    experience: "",
    seniority_band: "Mid-level",
    seniority_source: "inferred",
    salary_band: "",
    salary_source: "",
    location_rules: "",
    location_rules_source: "",
    visa_flags: [],
    must_haves: [],
    nice_to_haves: [],
    knockout_criteria: [],
    application_requirements: [],
    explicitly_stated: [],
    strongly_inferred: ["Product Manager (Protection)"],
    search_expansion: [],
    synonym_titles: [],
    responsibilities: [],
    search_queries: [],
    google_queries: [],
    skills_required: [],
    skills_preferred: [],
    ...overrides,
  };
}

describe("security clearance role enrichment", () => {
  it("turns explicit clearance requirements into a knockout and must-have", () => {
    const role = enrichRoleWithSecurityClearance(
      "Applicants must be eligible to obtain and maintain a national security clearance.",
      makeRole()
    );

    expect(role.knockout_criteria.some((item) => /security clearance/i.test(item))).toBe(true);
    expect(role.must_haves.some((item) => /security clearance/i.test(item))).toBe(true);
  });

  it("treats clearance-sensitive Customs context as inferred, not a knockout", () => {
    const role = enrichRoleWithSecurityClearance(
      "Software Developer role in the Protection product area.",
      makeRole()
    );

    expect(role.knockout_criteria).toEqual([]);
    expect(role.nice_to_haves.some((item) => /government|defence|border|security/i.test(item))).toBe(true);
    expect(role.strongly_inferred.some((item) => /clearance-sensitive/i.test(item))).toBe(true);
  });

  it("does not add clearance signals to ordinary private-sector roles", () => {
    const role = enrichRoleWithSecurityClearance(
      "Software Developer building product features.",
      makeRole({ company: "Xero", strongly_inferred: [] })
    );

    expect(role.knockout_criteria).toEqual([]);
    expect(role.nice_to_haves).toEqual([]);
  });

  it("detects sensitive organisation and title context separately", () => {
    const context = inferSecurityClearanceContext({
      company: "New Zealand Customs Service",
      title: "Software Developer",
      stronglyInferred: ["Product Manager (Protection)"],
    });

    expect(context.explicit).toBe(false);
    expect(context.inferred).toBe(true);
  });
});

