import { describe, expect, it } from "vitest";
import { computeFetchPriority } from "../fetch-priority";
import type { ParsedRole } from "../ai";

const role: ParsedRole = {
  title: "Senior Software Developer",
  title_source: "explicit",
  company: "",
  company_source: "",
  location: "Wellington",
  location_source: "explicit",
  location_rules: "Wellington or nearby",
  location_rules_source: "explicit",
  experience: "",
  salary_band: "",
  salary_source: "",
  seniority_band: "Senior",
  seniority_source: "explicit",
  must_haves: ["C++ programming experience", "Sybase database experience", "Linux scripting"],
  nice_to_haves: ["Azure cloud platform experience"],
  knockout_criteria: [],
  skills_required: ["C++", "Sybase", "Linux"],
  skills_preferred: ["Azure"],
  responsibilities: [],
  application_requirements: [],
  visa_flags: [],
  search_queries: ["C++ Sybase developer Wellington"],
  google_queries: [],
  synonym_titles: ["Software Engineer"],
  explicitly_stated: [],
  strongly_inferred: [],
  search_expansion: [],
};

describe("computeFetchPriority", () => {
  it("ranks a targeted search hit as a strong lead to fetch", () => {
    const priority = computeFetchPriority({
      parsedRole: role,
      candidateLocation: "Wellington, New Zealand",
      result: {
        name: "Taylor Morgan",
        headline: "Senior Software Developer | C++ | Sybase | Linux",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/taylor-morgan/",
        snippet: "Senior developer with C++, Sybase database, Linux scripting and Azure delivery experience.",
        matchedQuery: "C++ Sybase developer Wellington",
        source: "serpapi",
      },
    });

    expect(priority.score).toBeGreaterThanOrEqual(80);
    expect(priority.reason.label).toBe("Strong lead");
    expect(priority.reason.matchedTerms).toEqual(expect.arrayContaining(["C++", "Sybase", "Linux"]));
  });

  it("penalises junior/no-evidence hits for senior specialist roles", () => {
    const priority = computeFetchPriority({
      parsedRole: role,
      candidateLocation: "Wellington, New Zealand",
      result: {
        name: "Jamie Smith",
        headline: "Graduate Developer | Dev Academy | Seeking Entry-Level Role",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/jamie-smith/",
        snippet: "Bootcamp graduate with React projects and a desire to learn.",
        matchedQuery: "software developer",
        source: "serpapi",
      },
    });

    expect(priority.score).toBeLessThan(45);
    expect(priority.reason.risks.join(" ")).toMatch(/Junior|Few must-have/i);
  });

  it("boosts existing captured profiles because no LinkedIn fetch is needed", () => {
    const priority = computeFetchPriority({
      parsedRole: role,
      candidateLocation: "Wellington, New Zealand",
      profileText: "Taylor Morgan\nSenior Software Developer\nC++ Sybase Linux ".repeat(40),
      isFromTalentPool: true,
      result: {
        name: "Taylor Morgan",
        headline: "Senior Software Developer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/taylor-morgan/",
        snippet: "Senior Software Developer in Wellington.",
        source: "serpapi",
      },
    });

    expect(priority.score).toBeGreaterThanOrEqual(80);
    expect(priority.reason.signals).toContain("Existing captured profile available");
  });
});
