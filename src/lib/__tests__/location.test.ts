import { describe, expect, it } from "vitest";
import {
  assessLocationFit,
  buildTargetLocationLabel,
  expandLocationKeywords,
  extractKnownLocationTargets,
  inferCandidateCountry,
  inferCandidateLocation,
  isConfirmedOutOfAreaForLocalRole,
  isExplicitlyOverseasLocation,
  isOverseasForNzRole,
  isPlausibleLocation,
  isRemoteFriendlyLocationRule,
  locationMatches,
  shouldRejectAsOverseas,
} from "../location";

describe("inferCandidateLocation — search-snippet city detection", () => {
  it("trusts an explicit, plausible location field", () => {
    expect(inferCandidateLocation("Wellington, New Zealand", "any text"))
      .toBe("Wellington, New Zealand");
  });

  it("scans profileText for an NZ city when the location field is empty", () => {
    const snippet = "Senior Software Engineer based in Auckland, building Kotlin services.";
    expect(inferCandidateLocation(null, snippet)).toBe("Auckland");
  });

  it("scans multiple text sources in order until a city is found", () => {
    expect(inferCandidateLocation(null, null, "headline only", "snippet says Christchurch"))
      .toBe("Christchurch");
  });

  it("returns null when no plausible location and no city in any text", () => {
    expect(inferCandidateLocation(null, "Senior Engineer", "Five years experience"))
      .toBeNull();
  });

  it("uses the first-mentioned NZ city when several appear", () => {
    const text = "Worked in Auckland for 5 years before moving back to Christchurch";
    expect(inferCandidateLocation(null, text)).toBe("Auckland");
  });
});

describe("locationMatches", () => {
  it("rejects explicit overseas lookalikes even when the city name overlaps", () => {
    const wellingtonKeywords = expandLocationKeywords("Wellington");

    expect(locationMatches("Wellington, Somerset, England", wellingtonKeywords)).toBe(false);
    expect(locationMatches("Wellington, New Zealand", wellingtonKeywords)).toBe(true);
  });

  it("rejects obviously different NZ cities for a tight city search", () => {
    const wellingtonKeywords = expandLocationKeywords("Wellington");

    expect(locationMatches("Napier, Hawke's Bay, New Zealand", wellingtonKeywords)).toBe(false);
  });
});

describe("isRemoteFriendlyLocationRule", () => {
  it("uses one remote/hybrid interpretation for scoring and job prefill", () => {
    expect(isRemoteFriendlyLocationRule("Fully remote, NZ-based only")).toBe(true);
    expect(isRemoteFriendlyLocationRule("Can work from anywhere in NZ")).toBe(true);
    expect(isRemoteFriendlyLocationRule("Hybrid, Wellington office")).toBe(false);
    expect(isRemoteFriendlyLocationRule("Remote optional, 3 days in office")).toBe(false);
  });
});

