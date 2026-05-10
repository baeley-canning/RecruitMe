import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ─── Unified chat helper ───────────────────────────────────────────────────────
// Abstracts over Claude, OpenAI, and Ollama so all AI functions stay clean.

export type ChatProvider = "claude" | "openai" | "ollama";

export interface ChatOptions {
  provider?: ChatProvider;
  model?: string;
  /**
   * Static system instructions that apply to every call of this prompt shape.
   * Anthropic prompt caching keys on the system message; passing the same
   * system text across many calls turns subsequent calls into ~0.1× input
   * cost on the cached portion. Use for scoring rubrics, parsing rules,
   * and other long, stable instruction blocks.
   */
  system?: string;
  /**
   * When true, mark the system block as ephemeral-cacheable so Anthropic's
   * prompt cache can de-duplicate it across calls. Only relevant for Claude.
   */
  cacheSystem?: boolean;
}

export function resolveChatProvider(override?: ChatProvider): ChatProvider {
  return override ?? ((process.env.AI_PROVIDER as ChatProvider | undefined) ?? "claude");
}

export function getJobParsingProvider(): ChatProvider | undefined {
  return process.env.ANTHROPIC_API_KEY ? "claude" : undefined;
}

// Model tiering within Claude: Sonnet for full profiles where judgment matters,
// Haiku for snippets (provisional scores that get replaced when a full profile
// is captured anyway — no point spending Sonnet tokens on them).
export function resolveModelForDataQuality(dataQuality: "full_profile" | "snippet" | "minimal"): {
  provider: ChatProvider;
  model?: string;
} {
  return dataQuality === "full_profile"
    ? { provider: "claude", model: SONNET }
    : { provider: "claude" }; // defaults to ANTHROPIC_MODEL env var (Haiku)
}

export async function chat(
  prompt: string,
  temperature = 0.1,
  maxTokens = 2048,
  options?: ChatOptions
): Promise<string> {
  const provider = resolveChatProvider(options?.provider);

  // ── Claude (Anthropic) ──
  if (provider === "claude") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env.local");

    // 90s timeout — scoring prompts can be long but should never take longer.
    // Prevents requests hanging indefinitely if Anthropic is slow.
    const client = new Anthropic({ apiKey, timeout: 90_000 });
    const model  = options?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

    // Build the system block. When caching is requested we wrap the text in
    // an array with cache_control so Anthropic stores the key.
    const systemBlock = options?.system
      ? (options.cacheSystem
          ? [{ type: "text" as const, text: options.system, cache_control: { type: "ephemeral" as const } }]
          : options.system)
      : undefined;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(systemBlock !== undefined ? { system: systemBlock } : {}),
      messages: [{ role: "user", content: prompt }],
    });

    // Log token usage for cost visibility — surfaced in admin analytics
    if (response.usage) {
      const { input_tokens, output_tokens } = response.usage;
      console.log(`[ai] model=${model} input=${input_tokens} output=${output_tokens}`);
    }

    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }

  // ── OpenAI ──
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set in .env.local");

    const client = new OpenAI({ apiKey });
    const model  = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

    const messages = options?.system
      ? [{ role: "system" as const, content: options.system }, { role: "user" as const, content: prompt }]
      : [{ role: "user" as const, content: prompt }];
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    });

    return response.choices[0]?.message?.content ?? "";
  }

  // ── Ollama (default) ──
  const base = await findOllamaBase();
  const client = new OpenAI({ baseURL: `${base}/v1`, apiKey: "ollama" });
  const model  = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature,
    max_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content ?? "";
}

// ─── Retry helper ─────────────────────────────────────────────────────────────
// Retries an async function up to maxAttempts times with exponential backoff.
// Only retries on rate-limit (429) or transient server errors (500/529).
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const rawMsg = err instanceof Error ? (err.message ?? "") : String(err ?? "");
      const message = (typeof rawMsg === "string" ? rawMsg : String(rawMsg)).toLowerCase();
      // Retry: rate limits (429), server errors (500/502/503/504/529), and
      // network-level failures (no status property — connection reset, timeout, DNS).
      const isRetryable =
        status === 429 || status === 500 || status === 502 ||
        status === 503 || status === 504 || status === 529 ||
        status == null ||  // network error — no HTTP status
        /econnreset|econnrefused|enotfound|network|timeout|abort/i.test(message);
      if (!isRetryable) throw err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

