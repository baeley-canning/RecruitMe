import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  shapeResult,
  enrichByLinkedIn,
  isFirmableConfigured,
  isEnrichmentFresh,
  FirmableNotConfiguredError,
  type FirmablePersonRaw,
} from "../firmable";

describe("shapeResult", () => {
  it("picks the first non-DND personal phone as primary", () => {
    const raw: FirmablePersonRaw = {
      phones: [
        { value: "+64 21 555 1111", is_dnd: true },
        { value: "+64 21 555 2222", is_dnd: false },
        { value: "+64 21 555 3333" },
      ],
    };
    const result = shapeResult(raw);
    expect(result.primaryPhone).toBe("+64 21 555 2222");
    expect(result.primaryIsDnd).toBe(false);
    expect(result.personalPhones).toHaveLength(3);
  });

  it("falls back to a DND personal phone when no non-DND is available and flags it", () => {
    const raw: FirmablePersonRaw = {
      phones: [{ value: "+64 21 555 1111", is_dnd: true }],
    };
    const result = shapeResult(raw);
    expect(result.primaryPhone).toBe("+64 21 555 1111");
    expect(result.primaryIsDnd).toBe(true);
  });

  it("falls back to current_company.mobile_phones when no personal phones", () => {
    const raw: FirmablePersonRaw = {
      phones: [],
      current_company: {
        mobile_phones: ["+64 4 555 9000"],
        main_phones: ["+64 4 555 9999"],
      },
    };
    expect(shapeResult(raw).primaryPhone).toBe("+64 4 555 9000");
  });

  it("falls back to current_company.main_phones as last resort", () => {
    const raw: FirmablePersonRaw = {
      phones: [],
      current_company: { main_phones: ["+64 4 555 9999"] },
    };
    expect(shapeResult(raw).primaryPhone).toBe("+64 4 555 9999");
  });

  it("returns null primary when no phones present anywhere", () => {
    const raw: FirmablePersonRaw = { phones: [] };
    const result = shapeResult(raw);
    expect(result.primaryPhone).toBeNull();
    expect(result.personalPhones).toHaveLength(0);
  });

  it("filters out phones with empty values", () => {
    const raw: FirmablePersonRaw = {
      phones: [
        { value: "" },
        // @ts-expect-error — testing defensive filter
        { value: null },
        { value: "+64 21 555 1111" },
      ],
    };
    const result = shapeResult(raw);
    expect(result.personalPhones).toHaveLength(1);
    expect(result.primaryPhone).toBe("+64 21 555 1111");
  });

  it("prefers a deliverable email over an undeliverable one", () => {
    const raw: FirmablePersonRaw = {
      emails: [
        { value: "old@example.com", deliverable: false },
        { value: "current@example.com", deliverable: true },
      ],
    };
    expect(shapeResult(raw).primaryEmail).toBe("current@example.com");
  });

  it("falls back to any email when none are flagged deliverable", () => {
    const raw: FirmablePersonRaw = {
      emails: [{ value: "unknown@example.com" }],
    };
    expect(shapeResult(raw).primaryEmail).toBe("unknown@example.com");
  });
});

describe("isFirmableConfigured", () => {
  const prev = process.env.FIRMABLE_API_KEY;
  afterEach(() => { process.env.FIRMABLE_API_KEY = prev; });

  it("returns true when env is set", () => {
    process.env.FIRMABLE_API_KEY = "fbl_test123";
    expect(isFirmableConfigured()).toBe(true);
  });

  it("returns false when env is empty", () => {
    process.env.FIRMABLE_API_KEY = "";
    expect(isFirmableConfigured()).toBe(false);
  });

  it("returns false when env is whitespace", () => {
    process.env.FIRMABLE_API_KEY = "   ";
    expect(isFirmableConfigured()).toBe(false);
  });
});

describe("isEnrichmentFresh", () => {
  it("returns false when no timestamp", () => {
    expect(isEnrichmentFresh(null)).toBe(false);
    expect(isEnrichmentFresh(undefined)).toBe(false);
  });

  it("returns true within 90 days", () => {
    const t = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(isEnrichmentFresh(t)).toBe(true);
  });

  it("returns false beyond 90 days", () => {
    const t = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    expect(isEnrichmentFresh(t)).toBe(false);
  });
});

describe("enrichByLinkedIn", () => {
  const prev = process.env.FIRMABLE_API_KEY;
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { process.env.FIRMABLE_API_KEY = prev; });

  it("returns null without throwing when API key is missing", async () => {
    delete process.env.FIRMABLE_API_KEY;
    const result = await enrichByLinkedIn("https://www.linkedin.com/in/test/");
    expect(result).toBeNull();
  });

  it("throws FirmableNotConfiguredError when explicitly requested", async () => {
    delete process.env.FIRMABLE_API_KEY;
    await expect(
      enrichByLinkedIn("https://www.linkedin.com/in/test/", { throwIfNotConfigured: true }),
    ).rejects.toThrow(FirmableNotConfiguredError);
  });

  it("returns null when LinkedIn URL is empty", async () => {
    process.env.FIRMABLE_API_KEY = "fbl_test";
    expect(await enrichByLinkedIn("")).toBeNull();
  });

  it("sends Authorization header and ln_url param", async () => {
    process.env.FIRMABLE_API_KEY = "fbl_secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ phones: [{ value: "+64 21 555 7777" }] }), { status: 200 }),
    );

    const result = await enrichByLinkedIn("https://www.linkedin.com/in/jane/");

    expect(result?.primaryPhone).toBe("+64 21 555 7777");
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain("api.firmable.com/people");
    expect(String(calledUrl)).toContain("ln_url=https");
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: "Bearer fbl_secret",
    });
  });

  it("returns null on 404 (person not in Firmable)", async () => {
    process.env.FIRMABLE_API_KEY = "fbl_test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    expect(await enrichByLinkedIn("https://www.linkedin.com/in/missing/")).toBeNull();
  });

  it("returns null on 429 without throwing", async () => {
    process.env.FIRMABLE_API_KEY = "fbl_test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    expect(await enrichByLinkedIn("https://www.linkedin.com/in/rate/")).toBeNull();
  });

  it("returns null on network errors", async () => {
    process.env.FIRMABLE_API_KEY = "fbl_test";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    expect(await enrichByLinkedIn("https://www.linkedin.com/in/err/")).toBeNull();
  });
});
