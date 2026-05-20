/**
 * Unit tests for src/lib/candidate-photo.ts.
 *
 * The helper is pure URL construction over (candidateId, photoFileId). It
 * returns null whenever either value is missing so the Avatar component
 * silently falls back to initials — which is the visible behaviour for the
 * vast majority of candidates (no recruiter has uploaded a photo yet).
 */

import { describe, expect, it } from "vitest";
import { getCandidatePhotoUrl } from "../candidate-photo";

describe("getCandidatePhotoUrl", () => {
  it("returns null when photoFileId is missing", () => {
    expect(getCandidatePhotoUrl({ candidateId: "cand-1" })).toBeNull();
    expect(getCandidatePhotoUrl({ candidateId: "cand-1", photoFileId: null })).toBeNull();
    expect(getCandidatePhotoUrl({ candidateId: "cand-1", photoFileId: undefined })).toBeNull();
    expect(getCandidatePhotoUrl({ candidateId: "cand-1", photoFileId: "" })).toBeNull();
  });

  it("returns null when candidateId is missing", () => {
    expect(getCandidatePhotoUrl({ photoFileId: "file-1" })).toBeNull();
    expect(getCandidatePhotoUrl({ photoFileId: "file-1", candidateId: null })).toBeNull();
    expect(getCandidatePhotoUrl({ photoFileId: "file-1", candidateId: undefined })).toBeNull();
    expect(getCandidatePhotoUrl({ photoFileId: "file-1", candidateId: "" })).toBeNull();
  });

  it("returns the inline-serving files URL when both ids are set", () => {
    expect(
      getCandidatePhotoUrl({ candidateId: "cand-1", photoFileId: "file-1" }),
    ).toBe("/api/candidates/cand-1/files/file-1?inline=1");
  });

  it("preserves arbitrary id shapes verbatim — no encoding mangling", () => {
    // Prisma cuids are URL-safe alphanumerics; we deliberately don't URL-encode
    // so any future change to id shape produces visible breakage rather than a
    // silently-corrupted URL.
    expect(
      getCandidatePhotoUrl({ candidateId: "abc123", photoFileId: "xyz789" }),
    ).toBe("/api/candidates/abc123/files/xyz789?inline=1");
  });

  it("always includes ?inline=1 so the file route serves Content-Disposition: inline", () => {
    const url = getCandidatePhotoUrl({ candidateId: "c", photoFileId: "f" });
    expect(url).not.toBeNull();
    expect(url).toContain("?inline=1");
  });
});
