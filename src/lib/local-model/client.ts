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
import { recordProviderFailure, recordProviderSuccess } from "../provider-health";

/**
 * Build the ordered list of Ollama base URLs to try. We auto-detect because
 * Railway env-var stomping kept leaving OLLAMA_BASE_URL stale / wrong, and a
 * single hardcoded URL meant ZERO Ollama calls when the env was off by even
 * one character. Caches the first working URL after a successful call so
 * subsequent calls hit it directly (no wasted probe per call).
 */
let _resolvedBaseUrl: string | null = null;

function candidateBaseUrls(): string[] {
  const envUrl = process.env.OLLAMA_BASE_URL?.trim();
  // Strip trailing slash to avoid `${base}//api/generate`.
  const normalise = (u: string) => u.replace(/\/+$/, "");
  return [
    ...(envUrl ? [normalise(envUrl)] : []),
    "http://ollama.railway.internal:11434", // Railway internal DNS pattern
    "http://ollama:11434",                  // Docker/compose short DNS
    "http://127.0.0.1:11434",               // local dev
    "http://localhost:11434",               // local dev (IPv4)
    "http://[::1]:11434",                   // IPv6 localhost
  ].filter((u, i, arr) => arr.indexOf(u) === i); // dedupe
}

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

  // Try the cached working URL first; if not cached, walk the candidate
  // list. Once we find one that responds, cache it for the rest of the
  // process lifetime. A null result from EVERY URL means Ollama is truly
  // unreachable; we return null and the caller falls through.
  const urlsToTry = _resolvedBaseUrl ? [_resolvedBaseUrl] : candidateBaseUrls();
  console.log(`[ollama] generate START — model=${model} timeout=${timeoutMs}ms candidates=[${urlsToTry.join(", ")}]`);

  let lastError: string | null = null;
  for (const baseUrl of urlsToTry) {
    try {
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          ...(options.system ? { system: options.system } : {}),
          ...(options.json ? { format: "json" } : {}),
          options: { temperature: options.temperature ?? 0.1 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastError = `non-OK ${res.status} at ${baseUrl}`;
        console.warn(`[ollama] ${lastError}`);
        continue; // try next URL
      }
      const body = await res.json().catch(() => null) as { response?: unknown } | null;
      const text = typeof body?.response === "string" ? body.response : "";
      if (!text) {
        lastError = `empty response at ${baseUrl}`;
        console.warn(`[ollama] ${lastError}`);
        continue;
      }
      // SUCCESS — cache the working URL so subsequent calls skip the probe loop.
      _resolvedBaseUrl = baseUrl;
      const durationMs = Date.now() - started;
      console.log(`[ollama] generate OK — url=${baseUrl} model=${model} durationMs=${durationMs} chars=${text.length}`);
      recordProviderSuccess("ollama");
      return { text, durationMs };
    } catch (err) {
      lastError = `${err instanceof Error ? err.message : String(err)} at ${baseUrl}`;
      console.warn(`[ollama] generate failed: ${lastError}`);
      continue;
    }
  }

  // Every URL failed.
  console.warn(`[ollama] ALL ${urlsToTry.length} candidate URLs failed. Last error: ${lastError}`);
  recordProviderFailure("ollama", lastError ?? "unknown");
  return null;
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
