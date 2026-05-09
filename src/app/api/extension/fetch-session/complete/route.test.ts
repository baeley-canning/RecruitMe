import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  findSessionInQueue: vi.fn(),
  linkedInProfileMatches: vi.fn((a: string, b: string) => a.toLowerCase() === b.toLowerCase()),
  saveCapturedProfileFast: vi.fn(),
  applyAiEnrichmentInBackground: vi.fn(),
  updateSessionInQueue: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({
  verifyExtensionAuth: vi.fn(async () => ({ userId: "u-1", orgId: "org-1", isOwner: false })),
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);
vi.mock("@/lib/session", () => sessionMocks);

const AUTH_HEADER = { "Content-Type": "application/json", Authorization: "Basic dXNlcjpwYXNz" };

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
    linkedinCaptureMocks.saveCapturedProfileFast.mockResolvedValue({
      candidate: { id: "cand-4", name: "Pat Lee", source: "extension" },
      identity: { profileTextHash: "hash-1", profileUnchanged: false },
    });
    linkedinCaptureMocks.applyAiEnrichmentInBackground.mockResolvedValue({ applied: true });
  });

  it("returns 202 immediately after stage 1 fast-save and fires stage 2 in background", async () => {
    const req = new Request("http://localhost/api/extension/fetch-session/complete", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        sessionId: "sess-1",
        linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
        profileText: "Pat Lee\nSenior Software Engineer at Acme Corp\nAbout\nExperienced engineer with a decade of full-stack development. Strong background in distributed systems, cloud infrastructure, and team leadership. Based in Wellington, New Zealand.",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.status).toBe("processing");
    // Stage 1 ran synchronously before the response.
    expect(linkedinCaptureMocks.saveCapturedProfileFast).toHaveBeenCalledTimes(1);
    expect(linkedinCaptureMocks.saveCapturedProfileFast).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "cand-4",
        jobId: "job-1",
      })
    );
    // Session was marked "processing" between stage 1 and the 202.
    expect(linkedinCaptureMocks.updateSessionInQueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", status: "processing" })
    );

    // Stage 2 fires as a background promise — wait a microtask for it to start.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(linkedinCaptureMocks.applyAiEnrichmentInBackground).toHaveBeenCalledTimes(1);
    expect(linkedinCaptureMocks.applyAiEnrichmentInBackground).toHaveBeenCalledWith(
      "cand-4",
      expect.objectContaining({ profileTextHash: "hash-1" })
    );
    // Eventually marks session "completed".
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
      headers: AUTH_HEADER,
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
    expect(linkedinCaptureMocks.saveCapturedProfileFast).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "cand-ranjana",
        linkedinUrl: "https://www.linkedin.com/in/ranjanatyagi/",
      })
    );
  });

  it("returns 500 if stage 1 (fast save) fails — recruiter must see this immediately", async () => {
    linkedinCaptureMocks.saveCapturedProfileFast.mockRejectedValue(new Error("Candidate not found"));

    const req = new Request("http://localhost/api/extension/fetch-session/complete", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        sessionId: "sess-1",
        linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
        profileText: "Pat Lee\nSenior Software Engineer at Acme Corp\nAbout\nExperienced engineer with a decade of full-stack development. Strong background in distributed systems, cloud infrastructure, and team leadership. Based in Wellington, New Zealand.",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    expect(linkedinCaptureMocks.updateSessionInQueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", status: "error" })
    );
    // Stage 2 must not fire when stage 1 failed.
    expect(linkedinCaptureMocks.applyAiEnrichmentInBackground).not.toHaveBeenCalled();
  });

  it("marks session errored when stage 2 (AI scoring) crashes — but stage 1 had already saved profileText", async () => {
    linkedinCaptureMocks.applyAiEnrichmentInBackground.mockRejectedValue(new Error("Claude API down"));

    const req = new Request("http://localhost/api/extension/fetch-session/complete", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        sessionId: "sess-1",
        linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
        profileText: "Pat Lee\nSenior Software Engineer at Acme Corp\nAbout\nExperienced engineer with a decade of full-stack development. Strong background in distributed systems, cloud infrastructure, and team leadership. Based in Wellington, New Zealand.",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(202); // stage 1 succeeded
    // Wait for the background promise to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(linkedinCaptureMocks.updateSessionInQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        status: "error",
        message: expect.stringContaining("Captured but scoring failed"),
      })
    );
  });
});
