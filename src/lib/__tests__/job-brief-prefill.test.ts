import { describe, expect, it } from "vitest";
import { deriveJobBriefUploadPrefill, inferRemoteRole, parseSalaryBandRange } from "@/lib/job-brief-prefill";

describe("parseSalaryBandRange", () => {
  it("parses k-based salary ranges", () => {
    expect(parseSalaryBandRange("$95k-$115k NZD")).toEqual({
      min: 95000,
      max: 115000,
    });
  });

  it("parses mixed-unit salary ranges", () => {
    expect(parseSalaryBandRange("$120-$150k NZD")).toEqual({
      min: 120000,
      max: 150000,
    });
  });

  it("parses lower-bound salary hints", () => {
    expect(parseSalaryBandRange("From $130k NZD")).toEqual({
      min: 130000,
      max: null,
    });
  });
});

describe("inferRemoteRole", () => {
  it("detects fully remote roles", () => {
    expect(inferRemoteRole("Fully remote, NZ-based only")).toBe(true);
  });

  it("does not mark hybrid roles as remote", () => {
    expect(inferRemoteRole("Wellington CBD, 3 days in office")).toBe(false);
    expect(inferRemoteRole("Hybrid, Wellington office")).toBe(false);
  });
});

describe("deriveJobBriefUploadPrefill", () => {
  it("returns a usable prefill from parsed role data", () => {
    expect(
      deriveJobBriefUploadPrefill({
        title: "Senior Software Engineer",
        company: "Acme",
        location: "Wellington",
        location_rules: "Fully remote, NZ-based only",
        salary_band: "$110k-$140k NZD",
      })
    ).toEqual({
      title: "Senior Software Engineer",
      company: "Acme",
      location: "Wellington",
      isRemote: true,
      salaryEnabled: true,
      salaryMin: 110000,
      salaryMax: 140000,
    });
  });

  it("returns null when nothing useful was parsed", () => {
    expect(
      deriveJobBriefUploadPrefill({
        title: "",
        company: "",
        location: "",
        location_rules: "",
        salary_band: "",
      })
    ).toBeNull();
  });
});