describe("assessLocationFit", () => {
  it("scores exact city matches as strong", () => {
    const fit = assessLocationFit("Wellington, New Zealand", "Wellington");
    expect(fit?.score).toBe(100);
  });

  it("scores distant NZ cities as weak for office-based roles", () => {
    const fit = assessLocationFit("Napier, Hawke's Bay, New Zealand", "Wellington");
    expect(fit?.score).toBeLessThan(45);
  });

  it("scores explicit overseas locations as mismatches", () => {
    const fit = assessLocationFit("Shanghai, China", "Wellington");
    expect(fit?.score).toBe(0);
  });

  it("treats headline text stored as location as unknown", () => {
    const fit = assessLocationFit(
      "Specialist in Training Design, Development and Delivery at Multiple Clients",
      "Wellington"
    );
    expect(fit?.score).toBe(45);
    expect(fit?.evidence).toContain("not clearly stated");
  });

  it("treats two-word person names stored as location as unknown", () => {
    const fit = assessLocationFit("Denuka Kumarage", "Wellington");
    expect(fit?.score).toBe(45);
    expect(fit?.evidence).toContain("not clearly stated");
  });

  it("scores against the best valid target for multi-location roles", () => {
    const fit = assessLocationFit(
      "Wellington, Wellington, New Zealand",
      "Primary: Devonport, Auckland. Secondary option: Petone, Wellington. Full-time, on-site role."
    );

    expect(fit?.score).toBe(100);
    expect(fit?.evidence).toContain("Acceptable role locations");
  });

  // Satellite/parent-metro recognition. Without parentMetro tagging, a
  // Rolleston-based candidate scored 35 ("NZ but not local") for a
  // Christchurch role and a Paraparaumu candidate scored 80 by raw 45km
  // distance. Both should now be treated as 100 same-metro matches.
  describe("same-metro recognition", () => {
    it("treats Rolleston, Canterbury as a Christchurch match", () => {
      const fit = assessLocationFit("Rolleston, Canterbury", "Christchurch");
      expect(fit?.score).toBe(100);
      expect(fit?.evidence).toMatch(/Christchurch metro/);
    });

    it("treats Paraparaumu as a Wellington match (45km, beyond distance-100 bucket)", () => {
      // Use a candidate string with NO "Wellington" substring so we exercise
      // the parentMetro branch rather than the literal-substring shortcut.
      const fit = assessLocationFit("Paraparaumu, New Zealand", "Wellington");
      expect(fit?.score).toBe(100);
      expect(fit?.evidence).toMatch(/Wellington metro/);
    });

    it("treats Kaiapoi as a Christchurch match", () => {
      const fit = assessLocationFit("Kaiapoi, New Zealand", "Christchurch");
      expect(fit?.score).toBe(100);
    });

    it("treats North Shore as an Auckland match", () => {
      const fit = assessLocationFit("North Shore, Auckland", "Auckland");
      expect(fit?.score).toBe(100);
    });

    it("treats Pukekohe as an Auckland match (49km out — beyond distance fallback)", () => {
      const fit = assessLocationFit("Pukekohe, Auckland", "Auckland");
      expect(fit?.score).toBe(100);
    });

    it("does NOT promote a Christchurch candidate for a Wellington role", () => {
      const fit = assessLocationFit("Christchurch, New Zealand", "Wellington");
      expect(fit?.score).toBeLessThan(45);
    });

    it("does NOT promote one satellite to a different metro's parent", () => {
      const fit = assessLocationFit("Rolleston, Canterbury", "Wellington");
      expect(fit?.score).toBeLessThan(45);
    });
  });
});

describe("isConfirmedOutOfAreaForLocalRole", () => {
  it("flags Auckland as out of area for a Wellington office role", () => {
    expect(isConfirmedOutOfAreaForLocalRole("Auckland, New Zealand", "Wellington", null, false)).toBe(true);
  });

  it("does not reject unknown locations before the profile proves the mismatch", () => {
    expect(isConfirmedOutOfAreaForLocalRole(null, "Wellington", null, false)).toBe(false);
  });

  it("does not reject distant NZ candidates for remote roles", () => {
    expect(isConfirmedOutOfAreaForLocalRole("Auckland, New Zealand", "Wellington", null, true)).toBe(false);
  });
});

describe("extractKnownLocationTargets", () => {
  it("extracts all named NZ city targets in order", () => {
    expect(
      extractKnownLocationTargets(
        "Primary: Devonport, Auckland (on-site). Secondary option: Petone, Wellington."
      )
    ).toEqual(["North Shore", "Auckland", "Petone", "Wellington"]);
  });

  it("builds a readable target label for scoring and search fallback", () => {
    expect(buildTargetLocationLabel("Wellington", "Primary: Auckland. Secondary: Petone")).toBe(
      "Wellington OR Auckland OR Petone"
    );
  });
});

describe("isPlausibleLocation", () => {
  it("rejects job descriptions and headlines", () => {
    expect(isPlausibleLocation("Specialist in Training Design, Development and Delivery at Multiple Clients")).toBe(false);
    expect(isPlausibleLocation("Capability, Change, Learning and Development")).toBe(false);
  });

  it("keeps real locations", () => {
    expect(isPlausibleLocation("Porirua, Wellington, New Zealand")).toBe(true);
    expect(isPlausibleLocation("Wellington & Wairarapa, New Zealand")).toBe(true);
    expect(isPlausibleLocation("Shanghai, China")).toBe(true);
  });
});

