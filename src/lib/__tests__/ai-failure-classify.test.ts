import { describe, expect, it } from "vitest";
import { classifyAiFailure } from "../usage";

// A minimal stand-in for the Anthropic/OpenAI SDK error shape (carries `status`).
function apiError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

describe("classifyAiFailure — maps provider errors to a coarse reason", () => {
  it("429 + billing language → insufficient_credit (the headline 'out of tokens' case)", () => {
    expect(classifyAiFailure(apiError(429, "Your credit balance is too low to access the API"))).toBe("insufficient_credit");
    expect(classifyAiFailure(apiError(429, "billing: quota exceeded"))).toBe("insufficient_credit");
  });

  it("429 without billing language → rate_limit", () => {
    expect(classifyAiFailure(apiError(429, "Number of requests exceeded your rate limit"))).toBe("rate_limit");
    expect(classifyAiFailure(apiError(429, "too many requests"))).toBe("rate_limit");
  });

  it("402 / bare credit message → insufficient_credit", () => {
    expect(classifyAiFailure(apiError(402, "Payment required"))).toBe("insufficient_credit");
    expect(classifyAiFailure(new Error("insufficient funds for this request"))).toBe("insufficient_credit");
  });

  it("529 / 'overloaded' → overloaded", () => {
    expect(classifyAiFailure(apiError(529, "Overloaded"))).toBe("overloaded");
    expect(classifyAiFailure(new Error("the model is overloaded, try again"))).toBe("overloaded");
  });

  it("401/403 / auth language → auth", () => {
    expect(classifyAiFailure(apiError(401, "invalid x-api-key"))).toBe("auth");
    expect(classifyAiFailure(apiError(403, "forbidden"))).toBe("auth");
  });

  it("timeouts / connection drops → timeout", () => {
    const t = new Error("Request timed out");
    t.name = "APIConnectionTimeoutError";
    expect(classifyAiFailure(t)).toBe("timeout");
    expect(classifyAiFailure(new Error("socket hang up"))).toBe("timeout");
    expect(classifyAiFailure(new Error("ETIMEDOUT"))).toBe("timeout");
  });

  it("anything else → other (defensive, never throws)", () => {
    expect(classifyAiFailure(apiError(500, "internal server error"))).toBe("other");
    expect(classifyAiFailure(new Error("something weird"))).toBe("other");
    expect(classifyAiFailure(null)).toBe("other");
    expect(classifyAiFailure(undefined)).toBe("other");
    expect(classifyAiFailure("a string error")).toBe("other");
    expect(classifyAiFailure({ no: "status" })).toBe("other");
  });
});
