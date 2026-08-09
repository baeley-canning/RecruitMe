import { describe, it, expect } from "vitest";
import { computeCostUsd, isModelPriced } from "@/lib/ai-pricing";

describe("DeepSeek pricing (guards the daily spend cap)", () => {
  it("prices both v4 models", () => {
    expect(isModelPriced("deepseek-v4-flash")).toBe(true);
    expect(isModelPriced("deepseek-v4-pro")).toBe(true);
  });

  it("v4-flash costs what the rate card says (1M in + 1M out)", () => {
    expect(computeCostUsd("deepseek-v4-flash", 1_000_000, 0)).toBeCloseTo(0.14, 6);
    expect(computeCostUsd("deepseek-v4-flash", 0, 1_000_000)).toBeCloseTo(0.28, 6);
  });

  it("v4-pro costs what the rate card says", () => {
    expect(computeCostUsd("deepseek-v4-pro", 1_000_000, 0)).toBeCloseTo(0.435, 6);
    expect(computeCostUsd("deepseek-v4-pro", 0, 1_000_000)).toBeCloseTo(0.87, 6);
  });

  it("REGRESSION: billing the request name instead of the serving model overcharges ~10x", () => {
    // The app asks for claude-haiku-*; DeepSeek serves v4-flash. Recording the
    // request name charged Claude rates, inflating the spend cap's view.
    const asClaude = computeCostUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)!;
    const asServed = computeCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000)!;
    expect(asClaude).toBeGreaterThan(asServed * 10);
  });
});
