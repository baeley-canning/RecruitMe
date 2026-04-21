import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  findSessionInQueue: vi.fn(),
  updateSessionInQueue: vi.fn(),
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);

import { POST } from "./route";

describe("extension capture error route", () => {
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
    linkedinCaptureMocks.updateSessionInQueue.mockResolvedValue({
      sessionId: "sess-1",
      status: "error",
      message: "RecruitMe could not attach to the LinkedIn tab.",
      error: "RecruitMe could not attach to the LinkedIn tab.",
    });
  });

  it("marks a pending extension capture as failed", async () => {
    const req = new Request("http://localhost/api/extension/fetch-session/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-1",
        error: "RecruitMe could not attach to the LinkedIn tab.",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("error");
    expect(linkedinCaptureMocks.updateSessionInQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        status: "error",
        error: "RecruitMe could not attach to the LinkedIn tab.",
      })
    );
  });
});
