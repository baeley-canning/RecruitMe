/**
 * Local-model (Ollama) config reader. Centralises process.env reads so
 * tests can mutate env and re-read.
 *
 * Llama failover is ALWAYS ON. There is no env-var off-switch.
 *
 * Why: the env-var gate kept being a footgun in production — a stale
 * `ENABLE_LOCAL_MODEL_FAILOVER=false` from an old troubleshooting pass
 * would silently suppress the entire failover infrastructure and leave
 * the recruiter staring at raw "credit balance is too low" Claude errors
 * while a perfectly healthy Llama sat right next door. The protective
 * intent — "don't let Llama silently impersonate Claude" — is fully
 * delivered by:
 *   - scoredBy: "ollama" persisted on every Llama-derived breakdown
 *   - 10pt penalty applied at write time (applyLlamaScorePenalty)
 *   - "Llama" provenance pill rendered next to match + acceptance scores
 *   - [chat-failover] log line on every failover attempt
 * …so the recruiter can never mistake a Llama score for a Claude one,
 * and re-scoring when Claude is back automatically overwrites the pill.
 *
 * If a recruiter genuinely needs to disable Llama (compliance), the
 * mechanism is operational, not a config flag: stop the Ollama service.
 * Llama attempts will fail, original Claude error re-throws as before.
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
// 120s default to safely cover Ollama cold-starts on small Railway
// containers (model load + first inference can take 60-90s after the
// daemon has unloaded the model post-idle). Was 60s and was still hitting
// the edge on first-of-day requests.
const DEFAULT_TIMEOUT_MS = 120_000;

export function readLocalModelConfig(): LocalModelConfig {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL,
    model: process.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number(process.env.LOCAL_MODEL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    failoverEnabled: true,
    finalScoringFailoverEnabled: true,
  };
}

// Both gates return `true` unconditionally. See the file header for why
// the env-var dependency was removed. Kept as functions (not constants)
// so the rest of the codebase doesn't have to change.
export function isLocalFailoverEnabled(): boolean { return true; }
export function isLocalFinalScoringFailoverEnabled(): boolean { return true; }
