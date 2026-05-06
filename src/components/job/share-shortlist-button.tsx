"use client";

import { useEffect, useRef, useState } from "react";
import { Share2, Copy, Check, X, Trash2, Loader2 } from "lucide-react";

// "Share with client" affordance for the shortlist page. Generates an opaque
// token, returns the public URL, lets the recruiter copy or revoke. The token
// is regenerated on each rotation — old links stop working immediately.
export function ShareShortlistButton({ jobId }: { jobId: string }) {
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
        className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-medium transition-colors"
      >
        <Share2 className="w-4 h-4" />
        Share
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-lg p-4 z-10">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-slate-800">Share read-only shortlist</p>
            <button onClick={() => setOpen(false)} className="text-slate-300 hover:text-slate-500">
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-[11px] text-slate-500 mb-3">
            Anyone with this link can see the shortlisted candidates and their scoring summary. No login required. Notes and contact details are not shared.
          </p>

          {url ? (
            <div className="space-y-2">
              <div className="flex items-stretch gap-1.5">
                <input
                  readOnly
                  value={url}
                  className="flex-1 text-xs font-mono border border-slate-200 rounded-md px-2 py-1.5 bg-slate-50 text-slate-700 truncate"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={copy}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700"
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
                  className="text-[11px] text-slate-400 hover:text-slate-600 underline underline-offset-2"
                >
                  Rotate link
                </button>
                <button
                  onClick={revoke}
                  disabled={loading}
                  className="inline-flex items-center gap-1 text-[11px] text-red-500 hover:text-red-700"
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
              className="w-full inline-flex items-center justify-center gap-2 text-sm px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-slate-300"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
              Generate share link
            </button>
          )}

          {error && <p className="text-[11px] text-red-600 mt-2">{error}</p>}
        </div>
      )}
    </div>
  );
}
