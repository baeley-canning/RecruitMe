import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  findSessionInQueue: vi.fn(),
  updateSessionInQueue: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({
  verifyExtensionAuth: vi.fn(
    async (): Promise<{ userId: string; orgId: string | null; isOwner: boolean } | null> => ({
      userId: "u-1", orgId: "org-1", isOwner: false,
    })
  ),
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);
vi.mock("@/lib/session", () => sessionMocks);

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

  it("returns 401 when no auth header is present", async () => {
    sessionMocks.verifyExtensionAuth.mockResolvedValueOnce(null);
    const req = new Request("http://localhost/api/extension/fetch-session/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-1", error: "boom" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(linkedinCaptureMocks.updateSessionInQueue).not.toHaveBeenCalled();
  });

  it("returns 403 when the session belongs to a different org", async () => {
    sessionMocks.verifyExtensionAuth.mockResolvedValueOnce({ userId: "u-attacker", orgId: "org-attacker", isOwner: false });
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValueOnce({
      sessionId: "sess-target",
      jobId: "job-1",
      candidateId: "cand-target",
      linkedinUrl: "https://www.linkedin.com/in/pat-lee/",
      candidateName: "Pat Lee",
      status: "pending",
      message: "Waiting for capture",
      userId: "u-victim",
      orgId: "org-victim",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const req = new Request("http://localhost/api/extension/fetch-session/error", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic dXNlcjpwYXNz" },
      body: JSON.stringify({ sessionId: "sess-target", error: "boom" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(linkedinCaptureMocks.updateSessionInQueue).not.toHaveBeenCalled();
  });

  it("marks a pending extension capture as failed", async () => {
    const req = new Request("http://localhost/api/extension/fetch-session/error", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic dXNlcjpwYXNz" },
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
