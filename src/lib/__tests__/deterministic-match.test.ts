import { describe, expect, it } from "vitest";
import { runDeterministicMatch, buildStubBreakdown } from "../scoring";
import {
  extractSignalsFromRequirement,
  signalMatchesText,
} from "../requirement-signals";

const deps = {
  expandSignals: extractSignalsFromRequirement,
  matchSignal: signalMatchesText,
};

describe("runDeterministicMatch — Stage 1 signal presence + sufficiency gate", () => {
  it("Brendan stub case: 8000+ chars, NO work history, NO must-have tokens → sufficient=false", () => {
    // Reconstruction of the actual failure: long profile-shaped text but the
    // extension missed the Experience section entirely.
    const stub = (
      "Brendan Lester. Lead Engineer - Quality at Xero. Wellington, New Zealand. " +
      "About: SDLC consultancy with integration platform delivery. " +
      "Strong communicator, mentor and team lead. "
    ).repeat(40);
    const result = runDeterministicMatch({
      profileText: stub,
      mustHaves: ["C++ programming", "Sybase database", "Kubernetes deployment"],
      ...deps,
    });
    expect(result.charCount).toBeGreaterThanOrEqual(2000);
    expect(result.rolesDetected).toBe(0);
    expect(result.matchedSignals).toEqual([]);
    expect(result.sufficient).toBe(false);
    expect(result.reasonInsufficient).toMatch(/no detectable work history/i);
  });

  it("Real Brendan case: full profile WITH 'C++ Developer at NZ Customs (1997 - 1998)' → sufficient=true and C++ matched", () => {
    const realProfile = (
      "Brendan Lester. Lead Engineer - Quality at Xero. Wellington, New Zealand.\n" +
      "Experience\n" +
      "Lead Engineer - Quality, Xero (2018 - present). Playwright automation across SaaS platform.\n" +
      "Technical Consultant / C++ Developer at ACC, Xacta Consulting (1998 - 2001). Microsoft Visual C++ developer working with Sybase database on the Pathway team.\n" +
      "C++ Developer & Support, NZ Customs (1997 - 1998). Solaris C++ developer for Intelligence, Goods and Passenger streams within the CusMod solution.\n"
    );
    const result = runDeterministicMatch({
      profileText: realProfile,
      mustHaves: ["C++ programming experience", "Sybase database", "Linux scripting"],
      ...deps,
    });
    expect(result.rolesDetected).toBeGreaterThanOrEqual(2);
    expect(result.matchedSignals).toEqual(expect.arrayContaining([
      "C++ programming experience",
      "Sybase database",
    ]));
    expect(result.sufficient).toBe(true);
  });

  it("snippet-quality profile (<2000 chars) does NOT trigger the gate — falls through to provisional path", () => {
    const snippet = "Senior Frontend Engineer. React + TypeScript. Wellington.";
    const result = runDeterministicMatch({
      profileText: snippet,
      mustHaves: ["React", "Sybase"],
      ...deps,
    });
    expect(result.charCount).toBeLessThan(2000);
    // The gate is for full-profile-shaped captures only. Snippets are
    // intentionally not gated here — they have their own provisional path.
    expect(result.sufficient).toBe(true);
  });

  it("legitimately thin junior profile (1 role, 2000+ chars) passes the gate → Claude can score the prose", () => {
    const juniorProfile = (
      "Software Developer at AcmeCorp (2023 - present). Building React apps. " +
      "Recent graduate. Learning fast. "
    ).repeat(40);
    const result = runDeterministicMatch({
      profileText: juniorProfile,
      mustHaves: ["React"],
      ...deps,
    });
    expect(result.rolesDetected).toBeGreaterThanOrEqual(1);
    expect(result.matchedSignals).toContain("React");
    expect(result.sufficient).toBe(true);
  });

  it("empty must_haves: cannot gate on signal absence — sufficient=true", () => {
    const profileText = "A".repeat(3000);
    const result = runDeterministicMatch({
      profileText,
      mustHaves: [],
      ...deps,
    });
    // No must-haves to detect, no year ranges in filler text, but we don't
    // refuse to score — the role's own definition has nothing to gate on.
    expect(result.sufficient).toBe(true);
  });

  it("matched signals are exposed for prompt injection (Claude ground-truth)", () => {
    const profile = "Senior C++ engineer with Sybase ASE database experience since 2015. ".repeat(30);
    const result = runDeterministicMatch({
      profileText: profile,
      mustHaves: ["C++", "Sybase ASE", "Kubernetes"],
      ...deps,
    });
    expect(result.matchedSignals).toEqual(expect.arrayContaining(["C++", "Sybase ASE"]));
    expect(result.matchedSignals).not.toContain("Kubernetes");
    expect(result.missingSignals).toContain("Kubernetes");
  });

  it("rolesDetected counts year ranges across multiple formats", () => {
    const profile = (
      "Software Engineer (2020 - present). " +
      "Frontend Dev (2017 - 2020). " +
      "Junior Dev (Jan 2014 to Dec 2016). "
    ).repeat(20);
    const result = runDeterministicMatch({
      profileText: profile,
      mustHaves: [],
      ...deps,
    });
    expect(result.rolesDetected).toBeGreaterThanOrEqual(3);
  });

  it("recognises 'since 2018' / 'N yrs' as work-history markers (currently-employed candidates)", () => {
    // LinkedIn's current-role tile shows "Senior Engineer · Since 2018" or
    // "5 yrs 4 mos" in lieu of a YYYY-YYYY range. Without recognising these,
    // the gate would falsely refuse to score recently-employed candidates.
    const profile = (
      "Senior Engineer at Xero. Since 2018. 5 yrs 4 mos. " +
      "Wellington, NZ. About: Strong React engineer. "
    ).repeat(40);
    const result = runDeterministicMatch({
      profileText: profile,
      mustHaves: ["React"],
      ...deps,
    });
    expect(result.rolesDetected).toBeGreaterThanOrEqual(1);
    expect(result.matchedSignals).toContain("React");
    expect(result.sufficient).toBe(true);
  });

  it("legitimate junior false-positive guard: section markers present → gate does NOT fire even with no year-range / no signal hits", () => {
    // Critic 1 #1: a real junior with "5 mos" tenure, profile only has
    // React, JD wants Java. No year-range hit, no must-have hit. Without
    // the section-markers guard, the gate would falsely refuse to score.
    // With the guard, "Experience" / "About" / "Skills" headings prove the
    // capture worked → Claude scores the prose normally.
    const juniorProfile = (
      "About\n" +
      "Recent graduate building React apps.\n\n" +
      "Experience\n" +
      "Software Developer at AcmeCorp · 5 mos · Wellington\n" +
      "Skills\n" +
      "React, JavaScript\n"
    ).repeat(30);
    const result = runDeterministicMatch({
      profileText: juniorProfile,
      mustHaves: ["Java"],  // intentionally not in profile
      ...deps,
    });
    // No year-range OR current-role hits, but section markers present →
    // gate must NOT fire. (Note: "5 mos" actually IS now recognised as a
    // current-role marker by CURRENT_ROLE_RE — this test uses a profile
    // where rolesDetected > 0 OR section markers are present, both of
    // which prevent the false-positive gate firing.)
    expect(result.matchedSignals).toEqual([]);
    expect(result.sufficient).toBe(true);
  });

  it("recovery flow: stub gate refuses → CV merge passes (Brendan end-to-end)", () => {
    const stubProfile = (
      "Brendan Lester. Lead Engineer - Quality at Xero. Wellington, NZ. " +
      "About: SDLC consultancy across integration platforms. "
    ).repeat(40);
    const mustHaves = ["C++ programming", "Sybase database"];
    const before = runDeterministicMatch({ profileText: stubProfile, mustHaves, ...deps });
    expect(before.sufficient).toBe(false);

    // Recruiter uploads CV → merge appends real work history.
    const mergedProfile = stubProfile +
      "\nExperience\n" +
      "C++ Developer at NZ Customs (1997 - 1998). Sybase ASE on the Pathway team.\n" +
      "Lead Engineer at Xero (2018 - present). Test automation.\n";
    const after = runDeterministicMatch({ profileText: mergedProfile, mustHaves, ...deps });
    expect(after.rolesDetected).toBeGreaterThanOrEqual(2);
    expect(after.matchedSignals).toEqual(expect.arrayContaining(["C++ programming", "Sybase database"]));
    expect(after.sufficient).toBe(true);
  });

  it("regex special chars in must-haves: .NET 6.0, Node.js, C# match (F# is a known 2-char-token gap)", () => {
    // Locks the special-char handling for the must-haves we actually see in
    // recruiter JDs. F# isn't covered today — it's only 2 chars and isn't
    // in the alias table — so a JD with "F#" as a must-have would miss the
    // deterministic match. Documented gap; not blocking Brendan-class fixes.
    const profile = (
      "Senior engineer with .NET 6.0 microservices, " +
      "Node.js APIs, and C# enterprise development since 2015. "
    ).repeat(30);
    const result = runDeterministicMatch({
      profileText: profile,
      mustHaves: [".NET 6.0", "Node.js", "C#"],
      ...deps,
    });
    expect(result.matchedSignals).toEqual(
      expect.arrayContaining([".NET 6.0", "Node.js", "C#"]),
    );
  });
});

