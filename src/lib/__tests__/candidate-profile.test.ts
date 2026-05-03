import { describe, expect, it } from "vitest";
import { hasFullCandidateProfile, sanitizeCandidateProfileDraft } from "../candidate-profile";

describe("hasFullCandidateProfile", () => {
  it("accepts long profile text without a capture timestamp", () => {
    expect(
      hasFullCandidateProfile({
        profileCapturedAt: null,
        profileText: "Long profile. ".repeat(170),
      })
    ).toBe(true);
  });

  it("accepts shorter extension captures once they have a capture timestamp", () => {
    expect(
      hasFullCandidateProfile({
        profileCapturedAt: new Date("2026-05-03T00:00:00.000Z"),
        profileText: "Captured LinkedIn profile. ".repeat(25),
      })
    ).toBe(true);
  });

  it("rejects short search snippets", () => {
    expect(
      hasFullCandidateProfile({
        profileCapturedAt: null,
        profileText: "Short search snippet",
      })
    ).toBe(false);
  });
});

describe("sanitizeCandidateProfileDraft", () => {
  const source = `
Jane Candidate
Senior Data Engineer at Acme Data, January 2022 - Present
Built Azure Data Factory pipelines and SQL Server data warehouse models.
Bachelor of Computer Science, Victoria University, 2016
Available in four weeks.
`;

  it("keeps only facts with evidence quotes found in the source text", () => {
    const draft = sanitizeCandidateProfileDraft(
      {
        candidate: { value: "Jane Candidate", evidence_quote: "Jane Candidate" },
        role: { value: "Senior Data Engineer", evidence_quote: "Senior Data Engineer at Acme Data" },
        dateAvailable: { value: "Four weeks", evidence_quote: "Available in four weeks" },
        executiveSummary: [
          {
            text: "Jane is a Senior Data Engineer with Azure Data Factory and SQL Server experience.",
            evidence_quote: "Built Azure Data Factory pipelines and SQL Server data warehouse models.",
          },
          {
            text: "Jane has led teams of 20 people.",
            evidence_quote: "led teams of 20 people",
          },
        ],
        workHistory: [
          {
            company: { value: "Acme Data", evidence_quote: "Senior Data Engineer at Acme Data" },
            role: { value: "Senior Data Engineer", evidence_quote: "Senior Data Engineer at Acme Data" },
            dates: { value: "January 2022 - Present", evidence_quote: "January 2022 - Present" },
            bullets: [
              {
                text: "Built Azure Data Factory pipelines and SQL Server data warehouse models.",
                evidence_quote: "Built Azure Data Factory pipelines and SQL Server data warehouse models.",
              },
            ],
          },
        ],
        education: [
          {
            institution: { value: "Victoria University", evidence_quote: "Victoria University" },
            course: { value: "Bachelor of Computer Science", evidence_quote: "Bachelor of Computer Science" },
            year: { value: "2016", evidence_quote: "Victoria University, 2016" },
          },
        ],
      },
      source
    );

    expect(draft.candidate).toBe("Jane Candidate");
    expect(draft.executiveSummary).toContain("Azure Data Factory");
    expect(draft.executiveSummary).not.toContain("led teams");
    expect(draft.workHistory[0].company).toBe("Acme Data");
    expect(draft.education[0].institution).toBe("Victoria University");
    expect(draft.discardedUnsupportedFacts).toBe(1);
  });
});
