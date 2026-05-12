/**
 * Local-model (Ollama) config reader. Centralises process.env reads so
 * tests can mutate env and re-read.
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
 * Default: BOTH ON. When Claude dies (credits exhausted, 401, persistent
 * 5xx, network unreachable), Llama takes over. Llama-derived scores carry
 * scoredBy="ollama", a 10-point penalty applied at write time, and the
 * "Llama" provenance pill in the UI — so a recruiter can never mistake a
 * Llama score for a Claude one, and the recruiter can re-score when
 * Claude is back. Set ENABLE_LOCAL_MODEL_FAILOVER=false or
 * ENABLE_LOCAL_MODEL_FINAL_SCORING=false to explicitly opt out.
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

/**
 * Default-ON flag reader: missing env var → true. Only an explicit
 * false-ish value ("false" / "0" / "no" / "off") opts out. Used for the
 * Llama failover flags so a Claude outage automatically falls over to
 * the local model without requiring an env-var change first.
 */
function asBoolDefaultTrue(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

export function readLocalModelConfig(): LocalModelConfig {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL,
    model: process.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number(process.env.LOCAL_MODEL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    failoverEnabled: asBoolDefaultTrue(process.env.ENABLE_LOCAL_MODEL_FAILOVER),
    finalScoringFailoverEnabled: asBoolDefaultTrue(process.env.ENABLE_LOCAL_MODEL_FINAL_SCORING),
  };
}

export function isLocalFailoverEnabled(): boolean {
  return readLocalModelConfig().failoverEnabled;
}

export function isLocalFinalScoringFailoverEnabled(): boolean {
  return readLocalModelConfig().finalScoringFailoverEnabled;
}
