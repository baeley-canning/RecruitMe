import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  addSessionToQueue: vi.fn(),
  findSessionInQueue: vi.fn(),
  getSessionQueue: vi.fn(),
  normaliseLinkedInUrl: vi.fn((url: string) => url.toLowerCase()),
  removeSessionFromQueue: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  requireJobAccess: vi.fn(),
  verifyAnyAuth: vi.fn(),
  verifyExtensionAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);
vi.mock("@/lib/session", () => sessionMocks);
vi.mock("@/lib/db", () => dbMocks);

import { GET } from "./route";

describe("extension fetch-session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows web UI polling by unguessable session id even when auth cookies are unavailable", async () => {
    sessionMocks.verifyAnyAuth.mockResolvedValue(null);
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({
      sessionId: "sess-1",
      userId: "user-1",
      orgId: "org-1",
      jobId: "job-1",
      candidateId: "cand-1",
      linkedinUrl: "https://www.linkedin.com/in/michael-scanlon/",
      candidateName: "Michael Scanlon",
      status: "pending",
      message: "Waiting for browser extension to capture the profile",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await GET(
      new Request("http://localhost/api/extension/fetch-session?sessionId=sess-1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessionId).toBe("sess-1");
    expect(body.status).toBe("pending");
  });

  it("blocks authenticated users from polling someone else's session", async () => {
    sessionMocks.verifyAnyAuth.mockResolvedValue({ userId: "user-2", orgId: "org-2", isOwner: false });
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({
      sessionId: "sess-1",
      userId: "user-1",
      orgId: "org-1",
      jobId: "job-1",
      candidateId: "cand-1",
      linkedinUrl: "https://www.linkedin.com/in/michael-scanlon/",
      candidateName: "Michael Scanlon",
      status: "pending",
      message: "Waiting for browser extension to capture the profile",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await GET(
      new Request("http://localhost/api/extension/fetch-session?sessionId=sess-1")
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden");
  });
});
