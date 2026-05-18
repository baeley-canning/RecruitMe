"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Cpu, X } from "lucide-react";

interface AiFailoverInfo {
  enabled: boolean;
  isPrimaryDead: boolean;
  lastFailoverAt: string | null;
  lastPrimarySuccessAt: string | null;
  failoverReason: "auth_invalid" | "credits_exhausted" | "service_unavailable" | "network_unreachable" | null;
  failoverCount: number;
}

interface AiStatus {
  available: boolean;
  provider: string;
  model?: string;
  error?: string;
  failover?: AiFailoverInfo;
}

const FAILOVER_REASON_TEXT: Record<NonNullable<AiFailoverInfo["failoverReason"]>, string> = {
  auth_invalid: "Claude API key is invalid or missing",
  credits_exhausted: "Claude credits / quota exhausted",
  service_unavailable: "Claude service temporarily unreachable",
  network_unreachable: "Claude network unreachable",
};

export function AiStatusBanner() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = () => {
      fetch("/api/ai/status")
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setStatus(d as AiStatus); })
        .catch(() => { if (!cancelled) setStatus({ available: false, provider: "claude", error: "Could not reach AI status endpoint" }); });
    };
    fetchStatus();
    // Re-poll every 30s so the degraded-mode banner appears/disappears live.
    const id = setInterval(fetchStatus, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!status || dismissed) return null;

  // CASE 1: Claude is fully unavailable (no key) — warning amber.
  if (!status.available) {
    return (
      <div className="mb-4 rounded-md border border-warning/30 bg-warning-subtle overflow-hidden">
        <div className="flex items-start gap-2.5 px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-md font-medium text-warning-hover">
              AI is not available — analysis and auto-scoring are disabled
            </p>
            <p className="text-xs text-warning-hover/80 mt-0.5">
              ANTHROPIC_API_KEY is not configured. Add it to your Railway environment variables to enable AI features.
            </p>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="h-7 w-7 rounded flex items-center justify-center text-warning hover:text-warning-hover hover:bg-surface-hover transition-colors flex-shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  // CASE 2: Claude key present but failover triggered — running on GPT.
  // chat-with-failover.ts only supports Claude → OpenAI; there is no third
  // (local) provider. The card-level ProvenancePill renders Claude vs GPT
  // per-score so the "marked accordingly" claim is real.
  if (status.failover?.isPrimaryDead) {
    const reasonText = status.failover.failoverReason
      ? FAILOVER_REASON_TEXT[status.failover.failoverReason]
      : "Claude unreachable";
    return (
      <div className="mb-4 rounded-md border border-warning/30 bg-warning-subtle overflow-hidden">
        <div className="flex items-start gap-2.5 px-3 py-2">
          <Cpu className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-md font-medium text-warning-hover">
              Claude is degraded — using GPT (OpenAI) as fallback
            </p>
            <p className="text-xs text-warning-hover/80 mt-0.5">
              {reasonText}. New scores are produced by GPT and tagged with a provider pill on the candidate card. Recheck Claude status / credits and re-score when restored.
            </p>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="h-7 w-7 rounded flex items-center justify-center text-warning hover:text-warning-hover hover:bg-surface-hover transition-colors flex-shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return null;
}

export function AiStatusIndicator() {
  const [status, setStatus] = useState<AiStatus | null>(null);

  useEffect(() => {
    fetch("/api/ai/status")
      .then((r) => r.json())
      .then((d) => setStatus(d as AiStatus))
      .catch(() => null);
  }, []);

  if (!status) return null;

  if (status.failover?.isPrimaryDead) {
    return (
      <span className="flex items-center gap-1 text-xs text-warning">
        <Cpu className="w-3 h-3" />
        GPT fallback ({status.failover.failoverReason ?? "claude offline"})
      </span>
    );
  }

  if (status.available) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CheckCircle className="w-3 h-3" />
        AI ready ({status.model})
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-warning">
      <AlertTriangle className="w-3 h-3" />
      AI offline
    </span>
  );
}
