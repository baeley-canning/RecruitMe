"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, X, ChevronRight, Loader2, DollarSign, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SALARY_OPTIONS = [
  40000, 50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000,
  130000, 140000, 150000, 160000, 170000, 180000, 200000, 220000,
  250000, 300000,
];

function fmtSalary(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n}`;
}

export default function NewJobPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [isRemote, setIsRemote] = useState(false);
  const [salaryEnabled, setSalaryEnabled] = useState(false);
  const [salaryMin, setSalaryMin] = useState(80000);
  const [salaryMax, setSalaryMax] = useState(120000);
  const [jdText, setJdText] = useState("");
  const [fileName, setFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

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
        setJdText(data.text ?? "");
        setFileName(file.name);
      }
    } catch {
      setError("Upload failed. Try pasting the JD text instead.");
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

  const handleCreate = async () => {
    if (!title.trim()) { setError("Job title is required."); return; }
    if (!jdText.trim()) { setError("Job description is required."); return; }

    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          company: company.trim(),
          location: location.trim(),
          isRemote,
          rawJd: jdText.trim(),
          salaryMin: salaryEnabled ? salaryMin : null,
          salaryMax: salaryEnabled ? salaryMax : null,
        }),
      });
      const job = await res.json() as { id?: string; error?: string };
      if (!res.ok || job.error) {
        setError(job.error ?? "Failed to create job");
      } else if (job.id) {
        router.push(`/jobs/${job.id}?parse=1`);
      }
    } catch {
      setError("Failed to create job. Check your connection.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-7">
        <h1 className="text-2xl font-bold text-slate-900">New Job</h1>
        <p className="text-slate-500 text-sm mt-1">
          Upload or paste a job description or hiring brief — AI extracts must-haves, knockout criteria, salary band, and generates search queries off real recruiter thinking, not JD language.
        </p>
      </div>

      {/* Job details */}
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
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Company
            </label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Acme Corp"
              className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Location
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Wellington, NZ"
              className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Remote toggle */}
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
                  {isRemote
                    ? "Location penalty disabled — out-of-area candidates scored fairly"
                    : "Enable if candidates can work from anywhere"}
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

        {/* Salary range toggle */}
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
                  {salaryEnabled
                    ? `${fmtSalary(salaryMin)} – ${fmtSalary(salaryMax)} NZD / year`
                    : "Optional — enable to compare candidate seniority"}
                </p>
              </div>
            </div>
            {/* Toggle switch */}
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

      {/* JD / brief input */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-5">
        <div className="mb-3">
          <label className="block text-sm font-medium text-slate-700">
            Job Description or Hiring Brief <span className="text-red-500">*</span>
          </label>
          <p className="text-xs text-slate-400 mt-0.5">
            Paste a JD, upload a PDF/Word brief, or even paste a client email — AI handles both formal and informal formats.
          </p>
        </div>

        {/* Drop zone */}
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
                onClick={(e) => { e.stopPropagation(); setFileName(""); setJdText(""); }}
                className="text-slate-400 hover:text-red-500 ml-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-8 h-8 text-slate-400" />
              <p className="text-sm text-slate-500">
                Drop a PDF or TXT, or{" "}
                <span className="text-blue-600 font-medium">click to browse</span>
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
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          placeholder="Paste a job description, hiring brief, client email, or any informal requirements document…"
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
        <Button
          onClick={handleCreate}
          loading={creating}
          disabled={!title.trim() || !jdText.trim()}
          size="lg"
        >
          Create Job & Analyse
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