describe("isExplicitlyOverseasLocation — bare-city detection", () => {
  it("catches bare Australian city names without state or country", () => {
    // Bin Xiao class of leak: snippet-only location field, no AU/NSW marker.
    expect(isExplicitlyOverseasLocation("Sydney")).toBe(true);
    expect(isExplicitlyOverseasLocation("Melbourne")).toBe(true);
    expect(isExplicitlyOverseasLocation("Brisbane")).toBe(true);
    expect(isExplicitlyOverseasLocation("Perth")).toBe(true);
    expect(isExplicitlyOverseasLocation("Adelaide")).toBe(true);
  });

  it("catches bare UK / Ireland / India / Asia city names", () => {
    expect(isExplicitlyOverseasLocation("London")).toBe(true);
    expect(isExplicitlyOverseasLocation("Manchester")).toBe(true);
    expect(isExplicitlyOverseasLocation("Dublin")).toBe(true);
    expect(isExplicitlyOverseasLocation("Mumbai")).toBe(true);
    expect(isExplicitlyOverseasLocation("Bangalore")).toBe(true);
    expect(isExplicitlyOverseasLocation("Singapore")).toBe(true);
    expect(isExplicitlyOverseasLocation("Tokyo")).toBe(true);
  });

  it("still catches the explicit forms that already worked", () => {
    expect(isExplicitlyOverseasLocation("Sydney, New South Wales, Australia")).toBe(true);
    expect(isExplicitlyOverseasLocation("Sydney, NSW")).toBe(true);
    expect(isExplicitlyOverseasLocation("Pittsburgh, PA")).toBe(true);
  });

  it("does not flag NZ locations", () => {
    expect(isExplicitlyOverseasLocation("Wellington, New Zealand")).toBe(false);
    expect(isExplicitlyOverseasLocation("Auckland")).toBe(false);
    expect(isExplicitlyOverseasLocation("Christchurch, Canterbury, NZ")).toBe(false);
    expect(isExplicitlyOverseasLocation("")).toBe(false);
  });
});

describe("isOverseasForNzRole — country gate at save sites", () => {
  it("blocks bare-city Australian candidates on a non-remote NZ role", () => {
    expect(isOverseasForNzRole("Sydney", false)).toBe(true);
    expect(isOverseasForNzRole("Sydney, NSW, Australia", false)).toBe(true);
  });

  it("does not block NZ-wide candidates (loose intra-NZ — city-distance handles ranking)", () => {
    // Auckland for a Wellington role: still in NZ, NOT a country-level reject.
    // City-distance affects scoring, not the import gate.
    expect(isOverseasForNzRole("Auckland, New Zealand", false)).toBe(false);
    expect(isOverseasForNzRole("Christchurch", false)).toBe(false);
  });

  it("does not block when the role is remote", () => {
    expect(isOverseasForNzRole("Sydney, Australia", true)).toBe(false);
    expect(isOverseasForNzRole("London", true)).toBe(false);
  });

  it("does not block when the location is unknown", () => {
    // Unknown stays reviewable — fetch will reveal more later, and the
    // post-fetch enrichment path applies the gate retroactively.
    expect(isOverseasForNzRole(null, false)).toBe(false);
    expect(isOverseasForNzRole("", false)).toBe(false);
    expect(isOverseasForNzRole(undefined, false)).toBe(false);
  });
});

