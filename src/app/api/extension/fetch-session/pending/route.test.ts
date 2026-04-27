import { beforeEach, describe, expect, it, vi } from "vitest";

const linkedinCaptureMocks = vi.hoisted(() => ({
  findSessionInQueue: vi.fn(),
  normaliseLinkedInUrl: vi.fn((url: string) => url.toLowerCase()),
}));

vi.mock("@/lib/linkedin-capture", () => linkedinCaptureMocks);

import { GET } from "./route";

describe("extension fetch-session pending route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      new Request(
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
      new Request(
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
});
