/**
 * Direct Ollama client. The existing chat.ts has an Ollama path that goes
 * through the OpenAI SDK pointed at the Ollama base URL — that works but
 * mixes provider semantics. This adapter talks to Ollama's native
 * /api/generate and /api/chat endpoints directly, with:
 *   - hard timeout (default 30s — local inference is slow)
 *   - fail-closed: returns null on any error (caller can fall through)
 *   - explicit JSON mode for structured outputs
 *   - health-check endpoint for callers that want to probe before dispatch
 *
 * Used by chat-with-failover.ts as the lifeboat when Claude is unreachable
 * or credits hit zero. Never invoked unless an explicit env flag is set —
 * see config.ts.
 */

import { readLocalModelConfig } from "./config";

interface OllamaGenerateOptions {
  /** Override the configured model for one call. */
  model?: string;
  /** Override the configured timeout (ms). */
  timeoutMs?: number;
  /** Pass to Ollama as `format: "json"` to force JSON-mode output. The
   *  model still needs prompting to actually produce valid JSON, but this
   *  enables Ollama's grammar-constrained sampling for supported models. */
  json?: boolean;
  /** Temperature; defaults to 0.1 to match the Claude scoring defaults. */
  temperature?: number;
  /** System prompt — prepended via Ollama's `system` field. */
  system?: string;
}

interface OllamaGenerateResult {
  text: string;
  /** Wall-clock time the call took. Useful for ops logging. */
  durationMs: number;
}

/**
 * Single-shot generation against Ollama's /api/generate endpoint. Returns
 * null on ANY failure (network, timeout, non-200, malformed body). Callers
 * MUST treat null as "Ollama unavailable" and decide what to do.
 */
export async function ollamaGenerate(
  prompt: string,
  options: OllamaGenerateOptions = {},
): Promise<OllamaGenerateResult | null> {
  const cfg = readLocalModelConfig();
  const model = options.model ?? cfg.model;
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const started = Date.now();

  try {
    const res = await fetch(`${cfg.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        ...(options.system ? { system: options.system } : {}),
        ...(options.json ? { format: "json" } : {}),
        options: {
          temperature: options.temperature ?? 0.1,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[ollama] non-OK ${res.status}`);
      return null;
    }
    const body = await res.json().catch(() => null) as { response?: unknown } | null;
    const text = typeof body?.response === "string" ? body.response : "";
    if (!text) {
      console.warn("[ollama] empty / non-string response field");
      return null;
    }
    return { text, durationMs: Date.now() - started };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ollama] generate failed: ${msg}`);
    return null;
  }
}

/**
 * Health probe. Returns true iff Ollama responds on /api/tags within the
 * configured timeout. Used by chat-with-failover to skip Ollama dispatch
 * when we know the daemon isn't up.
 *
 * Result is intentionally NOT cached — Ollama can come and go (laptop
 * sleep, container restart) and a stale "yes it's up" check would mask
 * the real fallback path (return claude error to caller).
 */
export async function ollamaHealthy(): Promise<boolean> {
  const cfg = readLocalModelConfig();
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(Math.min(2000, cfg.timeoutMs)),
    });
    return res.ok;
  } catch {
    return false;
  }
}
