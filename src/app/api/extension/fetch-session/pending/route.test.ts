import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  findSessionInQueue: vi.fn(),
  linkedInProfileMatches: vi.fn((a: string, b: string) => a.toLowerCase() === b.toLowerCase()),
}));
const sessionMocks = vi.hoisted(() => ({
  verifyExtensionAuth: vi.fn(
    async (_req: Request): Promise<{ userId: string; orgId: string | null; isOwner: boolean } | null> => ({
      userId: "u-1", orgId: "org-1", isOwner: false,
    })
  ),
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);
vi.mock("@/lib/session", () => sessionMocks);

function authedRequest(url: string) {
  return new Request(url, { headers: { Authorization: "Basic dXNlcjpwYXNz" } });
}

import { GET } from "./route";

describe("extension fetch-session pending route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linkedinCaptureMocks.linkedInProfileMatches.mockImplementation(
      (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    );
  });

  it("returns pending for a matching pending session", async () => {
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({
      sessionId: "sess-pending",
      linkedinUrl: "https://www.linkedin.com/in/alex-legg/",
      candidateName: "Alex Legg",
      status: "pending",
      message: "Waiting for browser extension to capture the profile",
    });

    const res = await GET(
      authedRequest(
        "http://localhost/api/extension/fetch-session/pending?linkedinUrl=https%3A%2F%2Fwww.linkedin.com%2Fin%2Falex-legg%2F"
      )
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending).toBe(true);
    expect(body.active).toBe(true);
    expect(body.status).toBe("pending");
  });

  it("keeps processing sessions visible to the extension without marking them pending", async () => {
    linkedinCaptureMocks.findSessionInQueue.mockResolvedValue({
      sessionId: "sess-processing",
      linkedinUrl: "https://www.linkedin.com/in/alex-legg/",
      candidateName: "Alex Legg",
      status: "processing",
      message: "Profile received - scoring with AI",
    });

    const res = await GET(
      authedRequest(
        "http://localhost/api/extension/fetch-session/pending?linkedinUrl=https%3A%2F%2Fwww.linkedin.com%2Fin%2Falex-legg%2F"
      )
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending).toBe(false);
    expect(body.active).toBe(true);
    expect(body.status).toBe("processing");
    expect(body.message).toBe("Profile received - scoring with AI");
  });

  it("returns 401 when no auth header is present", async () => {
    sessionMocks.verifyExtensionAuth.mockResolvedValueOnce(null);
    const res = await GET(new Request("http://localhost/api/extension/fetch-session/pending?linkedinUrl=https%3A%2F%2Fwww.linkedin.com%2Fin%2Falex%2F"));
    expect(res.status).toBe(401);
    expect(linkedinCaptureMocks.findSessionInQueue).not.toHaveBeenCalled();
  });

  it("hides a session from a different org from a non-owner caller", async () => {
    // Caller is org-1, session belongs to org-2 — predicate must reject it.
    sessionMocks.verifyExtensionAuth.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", isOwner: false });
    linkedinCaptureMocks.findSessionInQueue.mockImplementation(async (predicate: (session: { linkedinUrl: string; status: string; userId?: string; orgId?: string }) => boolean) => {
      const session = {
        sessionId: "sess-org2",
        linkedinUrl: "https://www.linkedin.com/in/alex/",
        status: "pending",
        userId: "u-2",
        orgId: "org-2",
      };
      return predicate(session) ? session : null;
    });

    const res = await GET(authedRequest("http://localhost/api/extension/fetch-session/pending?linkedinUrl=https%3A%2F%2Fwww.linkedin.com%2Fin%2Falex%2F"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.active).toBe(false); // not visible
  });

  it("uses LinkedIn alias matching for redirected canonical profile URLs", async () => {
    linkedinCaptureMocks.linkedInProfileMatches.mockImplementation(
      (a: string, b: string) =>
        a.includes("ranjana-tyagi-3755b615") && b.includes("ranjanatyagi")
    );
    linkedinCaptureMocks.findSessionInQueue.mockImplementation(async (predicate: (session: { linkedinUrl: string; status: string }) => boolean) => {
      const session = {
        sessionId: "sess-ranjana",
        linkedinUrl: "https://www.linkedin.com/in/ranjana-tyagi-3755b615/",
        candidateName: "Ranjana Tyagi",
        status: "pending",
        message: "Waiting for browser extension to capture the profile",
      };
      return predicate(session) ? session : null;
    });

    const res = await GET(
      authedRequest(
        "http://localhost/api/extension/fetch-session/pending?linkedinUrl=https%3A%2F%2Fwww.linkedin.com%2Fin%2Franjanatyagi%2F"
      )
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pending).toBe(true);
    expect(body.sessionId).toBe("sess-ranjana");
    expect(linkedinCaptureMocks.linkedInProfileMatches).toHaveBeenCalledWith(
      "https://www.linkedin.com/in/ranjana-tyagi-3755b615/",
      "https://www.linkedin.com/in/ranjanatyagi/"
    );
  });
});
