"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, X } from "lucide-react";

interface AiStatus {
  available: boolean;
  provider: string;
  model?: string;
  error?: string;
}

export function AiStatusBanner() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch("/api/ai/status")
      .then((r) => r.json())
      .then((d) => setStatus(d as AiStatus))
      .catch(() => setStatus({ available: false, provider: "claude", error: "Could not reach AI status endpoint" }));
  }, []);

  if (!status || status.available || dismissed) return null;

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

export function AiStatusIndicator() {
  const [status, setStatus] = useState<AiStatus | null>(null);

  useEffect(() => {
    fetch("/api/ai/status")
      .then((r) => r.json())
      .then((d) => setStatus(d as AiStatus))
      .catch(() => null);
  }, []);

  if (!status) return null;

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
