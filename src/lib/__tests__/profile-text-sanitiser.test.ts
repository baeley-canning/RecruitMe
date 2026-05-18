import { describe, expect, it } from "vitest";
import {
  containsRecruiterAnnotations,
  sanitiseProfileTextForInsight,
} from "../profile-text-sanitiser";

describe("sanitiseProfileTextForInsight", () => {
  it("returns empty result for empty input", () => {
    expect(sanitiseProfileTextForInsight("")).toEqual({
      sanitised: "",
      droppedLines: 0,
      totalLines: 0,
    });
  });

  it("preserves a clean CV unchanged", () => {
    const cv = [
      "Jane Doe",
      "Senior Software Engineer",
      "Wellington, NZ",
      "",
      "WORK EXPERIENCE",
      "Senior Engineer · Acme Corp · 2020-present",
      "  - Led TypeScript migration of legacy codebase",
      "",
      "EDUCATION",
      "BSc Computer Science · University of Auckland · 2015",
    ].join("\n");
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.sanitised).toBe(cv);
    expect(r.droppedLines).toBe(0);
  });

  it("strips a recruiter-only note line (the Critic A §4 leak scenario)", () => {
    const cv = [
      "Jane Doe",
      "Senior Software Engineer",
      "Internal note: applicant disclosed migraines, may need accommodations",
      "WORK EXPERIENCE",
      "Senior Engineer · Acme Corp · 2020-present",
    ].join("\n");
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.droppedLines).toBe(1);
    expect(r.sanitised).not.toMatch(/migraines/i);
    expect(r.sanitised).toMatch(/Jane Doe/);
    expect(r.sanitised).toMatch(/WORK EXPERIENCE/);
  });

  it("strips multiple recruiter note variants", () => {
    const cv = [
      "Jane Doe",
      "Recruiter note: candidate is on a 4-week notice",
      "HR note: not yet briefed on the role",
      "Spoke to candidate last Tuesday",
      "[NOTE] strong reference from past manager",
      "Senior Software Engineer at Acme",
    ].join("\n");
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.droppedLines).toBe(4);
    expect(r.sanitised).not.toMatch(/recruiter note/i);
    expect(r.sanitised).not.toMatch(/HR note/i);
    expect(r.sanitised).not.toMatch(/Spoke to candidate/i);
    expect(r.sanitised).not.toMatch(/\[NOTE\]/i);
    expect(r.sanitised).toMatch(/Senior Software Engineer at Acme/);
  });

  it("is case-insensitive on patterns", () => {
    const r = sanitiseProfileTextForInsight("INTERNAL NOTE: this is private\nNormal content");
    expect(r.droppedLines).toBe(1);
    expect(r.sanitised).toBe("Normal content");
  });

  it("preserves blank lines (they delimit CV sections)", () => {
    const cv = "Section A\n\nSection B\n\nSection C";
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.sanitised).toBe(cv);
    expect(r.droppedLines).toBe(0);
    expect(r.totalLines).toBe(5);
  });

  it("does NOT strip lines that merely contain a pattern phrase mid-line", () => {
    // The phrase "internal note" appears mid-sentence; we only strip lines
    // that START with the pattern. Conservative false-positive protection.
    const cv = "We followed our internal note on the migration approach";
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.droppedLines).toBe(0);
    expect(r.sanitised).toBe(cv);
  });

  it("handles CRLF line endings", () => {
    const cv = "Jane Doe\r\nInternal note: private\r\nSenior Engineer";
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.droppedLines).toBe(1);
    expect(r.sanitised).toMatch(/Jane Doe/);
    expect(r.sanitised).toMatch(/Senior Engineer/);
    expect(r.sanitised).not.toMatch(/private/i);
  });

  it("strips screening-data shapes (salary expectation, notice period)", () => {
    const cv = [
      "Jane Doe",
      "Salary expectation: $150k",
      "Notice period: 4 weeks",
      "Availability: immediate",
      "Senior Software Engineer",
    ].join("\n");
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.droppedLines).toBe(3);
    expect(r.sanitised).not.toMatch(/Salary expectation/i);
    expect(r.sanitised).not.toMatch(/Notice period/i);
    expect(r.sanitised).not.toMatch(/Availability/i);
    expect(r.sanitised).toMatch(/Senior Software Engineer/);
  });

  it("reports totalLines accurately", () => {
    const cv = ["a", "b", "c", "d"].join("\n");
    const r = sanitiseProfileTextForInsight(cv);
    expect(r.totalLines).toBe(4);
  });
});

describe("containsRecruiterAnnotations", () => {
  it("returns true when at least one annotation line is present", () => {
    expect(containsRecruiterAnnotations("Internal note: foo\nCV body")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsRecruiterAnnotations("Just a normal CV body")).toBe(false);
    expect(containsRecruiterAnnotations("")).toBe(false);
  });
});
