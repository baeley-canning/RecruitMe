import { describe, expect, it } from "vitest";
import {
  buildProfileExcerpt,
  buildRequirementAwareProfileExcerpt,
} from "../profile-excerpt";

describe("buildRequirementAwareProfileExcerpt", () => {
  it("preserves deep historical evidence for distinctive requirements", () => {
    const earlyExperience = Array.from({ length: 90 }, (_, index) =>
      `Recent programme leadership line ${index + 1} with delivery governance and stakeholder management.`
    ).join("\n");
    const historicalSybaseRole = [
      "Contract Sybase DBA",
      "Capella Consulting / IBM NZ Global Technology Services",
      "Enhancing Sybase housekeeping scripts/processes in Talisman.",
      "Investigating and reporting data extract performance issues with Talisman application.",
    ].join("\n");
    const profileText = [
      "Michael Scanlon",
      "Practice Lead | ICT Programme & Delivery Leadership",
      "Martinborough, Wellington, New Zealand",
      "About",
      "Experienced ICT leader with 20+ years across delivery and database engineering.",
      "Experience",
      earlyExperience,
      historicalSybaseRole,
    ].join("\n");

    const baseline = buildProfileExcerpt(profileText, 1200);
    const requirementAware = buildRequirementAwareProfileExcerpt(profileText, 1200, [
      "Sybase database experience",
      "C++ programming experience",
    ]);

    expect(baseline).not.toContain("Sybase");
    expect(requirementAware).toContain("Contract Sybase DBA");
    expect(requirementAware).toContain("Enhancing Sybase housekeeping");
  });

  it("uses the shared requirement signals for newer role families", () => {
    const filler = Array.from({ length: 70 }, (_, index) =>
      `Recent delivery summary ${index + 1} covering roadmap, stakeholders and release planning.`
    ).join("\n");
    const historicalTestingRole = [
      "Senior QA Automation Engineer",
      "Built Selenium regression suites for payment workflows.",
      "Used Playwright for cross-browser smoke coverage.",
    ].join("\n");
    const profileText = [
      "Avery Chen",
      "Delivery Lead",
      "About",
      "Delivery and quality specialist.",
      "Experience",
      filler,
      historicalTestingRole,
    ].join("\n");

    const baseline = buildProfileExcerpt(profileText, 900);
    const requirementAware = buildRequirementAwareProfileExcerpt(profileText, 900, [
      "Experience with Selenium or similar test automation frameworks",
      "Playwright experience",
    ]);

    expect(baseline).not.toContain("Selenium regression");
    expect(requirementAware).toContain("Senior QA Automation Engineer");
    expect(requirementAware).toContain("Built Selenium regression suites");
    expect(requirementAware).toContain("Used Playwright");
  });

  it("does not preserve irrelevant NoSQL lines for a SQL requirement", () => {
    const filler = Array.from({ length: 70 }, (_, index) =>
      `Recent software delivery line ${index + 1} with API ownership.`
    ).join("\n");
    const profileText = [
      "Jamie Patel",
      "Backend Engineer",
      "About",
      "Backend engineer.",
      "Experience",
      filler,
      "Built NoSQL document models with MongoDB.",
    ].join("\n");

    const requirementAware = buildRequirementAwareProfileExcerpt(profileText, 900, [
      "SQL and relational database experience",
    ]);

    expect(requirementAware).not.toContain("Built NoSQL document models");
  });
});
