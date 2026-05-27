"use client";

import { useState } from "react";
import { Loader2, AlertCircle, X, CheckCircle2, Paperclip, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { isSeekProfileUrl } from "@/lib/seek";
import type { ParsedRole } from "@/lib/ai";

interface AddCandidateModalProps {
  jobId: string;
  parsedRole: ParsedRole | null;
  onComplete: (createdId?: string) => void;
  onClose: () => void;
}

export function AddCandidateModal({ jobId, parsedRole, onComplete, onClose }: AddCandidateModalProps) {
  const [form, setForm] = useState({ linkedinUrl: "", seekUrl: "", profileText: "" });
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
    const seek = form.seekUrl.trim();
    const text = form.profileText.trim();
    if (!url && !text) { setError("Paste a LinkedIn URL or some profile text."); return; }
    if (seek && !isSeekProfileUrl(seek)) { setError("Enter a valid SEEK profile URL."); return; }
    setAdding(true);
    setError("");
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkedinUrl: url || undefined, seekUrl: seek || undefined, profileText: text || undefined, autoScore: Boolean(text) }),
      });
      const created = await res.json().catch(() => ({})) as { id?: string; error?: string };
      if (!res.ok) {
        setError(created.error ?? `Failed to add candidate (${res.status})`);
        return;
      }
      onComplete(created.id);
    } finally { setAdding(false); }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      labelledBy="add-candidate-title"
      className="bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-lg max-h-[90vh] overflow-y-auto"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-separator">
        <div>
          <h3 id="add-candidate-title" className="text-md font-semibold text-text-primary">Add Candidate</h3>
          <p className="text-xs text-text-secondary mt-0.5">Paste a LinkedIn URL, upload a CV, or paste profile text directly.</p>
        </div>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors" aria-label="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-5 py-4 space-y-4">
        <div>
          <label className="block text-md font-medium text-text-primary mb-1.5">LinkedIn URL</label>
          <input type="url" value={form.linkedinUrl} onChange={(e) => setForm((f) => ({ ...f, linkedinUrl: e.target.value }))}
            placeholder="https://linkedin.com/in/username" autoFocus
            className="w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
          />
        </div>

        <div>
          <label className="block text-md font-medium text-text-primary mb-1.5">SEEK URL <span className="text-text-tertiary font-normal">(optional)</span></label>
          <input type="url" value={form.seekUrl} onChange={(e) => setForm((f) => ({ ...f, seekUrl: e.target.value }))}
            placeholder="https://talent.seek.com.au/profile/..."
            className="w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
          />
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-separator" /></div>
          <div className="relative flex justify-center"><span className="bg-surface-overlay px-3 text-xs text-text-tertiary">or add profile text</span></div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Upload CV (PDF, DOCX, TXT)</label>
          <label className={`flex items-center gap-3 px-3 py-2.5 border border-dashed rounded cursor-pointer transition-colors ${
            pdfUploading ? "border-accent bg-accent-subtle" : pdfFileName ? "border-success bg-success-subtle" : "border-separator-strong hover:border-accent hover:bg-accent-subtle"
          }`}>
            <input type="file" accept=".pdf,.docx,.doc,.txt" className="sr-only" disabled={pdfUploading || adding}
              onChange={(e) => { const file = e.target.files?.[0]; if (file) handlePdfUpload(file); e.target.value = ""; }} />
            {pdfUploading ? (
              <><Loader2 className="w-3.5 h-3.5 text-accent animate-spin flex-shrink-0" /><span className="text-base text-accent">Extracting and cleaning with AI…</span></>
            ) : pdfFileName ? (
              <><CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0" />
                <span className="text-base text-success truncate flex-1">{pdfFileName}</span>
                <button type="button" onClick={(e) => { e.preventDefault(); setPdfFileName(""); setForm((f) => ({ ...f, profileText: "" })); }} className="text-text-tertiary hover:text-text-primary flex-shrink-0">
                  <X className="w-3.5 h-3.5" />
                </button></>
            ) : (
              <><Paperclip className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
                <span className="text-base text-text-secondary">Click to upload <span className="font-medium text-text-primary">PDF, DOCX or TXT</span></span></>
            )}
          </label>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Or paste text</label>
          <textarea value={form.profileText}
            onChange={(e) => { setForm((f) => ({ ...f, profileText: e.target.value })); if (pdfFileName) setPdfFileName(""); }}
            placeholder="Paste CV or LinkedIn profile text — AI will extract details and score them."
            className="w-full px-2.5 py-2 rounded bg-surface-sunken border border-separator text-base text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus resize-none" rows={5}
          />
        </div>

        {!parsedRole && (
          <div className="flex items-start gap-2 px-3 py-2 bg-warning-subtle border-l-2 border-warning rounded-sm">
            <AlertCircle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
            <p className="text-xs text-warning">Analyse the job description first for automatic scoring to work.</p>
          </div>
        )}

        {error && <p className="text-base text-danger">{error}</p>}

        <div className="flex gap-3 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1" size="lg">Cancel</Button>
          <Button onClick={handleAdd} loading={adding} disabled={adding || pdfUploading} className="flex-1" size="lg">
            <Sparkles className="w-3.5 h-3.5" />
            {adding ? "Scoring…" : "Add & Score"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
