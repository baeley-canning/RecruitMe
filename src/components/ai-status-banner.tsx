"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, X, ChevronDown, ChevronUp, Terminal } from "lucide-react";

interface AiStatus {
  available: boolean;
  provider: string;
  model?: string;
  error?: string;
}

export function AiStatusBanner() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/ai/status")
      .then((r) => r.json())
      .then((d) => setStatus(d as AiStatus))
      .catch(() => setStatus({ available: false, provider: "unknown", error: "Could not reach AI status endpoint" }));
  }, []);

  if (!status || status.available || dismissed) return null;

  const isOllama = status.provider === "ollama";

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3">
        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-900">
            AI is not available — analysis and auto-scoring are disabled
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            {isOllama
              ? "Ollama is not running. You need to start it before you can analyse job descriptions or score candidates."
              : "OpenAI API key is not configured. Add OPENAI_API_KEY to .env.local to enable AI features."}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-amber-600 hover:text-amber-800 p-1 rounded transition-colors"
            title="Setup instructions"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-amber-500 hover:text-amber-700 p-1 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-amber-200 px-4 py-4 bg-amber-50/80">
          {isOllama ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-amber-900">Option 1 — Start Ollama (free, runs locally)</p>
              <div className="space-y-2">
                <Step n={1} text="Install Ollama if you haven't:" />
                <Code>curl -fsSL https://ollama.com/install.sh | sh</Code>
                <Step n={2} text="Start the Ollama server:" />
                <Code>ollama serve</Code>
                <Step n={3} text="Pull the model (first time only):" />
                <Code>ollama pull llama3.2:3b</Code>
                <Step n={4} text="Refresh this page — AI will activate automatically." />
              </div>

              <div className="mt-4 pt-3 border-t border-amber-200">
                <p className="text-xs font-semibold text-amber-900 mb-2">Option 2 — Use OpenAI instead (needs API key)</p>
                <p className="text-xs text-amber-800 mb-2">
                  Edit <code className="bg-amber-100 px-1 rounded">.env.local</code> in your project root:
                </p>
                <Code>{`AI_PROVIDER=openai\nOPENAI_API_KEY=sk-...your-key-here...`}</Code>
                <p className="text-xs text-amber-700 mt-2">
                  Then restart the dev server with <code className="bg-amber-100 px-1 rounded">npm run dev</code>.
                </p>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-xs font-semibold text-amber-900 mb-2">Add your OpenAI API key</p>
              <p className="text-xs text-amber-800 mb-2">
                Edit <code className="bg-amber-100 px-1 rounded">.env.local</code> in your project root:
              </p>
              <Code>{`OPENAI_API_KEY=sk-...your-key-here...\nOPENAI_MODEL=gpt-4o-mini`}</Code>
              <p className="text-xs text-amber-700 mt-2">
                Then restart the dev server with <code className="bg-amber-100 px-1 rounded">npm run dev</code>.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
        {n}
      </span>
      <p className="text-xs text-amber-800">{text}</p>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2 bg-slate-900 rounded-lg px-3 py-2.5 mt-1">
      <Terminal className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
      <pre className="text-xs text-emerald-400 font-mono whitespace-pre-wrap leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

// Named export for use in layouts too
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