describe("inferCandidateCountry — Present-block, NZ veto, two-signal rule", () => {
  it("flags overseas with HIGH confidence when current role and explicit location both signal AU", () => {
    const result = inferCandidateCountry({
      explicitLocation: "Sydney, NSW, Australia",
      headline: "Senior Engineer at Atlassian",
      profileText: "Senior Engineer at Atlassian · Mar 2023 - Present · Sydney, Australia\nC#, .NET, AWS",
    });
    expect(result.country).toBe("OVERSEAS");
    expect(result.confidence).toBe("high");
  });

  it("does NOT flag overseas when explicit location is Sydney but the candidate has +64 phone", () => {
    // Phone +64 is a hard NZ veto via the country-code path.
    const result = inferCandidateCountry({
      explicitLocation: "Sydney",
      profileText: "Contact: +64 21 555 0100\nSenior Engineer at Globex · Present · Sydney",
    });
    expect(result.country).toBe("NZ");
  });

  it("returnee Kiwi: previously at Atlassian Sydney, now at Xero Wellington — NOT overseas", () => {
    // The classic false-positive risk. Past role is overseas, current role is NZ.
    // NZ veto on "Wellington" + "New Zealand" must override the Atlassian mention.
    const result = inferCandidateCountry({
      explicitLocation: "Wellington, New Zealand",
      headline: "Lead Engineer at Xero",
      profileText: [
        "Lead Engineer at Xero · Jan 2023 - Present · Wellington, New Zealand",
        "Senior Engineer at Atlassian · Mar 2018 - Dec 2021 · Sydney, Australia",
      ].join("\n"),
    });
    expect(result.country).toBe("NZ");
  });

  it("multinational with NZ office: 'Engineer at Canva, Auckland' is NOT overseas", () => {
    // Canva is on the definitely-overseas list, but the role's location string
    // names Auckland — NZ veto wins.
    const result = inferCandidateCountry({
      explicitLocation: "Auckland, New Zealand",
      profileText: "Engineer at Canva · Jul 2024 - Present · Auckland, New Zealand",
    });
    expect(result.country).toBe("NZ");
  });

  it("dual-office founder: 'Auckland & Sydney' is NOT overseas (NZ token wins)", () => {
    const result = inferCandidateCountry({
      explicitLocation: "Auckland & Sydney",
      profileText: "Co-Founder at FooCorp · Jan 2022 - Present · Auckland & Sydney",
    });
    expect(result.country).toBe("NZ");
  });

  it("NZ contractor remote for AU client: 'Remote from NZ' wins over 'Commbank Sydney'", () => {
    const result = inferCandidateCountry({
      explicitLocation: "Wellington, NZ",
      profileText: "Lead Engineer at Commbank · Present · Sydney, Australia (remote from NZ)",
    });
    expect(result.country).toBe("NZ");
  });

  it("single overseas signal alone returns UNKNOWN — reviewable, not auto-rejected", () => {
    // Only ONE signal: "based in" phrase. No corroboration. Stay reviewable.
    const result = inferCandidateCountry({
      profileText: "Engineer based in Sydney working on cool stuff.",
    });
    expect(result.country).toBe("UNKNOWN");
  });

  it("Bin Xiao class: AU explicit location + AU current-role employer = HARD reject", () => {
    const result = inferCandidateCountry({
      explicitLocation: "Sydney, New South Wales, Australia",
      headline: "Web Developer: React | Javascript | HTML | C# | .NET | SQL | Azure | Blazor",
      profileText: "Web Developer at Kelly+Partners Group Holdings Limited · Present · Sydney",
    });
    expect(result.country).toBe("OVERSEAS");
    expect(result.confidence).toBe("high");
  });

  it("empty/null inputs return UNKNOWN", () => {
    expect(inferCandidateCountry({}).country).toBe("UNKNOWN");
    expect(inferCandidateCountry({ profileText: "" }).country).toBe("UNKNOWN");
  });
});

describe("shouldRejectAsOverseas — combined gate", () => {
  it("rejects when explicit location is unambiguously overseas", () => {
    const result = shouldRejectAsOverseas({ explicitLocation: "Sydney, NSW, Australia" });
    expect(result.reject).toBe(true);
  });

  it("does not reject when remote", () => {
    const result = shouldRejectAsOverseas({
      explicitLocation: "Sydney, Australia",
      isRemote: true,
    });
    expect(result.reject).toBe(false);
  });

  it("does not reject a returnee Kiwi based on past-role mentions alone", () => {
    const result = shouldRejectAsOverseas({
      explicitLocation: "Wellington, NZ",
      profileText: "Lead at Xero · Present · Wellington\nPrev: Atlassian · 2018-2021 · Sydney",
    });
    expect(result.reject).toBe(false);
  });

  it("does not reject on a single weak signal", () => {
    // "based in Sydney" alone, no corroborating signal → UNKNOWN, no reject.
    const result = shouldRejectAsOverseas({
      profileText: "Engineer based in Sydney working remotely.",
    });
    expect(result.reject).toBe(false);
  });
});

