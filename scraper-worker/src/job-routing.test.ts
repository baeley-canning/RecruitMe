/**
 * The worker must decide which scraper to run from the URL it was given, not
 * from the platform column that travelled alongside it.
 *
 * This is not hypothetical. 100 jobs were written with platform="linkedin" and
 * a profileUrl of "seek:https://nz.employer.seek.com/talentsearch/profile/…" —
 * a merge-key string that leaked into the linkedinUrl column. The worker
 * dispatched every one of them to the LinkedIn scraper, which rejected them in
 * about four seconds each. Because the loop paced itself from job COMPLETION,
 * those fast failures cycled roughly six times faster than intended and the
 * owner's LinkedIn account was flagged.
 *
 * The app-side enqueue was fixed to route by URL. This is the second line of
 * defence: even handed a contradictory row, the worker must not point the wrong
 * scraper at a URL.
 */
import { describe, it, expect } from "vitest";
import { resolveJobTarget } from "./job-routing";

const seekProfile = "https://nz.employer.seek.com/talentsearch/profile/123456";
const linkedInProfile = "https://www.linkedin.com/in/some-person";

describe("resolveJobTarget — the URL decides", () => {
  it("routes a SEEK URL to seek even when the job says linkedin (the real bug)", () => {
    const out = resolveJobTarget({ platform: "linkedin", profileUrl: `seek:${seekProfile}` });
    expect(out).toEqual({ ok: true, platform: "seek", url: seekProfile });
  });

  it("routes a LinkedIn URL to linkedin even when the job says seek", () => {
    const out = resolveJobTarget({ platform: "seek", profileUrl: linkedInProfile });
    expect(out).toEqual({ ok: true, platform: "linkedin", url: linkedInProfile });
  });

  it("strips a merge-key prefix before doing anything else", () => {
    for (const prefix of ["seek:", "linkedin:", "jobadder:"]) {
      const out = resolveJobTarget({ platform: "seek", profileUrl: `${prefix}${seekProfile}` });
      expect(out).toEqual({ ok: true, platform: "seek", url: seekProfile });
    }
  });

  it("agrees with the job when the job is already right", () => {
    expect(resolveJobTarget({ platform: "seek", profileUrl: seekProfile }))
      .toEqual({ ok: true, platform: "seek", url: seekProfile });
    expect(resolveJobTarget({ platform: "linkedin", profileUrl: linkedInProfile }))
      .toEqual({ ok: true, platform: "linkedin", url: linkedInProfile });
  });

  it("matches linkedin subdomains but not lookalike domains", () => {
    expect(resolveJobTarget({ platform: "seek", profileUrl: "https://nz.linkedin.com/in/x" }))
      .toEqual({ ok: true, platform: "linkedin", url: "https://nz.linkedin.com/in/x" });
    // notlinkedin.com must NOT be read as linkedin
    const out = resolveJobTarget({ platform: "jobadder", profileUrl: "https://notlinkedin.com/in/x" });
    expect(out).toEqual({ ok: true, platform: "jobadder", url: "https://notlinkedin.com/in/x" });
  });
});

describe("resolveJobTarget — falling back to the job's platform", () => {
  it("keeps the job platform when the URL identifies nothing (JobAdder custom hosts)", () => {
    const url = "https://acme-recruit.jobadder-instance.example.com/candidate/9";
    expect(resolveJobTarget({ platform: "jobadder", profileUrl: url }))
      .toEqual({ ok: true, platform: "jobadder", url });
  });

  it("rejects an unknown platform rather than guessing", () => {
    const out = resolveJobTarget({ platform: "myspace" as never, profileUrl: "https://example.com/x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/platform/i);
  });
});

describe("resolveJobTarget — refusing unusable input", () => {
  it("refuses a non-https URL", () => {
    for (const bad of ["http://nz.employer.seek.com/talentsearch/profile/1", "ftp://x/y", "javascript:alert(1)"]) {
      const out = resolveJobTarget({ platform: "seek", profileUrl: bad });
      expect(out.ok).toBe(false);
    }
  });

  it("refuses a bare merge key with no URL behind it", () => {
    const out = resolveJobTarget({ platform: "seek", profileUrl: "seek:12345" });
    expect(out.ok).toBe(false);
  });

  it("refuses empty, null and undefined", () => {
    for (const bad of ["", "   ", null, undefined]) {
      const out = resolveJobTarget({ platform: "seek", profileUrl: bad });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBeTruthy();
    }
  });

  it("never throws, whatever it is handed", () => {
    const junk = ["://", "https://", "https:// spaces .com", "%%%", "https://[", "seek:seek:seek:"];
    for (const bad of junk) {
      expect(() => resolveJobTarget({ platform: "seek", profileUrl: bad })).not.toThrow();
    }
  });
});

describe("resolveJobTarget — the failure must be legible", () => {
  it("names the URL it refused so the log identifies the poisoned row", () => {
    const out = resolveJobTarget({ platform: "seek", profileUrl: "seek:12345" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("12345");
  });
});
