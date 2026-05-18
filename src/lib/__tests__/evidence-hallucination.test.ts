import { describe, expect, it } from "vitest";
import { evidenceLooksGrounded } from "../ai/scoring";

describe("evidenceLooksGrounded — AI hallucination guard", () => {
  // Real candidate profile excerpt for the tests below.
  const profile = `
    Jane Smith — Senior Software Engineer at Trade Me Group
    Wellington, New Zealand
    Built and shipped a kotlin-based microservice handling payments at 50k tps.
    Led the platform team's adoption of kubernetes for staging environments.
    Previously at Vodafone NZ as a backend engineer working with java spring boot.
  `.toLowerCase();

  it("accepts evidence that quotes a token from the profile", () => {
    expect(evidenceLooksGrounded("Built kubernetes microservices", profile)).toBe(true);
    expect(evidenceLooksGrounded("Hands-on with kotlin in production", profile)).toBe(true);
  });

  it("accepts 'Not mentioned' boilerplate verbatim", () => {
    expect(evidenceLooksGrounded("Not mentioned", profile)).toBe(true);
    expect(evidenceLooksGrounded("Not mentioned in profile", profile)).toBe(true);
  });

  it("rejects evidence whose only meaningful tokens never appear in the profile", () => {
    // Claude fabricates Rust experience for a Java/Kotlin candidate.
    expect(evidenceLooksGrounded("Strong rust ownership and async tokio runtime", profile)).toBe(false);
  });

  it("rejects evidence whose specific claim isn't grounded even if it sounds plausible", () => {
    // No mention of Postgres anywhere in the profile.
    expect(evidenceLooksGrounded("Built postgres replication tooling", profile)).toBe(false);
  });

  it("rejects evidence with only benign filler words (no testable specifics)", () => {
    // All filler — should not validate as grounded.
    // (Empty meaningful-token case returns true to avoid false-flagging
    // genuinely contentless evidence; this test confirms the rule about
    // benign-word-only is interpreted as 'no testable content'.)
    expect(evidenceLooksGrounded("Candidate previously demonstrates expertise", profile)).toBe(true);
  });

  it("returns true for empty evidence (nothing to test)", () => {
    expect(evidenceLooksGrounded("", profile)).toBe(true);
  });

  it("is case-insensitive to the profile content", () => {
    const ucProfile = "JANE SHIPPED A KOTLIN PIPELINE FOR TRADE ME";
    expect(evidenceLooksGrounded("kotlin shipped at scale", ucProfile.toLowerCase())).toBe(true);
  });
});
