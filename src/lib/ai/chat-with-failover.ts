/**
 * Failover wrapper around chat(). When Claude is truly DEAD (auth invalid,
 * credits exhausted, persistent 5xx, unreachable network — exhausted after
 * withRetry has already done its job), route the same request through
 * local Ollama instead. Never silent: returns a `source` field so callers
 * can mark the result appropriately (e.g. scoredBy: "ollama" on a
 * ScoreBreakdown, UI badge on the candidate card).
 *
 * Behaviour matrix:
 *   ENABLE_LOCAL_MODEL_FAILOVER=false (default) → Claude error bubbles up,
 *     existing fallback logic (stub breakdowns / 500 responses) applies.
 *   ENABLE_LOCAL_MODEL_FAILOVER=true              → on a Claude-dead error,
 *     try Ollama. If Ollama also fails, original Claude error re-throws so
 *     the caller's stub-breakdown path activates as today.
 *
 * Crucially: this wrapper distinguishes DEAD from TRANSIENT. A 429 with
 * "rate limit exceeded" body is transient (withRetry handles it). A 429
 * with "credit balance exhausted" body is dead (no point retrying — same
 * request will fail tomorrow too).
 */

import { chat, type ChatOptions } from "./chat";
import { ollamaGenerate } from "../local-model/client";
import {
  isLocalFailoverEnabled,
  isLocalFinalScoringFailoverEnabled,
  readLocalModelConfig,
} from "../local-model/config";
import { recordClaudeSuccess, recordOllamaFailover } from "../ai-failover-health";
import { recordProviderFailure, recordProviderSuccess } from "../provider-health";

export type ChatSource = "claude" | "ollama";

export interface ChatFailoverResult {
  text: string;
  source: ChatSource;
  /** When source === "ollama", which Claude-dead condition triggered it. */
  failoverReason?: ClaudeDeadReason;
  /** Ollama-side latency for ops logs (undefined for Claude). */
  ollamaDurationMs?: number;
}

export type ClaudeDeadReason =
  | "auth_invalid"          // 401 / 403 — key bad or missing
  | "credits_exhausted"     // 429 with credit-balance-related body
  | "service_unavailable"   // persistent 502/503/504 after retries
  | "network_unreachable";  // ECONNREFUSED / ENOTFOUND / etc after retries

/**
 * Pure inspector — returns whether the given error indicates Claude is
 * dead (not transiently flaky). Exported for testability.
 */
export function classifyClaudeError(err: unknown): { dead: boolean; reason?: ClaudeDeadReason } {
  const status = (err as { status?: number })?.status;
  // Extract message from Error instances, plain objects with a message field,
  // or fall back to string-cast. Lowercased for case-insensitive matching.
  const rawMessage =
    err instanceof Error ? err.message
    : typeof (err as { message?: unknown })?.message === "string" ? (err as { message: string }).message
    : err == null ? "" : String(err);
  const message = rawMessage.toLowerCase();

  if (status === 401 || status === 403) {
    return { dead: true, reason: "auth_invalid" };
  }

  // 429 only counts as dead when the body indicates a credit / quota
  // problem. Generic "rate limit" is transient — withRetry handles those
  // and we shouldn't burn through Ollama every time we get a brief 429.
  // NOTE: avoid matching the bare word "exceeded" — that appears in plain
  // "Rate limit exceeded" too. Match credit/quota-specific markers only.
  if (status === 429 && /credit|quota|insufficient|balance/.test(message)) {
    return { dead: true, reason: "credits_exhausted" };
  }

  if (status === 502 || status === 503 || status === 504) {
    return { dead: true, reason: "service_unavailable" };
  }

  // Network-level errors with no HTTP status. withRetry already retries
  // these — if we still got an error after retries exhausted, treat as
  // dead and fall over to Ollama.
  if (!status && /econnrefused|enotfound|etimedout|getaddrinfo|network|abort/.test(message)) {
    return { dead: true, reason: "network_unreachable" };
  }

  return { dead: false };
}

/**
 * Drop-in replacement for chat() that adds a failover branch. Returns a
 * structured result instead of bare text so callers can record `source`.
 *
 * Behaviour:
 *   - Always tries Claude first via chat(prompt, ...).
 *   - On a Claude-dead error AND env flag set, tries Ollama.
 *   - On Ollama success, returns { text, source: "ollama", failoverReason }.
 *   - On Ollama failure (null), re-throws the original Claude error so the
 *     caller's existing "AI scoring unavailable" / stub path applies.
 *   - If the env flag is unset, original Claude error always bubbles up.
 *     ZERO behaviour change for default deployments.
 */
export async function chatWithFailover(
  prompt: string,
  temperature: number,
  maxTokens: number,
  options: ChatOptions = {},
): Promise<ChatFailoverResult> {
  try {
    const text = await chat(prompt, temperature, maxTokens, options);
    recordClaudeSuccess();
    recordProviderSuccess("claude");
    return { text, source: "claude" };
  } catch (err) {
    recordProviderFailure("claude", err instanceof Error ? err.message : String(err));
    // EITHER flag enables the failover machine. Without this, someone who
    // only sets ENABLE_LOCAL_MODEL_FINAL_SCORING=true (expecting score
    // failover) would silently get nothing because this gate would still
    // block it. Caller-level gates already decide WHICH callers participate.
    if (!isLocalFailoverEnabled() && !isLocalFinalScoringFailoverEnabled()) throw err;

    const { dead, reason } = classifyClaudeError(err);
    if (!dead || !reason) throw err;

    console.warn(`[chat-failover] Claude dead (${reason}) — attempting Ollama fallback`);

    const cfg = readLocalModelConfig();
    const ollamaResult = await ollamaGenerate(prompt, {
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      temperature,
      system: options.system,
    });

    if (!ollamaResult) {
      // Both providers down — re-throw Claude error so the caller's existing
      // stub / error-handling path takes over.
      console.warn(`[chat-failover] Ollama also unavailable — re-throwing Claude error`);
      throw err;
    }

    recordOllamaFailover(reason);
    // ollama provider-health is recorded inside ollamaGenerate itself.
    return {
      text: ollamaResult.text,
      source: "ollama",
      failoverReason: reason,
      ollamaDurationMs: ollamaResult.durationMs,
    };
  }
}

/**
 * Drop-in replacement for `chat()` for callers that DON'T care about the
 * provenance (Claude vs Llama). Returns just the text; routes through the
 * failover wrapper when EITHER `ENABLE_LOCAL_MODEL_FAILOVER` or
 * `ENABLE_LOCAL_MODEL_FINAL_SCORING` is set, falls through to raw chat()
 * otherwise.
 *
 * Use this for outreach generation, reference Q&A, profile-section
 * generation, shortlist summaries, candidate-info extraction — anywhere
 * the output is one-shot text whose source the recruiter doesn't need to
 * see explicitly. For SCORING calls where Llama-attributed scores need
 * the visible badge + penalty, call `chatWithFailover` directly and
 * inspect `.source`.
 *
 * This closes the 11-callsite gap the audit found where raw `chat()`
 * calls hard-failed on dead Claude despite the failover being enabled.
 */
export async function chatWithMaybeFailover(
  prompt: string,
  temperature: number,
  maxTokens: number,
  options: ChatOptions = {},
): Promise<string> {
  if (isLocalFailoverEnabled() || isLocalFinalScoringFailoverEnabled()) {
    const result = await chatWithFailover(prompt, temperature, maxTokens, options);
    return result.text;
  }
  return chat(prompt, temperature, maxTokens, options);
}
