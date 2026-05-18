"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Upload, FileText, X, ChevronRight, Loader2, DollarSign, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JobBriefUploadPrefill } from "@/lib/job-brief-prefill";
import { cn } from "@/lib/utils";
import { fmtSalary } from "@/lib/format";

const SALARY_OPTIONS = [
  40000, 50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000,
  130000, 140000, 150000, 160000, 170000, 180000, 200000, 220000,
  250000, 300000,
];

const LISTING_SEED_KEY = "recruitme:new-job-from-listing";

function snapSalaryFloor(value: number) {
  const match = [...SALARY_OPTIONS].reverse().find((option) => option <= value);
  return match ?? SALARY_OPTIONS[0];
}

function snapSalaryCeil(value: number) {
  const match = SALARY_OPTIONS.find((option) => option >= value);
  return match ?? SALARY_OPTIONS[SALARY_OPTIONS.length - 1];
}

const INPUT_BASE =
  "w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all";

const TEXTAREA_BASE =
  "w-full px-3 py-2 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all resize-none";

const SELECT_BASE =
  "w-full h-7 px-2 rounded bg-surface-sunken border border-separator text-md text-text-primary focus:outline-none focus:border-accent focus:shadow-focus transition-all";

export default function NewJobPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [location2, setLocation2] = useState("");
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
  const [loadedFromListing, setLoadedFromListing] = useState(false);
  const [autofilledFromUpload, setAutofilledFromUpload] = useState(false);

  useEffect(() => {
    const raw = window.sessionStorage.getItem(LISTING_SEED_KEY);
    if (!raw) return;

    try {
      const seed = JSON.parse(raw) as {
        title?: string;
        company?: string;
        location?: string;
        isRemote?: boolean;
        salaryEnabled?: boolean;
        salaryMin?: number;
        salaryMax?: number;
        jdText?: string;
      };
      if (seed.title) setTitle(seed.title);
      if (seed.company) setCompany(seed.company);
      if (seed.location) setLocation(seed.location);
      if (typeof seed.isRemote === "boolean") setIsRemote(seed.isRemote);
      if (typeof seed.salaryEnabled === "boolean") setSalaryEnabled(seed.salaryEnabled);
      if (typeof seed.salaryMin === "number") setSalaryMin(seed.salaryMin);
      if (typeof seed.salaryMax === "number") setSalaryMax(seed.salaryMax);
      if (seed.jdText) setJdText(seed.jdText);
      setLoadedFromListing(true);
    } catch {
      // ignore bad seed
    } finally {
      window.sessionStorage.removeItem(LISTING_SEED_KEY);
    }
  }, []);

  const handleFile = async (file: File) => {
    const n = file.name.toLowerCase();
    if (!n.endsWith(".pdf") && !n.endsWith(".txt") && !n.endsWith(".docx") && !n.endsWith(".doc")) {
      setAutofilledFromUpload(false);
      setError("Please upload a PDF, DOCX, or TXT file.");
      return;
    }
    setUploading(true);
    setAutofilledFromUpload(false);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", "job-brief");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json() as { text?: string; error?: string; prefill?: JobBriefUploadPrefill | null };
      if (!res.ok || data.error) {
        setError(data.error ?? "Upload failed");
      } else {
        setJdText(data.text ?? "");
        setFileName(file.name);
        if (data.prefill) {
          if (data.prefill.title) setTitle(data.prefill.title);
          if (data.prefill.company) setCompany(data.prefill.company);
          if (data.prefill.location) setLocation(data.prefill.location);
          setIsRemote(data.prefill.isRemote);
          if (data.prefill.salaryEnabled && data.prefill.salaryMin && data.prefill.salaryMax) {
            setSalaryEnabled(true);
            setSalaryMin(snapSalaryFloor(data.prefill.salaryMin));
            setSalaryMax(snapSalaryCeil(data.prefill.salaryMax));
          }
          setAutofilledFromUpload(true);
        } else {
          setAutofilledFromUpload(false);
        }
      }
    } catch {
      setAutofilledFromUpload(false);
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
          location2: location2.trim() || undefined,
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
    <div className="bg-surface-base min-h-full">
      {/* Toolbar */}
      <div className="toolbar">
        <h1 className="text-md font-semibold text-text-primary" aria-describedby="new-job-subtitle">New job</h1>
        <span className="text-xs text-text-tertiary">Build a role search from a job description or hiring brief</span>
        <div className="ml-auto" />
      </div>

      <div className="p-5 max-w-2xl mx-auto">
        <div className="mb-4">
          <p id="new-job-subtitle" className="text-text-secondary text-sm">
            Creates a job record from a finished JD and runs candidate matching against your library.
          </p>
          <p className="text-xs text-text-tertiary mt-1">
            Don&apos;t have the ad written yet? Try the{" "}
            <Link href="/jobs/listing-builder" className="text-accent hover:text-accent-hover font-medium">Listing Builder</Link>
            {" "}to draft one from a rough brief.
          </p>
        </div>

        {loadedFromListing && (
          <div className="mb-4 px-3 py-2 bg-accent-subtle border border-accent/30 rounded text-sm text-accent">
            Draft listing loaded from the Listing Builder. Review it, then create the job search.
          </div>
        )}

        {autofilledFromUpload && (
          <div className="mb-4 px-3 py-2 bg-success-subtle border border-success/30 rounded text-sm text-success">
            Brief uploaded and the top fields were auto-filled. Review them before creating the job.
          </div>
        )}

        {/* Fields card */}
        <div className="bg-surface-raised rounded-md border border-separator p-4 mb-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Job title <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Senior Software Engineer"
              className={INPUT_BASE}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Company
              </label>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Acme Corp"
                className={INPUT_BASE}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Location
              </label>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Wellington, NZ"
                className={INPUT_BASE}
              />
            </div>
          </div>

          {/* Optional second location */}
          <div>
            <details className="text-xs">
              <summary className="cursor-pointer text-text-tertiary hover:text-text-secondary select-none">
                {location2.trim()
                  ? <>+ second location: <span className="text-text-primary font-medium">{location2.trim()}</span></>
                  : <>+ add a second location <span className="text-text-tertiary">(optional — for dual-site roles)</span></>
                }
              </summary>
              <div className="mt-2">
                <input
                  type="text"
                  value={location2}
                  onChange={(e) => setLocation2(e.target.value)}
                  placeholder="e.g. Christchurch, NZ"
                  className={INPUT_BASE}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  Candidates based in either location will score the same for location fit.
                </p>
              </div>
            </details>
          </div>

          {/* Remote toggle */}
          <div className="rounded border border-separator bg-surface-sunken">
            <button
              type="button"
              onClick={() => setIsRemote((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <Wifi className={cn("w-4 h-4", isRemote ? "text-llama" : "text-text-tertiary")} />
                <div className="text-left">
                  <p className={cn("text-md font-medium", isRemote ? "text-text-primary" : "text-text-secondary")}>
                    Remote role
                  </p>
                  <p className="text-xs text-text-tertiary">
                    {isRemote
                      ? "Location penalty disabled — out-of-area candidates scored fairly"
                      : "Enable if candidates can work from anywhere"}
                  </p>
                </div>
              </div>
              <div className={cn(
                "relative w-10 h-5 rounded-full transition-colors flex-shrink-0",
                isRemote ? "bg-accent" : "bg-surface-hover"
              )}>
                <div className={cn(
                  "absolute top-0.5 w-4 h-4 bg-text-primary rounded-full shadow transition-transform",
                  isRemote ? "translate-x-5" : "translate-x-0.5"
                )} />
              </div>
            </button>
          </div>

          {/* Salary toggle + range */}
          <div className="rounded border border-separator bg-surface-sunken">
            <button
              type="button"
              onClick={() => setSalaryEnabled((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <DollarSign className={cn("w-4 h-4", salaryEnabled ? "text-accent" : "text-text-tertiary")} />
                <div className="text-left">
                  <p className={cn("text-md font-medium", salaryEnabled ? "text-text-primary" : "text-text-secondary")}>
                    Salary range
                  </p>
                  <p className="text-xs text-text-tertiary">
                    {salaryEnabled
                      ? <><span className="data-mono">{fmtSalary(salaryMin)} - {fmtSalary(salaryMax)}</span> NZD / year</>
                      : "Optional — enable to compare candidate seniority"}
                  </p>
                </div>
              </div>
              <div className={cn(
                "relative w-10 h-5 rounded-full transition-colors flex-shrink-0",
                salaryEnabled ? "bg-accent" : "bg-surface-hover"
              )}>
                <div className={cn(
                  "absolute top-0.5 w-4 h-4 bg-text-primary rounded-full shadow transition-transform",
                  salaryEnabled ? "translate-x-5" : "translate-x-0.5"
                )} />
              </div>
            </button>

            {salaryEnabled && (
              <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Minimum</label>
                  <select
                    value={salaryMin}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSalaryMin(v);
                      if (v > salaryMax) setSalaryMax(v);
                    }}
                    className={SELECT_BASE}
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
                    className={SELECT_BASE}
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

        {/* JD card */}
        <div className="bg-surface-raised rounded-md border border-separator p-4 mb-4">
          <div className="mb-3">
            <label className="block text-md font-medium text-text-primary">
              Job description or hiring brief <span className="text-danger">*</span>
            </label>
            <p className="text-xs text-text-tertiary mt-0.5">
              Paste a JD, upload a PDF/DOCX/TXT brief, or bring in the finished ad from the Listing Builder.
            </p>
          </div>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "border border-dashed rounded p-5 text-center cursor-pointer transition-colors mb-3",
              dragging
                ? "border-accent bg-accent-subtle"
                : "border-separator hover:border-separator-strong hover:bg-surface-hover"
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.doc,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            {uploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="w-5 h-5 text-accent animate-spin" />
                <p className="text-sm text-text-secondary">Reading brief and filling fields...</p>
              </div>
            ) : fileName ? (
              <div className="flex items-center justify-center gap-2">
                <FileText className="w-4 h-4 text-accent" />
                <span className="text-sm font-medium text-text-primary">{fileName}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setFileName(""); setJdText(""); setAutofilledFromUpload(false); }}
                  className="text-text-tertiary hover:text-danger ml-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5">
                <Upload className="w-5 h-5 text-text-tertiary" />
                <p className="text-sm text-text-secondary">
                  Drop a PDF or TXT, or <span className="text-accent font-medium">click to browse</span>
                </p>
                <p className="text-xs text-text-tertiary">PDF, DOCX, TXT up to 10MB</p>
              </div>
            )}
          </div>

          <div className="relative mb-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-separator" />
            </div>
            <div className="relative flex justify-center">
              <span className="px-2 bg-surface-raised text-xs text-text-tertiary">or paste below</span>
            </div>
          </div>

          <textarea
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
            placeholder="Paste a job description, hiring brief, client email, or the finished listing you want turned into a candidate search..."
            className={cn(TEXTAREA_BASE, "mt-2")}
            rows={10}
          />
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 bg-danger-subtle border border-danger/30 rounded text-sm text-danger">
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
            Create job & analyse
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