describe("buildStubBreakdown — synthetic breakdown returned when gate refuses to score", () => {
  it("emits the profile_capture_warning that the UI gates on", () => {
    const breakdown = buildStubBreakdown({
      parsedRoleMustHaves: ["C++", "Sybase"],
      parsedRoleNiceToHaves: ["Linux"],
      profileCharCount: 8234,
      reasonInsufficient: "Stubby capture: no work history visible",
    });
    expect(breakdown.profile_capture_warning).toBeDefined();
    expect(breakdown.profile_capture_warning?.code).toBe("incomplete_capture");
    expect(breakdown.profile_capture_warning?.evidence).toContain(
      "Stubby capture: no work history visible",
    );
  });

  it("sets all must-haves to 'unknown' with explanatory evidence — never 'missing'", () => {
    const breakdown = buildStubBreakdown({
      parsedRoleMustHaves: ["C++", "Sybase"],
      parsedRoleNiceToHaves: [],
      profileCharCount: 8234,
      reasonInsufficient: "stub",
    });
    expect(breakdown.must_have_coverage).toHaveLength(2);
    for (const c of breakdown.must_have_coverage) {
      // Critical: NEVER 'missing' on a partial capture — that's the lie that
      // destroyed recruiter trust on Brendan. Always 'unknown' with prose
      // explaining why.
      expect(c.status).toBe("unknown");
      expect(c.evidence).toMatch(/not visible.*current capture|may exist in full work history/i);
    }
  });

  it("emits empty reasons_for / reasons_against / missing_evidence — no fabricated narrative", () => {
    const breakdown = buildStubBreakdown({
      parsedRoleMustHaves: ["C++"],
      parsedRoleNiceToHaves: [],
      profileCharCount: 8234,
      reasonInsufficient: "stub",
    });
    expect(breakdown.reasons_for).toEqual([]);
    // The buildScoreBreakdown layer prepends a safe banner reason, but the
    // synthetic breakdown does NOT carry Claude-fabricated rejection
    // reasons (those are the recruiter-trust killer).
    expect(breakdown.reasons_against.every((r) => /capture (?:appears )?incomplete|do not (?:reject|progress)/i.test(r))).toBe(true);
  });

  it("recruiter_summary explains the partial capture and frames it as a sourcing-stage signal", () => {
    const breakdown = buildStubBreakdown({
      parsedRoleMustHaves: ["C++"],
      parsedRoleNiceToHaves: [],
      profileCharCount: 8234,
      reasonInsufficient: "stub",
    });
    expect(breakdown.recruiter_summary).toMatch(/visible linkedin data|partial|not.*captured/i);
    // Should NOT instruct recruiter to upload CV — that's wrong at sourcing
    // stage. The recruiter ranks candidates here; CV comes later in the funnel.
    expect(breakdown.recruiter_summary).not.toMatch(/upload cv|CV/);
  });

  it("overall is a real number (NOT a 0 sentinel) — recruiter needs ranking signal at sourcing stage", () => {
    const breakdown = buildStubBreakdown({
      parsedRoleMustHaves: ["C++"],
      parsedRoleNiceToHaves: [],
      profileCharCount: 8234,
      reasonInsufficient: "stub",
      visibleSignals: { headline: "Senior Engineer at Xero", location: "Wellington" },
    });
    // Score reflects visible content (location, seniority, title) — NOT 0.
    // Capped at 50 by data-quality rules so partial captures can't outrank
    // genuinely strong candidates.
    expect(breakdown.overall).toBeGreaterThan(0);
    expect(breakdown.overall).toBeLessThanOrEqual(50);
  });
});
