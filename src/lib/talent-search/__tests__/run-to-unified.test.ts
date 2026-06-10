import { describe, it, expect } from "vitest";
import { runResultToUnified } from "../run-to-unified";
import type { SearchRunResultDTO } from "@/lib/search-run";

/**
 * Guards the durable-run → modal adapter. The bug it locks down: routing a
 * non-LinkedIn profileUrl (a SEEK talentsearch URL) into UnifiedResult.linkedinUrl
 * made the import + display normalise it into the broken
 * `linkedin.com/in/https://…seek…` link. linkedinUrl must ONLY ever hold a
 * genuine linkedin.com/in URL.
 */
function dto(over: Partial<SearchRunResultDTO> = {}): SearchRunResultDTO {
  return {
    id: "res-1",
    mergeKey: "mk-1",
    sources: ["linkedin"],
    candidateId: null,
    candidateIdentityId: null,
    profileUrl: null,
    name: "Jane Doe",
    headline: "Engineer",
    location: "Wellington",
    snippet: "snippet",
    matchScore: null,
    relevance: 0.5,
    rank: null,
    photoUrl: null,
    ...over,
  };
}

describe("runResultToUnified", () => {
  it("keeps a genuine LinkedIn profileUrl in linkedinUrl", () => {
    const r = runResultToUnified(dto({ profileUrl: "https://www.linkedin.com/in/jane-doe", sources: ["linkedin"] }));
    expect(r.linkedinUrl).toBe("https://www.linkedin.com/in/jane-doe");
  });

  it("does NOT route a SEEK URL into linkedinUrl (the mangled-link bug)", () => {
    const r = runResultToUnified(dto({
      profileUrl: "https://nz.employer.seek.com/talentsearch/profile/571239686/",
      sources: ["seek"],
    }));
    expect(r.linkedinUrl).toBeNull();
  });

  it("rejects any other non-LinkedIn URL from linkedinUrl", () => {
    expect(runResultToUnified(dto({ profileUrl: "https://meet.google.com/abc" })).linkedinUrl).toBeNull();
    expect(runResultToUnified(dto({ profileUrl: "https://example.com/x" })).linkedinUrl).toBeNull();
  });

  it("collapses seek → linkedin in the source badges", () => {
    expect(runResultToUnified(dto({ sources: ["seek"] })).sources).toEqual(["linkedin"]);
    expect(runResultToUnified(dto({ sources: ["library", "seek"] })).sources).toEqual(["library", "linkedin"]);
  });

  it("preserves library identity fields and id = mergeKey", () => {
    const r = runResultToUnified(dto({
      mergeKey: "lib:cand-9", sources: ["library"], candidateId: "cand-9", candidateIdentityId: "id-9", profileUrl: null,
    }));
    expect(r.id).toBe("lib:cand-9");
    expect(r.candidateId).toBe("cand-9");
    expect(r.candidateIdentityId).toBe("id-9");
    expect(r.sources).toEqual(["library"]);
  });

  it("falls back to a placeholder name when the row has none", () => {
    expect(runResultToUnified(dto({ name: null })).name).toBe("Unnamed profile");
  });

  it("defaults empty sources sensibly (library if candidateId, else linkedin)", () => {
    expect(runResultToUnified(dto({ sources: [], candidateId: "c1" })).sources).toEqual(["library"]);
    expect(runResultToUnified(dto({ sources: [], candidateId: null })).sources).toEqual(["linkedin"]);
  });
});
