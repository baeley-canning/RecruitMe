"use client";

import { useEffect, useRef, useState } from "react";
import { Share2, Copy, Check, X, Trash2, Loader2 } from "lucide-react";

// "Share with client" affordance for the shortlist page. Generates an opaque
// token, returns the public URL, lets the recruiter copy or revoke. The token
// is regenerated on each rotation — old links stop working immediately.
export function ShareShortlistButton({ jobId, shortlistCount = 0 }: { jobId: string; shortlistCount?: number }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/jobs/${jobId}/shortlist/share`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { token: string | null } | null) => setToken(d?.token ?? null))
      .catch(() => {});
  }, [open, jobId]);

  // Click outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const generate = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/shortlist/share`, { method: "POST" });
      if (!res.ok) {
        setError("Failed to generate link.");
        return;
      }
      const data = await res.json() as { token: string };
      setToken(data.token);
    } finally {
      setLoading(false);
    }
  };

  const revoke = async () => {
    if (!confirm("Revoke this link? Anyone holding it will lose access.")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/shortlist/share`, { method: "DELETE" });
      if (res.ok) setToken(null);
    } finally {
      setLoading(false);
    }
  };

  const url = token && typeof window !== "undefined" ? `${window.location.origin}/shortlist/${token}` : null;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy — long-press the link to copy manually.");
    }
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-overlay text-text-primary border border-separator text-md font-medium transition-colors"
      >
        <Share2 className="w-3.5 h-3.5" />
        Share
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby="share-shortlist-title"
          className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] bg-surface-overlay border border-separator rounded-md shadow-popover p-4 z-10"
        >
          <div className="flex items-center justify-between mb-3">
            <p id="share-shortlist-title" className="text-md font-semibold text-text-primary">Share read-only shortlist</p>
            <button onClick={() => setOpen(false)} aria-label="Close share menu" className="text-text-tertiary hover:text-text-primary transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {shortlistCount === 0 && (
            <div className="mb-3 flex items-start gap-2 text-xs text-warning bg-warning-subtle border-l-2 border-warning rounded-sm px-3 py-2">
              <span className="mt-0.5">⚠</span>
              <span>No candidates have been shortlisted yet. The link will show a &ldquo;being evaluated&rdquo; message to clients until you shortlist candidates.</span>
            </div>
          )}
          <p className="text-xs text-text-secondary mb-3">
            Anyone with this link can see the shortlisted candidates and their scoring summary. No login required. Notes and contact details are not shared.
          </p>

          {url ? (
            <div className="space-y-2">
              <div className="flex items-stretch gap-1.5">
                <input
                  readOnly
                  value={url}
                  className="flex-1 h-7 px-2 rounded bg-surface-sunken border border-separator text-xs font-mono text-text-primary truncate focus:outline-none focus:border-accent"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={copy}
                  className="inline-flex items-center gap-1 h-7 px-2 bg-accent hover:bg-accent-hover text-white text-xs rounded font-medium transition-colors"
                  title="Copy link"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={generate}
                  disabled={loading}
                  className="text-xs text-text-tertiary hover:text-text-secondary underline underline-offset-2"
                >
                  Rotate link
                </button>
                <button
                  onClick={revoke}
                  disabled={loading}
                  className="inline-flex items-center gap-1 text-xs text-danger hover:text-danger-hover"
                >
                  <Trash2 className="w-3 h-3" />
                  Revoke
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={generate}
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 h-8 px-3 bg-accent hover:bg-accent-hover text-white text-md rounded font-medium disabled:opacity-50 transition-colors"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}
              Generate share link
            </button>
          )}

          {error && <p className="text-xs text-danger mt-2">{error}</p>}
        </div>
      )}
    </div>
  );
}
