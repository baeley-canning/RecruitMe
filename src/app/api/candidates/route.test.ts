import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  prisma: {
    candidate: {
      findMany: vi.fn(),
    },
  },
}));

const sessionMocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  unauthorized: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/session", () => sessionMocks);

import { GET } from "./route";

describe("candidates library API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.getAuth.mockResolvedValue({ userId: "user-1", orgId: "org-1", isOwner: false });
  });

  it("excludes short snippets, keeps meaningful captured profiles, and omits profileText", async () => {
    const now = new Date();
    const capturedProfile = "Captured profile text. ".repeat(35);
    dbMocks.prisma.candidate.findMany.mockResolvedValue([
      {
        id: "short-1",
        name: "Snippet Person",
        headline: "Developer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/snippet/",
        profileText: "Short SerpAPI snippet",
        matchScore: 61,
        source: "serpapi",
        status: "new",
        profileCapturedAt: null,
        createdAt: now,
        jobId: "job-1",
        job: { id: "job-1", title: "Developer", company: "Acme" },
        files: [],
      },
      {
        id: "full-1",
        name: "Full Person",
        headline: "Developer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/full/",
        profileText: "Full profile text. ".repeat(140),
        matchScore: 80,
        source: "extension",
        status: "new",
        profileCapturedAt: null,
        createdAt: now,
        jobId: "job-1",
        job: { id: "job-1", title: "Developer", company: "Acme" },
        files: [],
      },
      {
        id: "captured-short",
        name: "Captured Person",
        headline: "Designer",
        location: "Wellington",
        linkedinUrl: "https://www.linkedin.com/in/captured/",
        profileText: capturedProfile,
        matchScore: 72,
        source: "extension",
        status: "new",
        profileCapturedAt: now,
        createdAt: now,
        jobId: "job-2",
        job: { id: "job-2", title: "Designer", company: "Beta" },
        files: [],
      },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.map((row: { id: string }) => row.id).sort()).toEqual(["captured-short", "full-1"]);
    expect(body[0]).not.toHaveProperty("profileText");
  });
});
