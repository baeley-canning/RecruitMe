import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../ai/chat";

// withRetry retries Anthropic 5xx / 429 / network-level errors with exponential
// backoff, but bails immediately on user errors (400, malformed input). Tests
// here use baseDelayMs=1 so the suite stays fast.

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, 3, 1);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a 429 rate-limit and returns the eventual success", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce("recovered");
    const result = await withRetry(fn, 3, 1);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx server errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("upstream"), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, 3, 1);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries network-level errors (ECONNRESET, timeout, no status)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET reading socket"))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, 3, 1);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a 400 user error — fails fast", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("bad input"), { status: 400 }));
    await expect(withRetry(fn, 3, 1)).rejects.toThrow("bad input");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a 401 — fails fast", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    await expect(withRetry(fn, 3, 1)).rejects.toThrow("unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts retryable failures", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("rate limit"), { status: 429 }));
    await expect(withRetry(fn, 3, 1)).rejects.toThrow("rate limit");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
