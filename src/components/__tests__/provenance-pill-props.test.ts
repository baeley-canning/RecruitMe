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

  it("returns a GPT pill for scoredBy='openai' on match context", () => {
    const props = provenancePillProps("openai", "match");
    expect(props?.label).toBe("GPT");
    expect(props?.tone).toBe("openai");
    expect(props?.title).toMatch(/OpenAI/);
    expect(props?.title).toMatch(/failover from Claude/);
  });

  it("returns acceptance-context copy when context='acceptance'", () => {
    const claude = provenancePillProps("claude", "acceptance");
    expect(claude?.title).toMatch(/Acceptance likelihood produced by Claude/);

    const openai = provenancePillProps("openai", "acceptance");
    expect(openai?.title).toMatch(/Acceptance likelihood produced by OpenAI/);
  });

  it("returns null for missing scoredBy (legacy candidates show no provenance badge)", () => {
    expect(provenancePillProps(undefined, "match")).toBeNull();
    expect(provenancePillProps(null,      "match")).toBeNull();
    expect(provenancePillProps(undefined, "acceptance")).toBeNull();
  });

  it("returns null for unrecognised scoredBy values (forward-compat guard)", () => {
    // Legacy rows from the prior Llama-failover era still carry
    // scoredBy:"ollama" in JSON. Those should render no pill rather
    // than mislead the recruiter; the candidate just looks unscored
    // for that field until re-scored.
    expect(provenancePillProps("ollama" as never, "match")).toBeNull();
    expect(provenancePillProps(""       as never, "match")).toBeNull();
  });
});
