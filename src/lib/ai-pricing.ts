/**
 * AI provider pricing — USD per 1M tokens.
 *
 * Source: Anthropic public pricing pages as of 2026-05-15. Local Ollama
 * models run on the mini-PC and have no per-token cost (priced at 0).
 * Update when models are added or prices change. The map is keyed on the
 * exact model id passed to the API (not a friendly name) so a typo in
 * the env var falls through to the unknown-model handler.
 */

interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-haiku-4-5-20251001": { inputPerMTok: 1.00,  outputPerMTok: 5.00 },
  "claude-sonnet-4-6":         { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  "claude-opus-4-7":           { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  // Ollama (local, free — recorded at 0 to keep the cost dashboard honest)
  "qwen2.5:1.5b": { inputPerMTok: 0, outputPerMTok: 0 },
  "llama3.2:3b":  { inputPerMTok: 0, outputPerMTok: 0 },
};

/** Compute cost in USD from token counts and model id. Returns null when
 *  the model isn't priced (so the caller can log + skip rather than write
 *  misleading data). */
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const cost = (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
  // Round to 6 d.p. — finer than any real call but avoids float drift in sums.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Exported for tests + diagnostics. */
export function isModelPriced(model: string): boolean {
  return model in PRICES;
}
