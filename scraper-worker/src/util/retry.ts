/**
 * Exponential backoff retry wrapper.
 * Used by scrapers when a request fails transiently (network error, 5xx, etc.)
 * NOT used for rate-limit errors (those use a longer pause, handled separately).
 */

export class RateLimitError extends Error {
  constructor(platform: string) {
    super(`Rate limit detected on ${platform}`);
    this.name = "RateLimitError";
  }
}

export class LoginRequiredError extends Error {
  constructor(platform: string) {
    super(`Session expired — login required on ${platform}`);
    this.name = "LoginRequiredError";
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
  } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 2000, label = "operation" } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Don't retry rate-limit or login errors — caller handles those
      if (err instanceof RateLimitError || err instanceof LoginRequiredError) throw err;

      if (attempt === maxAttempts) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
      console.warn(`[retry] ${label} attempt ${attempt} failed, retrying in ${Math.round(delay)}ms:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
