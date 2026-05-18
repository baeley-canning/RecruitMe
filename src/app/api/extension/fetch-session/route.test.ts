import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  addSessionToQueue: vi.fn(),
  findSessionInQueue: vi.fn(),
  getSessionQueue: vi.fn(),
  normaliseLinkedInUrl: vi.fn((url: string) => url.toLowerCase()),
  removeSessionFromQueue: vi.fn(),
  updateSessionInQueue: vi.fn(),
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

import { DELETE, GET, PATCH } from "./route";

const baseSession = {
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
};

describe("extension fetch-session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows web UI polling by unguessable session id even when auth cookies are unavailable", async () => {
    sessionMocks.verifyAnyAuth.mockResolvedValue(null);
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue(baseSession);

    const res = await GET(
      new Request("http://localhost/api/extension/fetch-session?sessionId=sess-1")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessionId).toBe("sess-1");
    expect(body.status).toBe("pending");
    expect(body.candidateName).toBeUndefined();
    expect(body.linkedinUrl).toBeUndefined();
    expect(body.candidateId).toBeUndefined();
    expect(body.orgId).toBeUndefined();
  });

  it("blocks authenticated users from polling someone else's session", async () => {
    sessionMocks.verifyAnyAuth.mockResolvedValue({ userId: "user-2", orgId: "org-2", isOwner: false });
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue(baseSession);

    const res = await GET(
      new Request("http://localhost/api/extension/fetch-session?sessionId=sess-1")
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("does not allow missing userId to bypass org checks", async () => {
    sessionMocks.verifyExtensionAuth.mockResolvedValue({ userId: "user-2", orgId: "org-2", isOwner: false });
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({ ...baseSession, userId: undefined, orgId: "org-1" });

    const res = await PATCH(new Request("http://localhost/api/extension/fetch-session", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-1", status: "processing" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden");
    expect(linkedinCaptureMocks.updateSessionInQueue).not.toHaveBeenCalled();
  });

  it("requires access to the requested job before listing in-progress sessions", async () => {
    sessionMocks.verifyAnyAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1", isOwner: false });
    sessionMocks.requireJobAccess.mockResolvedValue({ job: null, error: new Response(null, { status: 403 }) });

    const res = await GET(new Request("http://localhost/api/extension/fetch-session?jobId=job-2"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.sessions).toEqual([]);
    expect(linkedinCaptureMocks.getSessionQueue).not.toHaveBeenCalled();
  });

  it("does not delete another org's session when userId is missing", async () => {
    sessionMocks.verifyAnyAuth.mockResolvedValue({ userId: "user-2", orgId: "org-2", isOwner: false });
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({ ...baseSession, userId: undefined, orgId: "org-1" });

    const res = await DELETE(new Request("http://localhost/api/extension/fetch-session?sessionId=sess-1", {
      method: "DELETE",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cleared).toBe(false);
    expect(linkedinCaptureMocks.removeSessionFromQueue).not.toHaveBeenCalled();
  });
});
