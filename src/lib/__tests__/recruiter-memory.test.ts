import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the prisma client BEFORE importing the SUT so the import-time module
// references resolve to our mock. The helpers we're testing only touch the
// Setting table, so a minimal mock is enough.
const dbMocks = vi.hoisted(() => ({
  prisma: {
    setting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("../db", () => dbMocks);

import {
  __resetCorrectionsVersionCache,
  bumpCorrectionsVersion,
  getCorrectionsVersion,
} from "../recruiter-memory";
import { buildScoreCacheKey } from "../utils";

describe("recruiter-memory corrections version (audit SC4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCorrectionsVersionCache();
  });

  it("returns 0 when no setting row exists for the org", async () => {
    dbMocks.prisma.setting.findUnique.mockResolvedValue(null);
    const v = await getCorrectionsVersion("org-1");
    expect(v).toBe(0);
    expect(dbMocks.prisma.setting.findUnique).toHaveBeenCalledWith({
      where: { key: "cv.corrections.version.org-1" },
    });
  });

  it("returns 0 when orgId is null/undefined/empty", async () => {
    await expect(getCorrectionsVersion(null)).resolves.toBe(0);
    await expect(getCorrectionsVersion(undefined)).resolves.toBe(0);
    await expect(getCorrectionsVersion("")).resolves.toBe(0);
    // No DB lookup should happen for a falsy orgId.
    expect(dbMocks.prisma.setting.findUnique).not.toHaveBeenCalled();
  });

  it("returns the stored counter when the row exists", async () => {
    dbMocks.prisma.setting.findUnique.mockResolvedValue({ key: "cv.corrections.version.org-1", value: "7" });
    await expect(getCorrectionsVersion("org-1")).resolves.toBe(7);
  });

  it("bumpCorrectionsVersion increments the counter and invalidates the in-process cache", async () => {
    // First call sees no row, returns 0.
    dbMocks.prisma.setting.findUnique.mockResolvedValueOnce(null);
    await expect(getCorrectionsVersion("org-1")).resolves.toBe(0);

    // Bump → reads 0, writes 1.
    dbMocks.prisma.setting.findUnique.mockResolvedValueOnce(null);
    dbMocks.prisma.setting.upsert.mockResolvedValueOnce({});
    const bumped = await bumpCorrectionsVersion("org-1");
    expect(bumped).toBe(1);
    expect(dbMocks.prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "cv.corrections.version.org-1" },
      update: { value: "1" },
      create: { key: "cv.corrections.version.org-1", value: "1" },
    });

    // Next read should hit the DB again (cache invalidated by the bump) and
    // see the new value the DB now returns.
    dbMocks.prisma.setting.findUnique.mockResolvedValueOnce({ key: "cv.corrections.version.org-1", value: "1" });
    await expect(getCorrectionsVersion("org-1")).resolves.toBe(1);
  });

  it("buildScoreCacheKey produces a different key for two distinct corrections versions", async () => {
    const profileText = "Senior React engineer in Wellington.";
    const parsedRole = { title: "Software Engineer", must_haves: ["React"] };

    const beforeBump = buildScoreCacheKey({
      profileText, parsedRole, salary: null, jobLocation: "Wellington", isRemote: false,
      correctionsVersion: 0,
    });
    const afterBump = buildScoreCacheKey({
      profileText, parsedRole, salary: null, jobLocation: "Wellington", isRemote: false,
      correctionsVersion: 1,
    });
    expect(afterBump).not.toBe(beforeBump);
  });

  it("caches the version in-process for 60s — back-to-back reads hit the DB only once", async () => {
    dbMocks.prisma.setting.findUnique.mockResolvedValue({ key: "cv.corrections.version.org-1", value: "3" });
    await expect(getCorrectionsVersion("org-1")).resolves.toBe(3);
    await expect(getCorrectionsVersion("org-1")).resolves.toBe(3);
    await expect(getCorrectionsVersion("org-1")).resolves.toBe(3);
    expect(dbMocks.prisma.setting.findUnique).toHaveBeenCalledTimes(1);
  });
});
