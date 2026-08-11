/**
 * enqueueScrapeJob must never write a row whose platform disagrees with its URL.
 *
 * The worker now re-derives the platform from the URL as a second line of
 * defence (scraper-worker/src/job-routing.ts), but a contradictory row should
 * not exist in the first place: it makes the queue lie about what work is
 * outstanding per platform, which is exactly what the daily platform budget
 * counts. 100 SEEK profiles were filed as LinkedIn work, so the LinkedIn budget
 * was being spent on SEEK URLs that could never succeed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const findFirst = vi.fn();

vi.mock("../db", () => ({
  prisma: { scrapeJob: { create: (...a: unknown[]) => create(...a), findFirst: (...a: unknown[]) => findFirst(...a) } },
}));
vi.mock("../error-reporting", () => ({ reportError: vi.fn() }));

const SEEK_URL = "https://nz.employer.seek.com/talentsearch/profile/998877";
const LI_URL = "https://www.linkedin.com/in/someone";

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: "job-1" });
});

async function enqueue(args: Parameters<typeof import("../scrape-queue").enqueueScrapeJob>[0]) {
  const { enqueueScrapeJob } = await import("../scrape-queue");
  return enqueueScrapeJob(args);
}

const dataOf = () => create.mock.calls[0][0].data as { platform: string; profileUrl: string };

describe("enqueueScrapeJob — the URL decides the platform", () => {
  it("files a SEEK URL as seek even when the caller says linkedin (the real bug)", async () => {
    await enqueue({ orgId: "o1", platform: "linkedin", profileUrl: SEEK_URL });
    expect(dataOf().platform).toBe("seek");
  });

  it("strips a merge-key prefix before storing the URL", async () => {
    await enqueue({ orgId: "o1", platform: "linkedin", profileUrl: `seek:${SEEK_URL}` });
    const data = dataOf();
    expect(data.profileUrl).toBe(SEEK_URL);
    expect(data.platform).toBe("seek");
  });

  it("files a LinkedIn URL as linkedin even when the caller says seek", async () => {
    await enqueue({ orgId: "o1", platform: "seek", profileUrl: LI_URL });
    expect(dataOf().platform).toBe("linkedin");
  });

  it("leaves an unidentifiable URL on the caller's platform (JobAdder custom hosts)", async () => {
    const url = "https://acme.example.com/candidates/42";
    await enqueue({ orgId: "o1", platform: "jobadder", profileUrl: url });
    const data = dataOf();
    expect(data.platform).toBe("jobadder");
    expect(data.profileUrl).toBe(url);
  });

  it("refuses to enqueue an unusable URL rather than storing a poisoned row", async () => {
    const out = await enqueue({ orgId: "o1", platform: "seek", profileUrl: "seek:12345" });
    expect(out).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a non-https URL", async () => {
    const out = await enqueue({ orgId: "o1", platform: "seek", profileUrl: "http://nz.employer.seek.com/talentsearch/profile/1" });
    expect(out).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("dedupes against the CLEANED url, so a merge-key duplicate is still caught", async () => {
    findFirst.mockResolvedValue({ id: "existing" });
    const out = await enqueue({ orgId: "o1", platform: "linkedin", profileUrl: `seek:${SEEK_URL}` });
    expect(out).toBeNull();
    expect(findFirst.mock.calls[0][0].where.profileUrl).toBe(SEEK_URL);
  });
});