// ─── Ollama auto-detect ────────────────────────────────────────────────────────

const OLLAMA_URL_CANDIDATES = [
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  "http://127.0.0.1:11434",
  "http://localhost:11434",
  "http://10.255.255.254:11434",
];

let _ollamaBaseCache: string | null = null;

async function findOllamaBase(): Promise<string> {
  if (_ollamaBaseCache) return _ollamaBaseCache;

  const urls = [...new Set(OLLAMA_URL_CANDIDATES)];
  const checks = urls.map(async (base) => {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error("not ok");
    return base;
  });

  try {
    _ollamaBaseCache = await Promise.any(checks);
    return _ollamaBaseCache;
  } catch {
    throw new Error(
      `Cannot connect to Ollama.\nTried: ${urls.join(", ")}\n\n` +
      `Run: ollama serve   or set AI_PROVIDER=claude in .env.local`
    );
  }
}

// ─── Shared JSON parser ────────────────────────────────────────────────────────

export function parseJson<T>(text: string): T {
  // Find earliest opening brace/bracket and treat that as the JSON start.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  const start = firstObj === -1
    ? firstArr
    : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) throw new Error("No JSON found in AI response");

  // Take from the first opener to the last matching closer (greedy) so any
  // markdown / prose around the JSON gets stripped.
  const lastObj = text.lastIndexOf("}");
  const lastArr = text.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  const raw = end > start ? text.slice(start, end + 1) : text.slice(start);

  // 1. Try raw
  try { return JSON.parse(raw) as T; } catch { /* continue */ }

  // 2. Normalize internal whitespace
  const normalized = raw.replace(/[\r\n\t]/g, " ");
  try { return JSON.parse(normalized) as T; } catch { /* continue */ }

  // 3. Remove trailing commas before ] or }
  const detrailed = normalized.replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(detrailed) as T; } catch { /* continue */ }

  // 4. Recover from truncation: walk the text tracking string/escape state and
  //    collect every position that could be a safe cut point (after `,`, `}`,
  //    `]`, or a closing string quote). Try them from latest to earliest,
  //    closing any open containers, and return the first variant that parses.
  //    Common failure modes when max_tokens is hit: truncation mid-string,
  //    mid-key, mid-number, mid-array.
  const recovered = repairTruncatedJson(text.slice(start));
  for (const candidate of recovered) {
    try { return JSON.parse(candidate) as T; } catch { /* continue */ }
  }

  throw new Error("Failed to parse JSON from AI response");
}

// Returns candidate repairs of a possibly-truncated JSON value, ordered from
// most-content-preserved to least. Each candidate is a syntactically balanced
// string (open braces/brackets closed) — JSON validity still depends on
// whether the cut point produced a valid tail.
function repairTruncatedJson(input: string): string[] {
  const safePoints: number[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = false; safePoints.push(i); }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "," || ch === "}" || ch === "]") safePoints.push(i);
  }

  const candidates: string[] = [];
  // Try cut points latest-first so we keep the most data when a tail parses.
  for (let k = safePoints.length - 1; k >= 0; k--) {
    let body = input.slice(0, safePoints[k] + 1);
    // Strip trailing comma so we don't produce ",}" or ",]".
    body = body.replace(/,\s*$/, "");
    if (!body) continue;

    // Walk the trimmed body to figure out which closers are still owed.
    const stack: Array<"{" | "["> = [];
    let s = false, e = false;
    for (const ch of body) {
      if (s) {
        if (e) { e = false; continue; }
        if (ch === "\\") { e = true; continue; }
        if (ch === '"') s = false;
        continue;
      }
      if (ch === '"') { s = true; continue; }
      if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") stack.pop();
    }
    if (s) continue; // trimmed mid-string somehow — skip
    let closers = "";
    while (stack.length) closers += stack.pop() === "{" ? "}" : "]";
    candidates.push(body + closers);
  }
  return candidates;
}

export const SONNET = "claude-sonnet-4-6";
