import { describe, expect, it, vi } from "vitest";
import { collectPagedSearchResults, type SearchPageTaskResult } from "../search-collection";

interface MockCandidate {
  linkedinUrl: string;
}

describe("collectPagedSearchResults", () => {
  it("retries transiently throttled pages and keeps collecting toward the target", async () => {
    const sleep = vi.fn(async () => {});
    const pageCalls: Array<{ page: number; attempt: number }> = [];

    const result = await collectPagedSearchResults<MockCandidate>({
      targetCount: 3,
      maxPages: 5,
      maxPageRetries: 2,
      emptyRoundsBeforeStop: 2,
      keyFn: (item) => item.linkedinUrl,
      sleep,
      getPage: async (page, attempt) => {
        pageCalls.push({ page, attempt });

        if (page === 0 && attempt === 0) {
          return [{ items: [], retryable: true, error: "429 Too Many Requests" }];
        }
        if (page === 0) {
          return [{ items: [{ linkedinUrl: "https://www.linkedin.com/in/alpha" }] }];
        }
        if (page === 1) {
          return [{ items: [{ linkedinUrl: "https://www.linkedin.com/in/bravo" }, { linkedinUrl: "https://www.linkedin.com/in/charlie" }] }];
        }
        return [];
      },
    });

    expect(result.items).toHaveLength(3);
    expect(result.sawRetryableFailure).toBe(true);
    expect(pageCalls).toEqual([
      { page: 0, attempt: 0 },
      { page: 0, attempt: 1 },
      { page: 1, attempt: 0 },
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("deduplicates across pages and stops after repeated empty settled rounds", async () => {
    const result = await collectPagedSearchResults<MockCandidate>({
      targetCount: 10,
      maxPages: 6,
      maxPageRetries: 1,
      emptyRoundsBeforeStop: 2,
      keyFn: (item) => item.linkedinUrl,
      getPage: async (page) => {
        const pages: Array<SearchPageTaskResult<MockCandidate>[]> = [
          [{ items: [{ linkedinUrl: "https://www.linkedin.com/in/alpha" }] }],
          [{ items: [{ linkedinUrl: "https://www.linkedin.com/in/alpha" }] }],
          [],
          [],
          [{ items: [{ linkedinUrl: "https://www.linkedin.com/in/late" }] }],
        ];
        return pages[page] ?? [];
      },
    });

    expect(result.items).toEqual([{ linkedinUrl: "https://www.linkedin.com/in/alpha" }]);
    expect(result.sawRetryableFailure).toBe(false);
  });
});
