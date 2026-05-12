/**
 * Unit test for the pure decision helper that drives <ProvenancePill>.
 *
 * Kept as a pure-function test (no React rendering) because the repo
 * doesn't have @testing-library/react wired in. The component itself is
 * a thin wrapper around this helper.
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

  it("returns a Llama pill for scoredBy='ollama' on match context (with penalty note)", () => {
    const props = provenancePillProps("ollama", "match");
    expect(props?.label).toBe("Llama");
    expect(props?.tone).toBe("llama");
    expect(props?.title).toMatch(/penalised/);
    expect(props?.title).toMatch(/local Llama/);
  });

  it("returns acceptance-context copy when context='acceptance'", () => {
    const claude = provenancePillProps("claude", "acceptance");
    expect(claude?.title).toMatch(/Acceptance likelihood produced by Claude/);

    const llama = provenancePillProps("ollama", "acceptance");
    expect(llama?.title).toMatch(/Acceptance likelihood produced by the local Llama/);
    expect(llama?.title).toMatch(/provisional/);
  });

  it("returns null for missing scoredBy (legacy candidates show no provenance badge)", () => {
    expect(provenancePillProps(undefined, "match")).toBeNull();
    expect(provenancePillProps(null,      "match")).toBeNull();
    expect(provenancePillProps(undefined, "acceptance")).toBeNull();
  });

  it("returns null for unrecognised scoredBy values (forward-compat guard)", () => {
    expect(provenancePillProps("openai"  as never, "match")).toBeNull();
    expect(provenancePillProps(""        as never, "match")).toBeNull();
  });
});
