import { describe, expect, it } from "vitest";
import { buildScoreCacheKey } from "../utils";

const parsedRole = {
  title: "Software Engineer",
  location: "Wellington",
  must_haves: ["React"],
};

describe("buildScoreCacheKey", () => {
  it("changes when job context changes even if profile text is unchanged", () => {
    const profileText = "React engineer based in Wellington.";
    const original = buildScoreCacheKey({
      profileText,
      parsedRole,
      salary: { min: 90000, max: 120000 },
      jobLocation: "Wellington",
      isRemote: false,
    });
    const changed = buildScoreCacheKey({
      profileText,
      parsedRole,
      salary: { min: 90000, max: 120000 },
      jobLocation: "Auckland",
      isRemote: false,
    });

    expect(changed).not.toBe(original);
  });

  it("is stable for equivalent object key ordering", () => {
    const profileText = "React engineer based in Wellington.";
    const first = buildScoreCacheKey({
      profileText,
      parsedRole: { title: "Software Engineer", location: "Wellington", must_haves: ["React"] },
      salary: null,
      jobLocation: "Wellington",
      isRemote: false,
    });
    const second = buildScoreCacheKey({
      profileText,
      parsedRole: { must_haves: ["React"], location: "Wellington", title: "Software Engineer" },
      salary: null,
      jobLocation: "Wellington",
      isRemote: false,
    });

    expect(second).toBe(first);
  });

  // Audit SC4: a recruiter saving a score correction must invalidate the
  // cache for the affected org's candidates. The corrections version is
  // threaded through buildScoreCacheKey to make that invalidation work.
  it("produces a different key when correctionsVersion changes", () => {
    const profileText = "React engineer based in Wellington.";
    const v1 = buildScoreCacheKey({
      profileText,
      parsedRole,
      salary: null,
      jobLocation: "Wellington",
      isRemote: false,
      correctionsVersion: 1,
    });
    const v2 = buildScoreCacheKey({
      profileText,
      parsedRole,
      salary: null,
      jobLocation: "Wellington",
      isRemote: false,
      correctionsVersion: 2,
    });
    expect(v2).not.toBe(v1);
  });

  it("treats missing correctionsVersion as 0 (back-compat with legacy callers)", () => {
    const profileText = "React engineer based in Wellington.";
    const withoutVersion = buildScoreCacheKey({
      profileText,
      parsedRole,
      salary: null,
      jobLocation: "Wellington",
      isRemote: false,
    });
    const withZero = buildScoreCacheKey({
      profileText,
      parsedRole,
      salary: null,
      jobLocation: "Wellington",
      isRemote: false,
      correctionsVersion: 0,
    });
    expect(withZero).toBe(withoutVersion);
  });
});

// ── Rubric fingerprint ──────────────────────────────────────────────────────
// The defect this closes: buildScoreCacheKey hashed everything that feeds a
// score EXCEPT the rubric that produces it, so improving the rubric left every
// candidate a cache hit holding the OLD rubric's verdict.
describe("buildScoreCacheKey — scorer fingerprint", () => {
  const base = {
    profileText: "Senior Software Engineer, 15 years",
    parsedRole: { title: "Senior Developer" },
    salary: { min: 100_000, max: 125_000 },
  };

  it("changes the key when the rubric changes", () => {
    const before = buildScoreCacheKey({ ...base, scorerFingerprint: "rubric-aaa" });
    const after = buildScoreCacheKey({ ...base, scorerFingerprint: "rubric-bbb" });
    expect(before).not.toBe(after);
  });

  it("is stable for an unchanged rubric", () => {
    expect(buildScoreCacheKey({ ...base, scorerFingerprint: "rubric-aaa" }))
      .toBe(buildScoreCacheKey({ ...base, scorerFingerprint: "rubric-aaa" }));
  });

  it("omitting it preserves the legacy key, so untouched callers don't invalidate", () => {
    const legacy = buildScoreCacheKey({ ...base });
    const explicitUndefined = buildScoreCacheKey({ ...base, scorerFingerprint: undefined });
    expect(explicitUndefined).toBe(legacy);
    expect(buildScoreCacheKey({ ...base, scorerFingerprint: "rubric-aaa" })).not.toBe(legacy);
  });
});

describe("scorerFingerprint", () => {
  it("is deterministic and derived from the rubric text", async () => {
    const { scorerFingerprint } = await import("../ai/scorer-fingerprint");
    const a = scorerFingerprint();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(scorerFingerprint()).toBe(a);
  });
});
