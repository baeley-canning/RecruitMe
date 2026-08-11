/**
 * Structured extraction from raw profile TEXT.
 *
 * Why this exists: scrapeSeekProfile guesses at CSS selectors
 * ([data-testid="work-history"] li and friends — its own comment calls them
 * "approximated"). When the site's markup drifts they silently return nothing,
 * which is how every SEEK profile was thrown away. Text survives redesigns;
 * markup does not.
 *
 * It also produces the fields the Candidate row has never had — years of
 * experience and current seniority — without which "within pay scale" and
 * "years worked" cannot be filtered or ranked at all, only guessed at by the
 * scorer, per profile, at cost.
 *
 * These tests cover the PARSER: what comes back from the model is untrusted
 * input, and it is the parser that has to be unbreakable.
 */
import { describe, it, expect } from "vitest";
import { parseExtractedProfile, type ExtractedProfile } from "../profile-extract";

const FULL = JSON.stringify({
  name: "Aaron Armour",
  headline: "Senior Software Engineer at Xero",
  location: "Wellington, NZ",
  roles: [
    { title: "Senior Software Engineer", employer: "Xero", start: "2021-03", end: null, isCurrent: true },
    { title: "Software Engineer", employer: "Trade Me", start: "2018-01", end: "2021-02", isCurrent: false },
  ],
  skills: ["C#", ".NET", "React"],
  totalYearsExperience: 8,
  currentSeniority: "senior",
});

describe("parseExtractedProfile", () => {
  it("parses a well-formed response", () => {
    const p = parseExtractedProfile(FULL) as ExtractedProfile;
    expect(p.name).toBe("Aaron Armour");
    expect(p.roles).toHaveLength(2);
    expect(p.roles[0].isCurrent).toBe(true);
    expect(p.skills).toContain(".NET");
    expect(p.totalYearsExperience).toBe(8);
    expect(p.currentSeniority).toBe("senior");
  });

  it("survives the model wrapping JSON in prose or a code fence", () => {
    expect(parseExtractedProfile("Here you go:\n```json\n" + FULL + "\n```")?.name).toBe("Aaron Armour");
    expect(parseExtractedProfile("Sure!\n" + FULL)?.name).toBe("Aaron Armour");
  });

  it("returns null rather than throwing on unusable output", () => {
    for (const junk of ["", "   ", "not json at all", "{", "null", "[]"]) {
      expect(parseExtractedProfile(junk)).toBeNull();
    }
  });

  it("never invents a name — page chrome must not become a candidate name", () => {
    // The exact failure that renamed a real candidate to "SEEK".
    for (const bad of ["SEEK", "LinkedIn", "Sign in", "Profile"]) {
      const p = parseExtractedProfile(JSON.stringify({ name: bad, roles: [] }));
      expect(p?.name).toBeNull();
    }
  });

  it("drops malformed roles instead of failing the whole parse", () => {
    const p = parseExtractedProfile(JSON.stringify({
      name: "Jo Smith",
      roles: [
        { title: "Engineer", employer: "Acme", start: "2020-01", end: null, isCurrent: true },
        { employer: "NoTitle Ltd" },
        "not an object",
        null,
      ],
    }));
    expect(p?.roles).toHaveLength(1);
    expect(p?.roles[0].title).toBe("Engineer");
  });

  it("rejects an implausible tenure rather than trusting the model", () => {
    // A hallucinated 90 years must not flow into the over-qualification rule.
    expect(parseExtractedProfile(JSON.stringify({ name: "Jo Smith", totalYearsExperience: 90, roles: [] }))?.totalYearsExperience).toBeNull();
    expect(parseExtractedProfile(JSON.stringify({ name: "Jo Smith", totalYearsExperience: -3, roles: [] }))?.totalYearsExperience).toBeNull();
    expect(parseExtractedProfile(JSON.stringify({ name: "Jo Smith", totalYearsExperience: "eight", roles: [] }))?.totalYearsExperience).toBeNull();
  });

  it("only accepts seniority from the known vocabulary", () => {
    expect(parseExtractedProfile(JSON.stringify({ name: "Jo Smith", currentSeniority: "senior", roles: [] }))?.currentSeniority).toBe("senior");
    expect(parseExtractedProfile(JSON.stringify({ name: "Jo Smith", currentSeniority: "rockstar", roles: [] }))?.currentSeniority).toBeNull();
  });

  it("caps runaway lists so one bad response can't bloat a row", () => {
    const p = parseExtractedProfile(JSON.stringify({
      name: "Jo Smith",
      skills: Array.from({ length: 500 }, (_, i) => `skill-${i}`),
      roles: Array.from({ length: 200 }, () => ({ title: "Engineer", employer: "Acme", isCurrent: false })),
    }));
    expect(p!.skills.length).toBeLessThanOrEqual(50);
    expect(p!.roles.length).toBeLessThanOrEqual(40);
  });

  it("tolerates every field being absent", () => {
    const p = parseExtractedProfile(JSON.stringify({ name: "Jo Smith" }));
    expect(p).not.toBeNull();
    expect(p!.roles).toEqual([]);
    expect(p!.skills).toEqual([]);
    expect(p!.headline).toBeNull();
    expect(p!.totalYearsExperience).toBeNull();
  });

  it("trims and collapses whitespace on text fields", () => {
    const p = parseExtractedProfile(JSON.stringify({ name: "  Jo   Smith \n", headline: " Engineer  at  Acme " }));
    expect(p?.name).toBe("Jo Smith");
    expect(p?.headline).toBe("Engineer at Acme");
  });
});
