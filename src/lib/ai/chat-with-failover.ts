/**
 * Claude → Ollama failover.
 *
 * Claude (hosted) is the primary when ANTHROPIC_API_KEY is configured;
 * on ANY error it falls over to the local Ollama model. Ollama is always
 * treated as available — its client URL always defaults to the local
 * endpoint — so the local model is the safety net even when the box has
 * no internet to reach Anthropic. When Claude has no key at all, Ollama
 * becomes the sole primary with no further fallback.
 *
 * No status-code classifier gates the failover — the prior design tried
 * to be clever about "is this error actually Claude-dead?" and every
 * shape Anthropic emitted (400 credit-balance, 401 auth, SDK timeout,
 * etc.) eventually slipped past it. Burning one extra (free, local)
 * Ollama call on a validation bug is strictly cheaper than an incident.
 *
 * Both providers are first-class; neither carries a score penalty. The
 * provenance pill still renders so the recruiter can see which model
 * produced any given score.
 */

import { chat, type ChatOptions, type ChatProvider } from "./chat";
import { recordProviderFailure, recordProviderSuccess } from "../provider-health";
import { recordFailover, recordPrimarySuccess } from "../ai-failover-health";

export type ChatSource = "claude" | "ollama";

export interface ProviderAvailability {
  hasClaude: boolean;
  hasOllama: boolean;
  /** Provider chosen as primary when both are available. */
  primary:   ChatSource | null;
  /** Provider used for failover (the other one, when both are available). */
  fallback?: ChatSource;
}

export interface ChatFailoverResult {
  text: string;
  source: ChatSource;
  /** Free-form label describing why the primary failed (telemetry only). */
  failoverReason?: string;
  /** Wall-clock for the call that actually returned text. */
  durationMs: number;
}

/**
 * Read process env once and decide which providers are configured.
 * Pure function — no side effects, no caching (env can change between
 * deploys; we want a fresh read per call).
 */
export function probeProviders(): ProviderAvailability {
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  // Ollama is always available: the OpenAI-compatible client URL defaults
  // to the local endpoint, so there's no key to gate on. This makes the
  // local model the standing safety net behind Claude.
  const hasOllama = true;

  // Claude is the primary whenever its key is set; otherwise the local
  // Ollama model is the sole provider.
  const primary: ChatSource | null = hasClaude ? "claude" : "ollama";

  const fallback: ChatSource | undefined =
    primary === "claude" && hasOllama ? "ollama" : undefined;

  return { hasClaude, hasOllama, primary, fallback };
}

/**
 * Convenience boolean for "is failover actually wired up?" — true iff
 * Claude is configured (the local Ollama fallback is always available).
 * Used by callers who want to short-circuit before constructing prompts
 * when there's no useful failover to gain.
 */
export function isAiFailoverConfigured(): boolean {
  const { hasClaude, hasOllama } = probeProviders();
  return hasClaude && hasOllama;
}

/** Brief error label for the [chat-failover] log line. Telemetry only. */
function summariseError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const msg = err instanceof Error ? err.message : String(err);
  const head = msg.length > 80 ? `${msg.slice(0, 80)}…` : msg;
  return status ? `${status} ${head}` : head;
}

/**
 * Drop-in replacement for `chat()`. Tries the primary provider; on any
 * error, falls over to the other provider if available; returns the
 * source + duration so callers can tag persisted breakdowns.
 *
 * When only one provider is configured: behaves identically to `chat()`
 * — single call, throws on failure, no failover attempted.
 */
export async function chatWithFailover(
  prompt: string,
  temperature: number,
  maxTokens: number,
  options: ChatOptions & { preferProvider?: ChatSource } = {},
): Promise<ChatFailoverResult> {
  const { primary, fallback } = probeProviders();
  if (!primary) {
    throw new Error("No AI provider configured: set ANTHROPIC_API_KEY (or run a local Ollama)");
  }

  const preferred: ChatSource = options.preferProvider ?? primary;
  const secondary: ChatSource | undefined =
    preferred === primary
      ? fallback
      : primary; // if caller forced the fallback as primary, the configured primary becomes the fallback

  // Strip the option that's local to this wrapper before passing through.
  const chatOpts: ChatOptions = { ...options };
  delete (chatOpts as { preferProvider?: ChatSource }).preferProvider;

  const started = Date.now();
  try {
    const text = await chat(prompt, temperature, maxTokens, { ...chatOpts, provider: preferred as ChatProvider });
    recordProviderSuccess(preferred);
    recordPrimarySuccess();
    return { text, source: preferred, durationMs: Date.now() - started };
  } catch (primaryErr) {
    recordProviderFailure(preferred, primaryErr instanceof Error ? primaryErr.message : String(primaryErr));
    const reason = summariseError(primaryErr);
    if (!secondary) {
      console.warn(`[chat-failover] ${preferred} failed (${reason}) — no secondary configured`);
      throw primaryErr;
    }

    console.warn(`[chat-failover] ${preferred} failed (${reason}) — attempting ${secondary} fallback`);
    const fallbackStarted = Date.now();
    try {
      const text = await chat(prompt, temperature, maxTokens, { ...chatOpts, provider: secondary as ChatProvider });
      recordProviderSuccess(secondary);
      recordFailover(secondary, reason);
      const durationMs = Date.now() - fallbackStarted;
      console.log(`[chat-failover] ✓ RECOVERED via ${secondary} — durationMs=${durationMs} chars=${text.length}`);
      return { text, source: secondary, failoverReason: reason, durationMs };
    } catch (secondaryErr) {
      const secondaryMsg = secondaryErr instanceof Error ? secondaryErr.message : String(secondaryErr);
      recordProviderFailure(secondary, secondaryMsg);
      // Surface the actual secondary error reason — without this, "ollama
      // also failed" appears for any reason (model not pulled, daemon down,
      // timeout) and there's no way to tell which.
      const secondaryReason = summariseError(secondaryErr);
      console.warn(`[chat-failover] ${secondary} also failed (${secondaryReason}) — re-throwing original ${preferred} error`);
      throw primaryErr;
    }
  }
}

/**
 * Thin wrapper for callers that don't need provenance — outreach,
 * references, profile sections, shortlist summaries, etc. Returns just
 * the text; failover runs identically under the hood.
 */
export async function chatWithMaybeFailover(
  prompt: string,
  temperature: number,
  maxTokens: number,
  options: ChatOptions = {},
): Promise<string> {
  const result = await chatWithFailover(prompt, temperature, maxTokens, options);
  return result.text;
}
