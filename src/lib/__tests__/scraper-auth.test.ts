import { describe, expect, it } from "vitest";
import { resolveScraperOrgId } from "@/lib/scraper-auth";

describe("resolveScraperOrgId — scraper tenant binding", () => {
  it("token-bound box: ignores a request with no orgId and uses its bound org", () => {
    expect(resolveScraperOrgId("org-A", null)).toEqual({ orgId: "org-A" });
  });

  it("token-bound box: accepts a matching requested orgId", () => {
    expect(resolveScraperOrgId("org-A", "org-A")).toEqual({ orgId: "org-A" });
  });

  it("token-bound box: REJECTS naming a different org (cross-tenant write attempt)", () => {
    const out = resolveScraperOrgId("org-A", "org-VICTIM");
    expect("error" in out).toBe(true);
  });

  it("owner-scope (shared secret / owner token): uses the requested org", () => {
    expect(resolveScraperOrgId(null, "org-anything")).toEqual({ orgId: "org-anything" });
  });

  it("owner-scope with no requested org: returns null (POST then 422s)", () => {
    expect(resolveScraperOrgId(null, null)).toEqual({ orgId: null });
  });
});
