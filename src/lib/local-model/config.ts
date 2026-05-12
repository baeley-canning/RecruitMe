/**
 * Local-model (Ollama) config reader. Centralises process.env reads so
 * tests can mutate env and re-read. Mirrors the search-providers/config
 * pattern.
 *
 * Two distinct enable flags:
 *   - ENABLE_LOCAL_MODEL_FAILOVER         → low-risk fallbacks
 *       (JD parsing, CV cleanup, anything non-scoring). When the Claude
 *       API is unreachable / credits exhausted / auth failed, route the
 *       call through Ollama and mark the response source.
 *   - ENABLE_LOCAL_MODEL_FINAL_SCORING    → high-risk fallback
 *       (scoreCandidateStructured / scoreCandidatesBatch). Same trigger
 *       conditions, but separately gated because Llama-scored candidates
 *       cannot be treated as Claude-quality — the UI MUST mark them.
 *
 * Default: both false. Wiring is dead code unless the recruiter opts in.
 */

export interface LocalModelConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  failoverEnabled: boolean;
  finalScoringFailoverEnabled: boolean;
}

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:7b";
const DEFAULT_TIMEOUT_MS = 30_000; // local inference is slow on commodity hardware

function asBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export function readLocalModelConfig(): LocalModelConfig {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL,
    model: process.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number(process.env.LOCAL_MODEL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    failoverEnabled: asBool(process.env.ENABLE_LOCAL_MODEL_FAILOVER),
    finalScoringFailoverEnabled: asBool(process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING),
  };
}

export function isLocalFailoverEnabled(): boolean {
  return readLocalModelConfig().failoverEnabled;
}

export function isLocalFinalScoringFailoverEnabled(): boolean {
  return readLocalModelConfig().finalScoringFailoverEnabled;
}
