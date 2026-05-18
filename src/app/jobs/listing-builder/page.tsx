"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, X, Loader2, DollarSign, Wifi, Sparkles, Copy, Check, ChevronRight, Download, Eye, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtSalary } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";

const SALARY_OPTIONS = [
  40000, 50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000,
  130000, 140000, 150000, 160000, 170000, 180000, 200000, 220000,
  250000, 300000,
];

const LISTING_SEED_KEY = "recruitme:new-job-from-listing";
const DRAFT_AUTOSAVE_KEY = "recruitme:listing-builder-draft";
const AUTOSAVE_DEBOUNCE_MS = 800;

// Shared input/select recipe for the page.
const INPUT = "w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all";

// Rendered markdown for the body preview. Mirrors the toHtml logic used by the
// PDF export so what you see on screen matches what gets exported. Kept inline
// rather than pulling in a markdown lib — the AI emits a tiny subset (headings,
// bold, bullet lists, paragraphs) and we'd rather not ship a parser for it.
function renderMarkdownBody(text: string): React.ReactNode {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let listBuf: string[] = [];

  const flushList = () => {
    if (listBuf.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="list-disc pl-5 mb-3 space-y-1 text-base text-text-secondary">
        {listBuf.map((item, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: inlineMarkdown(item) }} />
        ))}
      </ul>
    );
    listBuf = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,3}\s/.test(line)) {
      flushList();
      const level = line.match(/^(#{1,3})/)?.[1].length ?? 2;
      const content = line.replace(/^#{1,3}\s*/, "");
      const Tag = (`h${Math.min(level + 1, 6)}`) as keyof React.JSX.IntrinsicElements;
      out.push(
        <Tag key={`h-${out.length}`} className="text-md font-semibold text-text-primary mt-4 mb-2"
          dangerouslySetInnerHTML={{ __html: inlineMarkdown(content) }} />
      );
    } else if (/^[-*]\s/.test(line)) {
      listBuf.push(line.replace(/^[-*]\s*/, ""));
    } else if (line === "") {
      flushList();
      // Empty lines act as paragraph separators — no DOM needed.
    } else {
      flushList();
      out.push(
        <p key={`p-${out.length}`} className="text-base text-text-secondary leading-relaxed mb-3"
          dangerouslySetInnerHTML={{ __html: inlineMarkdown(line) }} />
      );
    }
  }
  flushList();
  return out;
}

// Inline-only markdown: bold + escaping. No links, no italics — the AI doesn't
// emit them and supporting unrequested syntax invites injection bugs.
function inlineMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

export default function ListingBuilderPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [isRemote, setIsRemote] = useState(false);
  const [salaryEnabled, setSalaryEnabled] = useState(false);
  const [salaryMin, setSalaryMin] = useState(80000);
  const [salaryMax, setSalaryMax] = useState(120000);
  const [brief, setBrief] = useState("");
  const [fileName, setFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [listingHeadline, setListingHeadline] = useState("");
  const [listingBody, setListingBody] = useState("");
  const [listingCopied, setListingCopied] = useState(false);
  const [bodyEditing, setBodyEditing] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);

  // ── Autosave: restore on mount, persist on every change (debounced) ─────────
  // Saves to localStorage so closing the tab mid-draft no longer loses work.
  // Cleared on successful "Use in New Job" hand-off.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(DRAFT_AUTOSAVE_KEY);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw) as {
        title?: string; company?: string; location?: string; isRemote?: boolean;
        salaryEnabled?: boolean; salaryMin?: number; salaryMax?: number;
        brief?: string; listingHeadline?: string; listingBody?: string;
      };
      if (draft.title) setTitle(draft.title);
      if (draft.company) setCompany(draft.company);
      if (draft.location) setLocation(draft.location);
      if (typeof draft.isRemote === "boolean") setIsRemote(draft.isRemote);
      if (typeof draft.salaryEnabled === "boolean") setSalaryEnabled(draft.salaryEnabled);
      if (typeof draft.salaryMin === "number") setSalaryMin(draft.salaryMin);
      if (typeof draft.salaryMax === "number") setSalaryMax(draft.salaryMax);
      if (draft.brief) setBrief(draft.brief);
      if (draft.listingHeadline) setListingHeadline(draft.listingHeadline);
      if (draft.listingBody) setListingBody(draft.listingBody);
      const hadAnything = Boolean(draft.brief || draft.listingHeadline || draft.listingBody || draft.title);
      if (hadAnything) setDraftRestored(true);
    } catch {
      // Bad cached draft — drop it rather than show a confusing stale UI.
      window.localStorage.removeItem(DRAFT_AUTOSAVE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = setTimeout(() => {
      const hasContent = title || company || location || brief || listingHeadline || listingBody;
      if (!hasContent) {
        window.localStorage.removeItem(DRAFT_AUTOSAVE_KEY);
        return;
      }
      window.localStorage.setItem(DRAFT_AUTOSAVE_KEY, JSON.stringify({
        title, company, location, isRemote,
        salaryEnabled, salaryMin, salaryMax,
        brief, listingHeadline, listingBody,
      }));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [title, company, location, isRemote, salaryEnabled, salaryMin, salaryMax, brief, listingHeadline, listingBody]);

  const clearDraft = () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(DRAFT_AUTOSAVE_KEY);
    setTitle(""); setCompany(""); setLocation(""); setIsRemote(false);
    setSalaryEnabled(false); setBrief(""); setFileName("");
    setListingHeadline(""); setListingBody(""); setListingCopied(false);
    setError(""); setDraftRestored(false);
  };

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf") && !file.name.toLowerCase().endsWith(".txt")) {
      setError("Please upload a PDF or TXT file.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json() as { text?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "Upload failed");
      } else {
        setBrief(data.text ?? "");
        setFileName(file.name);
      }
    } catch {
      setError("Upload failed. Try pasting the brief instead.");
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleDraft = async () => {
    if (!title.trim()) { setError("Job title is required before drafting a listing."); return; }
    if (brief.trim().length < 40) { setError("Add a rough brief first so AI has enough context."); return; }

    setDrafting(true);
    setListingHeadline("");
    setListingBody("");
    setListingCopied(false);
    setError("");

    try {
      const res = await fetch("/api/jobs/generate-ad-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          company: company.trim(),
          location: location.trim(),
          isRemote,
          salaryMin: salaryEnabled ? salaryMin : null,
          salaryMax: salaryEnabled ? salaryMax : null,
          brief: brief.trim(),
        }),
      });
      const data = await res.json() as { headline?: string; body?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "Failed to draft listing");
        return;
      }
      setListingHeadline(data.headline ?? "");
      setListingBody(data.body ?? "");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setDrafting(false);
    }
  };

  const handleExportPDF = () => {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const toHtml = (text: string) => {
      const lines = text.split("\n");
      const out: string[] = [];
      let inList = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^#{1,3}\s/.test(trimmed)) {
          if (inList) { out.push("</ul>"); inList = false; }
          const level = trimmed.match(/^(#{1,3})/)?.[1].length ?? 2;
          const content = esc(trimmed.replace(/^#{1,3}\s*/, "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          out.push(`<h${level + 1}>${content}</h${level + 1}>`);
        } else if (/^[-*]\s/.test(trimmed)) {
          if (!inList) { out.push("<ul>"); inList = true; }
          const content = esc(trimmed.replace(/^[-*]\s*/, "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          out.push(`<li>${content}</li>`);
        } else if (trimmed === "") {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push("<br>");
        } else {
          if (inList) { out.push("</ul>"); inList = false; }
          const content = esc(trimmed).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          out.push(`<p>${content}</p>`);
        }
      }
      if (inList) out.push("</ul>");
      return out.join("\n");
    };

    const meta = [company, location, salaryEnabled ? `$${Math.round(salaryMin / 1000)}k–$${Math.round(salaryMax / 1000)}k NZD` : ""].filter(Boolean).join(" · ");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(listingHeadline || title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:48px auto;padding:0 24px;color:#1e293b;line-height:1.65;font-size:15px}
  h1{font-size:26px;font-weight:700;margin:0 0 6px}
  .meta{color:#64748b;font-size:13px;margin-bottom:36px}
  h2,h3,h4{font-size:16px;font-weight:600;margin:24px 0 8px;color:#0f172a}
  p{margin:0 0 12px}
  ul{margin:0 0 12px;padding-left:20px}
  li{margin-bottom:4px}
  @media print{body{margin:0;padding:24px}}
</style></head><body>
<h1>${esc(listingHeadline || title)}</h1>
${meta ? `<p class="meta">${esc(meta)}</p>` : ""}
${toHtml(listingBody)}
</body></html>`;

    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  };

  const handleUseInNewJob = () => {
    const jdText = `${listingHeadline}\n\n${listingBody}`.trim();
    window.sessionStorage.setItem(
      LISTING_SEED_KEY,
      JSON.stringify({
        title,
        company,
        location,
        isRemote,
        salaryEnabled,
        salaryMin,
        salaryMax,
        jdText,
      })
    );
    // Drop the autosaved draft — the listing has now graduated into a real job.
    if (typeof window !== "undefined") window.localStorage.removeItem(DRAFT_AUTOSAVE_KEY);
    router.push("/jobs/new");
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="toolbar">
        <Sparkles className="w-3.5 h-3.5 text-text-secondary" />
        <h1 className="text-md font-semibold text-text-primary" aria-describedby="listing-builder-subtitle">Listing Builder</h1>
        <span className="text-xs text-text-tertiary">Draft the external job ad before running the search</span>
        {(title || brief || listingHeadline || listingBody) && (
          <button
            type="button"
            onClick={clearDraft}
            className="ml-auto text-xs text-text-tertiary hover:text-danger transition-colors"
            title="Clear the saved draft and start fresh"
          >
            Start over
          </button>
        )}
      </div>

      <div className="p-4 max-w-3xl mx-auto space-y-4">
        <div>
          <p id="listing-builder-subtitle" className="text-text-secondary text-sm">
            Turns a rough brief into polished ad copy (headline + body) you can copy, PDF, or send into a new job search.
          </p>
          <p className="text-xs text-text-tertiary mt-1">
            Already have a finished JD? Skip ahead and{" "}
            <a href="/jobs/new" className="text-accent hover:text-accent-hover font-medium">create the job</a>
            {" "}directly.
          </p>
        </div>
        {draftRestored && (
          <div className="px-3 py-2 bg-accent-subtle border border-separator rounded flex items-center justify-between gap-3">
            <p className="text-xs text-accent">
              <span className="font-medium">Draft restored.</span> We auto-save your work as you type — close the tab and come back any time.
            </p>
            <button
              type="button"
              onClick={() => setDraftRestored(false)}
              className="text-accent hover:text-accent-hover flex-shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <Card>
          <CardBody className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Job Title <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Senior Software Engineer"
                className={INPUT}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Company</label>
                <input
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className={INPUT}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Location</label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Wellington, NZ"
                  className={INPUT}
                />
              </div>
            </div>

            <div className={cn(
              "rounded-md border bg-surface-sunken transition-colors",
              isRemote ? "border-llama/40" : "border-separator"
            )}>
              <button
                type="button"
                onClick={() => setIsRemote((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <Wifi className={cn("w-3.5 h-3.5", isRemote ? "text-llama" : "text-text-tertiary")} />
                  <div className="text-left">
                    <p className={cn("text-base font-medium", isRemote ? "text-text-primary" : "text-text-secondary")}>
                      Remote Role
                    </p>
                    <p className="text-xs text-text-tertiary">
                      {isRemote ? "Tell the ad it is remote/flexible." : "Enable if candidates can work remotely."}
                    </p>
                  </div>
                </div>
                <div className={cn(
                  "relative w-9 h-5 rounded-full transition-colors flex-shrink-0",
                  isRemote ? "bg-llama" : "bg-surface-hover"
                )}>
                  <div className={cn(
                    "absolute top-0.5 w-4 h-4 bg-text-primary rounded-full transition-transform",
                    isRemote ? "translate-x-4" : "translate-x-0.5"
                  )} />
                </div>
              </button>
            </div>

            <div className={cn(
              "rounded-md border bg-surface-sunken transition-colors",
              salaryEnabled ? "border-accent/40" : "border-separator"
            )}>
              <button
                type="button"
                onClick={() => setSalaryEnabled((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <DollarSign className={cn("w-3.5 h-3.5", salaryEnabled ? "text-accent" : "text-text-tertiary")} />
                  <div className="text-left">
                    <p className={cn("text-base font-medium", salaryEnabled ? "text-text-primary" : "text-text-secondary")}>
                      Salary Range
                    </p>
                    <p className="text-xs text-text-tertiary">
                      {salaryEnabled
                        ? `${fmtSalary(salaryMin)} - ${fmtSalary(salaryMax)} NZD / year`
                        : "Optional - include if you want it in the listing"}
                    </p>
                  </div>
                </div>
                <div className={cn(
                  "relative w-9 h-5 rounded-full transition-colors flex-shrink-0",
                  salaryEnabled ? "bg-accent" : "bg-surface-hover"
                )}>
                  <div className={cn(
                    "absolute top-0.5 w-4 h-4 bg-text-primary rounded-full transition-transform",
                    salaryEnabled ? "translate-x-4" : "translate-x-0.5"
                  )} />
                </div>
              </button>

              {salaryEnabled && (
                <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1">Minimum</label>
                    <select
                      value={salaryMin}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setSalaryMin(v);
                        if (v > salaryMax) setSalaryMax(v);
                      }}
                      className={INPUT}
                    >
                      {SALARY_OPTIONS.map((n) => (
                        <option key={n} value={n}>{fmtSalary(n)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1">Maximum</label>
                    <select
                      value={salaryMax}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setSalaryMax(v);
                        if (v < salaryMin) setSalaryMin(v);
                      }}
                      className={INPUT}
                    >
                      {SALARY_OPTIONS.filter((n) => n >= salaryMin).map((n) => (
                        <option key={n} value={n}>{fmtSalary(n)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="mb-2">
              <label className="block text-md font-medium text-text-primary">
                Rough Hiring Brief <span className="text-danger">*</span>
              </label>
              <p className="text-xs text-text-tertiary mt-0.5">
                Paste recruiter notes, a client email, or any rough brief. This page is for drafting the ad, not running the search yet.
              </p>
            </div>

            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-md p-4 text-center cursor-pointer transition-colors mb-3",
                dragging
                  ? "border-accent bg-accent-subtle"
                  : "border-separator-strong hover:border-accent hover:bg-surface-hover"
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              {uploading ? (
                <div className="flex flex-col items-center gap-1.5">
                  <Loader2 className="w-6 h-6 text-accent animate-spin" />
                  <p className="text-base text-text-secondary">Extracting text...</p>
                </div>
              ) : fileName ? (
                <div className="flex items-center justify-center gap-2">
                  <FileText className="w-4 h-4 text-accent" />
                  <span className="text-base font-medium text-text-primary">{fileName}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFileName(""); setBrief(""); }}
                    className="text-text-tertiary hover:text-danger ml-1"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  <Upload className="w-6 h-6 text-text-tertiary" />
                  <p className="text-base text-text-secondary">
                    Drop a PDF or TXT, or <span className="text-accent font-medium">click to browse</span>
                  </p>
                  <p className="text-xs text-text-tertiary">PDF, TXT up to 10MB</p>
                </div>
              )}
            </div>

            <div className="relative mb-2">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-separator" />
              </div>
              <div className="relative flex justify-center">
                <span className="px-3 bg-surface-raised text-xs text-text-tertiary">or paste below</span>
              </div>
            </div>

            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Paste the rough requirements, recruiter notes, or client brief here..."
              className="w-full mt-2 px-2.5 py-2 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all resize-none"
              rows={10}
            />
          </CardBody>
        </Card>

        {error && (
          <div className="px-3 py-2 bg-danger-subtle border border-separator rounded text-xs text-danger">
            {error}
          </div>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={handleDraft}
            disabled={!title.trim() || brief.trim().length < 40 || drafting}
            loading={drafting}
            variant="primary"
            size="lg"
          >
            {!drafting && <Sparkles className="w-4 h-4" />}
            Draft Listing
          </Button>
        </div>

        {(listingHeadline || listingBody) && (
          <Card>
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-md font-semibold text-text-primary">Draft Listing</h2>
                  <p className="text-xs text-text-tertiary mt-0.5">
                    Review it, copy it, or send it into the new job search flow.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(`${listingHeadline}\n\n${listingBody}`).then(() => {
                        setListingCopied(true);
                        setTimeout(() => setListingCopied(false), 2000);
                      });
                    }}
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-overlay text-text-primary text-md font-medium border border-separator transition-colors"
                  >
                    {listingCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                    {listingCopied ? "Copied!" : "Copy All"}
                  </button>
                  <button
                    type="button"
                    onClick={handleExportPDF}
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-surface-hover hover:bg-surface-overlay text-text-primary text-md font-medium border border-separator transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export PDF
                  </button>
                  <button
                    type="button"
                    onClick={handleDraft}
                    className="text-xs text-accent hover:text-accent-hover font-medium"
                  >
                    Regenerate
                  </button>
                </div>
              </div>

              <div className="p-3 bg-accent-subtle border border-separator rounded-md">
                <p className="text-2xs font-semibold text-accent uppercase tracking-wider mb-1">Headline</p>
                <input
                  type="text"
                  value={listingHeadline}
                  onChange={(e) => setListingHeadline(e.target.value)}
                  className="w-full bg-transparent font-semibold text-text-primary text-lg leading-snug focus:outline-none rounded px-1 -mx-1"
                />
              </div>

              <div className="p-3 bg-surface-sunken border border-separator rounded-md">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider">Body</p>
                  <button
                    type="button"
                    onClick={() => setBodyEditing((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary"
                    title={bodyEditing ? "Switch to rendered preview" : "Edit the body before exporting"}
                  >
                    {bodyEditing
                      ? <><Eye className="w-3 h-3" /> Preview</>
                      : <><Pencil className="w-3 h-3" /> Edit</>}
                  </button>
                </div>
                {bodyEditing ? (
                  <textarea
                    value={listingBody}
                    onChange={(e) => setListingBody(e.target.value)}
                    rows={Math.max(8, Math.min(28, listingBody.split("\n").length + 2))}
                    className="w-full bg-surface-base border border-separator rounded px-2.5 py-2 text-base font-mono text-text-primary leading-relaxed focus:outline-none focus:border-accent focus:shadow-focus"
                  />
                ) : (
                  <div className="prose-sm max-w-none">
                    {renderMarkdownBody(listingBody)}
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <Button type="button" onClick={handleUseInNewJob} variant="primary" size="lg">
                  Use in New Job Search
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
