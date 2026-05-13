import { describe, expect, it } from "vitest";
import {
  isProtectedStatus,
  mapSheetStatusToCandidateStatus,
  normaliseSheetLinkedInUrl,
  parseLastContactedCell,
  pickBestJob,
  titleSimilarity,
} from "../normalize";

describe("mapSheetStatusToCandidateStatus", () => {
  it("maps 'JD sent' to contacted + isContactTouch", () => {
    expect(mapSheetStatusToCandidateStatus("JD sent")).toEqual({ mapped: "contacted", isContactTouch: true });
    expect(mapSheetStatusToCandidateStatus("JD SENT")).toEqual({ mapped: "contacted", isContactTouch: true });
    expect(mapSheetStatusToCandidateStatus("message sent")).toEqual({ mapped: "contacted", isContactTouch: true });
  });

  it("maps 'Not interested' family to declined (NOT a contact touch — candidate said no)", () => {
    expect(mapSheetStatusToCandidateStatus("Not interested")).toEqual({ mapped: "declined", isContactTouch: false });
    expect(mapSheetStatusToCandidateStatus("Not interested/not looking")).toEqual({ mapped: "declined", isContactTouch: false });
    expect(mapSheetStatusToCandidateStatus("declined")).toEqual({ mapped: "declined", isContactTouch: false });
  });

  it("'Interested' leaves status unchanged but still logs a contact touch", () => {
    expect(mapSheetStatusToCandidateStatus("Interested")).toEqual({ mapped: "no_change", isContactTouch: true });
    expect(mapSheetStatusToCandidateStatus("Interested but not further replies.")).toEqual({ mapped: "no_change", isContactTouch: true });
  });

  it("empty status → no_change, no touch", () => {
    expect(mapSheetStatusToCandidateStatus("")).toEqual({ mapped: "no_change", isContactTouch: false });
    expect(mapSheetStatusToCandidateStatus("   ")).toEqual({ mapped: "no_change", isContactTouch: false });
  });

  it("unrecognised values surface as 'unknown' so the planner can skip", () => {
    expect(mapSheetStatusToCandidateStatus("something-else")).toEqual({ mapped: "unknown", isContactTouch: false });
  });

  it("'Not interested' wins over the 'interested' substring (longest-match rule)", () => {
    // Guards a regression where a naive contains("interested") would
    // misroute "Not interested" into the no_change branch.
    expect(mapSheetStatusToCandidateStatus("Not interested at this time").mapped).toBe("declined");
  });
});

describe("isProtectedStatus", () => {
  it("treats downstream pipeline states as protected from sheet overwrites", () => {
    expect(isProtectedStatus("shortlisted")).toBe(true);
    expect(isProtectedStatus("interviewing")).toBe(true);
    expect(isProtectedStatus("offer_sent")).toBe(true);
    expect(isProtectedStatus("hired")).toBe(true);
  });

  it("does NOT protect early-pipeline states", () => {
    expect(isProtectedStatus("new")).toBe(false);
    expect(isProtectedStatus("reviewing")).toBe(false);
    expect(isProtectedStatus("contacted")).toBe(false);
    expect(isProtectedStatus("declined")).toBe(false);
    expect(isProtectedStatus("rejected")).toBe(false);
  });
});

describe("titleSimilarity", () => {
  it("scores high on common abbreviations + punctuation differences", () => {
    expect(titleSimilarity("Sr. Full Stack Dev", "Senior Full-Stack Developer")).toBeGreaterThan(0.7);
    expect(titleSimilarity("Project Manager RFP RFI", "Project Manager")).toBeGreaterThan(0.7);
  });

  it("scores low on genuinely different titles", () => {
    expect(titleSimilarity("Tech Support", "Sales Manager")).toBeLessThan(0.5);
  });

  it("returns 0 for empty input either side", () => {
    expect(titleSimilarity("", "anything")).toBe(0);
    expect(titleSimilarity("anything", "")).toBe(0);
  });
});

describe("pickBestJob", () => {
  const jobs = [
    { id: "j1", title: "Senior Full-Stack Developer" },
    { id: "j2", title: "Technical Support & Sales Engineer – Power & SCADA" },
    { id: "j3", title: "Project Manager" },
  ];

  it("picks the best fuzzy match above the threshold", () => {
    const m = pickBestJob("Sr Full Stack Dev", jobs);
    expect(m?.id).toBe("j1");
  });

  it("returns null when nothing scores above 0.7", () => {
    expect(pickBestJob("Marketing Director", jobs)).toBeNull();
  });

  it("returns null when two candidates are within 10% of each other (ambiguous)", () => {
    const ambiguousJobs = [
      { id: "a", title: "Software Developer" },
      { id: "b", title: "Senior Software Developer" },
    ];
    // "software developer" matches both perfectly — should refuse to guess.
    expect(pickBestJob("Software Developer", ambiguousJobs)).toBeNull();
  });
});

describe("normaliseSheetLinkedInUrl", () => {
  it("returns the canonical form for a valid LinkedIn URL", () => {
    expect(normaliseSheetLinkedInUrl("https://www.linkedin.com/in/rohit-prasad-7a440040/"))
      .toBe("https://www.linkedin.com/in/rohit-prasad-7a440040");
  });

  it("returns empty for non-LinkedIn URLs (so the planner can skip)", () => {
    expect(normaliseSheetLinkedInUrl("https://example.com/in/someone")).toBe("");
    expect(normaliseSheetLinkedInUrl("")).toBe("");
    expect(normaliseSheetLinkedInUrl("just a name")).toBe("");
  });
});

describe("parseLastContactedCell", () => {
  it("parses ISO dates", () => {
    expect(parseLastContactedCell("2026-05-10")?.toISOString().slice(0, 10)).toBe("2026-05-10");
  });

  it("parses DMY (NZ/AU)", () => {
    expect(parseLastContactedCell("10/05/2026")?.toISOString().slice(0, 10)).toBe("2026-05-10");
  });

  it("returns null for empty / unparseable cells", () => {
    expect(parseLastContactedCell("")).toBeNull();
    expect(parseLastContactedCell("   ")).toBeNull();
    expect(parseLastContactedCell("not a date")).toBeNull();
  });
});
