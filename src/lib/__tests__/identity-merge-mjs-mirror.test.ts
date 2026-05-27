/**
 * Cross-check: scripts/_identity-merge.mjs MUST produce the same merge keys
 * and normalisations as src/lib/identity-merge.ts. The .mjs file exists
 * because the clustering script is plain ESM (no ts-node), and a duplicated
 * helper is cheaper than wiring a TS runner into one-off backfill tooling —
 * but the cost of duplication is drift. This test pins them together.
 *
 * If you change either file and this test fails, change the other file too
 * before declaring the work done.
 */

import { describe, expect, it } from "vitest";
import {
  identityMergeKey as identityMergeKeyTs,
  isSyntheticLibraryKey as isSyntheticLibraryKeyTs,
  normaliseJobAdderUrl as normaliseJobAdderUrlTs,
  mergeKeyToString as mergeKeyToStringTs,
} from "../identity-merge";
// Vitest can import .mjs files; the runtime tolerates the loader.
import {
  identityMergeKey as identityMergeKeyMjs,
  isSyntheticLibraryKey as isSyntheticLibraryKeyMjs,
  normaliseJobAdderUrl as normaliseJobAdderUrlMjs,
  normaliseSeekUrl as normaliseSeekUrlMjs,
  mergeKeyToString as mergeKeyToStringMjs,
} from "../../../scripts/_identity-merge.mjs";
import { normaliseSeekUrl as normaliseSeekUrlTs } from "../seek";

describe("identity-merge .mjs mirror parity", () => {
  const ROWS = [
    { linkedinUrl: "https://linkedin.com/in/jane", jobAdderUrl: null },
    { linkedinUrl: "https://www.linkedin.com/in/Jane/", jobAdderUrl: null },
    { linkedinUrl: "http://nz.linkedin.com/in/jane?trk=foo", jobAdderUrl: null },
    { linkedinUrl: null, jobAdderUrl: "https://acme.jobadder.com/c/123" },
    { linkedinUrl: "library:src-1", jobAdderUrl: "https://acme.jobadder.com/c/456" },
    { linkedinUrl: "library:abc", jobAdderUrl: null },
    { linkedinUrl: null, jobAdderUrl: null },
    { linkedinUrl: "  https://linkedin.com/in/whitespace  ", jobAdderUrl: null },
    { linkedinUrl: null, jobAdderUrl: "HTTPS://Acme.JobAdder.com/c/MixedCase?utm=x" },
    // SEEK-only rows — lowest precedence, only used when LinkedIn + JobAdder absent.
    { linkedinUrl: null, jobAdderUrl: null, seekUrl: "https://talent.seek.com.au/profile/AbC123?utm=x" },
    { linkedinUrl: null, jobAdderUrl: null, seekUrl: "  https://www.seek.co.nz/profile/xyz/  " },
    // Precedence checks: SEEK must NOT win when a higher key exists.
    { linkedinUrl: "https://linkedin.com/in/jane", jobAdderUrl: null, seekUrl: "https://seek.com.au/profile/1" },
    { linkedinUrl: "library:src-1", jobAdderUrl: "https://acme.jobadder.com/c/9", seekUrl: "https://seek.com.au/profile/2" },
  ];

  for (const row of ROWS) {
    it(`identityMergeKey matches for ${JSON.stringify(row)}`, () => {
      const ts = identityMergeKeyTs(row);
      const mjs = identityMergeKeyMjs(row);
      expect(mjs).toEqual(ts);
    });
  }

  it("isSyntheticLibraryKey matches", () => {
    for (const v of ["library:abc", "https://linkedin.com/in/jane", "", null]) {
      expect(isSyntheticLibraryKeyMjs(v)).toBe(isSyntheticLibraryKeyTs(v));
    }
  });

  it("normaliseJobAdderUrl matches", () => {
    const cases = [
      "https://acme.jobadder.com/c/123?trk=foo",
      "https://acme.jobadder.com/c/123/",
      "HTTPS://Acme.JobAdder.com/c/MixedCase",
      "  https://acme.jobadder.com/c/spaces  ",
    ];
    for (const c of cases) {
      expect(normaliseJobAdderUrlMjs(c)).toBe(normaliseJobAdderUrlTs(c));
    }
  });

  it("normaliseSeekUrl matches", () => {
    const cases = [
      "https://talent.seek.com.au/profile/AbC123?utm=foo",
      "https://www.seek.co.nz/profile/xyz/",
      "HTTPS://Seek.Com.AU/profile/MixedCase",
      "  https://seek.com.au/profile/spaces  ",
    ];
    for (const c of cases) {
      expect(normaliseSeekUrlMjs(c)).toBe(normaliseSeekUrlTs(c));
    }
  });

  it("mergeKeyToString matches", () => {
    const cases: Array<Parameters<typeof mergeKeyToStringTs>[0]> = [
      null,
      { kind: "linkedinUrl", value: "https://www.linkedin.com/in/x" },
      { kind: "jobAdderUrl", value: "https://acme.jobadder.com/c/1" },
      { kind: "seekUrl", value: "https://seek.com.au/profile/1" },
    ];
    for (const c of cases) {
      expect(mergeKeyToStringMjs(c)).toBe(mergeKeyToStringTs(c));
    }
  });
});