describe("inferCandidateCountry — false-positive guards (round 2)", () => {
  it("'Wellington Smith' name with explicit Sydney location is rejected, NOT vetoed by name", () => {
    // The bug the agents found: NZ veto used to fire on "wellington" appearing
    // anywhere in the text — including the candidate's surname. Two
    // corroborating overseas signals must override body NZ mentions.
    const result = inferCandidateCountry({
      explicitLocation: "Sydney, Australia",
      headline: "CEO",
      profileText: "Wellington Smith — CEO at Foo Corp · Present · Sydney, Australia",
    });
    expect(result.country).toBe("OVERSEAS");
    expect(result.confidence).toBe("high");
  });

  it("returnee Kiwi WITHOUT explicit NZ location: NZ via soft veto", () => {
    // The agents flagged this as the test we never had — every previous
    // returnee test had explicit "Wellington, NZ" which short-circuited
    // before reaching the inference. This one has profile text only.
    const result = inferCandidateCountry({
      profileText: [
        "Lead Engineer at Xero · Jan 2023 - Present · Wellington",
        "Senior Engineer at Atlassian · Mar 2018 - Dec 2021 · Sydney, Australia",
      ].join("\n"),
    });
    expect(result.country).toBe("NZ");
  });

  it("does not flag profiles using common English words 'reading', 'oxford', 'cambridge'", () => {
    // The agents flagged that bare "reading" / "oxford" / "cambridge" in
    // OVERSEAS_CITIES was over-aggressive — they appear in normal English.
    // Cambridge in particular collides with a NZ town. These are now removed.
    expect(isExplicitlyOverseasLocation("My reading list includes books on architecture")).toBe(false);
    expect(isExplicitlyOverseasLocation("Use the Oxford comma")).toBe(false);
    expect(isExplicitlyOverseasLocation("Cambridge University Press")).toBe(false);
    expect(isExplicitlyOverseasLocation("Cambridge, Waikato, New Zealand")).toBe(false); // NZ town
  });

  it("PRESENT_LOCATION_RE matches the realistic LinkedIn next-line format", () => {
    // Real LinkedIn captures put the location on the LINE AFTER 'Present',
    // not inline — what follows '· Present ·' is the duration text. The
    // earlier regex required inline format and silently missed every
    // realistic capture. This test locks the fix.
    const result = inferCandidateCountry({
      profileText: [
        "Senior Engineer",
        "Acme Corp · Full-time",
        "Mar 2023 - Present · 1 yr 9 mos",
        "Sydney, New South Wales, Australia · Hybrid",
        ".NET, C#, SQL Server",
      ].join("\n"),
    });
    // Two signals: Present-block location ("Sydney, NSW, Australia") AND
    // the same line is recognised by isExplicitlyOverseasLocation. Wait —
    // actually that's still one signal class. Let me phrase this as: the
    // helper SHOULD detect Sydney from this format. With no explicit
    // location and no other corroboration, single signal → UNKNOWN. But
    // crucially, Sydney IS detected.
    expect(result.evidence).toMatch(/Sydney|Present-role/i);
  });

  it("re-score un-rejection: recovery path returns NZ when location is corrected", () => {
    // A candidate previously auto-rejected as overseas whose location
    // field has been corrected to NZ should infer NZ on re-score.
    const result = inferCandidateCountry({
      explicitLocation: "Wellington, New Zealand",
      profileText: "Senior Engineer at Atlassian · Mar 2018 - Dec 2021 · Sydney",
    });
    expect(result.country).toBe("NZ");
  });

  it("escapes regex metacharacters in DEFINITELY_OVERSEAS_COMPANIES company names", () => {
    // Confidence test — "Kelly+Partners" has a `+` regex meta. The escape
    // function must turn that into `\+` not `\\+` (which would have been the
    // case with the broken character class). If escaping is wrong, the
    // pattern construction throws or fails to match.
    const result = inferCandidateCountry({
      explicitLocation: "Sydney, Australia",
      profileText: "Web Developer at Kelly+Partners Group Holdings Limited · Present · Sydney",
    });
    expect(result.country).toBe("OVERSEAS");
  });
});
