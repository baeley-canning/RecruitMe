/**
 * Per-task routing to the local LLM (Ollama on the mini-PC).
 *
 * Each AI workflow in the app passes a task key — e.g. "cv_clean",
 * "info_extract", "refs_questions" — and this helper decides whether to
 * route that call to the local Qwen instance vs. the default hosted
 * provider (Claude, with the local Ollama model as failover).
 *
 * Configured via a single env var so flipping a task on/off doesn't need
 * a code change:
 *
 *   OLLAMA_OFFLOAD_TASKS=cv_clean,info_extract,refs_questions
 *
 * Set to an empty string (or unset) to keep everything on the hosted
 * stack. Set to `*` to route every workflow.
 *
 * Why per-task instead of a single global flag: the agent research that
 * picked Qwen 2.5 1.5B explicitly identified quality-tolerant workflows
 * (CV text cleaning, simple field extraction, reference-question
 * generation, rejection emails, offer letters, shortlist summaries) as
 * safe to move to local. Workflows like candidate scoring, JD parsing,
 * outreach generation, and insight extraction stay on the frontier
 * model — they're the ones where quality is load-bearing.
 */

import type { ChatProvider } from "./chat";

export type LocalTaskKey =
  | "cv_clean"        // src/lib/ai/profile.ts — cleanCvText (PDF text repair)
  | "info_extract"    // src/lib/ai/profile.ts — extractCandidateInfo (name/headline/location)
  | "refs_questions"  // src/lib/ai/references.ts — reference question generation
  | "refs_summary"    // src/lib/ai/references.ts — reference check summary
  | "rejection_email" // src/lib/ai/outreach.ts — generateRejectionEmail
  | "offer_letter"    // src/lib/ai/outreach.ts — generateOfferLetter
  | "shortlist_summary"; // /api/jobs/[id]/shortlist-summary — client report blurbs

let cachedAllowSet: Set<string> | null = null;
let cachedAllowAll = false;
let cachedEnv = "";

function refreshCache() {
  const env = process.env.OLLAMA_OFFLOAD_TASKS ?? "";
  if (env === cachedEnv) return;
  cachedEnv = env;
  cachedAllowAll = env.trim() === "*";
  cachedAllowSet = new Set(env.split(",").map((t) => t.trim()).filter(Boolean));
}

/**
 * Returns `"ollama"` if the given task is opted in via OLLAMA_OFFLOAD_TASKS,
 * else `undefined` (let the caller's default provider stand). Designed so
 * call sites read like:
 *
 *   const provider = ollamaProviderFor("cv_clean");
 *   await chat(prompt, { provider, ... });
 *
 * — `undefined` is the no-op that preserves existing behaviour.
 */
export function ollamaProviderFor(task: LocalTaskKey): ChatProvider | undefined {
  refreshCache();
  if (cachedAllowAll) return "ollama";
  if (cachedAllowSet?.has(task)) return "ollama";
  return undefined;
}
