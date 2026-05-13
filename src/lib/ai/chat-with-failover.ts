/**
 * Symmetric Claude ↔ OpenAI failover.
 *
 * When BOTH ANTHROPIC_API_KEY and OPENAI_API_KEY are configured: the
 * primary (Claude by default; OpenAI if AI_PROVIDER=openai) is tried
 * first; on ANY error, the other provider is attempted. When only ONE
 * key is configured: that provider is used alone with no failover.
 *
 * No status-code classifier gates the failover — the prior Llama-era
 * design tried to be clever about "is this error actually Claude-dead?"
 * and every shape Anthropic emitted (400 credit-balance, 401 auth,
 * SDK timeout, etc.) eventually slipped past it. Burning one extra
 * provider call on a validation bug is strictly cheaper than another
 * incident.
 *
 * On Llama-era code being removed: there is no more provisional /
 * penalised tier. Claude and OpenAI are both first-class; neither
 * carries a score penalty. The provenance pill still renders so the
 * recruiter can see which model produced any given score.
 */

import { chat, type ChatOptions, type ChatProvider } from "./chat";
import { recordProviderFailure, recordProviderSuccess } from "../provider-health";
import { recordFailover, recordPrimarySuccess } from "../ai-failover-health";

export type ChatSource = "claude" | "openai";

export interface ProviderAvailability {
  hasClaude: boolean;
  hasOpenAI: boolean;
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
  const hasClaude  = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const hasOpenAI  = Boolean(process.env.OPENAI_API_KEY?.trim());

  // AI_PROVIDER explicit override wins. Otherwise Claude is the
  // default primary (per user spec).
  const explicit = (process.env.AI_PROVIDER ?? "").toLowerCase().trim();
  let primary: ChatSource | null = null;
  if (explicit === "openai" && hasOpenAI) primary = "openai";
  else if (explicit === "claude" && hasClaude) primary = "claude";
  else if (hasClaude) primary = "claude";
  else if (hasOpenAI) primary = "openai";

  const fallback: ChatSource | undefined =
    primary === "claude" && hasOpenAI  ? "openai" :
    primary === "openai" && hasClaude  ? "claude" :
    undefined;

  return { hasClaude, hasOpenAI, primary, fallback };
}

/**
 * Convenience boolean for "is failover actually wired up?" — true iff
 * BOTH providers are configured. Used by callers who want to short-
 * circuit before constructing prompts when only one provider exists
 * (no useful failover to gain).
 */
export function isAiFailoverConfigured(): boolean {
  const { hasClaude, hasOpenAI } = probeProviders();
  return hasClaude && hasOpenAI;
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
    throw new Error("No AI provider configured: set ANTHROPIC_API_KEY or OPENAI_API_KEY");
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
      // Surface the actual secondary error reason — without this, "openai
      // also failed" appears for any reason (bad key, no credits, wrong
      // model, network) and there's no way to tell which.
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
