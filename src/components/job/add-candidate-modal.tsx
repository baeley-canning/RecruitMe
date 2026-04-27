"use client";

import { useState } from "react";
import { Loader2, AlertCircle, X, CheckCircle2, Paperclip, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ParsedRole } from "@/lib/ai";

interface AddCandidateModalProps {
  jobId: string;
  parsedRole: ParsedRole | null;
  onComplete: (createdId?: string) => void;
  onClose: () => void;
}

export function AddCandidateModal({ jobId, parsedRole, onComplete, onClose }: AddCandidateModalProps) {
  const [form, setForm] = useState({ linkedinUrl: "", profileText: "" });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfFileName, setPdfFileName] = useState("");

  const handlePdfUpload = async (file: File) => {
    setPdfUploading(true);
    setPdfFileName(file.name);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json() as { text?: string; error?: string };
      if (!res.ok || data.error) { setError(data.error ?? "Failed to read PDF"); setPdfFileName(""); }
      else { setForm((f) => ({ ...f, profileText: data.text ?? "" })); }
    } catch { setError("Failed to upload file"); setPdfFileName(""); }
    finally { setPdfUploading(false); }
  };

  const handleAdd = async () => {
    const url = form.linkedinUrl.trim();
    const text = form.profileText.trim();
    if (!url && !text) { setError("Paste a LinkedIn URL or some profile text."); return; }
    setAdding(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl: url || undefined, profileText: text || undefined, autoScore: Boolean(text) }),
      });
      const created = await res.json() as { id?: string; error?: string };
      if (!res.ok) { setError(created.error ?? "Failed to add candidate"); return; }
      onComplete(created.id);
    } finally { setAdding(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h3 className="font-semibold text-slate-900">Add Candidate</h3>
            <p className="text-xs text-slate-500 mt-0.5">Paste a LinkedIn URL, upload a CV, or paste profile text directly.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">LinkedIn URL</label>
            <input type="url" value={form.linkedinUrl} onChange={(e) => setForm((f) => ({ ...f, linkedinUrl: e.target.value }))}
              placeholder="https://linkedin.com/in/username" autoFocus
              className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-200" /></div>
            <div className="relative flex justify-center"><span className="bg-white px-3 text-xs text-slate-400">or add profile text</span></div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Upload CV / PDF</label>
            <label className={`flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
              pdfUploading ? "border-blue-300 bg-blue-50" : pdfFileName ? "border-emerald-300 bg-emerald-50" : "border-slate-200 hover:border-blue-300 hover:bg-blue-50"
            }`}>
              <input type="file" accept=".pdf,.txt" className="sr-only" disabled={pdfUploading || adding}
                onChange={(e) => { const file = e.target.files?.[0]; if (file) handlePdfUpload(file); e.target.value = ""; }} />
              {pdfUploading ? (
                <><Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" /><span className="text-sm text-blue-600">Extracting and cleaning with AI…</span></>
              ) : pdfFileName ? (
                <><CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  <span className="text-sm text-emerald-700 truncate flex-1">{pdfFileName}</span>
                  <button type="button" onClick={(e) => { e.preventDefault(); setPdfFileName(""); setForm((f) => ({ ...f, profileText: "" })); }} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button></>
              ) : (
                <><Paperclip className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span className="text-sm text-slate-500">Click to upload <span className="font-medium text-slate-700">PDF or TXT</span></span></>
              )}
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Or paste text</label>
            <textarea value={form.profileText}
              onChange={(e) => { setForm((f) => ({ ...f, profileText: e.target.value })); if (pdfFileName) setPdfFileName(""); }}
              placeholder="Paste CV or LinkedIn profile text — AI will extract details and score them."
              className="w-full px-3.5 py-3 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" rows={5}
            />
          </div>

          {!parsedRole && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700">Analyse the job description first for automatic scoring to work.</p>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-3 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
            <Button onClick={handleAdd} loading={adding} disabled={adding || pdfUploading} className="flex-1">
              <Sparkles className="w-4 h-4" />
              {adding ? "Scoring…" : "Add & Score"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
