"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Cpu, X } from "lucide-react";

interface AiFailoverInfo {
  enabled: boolean;
  isClaudeDead: boolean;
  lastFailoverAt: string | null;
  lastClaudeSuccessAt: string | null;
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

  // CASE 1: Claude is fully unavailable (no key) — original red-flag banner.
  if (!status.available) {
    return (
      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 overflow-hidden">
        <div className="flex items-start gap-3 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900">
              AI is not available — analysis and auto-scoring are disabled
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              ANTHROPIC_API_KEY is not configured. Add it to your Railway environment variables to enable AI features.
            </p>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="text-amber-500 hover:text-amber-700 p-1 rounded transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  // CASE 2: Claude key present but the failover has triggered — running on Llama.
  if (status.failover?.isClaudeDead) {
    const reasonText = status.failover.failoverReason
      ? FAILOVER_REASON_TEXT[status.failover.failoverReason]
      : "Claude unreachable";
    return (
      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 overflow-hidden">
        <div className="flex items-start gap-3 px-4 py-3">
          <Cpu className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900">
              Running on local Llama — Claude is offline
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              {reasonText}. New scores are produced by the local model and will be marked accordingly. Recheck Claude status / credits and re-score when restored.
            </p>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="text-amber-500 hover:text-amber-700 p-1 rounded transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
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

  if (status.failover?.isClaudeDead) {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600">
        <Cpu className="w-3 h-3" />
        Llama fallback ({status.failover.failoverReason ?? "claude offline"})
      </span>
    );
  }

  if (status.available) {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600">
        <CheckCircle className="w-3 h-3" />
        AI ready ({status.model})
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-amber-600">
      <AlertTriangle className="w-3 h-3" />
      AI offline
    </span>
  );
}
