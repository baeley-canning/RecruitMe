import { describe, expect, it } from "vitest";
import { inferEmploymentType } from "../search";

describe("inferEmploymentType", () => {
  it("returns 'permanent' for explicitly permanent JDs", () => {
    expect(inferEmploymentType("Permanent role based in Wellington")).toBe("permanent");
    expect(inferEmploymentType("Full-time permanent position")).toBe("permanent");
    expect(inferEmploymentType("This is a perm role, salary $130k")).toBe("permanent");
    expect(inferEmploymentType("Ongoing role with a strong delivery culture")).toBe("permanent");
  });

  it("returns 'contract' for explicit contract phrasing", () => {
    expect(inferEmploymentType("6-month contract with possible extension")).toBe("contract");
    expect(inferEmploymentType("12-month fixed-term contract")).toBe("contract");
    expect(inferEmploymentType("Interim role for 9 months")).toBe("contract");
    expect(inferEmploymentType("Day-rate contractor opportunity")).toBe("contract");
    expect(inferEmploymentType("Contract role — daily rate negotiable")).toBe("contract");
  });

  it("returns 'unknown' for ambiguous JDs (default → don't exclude contractors)", () => {
    expect(inferEmploymentType("Senior Software Engineer at Xero")).toBe("unknown");
    expect(inferEmploymentType("Looking for a Project Manager")).toBe("unknown");
    expect(inferEmploymentType("")).toBe("unknown");
    expect(inferEmploymentType(null)).toBe("unknown");
    expect(inferEmploymentType(undefined)).toBe("unknown");
  });

  it("contract phrasing wins when BOTH are present (rare but real wording)", () => {
    // JDs that say "12-month contract — permanent staff would also be
    // considered" should be treated as contract because that's the
    // recruiter's primary intent.
    expect(inferEmploymentType("12-month fixed-term role — permanent staff also considered")).toBe("contract");
    expect(inferEmploymentType("Day-rate contract role, perm conversion possible")).toBe("contract");
  });

  it("doesn't trip on words that contain 'permanent' or 'contract' substrings", () => {
    // Word-boundary protection — "subcontract" / "permanently" shouldn't fire
    // on the SUBSTRING alone. (Both happen to use \b so they match exactly,
    // confirming the patterns are word-anchored.)
    expect(inferEmploymentType("subcontracted services to multiple agencies")).toBe("unknown");
  });
});
