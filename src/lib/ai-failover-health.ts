/**
 * In-memory health state for the Claude → Ollama failover.
 * When `chatWithFailover` succeeds against the primary, isPrimaryDead
 * is cleared; when it falls over to the secondary, isPrimaryDead is
 * set with a free-form reason. The /api/ai/status endpoint reads this
 * so the AiStatusBanner can show a "running on fallback" indicator.
 *
 * Module-level state lives for the lifetime of the Node process. In
 * dev, Next.js HMR can recreate this module on hot reload — fine; the
 * next provider call repopulates it. In production (single Railway
 * process) the state is stable until restart.
 *
 * "Primary" here is whichever provider `probeProviders().primary`
 * resolves to (Claude when ANTHROPIC_API_KEY is set; otherwise the
 * local Ollama model).
 */

import type { ChatSource } from "./ai/chat-with-failover";

export interface AiFailoverState {
  isPrimaryDead: boolean;
  lastFailoverAt: string | null;
  lastPrimarySuccessAt: string | null;
  /** Free-form label from summariseError — telemetry only. */
  failoverReason: string | null;
  /** Which provider is currently being used to recover. */
  failoverSource: ChatSource | null;
  failoverCount: number;
}

export const aiFailoverHealth: AiFailoverState = {
  isPrimaryDead: false,
  lastFailoverAt: null,
  lastPrimarySuccessAt: null,
  failoverReason: null,
  failoverSource: null,
  failoverCount: 0,
};

export function recordPrimarySuccess(): void {
  aiFailoverHealth.isPrimaryDead = false;
  aiFailoverHealth.failoverReason = null;
  aiFailoverHealth.failoverSource = null;
  aiFailoverHealth.lastPrimarySuccessAt = new Date().toISOString();
}

export function recordFailover(source: ChatSource, reason: string): void {
  aiFailoverHealth.isPrimaryDead = true;
  aiFailoverHealth.failoverReason = reason;
  aiFailoverHealth.failoverSource = source;
  aiFailoverHealth.lastFailoverAt = new Date().toISOString();
  aiFailoverHealth.failoverCount += 1;
}

export function snapshotFailoverHealth(): AiFailoverState {
  return { ...aiFailoverHealth };
}

// Test-only: reset state between test cases.
export function __resetFailoverHealthForTests(): void {
  aiFailoverHealth.isPrimaryDead = false;
  aiFailoverHealth.lastFailoverAt = null;
  aiFailoverHealth.lastPrimarySuccessAt = null;
  aiFailoverHealth.failoverReason = null;
  aiFailoverHealth.failoverSource = null;
  aiFailoverHealth.failoverCount = 0;
}
