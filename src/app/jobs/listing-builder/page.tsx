"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, X, Loader2, DollarSign, Wifi, Sparkles, Copy, Check, ChevronRight, Download } from "lucide-react";
import { cn } from "@/lib/utils";

const SALARY_OPTIONS = [
  40000, 50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000,
  130000, 140000, 150000, 160000, 170000, 180000, 200000, 220000,
  250000, 300000,
];

const LISTING_SEED_KEY = "recruitme:new-job-from-listing";

function fmtSalary(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`;
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
    router.push("/jobs/new");
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-7">
        <h1 className="text-2xl font-bold text-slate-900">Listing Builder</h1>
        <p className="text-slate-500 text-sm mt-1">
          Draft the external job advertisement first. When it looks right, send it into the new job search flow.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Job Title <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Senior Software Engineer"
            className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Company</label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Acme Corp"
              className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Location</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Wellington, NZ"
              className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className={cn(
          "rounded-lg border transition-colors",
          isRemote ? "border-violet-200 bg-violet-50" : "border-slate-200 bg-slate-50"
        )}>
          <button
            type="button"
            onClick={() => setIsRemote((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3"
          >
            <div className="flex items-center gap-2.5">
              <Wifi className={cn("w-4 h-4", isRemote ? "text-violet-600" : "text-slate-400")} />
              <div className="text-left">
                <p className={cn("text-sm font-medium", isRemote ? "text-violet-800" : "text-slate-600")}>
                  Remote Role
                </p>
                <p className="text-xs text-slate-400">
                  {isRemote ? "Tell the ad it is remote/flexible." : "Enable if candidates can work remotely."}
                </p>
              </div>
            </div>
            <div className={cn(
              "relative w-10 h-5 rounded-full transition-colors flex-shrink-0",
              isRemote ? "bg-violet-500" : "bg-slate-300"
            )}>
              <div className={cn(
                "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                isRemote ? "translate-x-5" : "translate-x-0.5"
              )} />
            </div>
          </button>
        </div>

        <div className={cn(
          "rounded-lg border transition-colors",
          salaryEnabled ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50"
        )}>
          <button
            type="button"
            onClick={() => setSalaryEnabled((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3"
          >
            <div className="flex items-center gap-2.5">
              <DollarSign className={cn("w-4 h-4", salaryEnabled ? "text-blue-600" : "text-slate-400")} />
              <div className="text-left">
                <p className={cn("text-sm font-medium", salaryEnabled ? "text-blue-800" : "text-slate-600")}>
                  Salary Range
                </p>
                <p className="text-xs text-slate-400">
                  {salaryEnabled ? `${fmtSalary(salaryMin)} - ${fmtSalary(salaryMax)} NZD / year` : "Optional - include if you want it in the listing"}
                </p>
              </div>
            </div>
            <div className={cn(
              "relative w-10 h-5 rounded-full transition-colors flex-shrink-0",
              salaryEnabled ? "bg-blue-500" : "bg-slate-300"
            )}>
              <div className={cn(
                "absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                salaryEnabled ? "translate-x-5" : "translate-x-0.5"
              )} />
            </div>
          </button>

          {salaryEnabled && (
            <div className="px-4 pb-4 grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-blue-700 mb-1.5">Minimum</label>
                <select
                  value={salaryMin}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSalaryMin(v);
                    if (v > salaryMax) setSalaryMax(v);
                  }}
                  className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SALARY_OPTIONS.map((n) => (
                    <option key={n} value={n}>{fmtSalary(n)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-blue-700 mb-1.5">Maximum</label>
                <select
                  value={salaryMax}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSalaryMax(v);
                    if (v < salaryMin) setSalaryMin(v);
                  }}
                  className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SALARY_OPTIONS.filter((n) => n >= salaryMin).map((n) => (
                    <option key={n} value={n}>{fmtSalary(n)}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-5">
        <div className="mb-3">
          <label className="block text-sm font-medium text-slate-700">
            Rough Hiring Brief <span className="text-red-500">*</span>
          </label>
          <p className="text-xs text-slate-400 mt-0.5">
            Paste recruiter notes, a client email, or any rough brief. This page is for drafting the ad, not running the search yet.
          </p>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors mb-4",
            dragging
              ? "border-blue-400 bg-blue-50"
              : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
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
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
              <p className="text-sm text-slate-500">Extracting text...</p>
            </div>
          ) : fileName ? (
            <div className="flex items-center justify-center gap-2">
              <FileText className="w-5 h-5 text-blue-500" />
              <span className="text-sm font-medium text-slate-700">{fileName}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setFileName(""); setBrief(""); }}
                className="text-slate-400 hover:text-red-500 ml-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-8 h-8 text-slate-400" />
              <p className="text-sm text-slate-500">
                Drop a PDF or TXT, or <span className="text-blue-600 font-medium">click to browse</span>
              </p>
              <p className="text-xs text-slate-400">PDF, TXT up to 10MB</p>
            </div>
          )}
        </div>

        <div className="relative mb-1">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-200" />
          </div>
          <div className="relative flex justify-center">
            <span className="px-3 bg-white text-xs text-slate-400">or paste below</span>
          </div>
        </div>

        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Paste the rough requirements, recruiter notes, or client brief here..."
          className="w-full mt-3 px-3.5 py-3 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          rows={10}
        />
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleDraft}
          disabled={!title.trim() || brief.trim().length < 40 || drafting}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
        >
          {drafting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Draft Listing
        </button>
      </div>

      {(listingHeadline || listingBody) && (
        <div className="mt-6 bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">Draft Listing</h2>
              <p className="text-xs text-slate-500 mt-0.5">Review it, copy it, or send it into the new job search flow.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(`${listingHeadline}\n\n${listingBody}`).then(() => {
                    setListingCopied(true);
                    setTimeout(() => setListingCopied(false), 2000);
                  });
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
              >
                {listingCopied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {listingCopied ? "Copied!" : "Copy All"}
              </button>
              <button
                type="button"
                onClick={handleExportPDF}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Export PDF
              </button>
              <button
                type="button"
                onClick={handleDraft}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                Regenerate
              </button>
            </div>
          </div>

          <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">Headline</p>
            <p className="font-bold text-slate-900 text-lg leading-snug">{listingHeadline}</p>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Body</p>
            <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{listingBody}</p>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleUseInNewJob}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Use in New Job Search
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
