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
  anchor_terms: ["C++", "Sybase"],
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
    expect(priority.reason.matchedTerms).toEqual(expect.arrayContaining(["c++", "sybase", "linux"]));
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

  it("does not use matchedQuery as candidate evidence", () => {
    const priority = computeFetchPriority({
      parsedRole: role,
      candidateLocation: "Wellington, New Zealand",
      result: {
        name: "Query Only",
        headline: "Enterprise Software Developer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/query-only/",
        snippet: "Experienced enterprise developer with government delivery background.",
        matchedQuery: "C++ Sybase Linux developer Wellington",
        source: "serpapi",
      },
    });

    expect(priority.reason.signals.join(" ")).not.toMatch(/C\+\+|Sybase|high-intent query/i);
    expect(priority.reason.matchedTerms).not.toEqual(expect.arrayContaining(["c++", "sybase", "linux"]));
    expect(priority.score).toBeLessThan(65);
  });

  it("does not let matchedQuery-only anchor text erase specialist risk", () => {
    const priority = computeFetchPriority({
      parsedRole: role,
      result: {
        name: "Matched Query Only",
        headline: "Senior Software Engineer",
        location: "",
        linkedinUrl: "https://www.linkedin.com/in/matched-query-only/",
        snippet: "Builds React and TypeScript applications.",
        matchedQuery: "C++ Sybase",
        source: "serpapi",
      },
    });

    expect(priority.reason.risks.join(" ")).toMatch(/Missing 2 of 2 anchor terms|Few must-have/i);
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

  it("does not treat soft behavioural requirements as fetch-priority evidence", () => {
    const priority = computeFetchPriority({
      parsedRole: {
        ...role,
        must_haves: [
          "Excellent stakeholder management and communication skills",
          "Proven track record of delivering large-scale solutions",
          "Strong analytical and problem-solving skills",
        ],
        skills_required: [],
        knockout_criteria: [],
      },
      candidateLocation: "Wellington, New Zealand",
      result: {
        name: "Morgan Lee",
        headline: "Senior Software Developer",
        location: "Wellington, New Zealand",
        linkedinUrl: "https://www.linkedin.com/in/morgan-lee/",
        snippet: "Senior developer with stakeholder management, solutions delivery and analytical problem solving.",
        matchedQuery: "software developer Wellington",
        source: "serpapi",
      },
    });

    expect(priority.reason.signals.join(" ")).not.toMatch(/Must-have evidence/i);
    expect(priority.reason.matchedTerms).not.toEqual(
      expect.arrayContaining(["stakeholder", "management", "solutions", "analytical"])
    );
  });
});
