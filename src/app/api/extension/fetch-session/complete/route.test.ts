import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  findSessionInQueue: vi.fn(),
  normaliseLinkedInUrl: vi.fn((url: string) => url.toLowerCase()),
  saveCapturedProfileToCandidate: vi.fn(),
  updateSessionInQueue: vi.fn(),
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);

import { POST } from "./route";

describe("extension capture completion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(res.status).toBe(200);
    expect(body.id).toBe("cand-4");
    expect(linkedinCaptureMocks.saveCapturedProfileToCandidate).toHaveBeenCalledTimes(1);
    expect(linkedinCaptureMocks.updateSessionInQueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", status: "completed" })
    );
  });
});
