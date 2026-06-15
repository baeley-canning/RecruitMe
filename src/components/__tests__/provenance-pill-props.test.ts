/**
 * Unit test for the pure decision helper that drives <ProvenancePill>.
 *
 * Kept as a pure-function test (no React rendering) because the repo
 * doesn't have @testing-library/react wired in. The component itself
 * is a thin wrapper around this helper.
 */
import { describe, expect, it } from "vitest";
import { provenancePillProps } from "../provenance-pill-props";

describe("provenancePillProps", () => {
  it("returns a Claude pill for scoredBy='claude' on match context", () => {
    expect(provenancePillProps("claude", "match")).toEqual({
      label: "Claude",
      tone:  "claude",
      title: "Match score produced by Claude.",
    });
  });

  it("returns a Llama pill for scoredBy='ollama' on match context", () => {
    const props = provenancePillProps("ollama", "match");
    expect(props?.label).toBe("Llama");
    expect(props?.tone).toBe("ollama");
    expect(props?.title).toMatch(/Llama/);
    expect(props?.title).toMatch(/failover from Claude/);
  });

  it("returns acceptance-context copy when context='acceptance'", () => {
    const claude = provenancePillProps("claude", "acceptance");
    expect(claude?.title).toMatch(/Acceptance likelihood produced by Claude/);

    const ollama = provenancePillProps("ollama", "acceptance");
    expect(ollama?.title).toMatch(/Acceptance likelihood produced by the local Llama model/);
  });

  it("returns null for missing scoredBy (legacy candidates show no provenance badge)", () => {
    expect(provenancePillProps(undefined, "match")).toBeNull();
    expect(provenancePillProps(null,      "match")).toBeNull();
    expect(provenancePillProps(undefined, "acceptance")).toBeNull();
  });

  it("returns null for unrecognised scoredBy values (forward-compat guard)", () => {
    // Legacy rows from the prior OpenAI-failover era still carry
    // scoredBy:"openai" in JSON, and any future-removed provider (e.g.
    // "gemini") likewise. Those should render no pill rather than
    // mislead the recruiter; the candidate just looks unscored for that
    // field until re-scored.
    expect(provenancePillProps("gemini" as never, "match")).toBeNull();
    expect(provenancePillProps("openai" as never, "match")).toBeNull();
    expect(provenancePillProps(""       as never, "match")).toBeNull();
  });

  it("returns a Base pill for scoredBy='heuristic' on match (deterministic, no AI)", () => {
    const props = provenancePillProps("heuristic", "match");
    expect(props?.label).toBe("Base");
    expect(props?.tone).toBe("base");
    expect(props?.title).toMatch(/No AI ran/i);
  });

  it("returns null for heuristic on acceptance context (acceptance is always model-produced)", () => {
    expect(provenancePillProps("heuristic", "acceptance")).toBeNull();
  });
});
