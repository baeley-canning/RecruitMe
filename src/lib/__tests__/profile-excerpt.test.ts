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
});
