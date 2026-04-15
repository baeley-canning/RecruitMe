"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Search,
  UserPlus,
  ChevronRight,
  MapPin,
  Briefcase,
  Loader2,
  AlertCircle,
  X,
  Users,
  Star,
  ExternalLink,
  Key,
  CheckCircle2,
  Lock,
  LockOpen,
  Trash2,
  Download,
  FileText,
  Copy,
  Check,
  Paperclip,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { CandidateCard } from "@/components/candidate-card";
import { AiStatusBanner } from "@/components/ai-status-banner";
import { LocationRadiusMap } from "@/components/location-radius-map";
import { cn, statusBadge, statusLabel, safeParseJson } from "@/lib/utils";
import { getCityCoords, getCityNamesWithinRadius } from "@/lib/nz-cities";
import type { ParsedRole } from "@/lib/ai";

interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  profileText: string | null;
  matchScore: number | null;
  matchReason: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  notes: string | null;
  status: string;
  statusHistory: string | null;
  source: string;
  createdAt: string;
}

interface Job {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  rawJd: string;
  parsedRole: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  status: string;
  candidates: Candidate[];
}

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const shouldParse = searchParams.get("parse") === "1";

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<{ count: number; message?: string } | null>(null);
  const [searchError, setSearchError] = useState("");
  const [hasSerpApi, setHasSerpApi] = useState<boolean | null>(null);
  const [sources, setSources] = useState<{ serpapi: boolean; bing: boolean; pdl: boolean } | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<"ok" | "invalid" | "error" | "unconfigured" | null>(null);
  const [maxResults, setMaxResults] = useState(20);
  const [minScore, setMinScore] = useState(0);
  const [radiusKm, setRadiusKm] = useState(25);
  const [showMap, setShowMap] = useState(false);
  const [locationLocked, setLocationLocked] = useState(false);
  const [customCenter, setCustomCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [showAddCandidate, setShowAddCandidate] = useState(false);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const [fetchingProfileId, setFetchingProfileId] = useState<string | null>(null);
  const [fetchProfileStatus, setFetchProfileStatus] = useState<{
    name: string;
    state: "fetching" | "waiting" | "done" | "error";
    message: string;
  } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [rescoringAll, setRescoringAll] = useState(false);
  const [rescoreResult, setRescoreResult] = useState<{ scored: number; total: number } | null>(null);

  const [addForm, setAddForm] = useState({ linkedinUrl: "", profileText: "" });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfFileName, setPdfFileName] = useState("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [salaryMin, setSalaryMin] = useState<string>("");
  const [salaryMax, setSalaryMax] = useState<string>("");
  const [editingSalary, setEditingSalary] = useState(false);
  const [savingSalary, setSavingSalary] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  // Client report modal
  const [showReport, setShowReport] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [reportSummaries, setReportSummaries] = useState<{ id: string; name: string; paragraph: string }[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  // Ref used to clean up BroadcastChannel when fetch-profile tab closes/completes
  const fetchChannelRef = useRef<BroadcastChannel | null>(null);

  const fetchJob = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.ok) {
      const data = await res.json() as Job;
      setJob(data);
      setSalaryMin(data.salaryMin ? String(data.salaryMin / 1000) : "");
      setSalaryMax(data.salaryMax ? String(data.salaryMax / 1000) : "");
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  const handleSaveSalary = async () => {
    if (!job) return;
    setSavingSalary(true);
    const min = salaryMin ? Math.round(parseFloat(salaryMin) * 1000) : null;
    const max = salaryMax ? Math.round(parseFloat(salaryMax) * 1000) : null;
    const res = await fetch(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ salaryMin: min, salaryMax: max }),
    });
    if (res.ok) {
      const updated = await res.json() as Job;
      setJob((prev) => prev ? { ...prev, salaryMin: updated.salaryMin, salaryMax: updated.salaryMax } : prev);
      setEditingSalary(false);
    }
    setSavingSalary(false);
  };

  const handleToggleStatus = async () => {
    if (!job) return;
    const next = job.status === "active" ? "closed" : "active";
    setTogglingStatus(true);
    const res = await fetch(`/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      const updated = await res.json() as Job;
      setJob((prev) => prev ? { ...prev, status: updated.status } : prev);
    }
    setTogglingStatus(false);
  };

  // Check configured search/enrichment sources
  useEffect(() => {
    fetch("/api/search/status")
      .then((r) => r.json())
      .then((d: { available: boolean; sources: { serpapi: boolean; bing: boolean; pdl: boolean }; ai?: { provider: string; claude: "ok" | "invalid" | "error" | "unconfigured" } }) => {
        setHasSerpApi(d.available);
        setSources(d.sources ?? null);
        if (d.ai?.provider === "claude") setClaudeStatus(d.ai.claude);
      })
      .catch(() => setHasSerpApi(false));
  }, []);

  useEffect(() => {
    if (shouldParse && job && !job.parsedRole && !parsing) {
      handleParse();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldParse, job]);

  const handleParse = async () => {
    if (!job) return;
    setParsing(true);
    setParseError("");
    try {
      const res = await fetch(`/api/jobs/${id}/parse`, { method: "POST" });
      const data = await res.json() as { parsedRole?: ParsedRole; error?: string };
      if (!res.ok || data.error) {
        setParseError(data.error ?? "Parsing failed");
      } else {
        await fetchJob();
      }
    } catch {
      setParseError("Parsing failed. Make sure Ollama is running.");
    } finally {
      setParsing(false);
    }
  };

  const handleSearch = async () => {
    setSearching(true);
    setSearchError("");
    setSearchResult(null);
    try {
      const res = await fetch(`/api/jobs/${id}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults, minScore, radiusKm }),
      });
      const data = await res.json() as { count?: number; candidates?: Candidate[]; error?: string; message?: string };
      if (!res.ok || data.error) {
        if (data.error === "SERPAPI_KEY_MISSING") {
          setHasSerpApi(false);
        } else {
          setSearchError(data.error ?? "Search failed");
        }
      } else {
        setSearchResult({ count: data.count ?? 0, message: data.message });
        await fetchJob();
      }
    } catch {
      setSearchError("Search failed. Check your connection.");
    } finally {
      setSearching(false);
    }
  };

  const handleScore = async (candidateId: string) => {
    setScoringId(candidateId);
    try {
      const res = await fetch(`/api/jobs/${id}/candidates/${candidateId}/score`, { method: "POST" });
      if (res.ok) await fetchJob();
    } finally {
      setScoringId(null);
    }
  };

  const clearFetchStatus = (delay = 4000) =>
    setTimeout(() => setFetchProfileStatus(null), delay);

  // Must NOT be async — window.open() is blocked by browsers after an await
  const handleFetchProfile = (candidateId: string) => {
    const candidate = job?.candidates.find((c) => c.id === candidateId);
    if (!candidate?.linkedinUrl) return;

    // Close any previous channel still open from a prior fetch
    if (fetchChannelRef.current) {
      fetchChannelRef.current.close();
      fetchChannelRef.current = null;
    }

    setFetchingProfileId(candidateId);
    setFetchProfileStatus({ name: candidate.name, state: "waiting", message: "Opening LinkedIn profile…" });

    // Open in a new named tab (synchronous — user gesture still active, bookmarks bar visible).
    // The name 'rm-fetch' is how the bookmarklet detects it was opened by us.
    const tab = window.open(candidate.linkedinUrl, "rm-fetch");

    if (!tab) {
      setFetchingProfileId(null);
      setFetchProfileStatus({
        name: candidate.name,
        state: "error",
        message: "Tab blocked — allow popups for this site and try again",
      });
      clearFetchStatus(6000);
      return;
    }

    setFetchProfileStatus({
      name: candidate.name,
      state: "waiting",
      message: "LinkedIn opened — click your bookmark in the new tab",
    });

    let done = false;
    let checkInterval: ReturnType<typeof setInterval> | undefined;

    // BroadcastChannel is same-origin only — perfect for localhost:3000 ↔ localhost:3000.
    // The bookmarklet navigates the tab to /bookmarklet/return which broadcasts here.
    const ch = new BroadcastChannel("recruitme-capture");
    fetchChannelRef.current = ch;

    const finish = async (profileText: string, linkedinUrl: string) => {
      if (done) return;
      done = true;
      clearInterval(checkInterval);
      ch.close();
      fetchChannelRef.current = null;

      setFetchProfileStatus({ name: candidate.name, state: "fetching", message: "Profile received — scoring with AI…" });

      try {
        const r = await fetch(`/api/jobs/${id}/candidates/${candidateId}/fetch-profile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileText, linkedinUrl }),
        });
        if (r.ok) {
          const updated = (await r.json()) as Candidate;
          setJob((prev) =>
            prev ? { ...prev, candidates: prev.candidates.map((c) => c.id === candidateId ? updated : c) } : prev
          );
          setFetchProfileStatus({ name: candidate.name, state: "done", message: "Profile captured and scored" });
        } else {
          setFetchProfileStatus({ name: candidate.name, state: "error", message: "Failed to save — try again" });
        }
      } catch {
        setFetchProfileStatus({ name: candidate.name, state: "error", message: "Network error — try again" });
      } finally {
        setFetchingProfileId(null);
        clearFetchStatus();
      }
    };

    ch.onmessage = (e) => {
      if (e.data?.type !== "recruitme-profile") return;
      const { profileText, linkedinUrl } = e.data as { profileText: string; linkedinUrl: string };
      void finish(profileText, linkedinUrl);
    };

    // Detect tab closed by user before the bookmark was clicked
    checkInterval = setInterval(() => {
      if (tab.closed) {
        clearInterval(checkInterval);
        if (!done) {
          done = true;
          ch.close();
          fetchChannelRef.current = null;
          setFetchingProfileId(null);
          setFetchProfileStatus({ name: candidate.name, state: "error", message: "Tab closed — try again" });
          clearFetchStatus();
        }
      }
    }, 800);
  };

  const handleStatusChange = async (candidateId: string, status: string) => {
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await fetchJob();
  };

  const handleNotesChange = async (candidateId: string, notes: string) => {
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    await fetchJob();
  };

  const handleRescoreAll = async () => {
    setRescoringAll(true);
    setRescoreResult(null);
    try {
      const res = await fetch(`/api/jobs/${id}/candidates/score-all`, { method: "POST" });
      const data = await res.json() as { scored?: number; total?: number; error?: string };
      if (res.ok) {
        setRescoreResult({ scored: data.scored ?? 0, total: data.total ?? 0 });
        await fetchJob();
      }
    } finally {
      setRescoringAll(false);
    }
  };

  const handleDelete = async (candidateId: string) => {
    if (!confirm("Remove this candidate?")) return;
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, { method: "DELETE" });
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(candidateId); return next; });
    await fetchJob();
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} candidate${selectedIds.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setBulkDeleting(true);
    await fetch(`/api/jobs/${id}/candidates/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selectedIds] }),
    });
    setSelectedIds(new Set());
    setBulkDeleting(false);
    await fetchJob();
  };

  const handleExportCsv = () => {
    if (!job) return;
    const headers = ["Name", "Headline", "Location", "Match Score", "Acceptance Score", "LinkedIn URL", "Status", "Notes", "Source"];
    const rows = filteredCandidates.map((c) => [
      c.name,
      c.headline ?? "",
      c.location ?? "",
      c.matchScore != null ? String(c.matchScore) : "",
      c.acceptanceScore != null ? String(c.acceptanceScore) : "",
      c.linkedinUrl ?? "",
      statusLabel(c.status),
      (c.notes ?? "").replace(/\n/g, " "),
      c.source,
    ]);
    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${job.title.replace(/[^a-zA-Z0-9]/g, "_")}_candidates.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleGenerateReport = async () => {
    if (!job) return;
    const shortlisted = job.candidates.filter((c) => c.status === "shortlisted");
    if (shortlisted.length === 0) return;
    setShowReport(true);
    setReportLoading(true);
    setReportError("");
    setReportSummaries([]);
    try {
      const res = await fetch(`/api/jobs/${id}/shortlist-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates: shortlisted }),
      });
      const data = await res.json() as { summaries?: { id: string; name: string; paragraph: string }[]; error?: string };
      if (!res.ok || data.error) {
        setReportError(data.error ?? "Failed to generate report");
      } else {
        setReportSummaries(data.summaries ?? []);
      }
    } catch {
      setReportError("Network error. Try again.");
    } finally {
      setReportLoading(false);
    }
  };

  const handleCopyParagraph = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const handleCopyAll = () => {
    if (!job || reportSummaries.length === 0) return;
    const parsedRoleLocal = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    const header = `Shortlist Report — ${parsedRoleLocal?.title ?? job.title}\n${"=".repeat(50)}\n\n`;
    const body = reportSummaries
      .map((s) => `${s.name}\n${s.paragraph}`)
      .join("\n\n---\n\n");
    navigator.clipboard.writeText(header + body).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2500);
    });
  };

  const toggleSelect = (candidateId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const handleAddCandidate = async () => {
    const url = addForm.linkedinUrl.trim();
    const text = addForm.profileText.trim();
    if (!url && !text) {
      setAddError("Paste a LinkedIn URL or some profile text.");
      return;
    }
    setAdding(true);
    setAddError("");
    try {
      const res = await fetch(`/api/jobs/${id}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linkedinUrl: url || undefined,
          profileText: text || undefined,
          autoScore: Boolean(text),
        }),
      });
      const created = await res.json() as { id?: string; error?: string };
      if (!res.ok) {
        setAddError(created.error ?? "Failed to add candidate");
        return;
      }
      setShowAddCandidate(false);
      setAddForm({ linkedinUrl: "", profileText: "" });
      setPdfFileName("");
      await fetchJob();
      // URL-only: open the profile popup so the bookmarklet can capture it
      if (url && !text && created.id) {
        handleFetchProfile(created.id);
      }
    } finally {
      setAdding(false);
    }
  };

  const handlePdfUpload = async (file: File) => {
    setPdfUploading(true);
    setPdfFileName(file.name);
    setAddError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json() as { text?: string; error?: string };
      if (!res.ok || data.error) {
        setAddError(data.error ?? "Failed to read PDF");
        setPdfFileName("");
      } else {
        setAddForm((f) => ({ ...f, profileText: data.text ?? "" }));
      }
    } catch {
      setAddError("Failed to upload file");
      setPdfFileName("");
    } finally {
      setPdfUploading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (!job) {
    return <div className="p-8 text-center text-slate-500">Job not found.</div>;
  }

  const parsedRole = safeParseJson<ParsedRole | null>(job.parsedRole, null);

  const filteredCandidates = job.candidates
    .filter((c) => (filter === "all" ? true : c.status === filter))
    .filter((c) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        (c.headline ?? "").toLowerCase().includes(q) ||
        (c.location ?? "").toLowerCase().includes(q) ||
        (c.notes ?? "").toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      // Primary: match score descending
      const scoreDiff = (b.matchScore ?? -1) - (a.matchScore ?? -1);
      if (scoreDiff !== 0) return scoreDiff;
      // Tiebreaker: acceptance score descending — "likely open" ranks above "may consider"
      return (b.acceptanceScore ?? -1) - (a.acceptanceScore ?? -1);
    });

  const shortlistCount = job.candidates.filter((c) => c.status === "shortlisted").length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-slate-900">{job.title}</h1>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", statusBadge(job.status))}>
              {statusLabel(job.status)}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            {job.company && (
              <span className="flex items-center gap-1">
                <Briefcase className="w-3.5 h-3.5" />
                {job.company}
              </span>
            )}
            {job.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" />
                {job.location}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {shortlistCount > 0 && (
            <>
              <button
                onClick={handleGenerateReport}
                className="inline-flex items-center gap-2 px-3 py-2 border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 rounded-lg text-sm font-medium transition-colors"
              >
                <FileText className="w-4 h-4" />
                Client Report
              </button>
              <Link
                href={`/jobs/${id}/shortlist`}
                className="inline-flex items-center gap-2 px-3 py-2 border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-medium transition-colors"
              >
                <Star className="w-4 h-4 text-amber-500" />
                View Shortlist ({shortlistCount})
                <ChevronRight className="w-3.5 h-3.5" />
              </Link>
            </>
          )}
          {job.status === "active" && (
            <button
              onClick={handleToggleStatus}
              disabled={togglingStatus}
              className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {togglingStatus ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {togglingStatus ? "Closing…" : "Close job"}
            </button>
          )}
          <Button onClick={() => setShowAddCandidate(true)}>
            <UserPlus className="w-4 h-4" />
            Add Candidate
          </Button>
        </div>
      </div>

      {/* Closed job banner */}
      {job.status === "closed" && (
        <div className="mb-5 flex items-center justify-between gap-4 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl">
          <p className="text-sm text-slate-600">
            This job is <span className="font-semibold text-slate-800">closed</span> — searching and scoring are disabled.
          </p>
          <button
            onClick={handleToggleStatus}
            disabled={togglingStatus}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap disabled:opacity-50"
          >
            {togglingStatus ? "Reopening…" : "Reopen job"}
          </button>
        </div>
      )}

      {/* AI status banner */}
      <AiStatusBanner />

      {/* Step 1: Parse JD */}
      {!parsedRole && (
        <Card className="mb-6">
          <CardBody className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <p className="font-medium text-slate-900 text-sm">Step 1 — Analyse Job Description</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  AI reads the JD and extracts what to look for in candidates.
                </p>
                {parseError && (
                  <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {parseError}
                  </p>
                )}
              </div>
            </div>
            <Button onClick={handleParse} loading={parsing}>
              <Sparkles className="w-4 h-4" />
              {parsing ? "Analysing..." : "Analyse with AI"}
            </Button>
          </CardBody>
        </Card>
      )}

      {/* Main layout once parsed */}
      {parsedRole && (
        <div className="grid grid-cols-3 gap-5 mb-6">
          {/* Hiring brief */}
          <Card className="col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-slate-900 text-sm">Hiring Brief</h2>
                <button
                  onClick={handleParse}
                  disabled={parsing}
                  className="text-xs text-slate-400 hover:text-blue-600 transition-colors flex items-center gap-1"
                >
                  {parsing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  Re-analyse
                </button>
              </div>
            </CardHeader>
            <CardBody className="space-y-4">

              {/* Meta row — seniority, location, salary */}
              <div className="grid grid-cols-3 gap-3">
                {parsedRole.seniority_band && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Seniority</p>
                    <p className="text-sm text-slate-800">{parsedRole.seniority_band}</p>
                  </div>
                )}
                {(parsedRole.location_rules || parsedRole.location) && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Location / Remote</p>
                    <p className="text-sm text-slate-800">{parsedRole.location_rules || parsedRole.location}</p>
                  </div>
                )}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Salary (NZD)</p>
                    {!editingSalary && (
                      <button onClick={() => setEditingSalary(true)} className="text-xs text-blue-600 hover:text-blue-700">
                        {job.salaryMin || job.salaryMax ? "Edit" : "Set"}
                      </button>
                    )}
                  </div>
                  {editingSalary ? (
                    <div className="flex items-center gap-1.5">
                      <div className="relative flex-1">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                        <input
                          type="number"
                          placeholder="Min (k)"
                          value={salaryMin}
                          onChange={(e) => setSalaryMin(e.target.value)}
                          className="w-full pl-5 pr-2 py-1 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <span className="text-slate-400 text-sm">–</span>
                      <div className="relative flex-1">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                        <input
                          type="number"
                          placeholder="Max (k)"
                          value={salaryMax}
                          onChange={(e) => setSalaryMax(e.target.value)}
                          className="w-full pl-5 pr-2 py-1 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <span className="text-slate-400 text-xs">k</span>
                      <button onClick={handleSaveSalary} disabled={savingSalary} className="px-2 py-1 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 disabled:opacity-50">
                        {savingSalary ? "..." : "Save"}
                      </button>
                      <button onClick={() => setEditingSalary(false)} className="text-slate-400 hover:text-slate-600">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-800">
                      {job.salaryMin && job.salaryMax
                        ? `$${(job.salaryMin / 1000).toFixed(0)}k – $${(job.salaryMax / 1000).toFixed(0)}k`
                        : job.salaryMin ? `From $${(job.salaryMin / 1000).toFixed(0)}k`
                        : job.salaryMax ? `Up to $${(job.salaryMax / 1000).toFixed(0)}k`
                        : parsedRole.salary_band
                        ? <span className="text-slate-500 italic text-xs">{parsedRole.salary_band} (est.)</span>
                        : <span className="text-slate-400 italic">Not set</span>}
                    </p>
                  )}
                </div>
              </div>

              {/* Knockout criteria */}
              {parsedRole.knockout_criteria?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-red-600 uppercase tracking-wide mb-2">Knockout Criteria</p>
                  <div className="flex flex-wrap gap-1.5">
                    {parsedRole.knockout_criteria.map((s) => (
                      <span key={s} className="px-2 py-0.5 bg-red-50 text-red-700 text-xs rounded-md border border-red-200 font-medium">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Must-haves — fall back to skills_required for old jobs */}
              {(parsedRole.must_haves?.length > 0 || parsedRole.skills_required?.length > 0) && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Must-haves</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(parsedRole.must_haves?.length > 0 ? parsedRole.must_haves : parsedRole.skills_required).map((s) => (
                      <span key={s} className="px-2 py-0.5 bg-violet-50 text-violet-700 text-xs rounded-md border border-violet-100 font-medium">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Nice-to-haves — fall back to skills_preferred */}
              {(parsedRole.nice_to_haves?.length > 0 || parsedRole.skills_preferred?.length > 0) && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Nice-to-haves</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(parsedRole.nice_to_haves?.length > 0 ? parsedRole.nice_to_haves : parsedRole.skills_preferred).map((s) => (
                      <span key={s} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-md border border-slate-200">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Visa / work rights — only show if not already covered by knockout criteria */}
              {parsedRole.visa_flags?.length > 0 && (() => {
                const knockoutText = (parsedRole.knockout_criteria ?? []).join(" ").toLowerCase();
                const extra = parsedRole.visa_flags.filter(
                  (f) => !knockoutText.includes(f.toLowerCase().slice(0, 12))
                );
                return extra.length > 0 ? (
                  <div>
                    <p className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-2">Work Rights</p>
                    <div className="flex flex-wrap gap-1.5">
                      {extra.map((s) => (
                        <span key={s} className="px-2 py-0.5 bg-amber-50 text-amber-800 text-xs rounded-md border border-amber-200">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null;
              })()}

              {/* Synonym titles searched */}
              {parsedRole.synonym_titles?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Titles Searched</p>
                  <div className="flex flex-wrap gap-1.5">
                    {parsedRole.synonym_titles.map((s) => (
                      <span key={s} className="px-2 py-0.5 bg-slate-50 text-slate-500 text-xs rounded-md border border-slate-200 font-mono">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </CardBody>
          </Card>

          {/* Pipeline stats */}
          <Card>
            <CardHeader>
              <h2 className="font-semibold text-slate-900 text-sm">Pipeline</h2>
            </CardHeader>
            <CardBody className="space-y-0.5">
              {/* All */}
              {(["all"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors",
                    filter === s ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"
                  )}
                >
                  <span>All candidates</span>
                  <span className="font-semibold">{job.candidates.length}</span>
                </button>
              ))}

              {/* Active pipeline */}
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wide px-3 pt-2 pb-0.5">Pipeline</p>
              {(["new", "reviewing", "shortlisted", "contacted", "interviewing", "offer_sent"] as const).map((s) => {
                const count = job.candidates.filter((c) => c.status === s).length;
                if (count === 0 && !["new", "reviewing", "shortlisted"].includes(s)) return null;
                return (
                  <button
                    key={s}
                    onClick={() => setFilter(s)}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors",
                      filter === s ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    <span>{statusLabel(s)}</span>
                    <span className={cn("font-semibold text-xs", count > 0 ? "" : "text-slate-300")}>{count}</span>
                  </button>
                );
              })}

              {/* Closed */}
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wide px-3 pt-2 pb-0.5">Closed</p>
              {(["hired", "declined", "rejected"] as const).map((s) => {
                const count = job.candidates.filter((c) => c.status === s).length;
                return (
                  <button
                    key={s}
                    onClick={() => setFilter(s)}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors",
                      filter === s ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    <span>{statusLabel(s)}</span>
                    <span className={cn("font-semibold text-xs", count > 0 ? "" : "text-slate-300")}>{count}</span>
                  </button>
                );
              })}
            </CardBody>
          </Card>
        </div>
      )}

      {/* Step 2: LinkedIn Search */}
      {parsedRole && (
        <Card className="mb-6">
          <CardBody>
            {hasSerpApi === false ? (
              /* No search sources configured */
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Key className="w-5 h-5 text-slate-500" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-slate-900 text-sm">Enable Candidate Search</p>
                  <p className="text-xs text-slate-500 mt-1 mb-3">
                    Add one or more of the keys below to <code className="bg-slate-100 px-1 rounded">.env.local</code>, then restart the server. Each source adds more coverage and accuracy.
                  </p>
                  <div className="space-y-3">
                    {[
                      {
                        label: "SerpAPI", required: true, env: "SERPAPI_API_KEY",
                        desc: "Searches Google for LinkedIn profiles. 100 searches/month free.",
                        url: "https://serpapi.com",
                      },
                      {
                        label: "Bing Web Search", required: false, env: "BING_API_KEY",
                        desc: "Second search index — finds different profiles than Google. $5/1000 searches via Azure.",
                        url: "https://portal.azure.com",
                      },
                    ].map(({ label, required, env, desc, url }) => (
                      <div key={env} className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                        <div>
                          <div className="flex items-center gap-2 mb-0.5">
                            <p className="text-xs font-semibold text-slate-800">{label}</p>
                            {required
                              ? <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">Required</span>
                              : <span className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">Optional</span>
                            }
                          </div>
                          <p className="text-xs text-slate-500 mb-1">{desc}</p>
                          <div className="flex items-center gap-2">
                            <code className="text-xs bg-slate-900 text-emerald-400 px-2 py-0.5 rounded font-mono">{env}=your-key</code>
                            <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5">
                              Get key <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              /* Search sources ready */
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
                      searching ? "bg-blue-50" : "bg-emerald-50"
                    )}>
                      {searching
                        ? <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                        : <Search className="w-5 h-5 text-emerald-600" />
                      }
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <p className="font-semibold text-slate-900 text-sm">
                          {searching ? "Searching LinkedIn..." : "Step 2 — Find Candidates on LinkedIn"}
                        </p>
                        {sources && (
                          <div className="flex items-center gap-1">
                            {[
                              { key: "serpapi", label: "Google" },
                              { key: "bing",    label: "Bing" },
                              { key: "pdl",     label: "PDL" },
                            ].map(({ key, label }) => (
                              <span
                                key={key}
                                className={cn(
                                  "text-xs px-1.5 py-0.5 rounded font-medium border",
                                  (sources as Record<string, boolean>)[key]
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : "bg-slate-50 text-slate-400 border-slate-200"
                                )}
                                title={
                                  (sources as Record<string, boolean>)[key]
                                    ? `${label} configured`
                                    : `${label} not configured — add API key to .env.local`
                                }
                              >
                                {label}
                              </span>
                            ))}
                            {claudeStatus && (
                              <span
                                className={cn(
                                  "text-xs px-1.5 py-0.5 rounded font-medium border",
                                  claudeStatus === "ok"
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : claudeStatus === "unconfigured"
                                    ? "bg-slate-50 text-slate-400 border-slate-200"
                                    : "bg-red-50 text-red-600 border-red-200"
                                )}
                                title={
                                  claudeStatus === "ok"       ? "Claude API connected" :
                                  claudeStatus === "invalid"  ? "Claude API key invalid" :
                                  claudeStatus === "error"    ? "Claude API unreachable" :
                                  "Claude not configured"
                                }
                              >
                                Claude
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">
                        {searching
                          ? "Searching profiles and scoring matches. This takes 1–2 minutes."
                          : "Searches across all configured sources, fetches full profiles, and scores each match against the role."
                        }
                      </p>
                      {searchResult && (
                        <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          {searchResult.count > 0
                            ? `Found and imported ${searchResult.count} candidates — scroll down to see them`
                            : (searchResult.message ?? "No new candidates found. Try re-analysing with a broader job description.")
                          }
                        </p>
                      )}
                      {searchError && (
                        <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          {searchError}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    onClick={handleSearch}
                    loading={searching}
                    disabled={searching || job.status === "closed"}
                    size="lg"
                    className="flex-shrink-0"
                  >
                    <Search className="w-4 h-4" />
                    {searching ? "Searching..." : searchResult ? "Search Again" : "Search LinkedIn Now"}
                  </Button>
                </div>

                {/* Search controls */}
                {(() => {
                  const coords = parsedRole.location ? getCityCoords(parsedRole.location) : null;
                  const nearbyNames = coords ? getCityNamesWithinRadius(coords.lat, coords.lng, radiusKm) : [];
                  const cityName = nearbyNames[0] ?? parsedRole.location ?? "Unknown";
                  return (
                    <div className="space-y-3 pt-1 border-t border-slate-100">
                      <div className="flex items-center gap-4 flex-wrap">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-slate-500 whitespace-nowrap">Max candidates</label>
                          <select
                            value={maxResults}
                            onChange={(e) => setMaxResults(Number(e.target.value))}
                            disabled={searching}
                            className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                          >
                            {[10, 20, 30, 50, 75, 100].map((n) => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-slate-500 whitespace-nowrap">Min. match score</label>
                          <select
                            value={minScore}
                            onChange={(e) => setMinScore(Number(e.target.value))}
                            disabled={searching}
                            className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                          >
                            {[0, 50, 60, 70, 80, 90].map((n) => (
                              <option key={n} value={n}>{n === 0 ? "No filter" : `${n}%`}</option>
                            ))}
                          </select>
                        </div>
                        {coords && !locationLocked && (
                          <button
                            onClick={() => setShowMap((v) => !v)}
                            className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1 font-medium"
                          >
                            <MapPin className="w-3 h-3" />
                            {showMap ? "Hide map" : "Set search area"}
                          </button>
                        )}
                      </div>

                      {/* Locked location banner */}
                      {locationLocked && coords && (
                        <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl">
                          <div className="flex items-center gap-2.5">
                            <Lock className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                            <div>
                              <p className="text-xs font-semibold text-emerald-800">
                                {cityName} · {radiusKm} km radius
                              </p>
                              {nearbyNames.length > 1 && (
                                <p className="text-xs text-emerald-600 mt-0.5">
                                  {nearbyNames.join(", ")}
                                </p>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => { setLocationLocked(false); setShowMap(true); }}
                            disabled={searching}
                            className="text-xs text-emerald-700 hover:text-emerald-900 flex items-center gap-1 font-medium whitespace-nowrap disabled:opacity-50"
                          >
                            <LockOpen className="w-3 h-3" />
                            Edit
                          </button>
                        </div>
                      )}

                      {/* Radius map */}
                      {showMap && !locationLocked && coords && (
                        <div className="space-y-2">
                          <div className="overflow-hidden rounded-xl border border-slate-200">
                            <LocationRadiusMap
                              lat={customCenter?.lat ?? coords.lat}
                              lng={customCenter?.lng ?? coords.lng}
                              radiusKm={radiusKm}
                              onCenterChange={(lat, lng) => setCustomCenter({ lat, lng })}
                            />
                          </div>
                          {customCenter && (
                            <button
                              onClick={() => setCustomCenter(null)}
                              className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
                            >
                              <X className="w-3 h-3" /> Reset to {parsedRole?.location || "default"}
                            </button>
                          )}
                          <div className="flex items-center gap-3">
                            <MapPin className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                            <input
                              type="range"
                              min={5}
                              max={150}
                              step={5}
                              value={radiusKm}
                              onChange={(e) => setRadiusKm(Number(e.target.value))}
                              disabled={searching}
                              className="flex-1 accent-blue-500"
                            />
                            <span className="text-xs font-semibold text-slate-700 w-14 text-right">
                              {radiusKm} km
                            </span>
                          </div>
                          {nearbyNames.length > 0 && (
                            <p className="text-xs text-slate-500">
                              <span className="font-medium text-slate-700">Searching within: </span>
                              {nearbyNames.join(", ")}
                            </p>
                          )}
                          <div className="flex justify-end">
                            <button
                              onClick={() => { setLocationLocked(true); setShowMap(false); }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg transition-colors"
                            >
                              <Lock className="w-3 h-3" />
                              Lock location
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Candidates */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            {filteredCandidates.length > 0 && (
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-slate-300 text-blue-600 cursor-pointer"
                checked={filteredCandidates.length > 0 && filteredCandidates.every((c) => selectedIds.has(c.id))}
                onChange={(e) => {
                  if (e.target.checked) setSelectedIds(new Set(filteredCandidates.map((c) => c.id)));
                  else setSelectedIds(new Set());
                }}
                title="Select all"
              />
            )}
            <h2 className="font-semibold text-slate-900">
              Candidates
              {filteredCandidates.length > 0 && (
                <span className="ml-2 text-sm font-normal text-slate-500">
                  ({filteredCandidates.length})
                </span>
              )}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 ? (
              <>
                <span className="text-xs text-slate-500">{selectedIds.size} selected</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBulkDelete}
                  loading={bulkDeleting}
                  disabled={bulkDeleting}
                  className="text-red-600 border-red-200 hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {bulkDeleting ? "Deleting…" : `Delete ${selectedIds.size}`}
                </Button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                {filter !== "all" && (
                  <button
                    onClick={() => setFilter("all")}
                    className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                  >
                    <X className="w-3 h-3" />
                    Clear filter
                  </button>
                )}
                {parsedRole && job.candidates.some((c) => c.profileText) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRescoreAll}
                    loading={rescoringAll}
                    disabled={rescoringAll}
                    title="Re-score all candidates with current job requirements"
                  >
                    {!rescoringAll && <Sparkles className="w-3.5 h-3.5" />}
                    {rescoringAll ? "Scoring…" : "Re-score all"}
                  </Button>
                )}
                {filteredCandidates.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleExportCsv}
                    title="Download candidates as CSV"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export CSV
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setShowAddCandidate(true)}>
                  <UserPlus className="w-3.5 h-3.5" />
                  Add manually
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Keyword search */}
        {job.candidates.length > 0 && (
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, role, location, or notes…"
              className="w-full pl-8 pr-8 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-700 placeholder:text-slate-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Re-score result */}
        {rescoreResult && !rescoringAll && (
          <div className="mb-3 flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
            Re-scored {rescoreResult.scored} of {rescoreResult.total} candidates
          </div>
        )}

        {filteredCandidates.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border border-slate-200 border-dashed">
            <Users className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 text-sm font-medium">
              {filter === "all" ? "No candidates yet" : `No ${statusLabel(filter).toLowerCase()} candidates`}
            </p>
            {filter === "all" && parsedRole && (
              <p className="text-slate-400 text-xs mt-1">
                {hasSerpApi
                  ? "Click \"Search LinkedIn Now\" above to find candidates automatically"
                  : "Add a SerpAPI key to auto-search, or add candidates manually below"}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredCandidates.map((candidate) => (
              <div key={candidate.id} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-4 w-4 h-4 rounded border-slate-300 text-blue-600 cursor-pointer flex-shrink-0"
                  checked={selectedIds.has(candidate.id)}
                  onChange={() => toggleSelect(candidate.id)}
                />
                <div className="flex-1 min-w-0">
                  <CandidateCard
                    candidate={candidate}
                    jobId={id}
                    onStatusChange={handleStatusChange}
                    onScore={handleScore}
                    onFetchProfile={handleFetchProfile}
                    onNotesChange={handleNotesChange}
                    onDelete={handleDelete}
                    scoring={scoringId === candidate.id}
                    fetchingProfile={fetchingProfileId === candidate.id}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fetch Profile Status Toast */}
      {fetchProfileStatus && (
        <div className="fixed bottom-6 right-6 z-50 w-80 bg-white border border-slate-200 rounded-xl shadow-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              {fetchProfileStatus.state === "fetching" && (
                <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
              )}
              {fetchProfileStatus.state === "waiting" && (
                <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
              )}
              {fetchProfileStatus.state === "done" && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              )}
              {fetchProfileStatus.state === "error" && (
                <AlertCircle className="w-5 h-5 text-red-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-900 truncate">
                {fetchProfileStatus.name}
              </p>
              <p className="text-xs text-slate-500 mt-0.5 leading-snug">
                {fetchProfileStatus.message}
              </p>
              {fetchProfileStatus.state === "waiting" && (
                <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <p className="text-xs font-medium text-amber-800">
                    Click your <strong>Add to RecruitMe</strong> bookmark in the LinkedIn tab, then come back here.
                  </p>
                  <p className="text-xs text-amber-600 mt-1">
                    No bookmark?{" "}
                    <a href="/bookmarklet" target="_blank" className="underline">
                      Set one up
                    </a>
                  </p>
                </div>
              )}
            </div>
            <button
              onClick={() => { setFetchProfileStatus(null); }}
              className="flex-shrink-0 text-slate-400 hover:text-slate-600 mt-0.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Client Report Modal */}
      {showReport && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
              <div>
                <h3 className="font-semibold text-slate-900">Client Report</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  AI-generated recruiter summaries for shortlisted candidates. Copy and paste into an email.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {reportSummaries.length > 0 && (
                  <button
                    onClick={handleCopyAll}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    {copiedAll ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedAll ? "Copied!" : "Copy All"}
                  </button>
                )}
                <button
                  onClick={() => { setShowReport(false); setReportSummaries([]); setReportError(""); }}
                  className="text-slate-400 hover:text-slate-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 px-6 py-5">
              {reportLoading && (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
                  <p className="text-sm text-slate-500">Claude is writing candidate summaries…</p>
                </div>
              )}
              {reportError && !reportLoading && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700">{reportError}</p>
                </div>
              )}
              {reportSummaries.length > 0 && (
                <div className="space-y-5">
                  {reportSummaries.map((s) => (
                    <div key={s.id} className="group relative p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <p className="text-sm font-semibold text-slate-900">{s.name}</p>
                        <button
                          onClick={() => handleCopyParagraph(s.id, s.paragraph)}
                          className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          {copiedId === s.id ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                          {copiedId === s.id ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <p className="text-sm text-slate-700 leading-relaxed">{s.paragraph}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Candidate Modal */}
      {showAddCandidate && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h3 className="font-semibold text-slate-900">Add Candidate</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Paste a LinkedIn URL, upload a CV, or paste profile text directly.
                </p>
              </div>
              <button
                onClick={() => { setShowAddCandidate(false); setAddError(""); setPdfFileName(""); }}
                className="text-slate-400 hover:text-slate-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  LinkedIn URL
                </label>
                <input
                  type="url"
                  value={addForm.linkedinUrl}
                  onChange={(e) => setAddForm((f) => ({ ...f, linkedinUrl: e.target.value }))}
                  placeholder="https://linkedin.com/in/username"
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>

              {/* OR divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-white px-3 text-xs text-slate-400">or add profile text</span>
                </div>
              </div>

              {/* PDF upload */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Upload CV / PDF</label>
                <label className={`flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                  pdfUploading
                    ? "border-blue-300 bg-blue-50"
                    : pdfFileName
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-blue-300 hover:bg-blue-50"
                }`}>
                  <input
                    type="file"
                    accept=".pdf,.txt"
                    className="sr-only"
                    disabled={pdfUploading || adding}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handlePdfUpload(file);
                      e.target.value = "";
                    }}
                  />
                  {pdfUploading ? (
                    <>
                      <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
                      <span className="text-sm text-blue-600">Extracting and cleaning with AI…</span>
                    </>
                  ) : pdfFileName ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      <span className="text-sm text-emerald-700 truncate flex-1">{pdfFileName}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); setPdfFileName(""); setAddForm((f) => ({ ...f, profileText: "" })); }}
                        className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <Paperclip className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      <span className="text-sm text-slate-500">
                        Click to upload <span className="font-medium text-slate-700">PDF or TXT</span>
                      </span>
                    </>
                  )}
                </label>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Or paste text</label>
                <textarea
                  value={addForm.profileText}
                  onChange={(e) => { setAddForm((f) => ({ ...f, profileText: e.target.value })); if (pdfFileName) setPdfFileName(""); }}
                  placeholder="Paste CV or LinkedIn profile text — AI will extract details and score them."
                  className="w-full px-3.5 py-3 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  rows={5}
                />
              </div>

              {!job.parsedRole && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700">
                    Analyse the job description first for automatic scoring to work.
                  </p>
                </div>
              )}

              {addError && <p className="text-sm text-red-600">{addError}</p>}

              <div className="flex gap-3 pt-1">
                <Button
                  variant="secondary"
                  onClick={() => { setShowAddCandidate(false); setAddError(""); }}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button onClick={handleAddCandidate} loading={adding} disabled={adding || pdfUploading} className="flex-1">
                  <Sparkles className="w-4 h-4" />
                  {adding ? "Scoring…" : "Add & Score"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
