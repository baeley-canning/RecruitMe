import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  findSessionInQueue: vi.fn(),
  linkedInProfileMatches: vi.fn((a: string, b: string) => a.toLowerCase() === b.toLowerCase()),
  saveCapturedProfileToCandidate: vi.fn(),
  updateSessionInQueue: vi.fn(),
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);

import { POST } from "./route";

describe("extension capture completion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linkedinCaptureMocks.linkedInProfileMatches.mockImplementation(
      (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    );
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({
      sessionId: "sess-1",
      jobId: "job-1",
      candidateId: "cand-4",
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      candidateName: "Pat Lee",
      status: "pending",
      message: "Waiting for capture",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    linkedinCaptureMocks.saveCapturedProfileToCandidate.mockResolvedValue({
      id: "cand-4",
      name: "Pat Lee",
      source: "extension",
    });
  });

  it("completes a pending extension capture and marks the session completed", async () => {
    const req = new Request("http://localhost/api/extension/fetch-session/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-1",
        linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
        profileText: "Pat Lee\nSenior Software Engineer at Acme Corp\nAbout\nExperienced engineer with a decade of full-stack development. Strong background in distributed systems, cloud infrastructure, and team leadership. Based in Wellington, New Zealand.",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.status).toBe("processing");
    expect(linkedinCaptureMocks.saveCapturedProfileToCandidate).toHaveBeenCalledTimes(1);
    expect(linkedinCaptureMocks.updateSessionInQueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", status: "completed" })
    );
  });

  it("accepts a LinkedIn canonical redirect URL when it matches the queued profile alias", async () => {
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({
      sessionId: "sess-ranjana",
      jobId: "job-1",
      candidateId: "cand-ranjana",
      linkedinUrl: "https://www.linkedin.com/in/ranjana-tyagi-3755b615/",
      candidateName: "Ranjana Tyagi",
      status: "pending",
      message: "Waiting for capture",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    linkedinCaptureMocks.linkedInProfileMatches.mockImplementation(
      (a: string, b: string) =>
        a.includes("ranjana-tyagi-3755b615") && b.includes("ranjanatyagi")
    );

    const req = new Request("http://localhost/api/extension/fetch-session/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-ranjana",
        linkedinUrl: "https://www.linkedin.com/in/ranjanatyagi/",
        profileText: "Ranjana Tyagi\n.NET Developer\nExperience\nSenior developer with extensive API design, Azure, SQL Server, ETL, and data engineering experience in Wellington, New Zealand.",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(linkedinCaptureMocks.saveCapturedProfileToCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "cand-ranjana",
        linkedinUrl: "https://www.linkedin.com/in/ranjanatyagi/",
      })
    );
  });
});
