import { describe, it, expect } from "vitest";
import {
  parsePermissions,
  serializePermissions,
  hasCapability,
  effectiveCapabilities,
  isCapability,
  ALL_CAPABILITIES,
} from "@/lib/permissions";

describe("parsePermissions", () => {
  it("parses a valid JSON array, keeping only known capabilities", () => {
    expect(parsePermissions('["search","score","bogus"]')).toEqual(["search", "score"]);
  });
  it("returns [] for null / empty / malformed / non-array", () => {
    expect(parsePermissions(null)).toEqual([]);
    expect(parsePermissions("")).toEqual([]);
    expect(parsePermissions("not json")).toEqual([]);
    expect(parsePermissions('{"a":1}')).toEqual([]);
    expect(parsePermissions('"search"')).toEqual([]);
  });
});

describe("serializePermissions", () => {
  it("dedups and drops unknown slugs", () => {
    expect(serializePermissions(["search", "search", "score", "nope"])).toBe(JSON.stringify(["search", "score"]));
  });
  it("empty in → empty array out", () => {
    expect(serializePermissions([])).toBe("[]");
  });
  it("round-trips through parse", () => {
    expect(parsePermissions(serializePermissions(["enrich", "parse"]))).toEqual(["enrich", "parse"]);
  });
});

describe("hasCapability", () => {
  it("owner has every capability regardless of grants", () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(hasCapability({ isOwner: true, permissions: [] }, cap)).toBe(true);
    }
  });
  it("a user has only granted capabilities (default-deny)", () => {
    expect(hasCapability({ isOwner: false, permissions: ["score"] }, "score")).toBe(true);
    expect(hasCapability({ isOwner: false, permissions: ["score"] }, "search")).toBe(false);
    expect(hasCapability({ isOwner: false, permissions: [] }, "enrich")).toBe(false);
  });
});

describe("effectiveCapabilities", () => {
  it("owner → all", () => {
    expect(effectiveCapabilities({ isOwner: true, permissions: [] }).sort()).toEqual([...ALL_CAPABILITIES].sort());
  });
  it("user → the intersection with the known set, order-stable", () => {
    expect(effectiveCapabilities({ isOwner: false, permissions: ["parse", "search"] })).toEqual(
      ALL_CAPABILITIES.filter((c) => c === "search" || c === "parse"),
    );
  });
});

describe("isCapability", () => {
  it("recognises known slugs only", () => {
    expect(isCapability("search")).toBe(true);
    expect(isCapability("nope")).toBe(false);
    expect(isCapability(42)).toBe(false);
  });
});
