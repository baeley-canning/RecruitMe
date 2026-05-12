/**
 * In-memory health state for the Claude → Ollama failover. When
 * chatWithFailover successfully reaches Claude we reset isClaudeDead; when
 * it falls over to Ollama we set isClaudeDead, record the reason, and bump
 * the failover counter. The /api/ai/status endpoint reads this so the
 * AiStatusBanner can surface a "running on local model" indicator.
 *
 * Module-level state lives for the lifetime of the Node process. In dev,
 * Next.js HMR can recreate this module on hot reload, which means the state
 * resets between code edits — that is OK because the next Claude call will
 * re-populate it. In production (single Railway process) the state is
 * stable until restart.
 *
 * Single source of truth — do not duplicate this state anywhere else.
 */
import type { ClaudeDeadReason } from "./ai/chat-with-failover";

export interface AiFailoverState {
  isClaudeDead: boolean;
  lastFailoverAt: string | null;
  lastClaudeSuccessAt: string | null;
  failoverReason: ClaudeDeadReason | null;
  failoverCount: number;
}

export const aiFailoverHealth: AiFailoverState = {
  isClaudeDead: false,
  lastFailoverAt: null,
  lastClaudeSuccessAt: null,
  failoverReason: null,
  failoverCount: 0,
};

export function recordClaudeSuccess(): void {
  aiFailoverHealth.isClaudeDead = false;
  aiFailoverHealth.failoverReason = null;
  aiFailoverHealth.lastClaudeSuccessAt = new Date().toISOString();
}

export function recordOllamaFailover(reason: ClaudeDeadReason): void {
  aiFailoverHealth.isClaudeDead = true;
  aiFailoverHealth.failoverReason = reason;
  aiFailoverHealth.lastFailoverAt = new Date().toISOString();
  aiFailoverHealth.failoverCount += 1;
}

export function snapshotFailoverHealth(): AiFailoverState {
  return { ...aiFailoverHealth };
}

// Test-only: reset state between test cases.
export function __resetFailoverHealthForTests(): void {
  aiFailoverHealth.isClaudeDead = false;
  aiFailoverHealth.lastFailoverAt = null;
  aiFailoverHealth.lastClaudeSuccessAt = null;
  aiFailoverHealth.failoverReason = null;
  aiFailoverHealth.failoverCount = 0;
}
