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
  it("returns a usable prefill from parsed role data (source: ai)", () => {
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
      source: "ai",
    });
  });

  it("returns null when nothing useful was parsed and no jdText fallback provided", () => {
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

  it("falls back to regex extraction when AI returns empty title — uses jdText first line", () => {
    const result = deriveJobBriefUploadPrefill(
      { title: "", company: "", location: "" },
      "Technical Support and Sales Engineer - POWER\n\nResponsible to:\nTechnical Support and Sales Engineer Manager\nLocation: Wellington, New Zealand\n",
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Technical Support and Sales Engineer - POWER");
    expect(result?.location).toBe("Wellington, New Zealand");
    expect(result?.source).toBe("merged");
  });

  it("AI fields take precedence over regex when both present", () => {
    const result = deriveJobBriefUploadPrefill(
      { title: "AI-extracted Title", company: "", location: "Auckland" },
      "Some Other Title\nLocation: Wellington\n",
    );
    expect(result?.title).toBe("AI-extracted Title");   // AI wins
    expect(result?.location).toBe("Auckland");          // AI wins
  });
});
