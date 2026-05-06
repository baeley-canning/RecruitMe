import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: { job: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/db", () => dbMocks);

import { GET } from "./route";

describe("public shortlist route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects short tokens (defends against URL truncation / brute-force)", async () => {
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ token: "short" }),
    });
    expect(res.status).toBe(404);
    expect(dbMocks.prisma.job.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when token doesn't match a job", async () => {
    dbMocks.prisma.job.findUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ token: "a".repeat(43) }),
    });
    expect(res.status).toBe(404);
  });

  it("returns shortlisted candidates with safe fields only", async () => {
    dbMocks.prisma.job.findUnique.mockResolvedValue({
      id: "job-1",
      title: "Senior Engineer",
      company: "Acme",
      location: "Wellington",
      parsedRole: JSON.stringify({ must_haves: ["React", "Rails"] }),
      candidates: [
        {
          id: "c1",
          name: "Alex",
          headline: "Eng",
          location: "Wellington",
          linkedinUrl: "https://www.linkedin.com/in/alex/",
          matchScore: 88,
          scoreBreakdown: JSON.stringify({
            recruiter_summary: "Strong match.",
            reasons_for: ["Rails depth"],
            reasons_against: ["No NZ exposure"],
            // Notes/etc shouldn't be returned even if accidentally present
            notes: "INTERNAL — do not share",
          }),
        },
      ],
    });
    const res = await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ token: "a".repeat(43) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.title).toBe("Senior Engineer");
    expect(body.job.mustHaves).toEqual(["React", "Rails"]);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].summary).toBe("Strong match.");
    expect(body.candidates[0].strengths).toEqual(["Rails depth"]);
    expect(body.candidates[0].gaps).toEqual(["No NZ exposure"]);
    // Internal-only fields should never appear
    expect(JSON.stringify(body)).not.toContain("INTERNAL");
    expect(body.candidates[0]).not.toHaveProperty("notes");
    expect(body.candidates[0]).not.toHaveProperty("status");
    expect(body.candidates[0]).not.toHaveProperty("scoreBreakdown");
  });

  it("scopes candidate query to status=shortlisted", async () => {
    dbMocks.prisma.job.findUnique.mockResolvedValue({
      id: "job-1",
      title: "T", company: null, location: null,
      parsedRole: null,
      candidates: [],
    });
    await GET(new Request("http://localhost/"), {
      params: Promise.resolve({ token: "a".repeat(43) }),
    });
    const call = dbMocks.prisma.job.findUnique.mock.calls[0][0];
    expect(call.where).toEqual({ shareToken: "a".repeat(43) });
    expect(call.select.candidates.where).toEqual({ status: "shortlisted" });
  });
});
