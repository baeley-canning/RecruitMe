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
});
