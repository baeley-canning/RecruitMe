"use client";

import { useDeferredValue, useEffect, useMemo, useState, useCallback, useRef, use } from "react";
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
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { CandidateCard } from "@/components/candidate-card";
import { AiStatusBanner } from "@/components/ai-status-banner";
import { LocationRadiusMap } from "@/components/location-radius-map";
import { BulkUploadModal } from "@/components/bulk-upload-modal";
import { FetchQueueToast } from "@/components/fetch-queue-toast";
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
  profileCapturedAt: string | null;
  matchScore: number | null;
  matchReason: string | null;
  acceptanceScore: number | null;
  acceptanceReason: string | null;
  scoreBreakdown: string | null;
  notes: string | null;
  screeningData: string | null;
  interviewNotes: string | null;
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

interface ElectronBridge {
  platform?: string;
  openExternal?: (url: string) => Promise<boolean>;
}

function getElectronBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { electron?: ElectronBridge }).electron ?? null;
}

type ParsedRoleSource = ParsedRole["title_source"];

function normalizeParsedRoleSource(value: unknown): ParsedRoleSource {
  return value === "explicit" || value === "inferred" ? value : "";
}

function SourceBadge({ source }: { source?: ParsedRoleSource }) {
  const normalized = normalizeParsedRoleSource(source);
  if (!normalized) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        normalized === "explicit"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-blue-200 bg-blue-50 text-blue-700"
      )}
    >
      {normalized === "explicit" ? "Explicit" : "Inferred"}
    </span>
  );
}

interface HiringBriefChipSectionProps {
  title: string;
  items: string[] | undefined;
  chipClassName: string;
  labelClassName?: string;
  monospace?: boolean;
}

function HiringBriefChipSection({
  title,
  items,
  chipClassName,
  labelClassName,
  monospace = false,
}: HiringBriefChipSectionProps) {
  const cleanItems = (items ?? []).filter(Boolean);
  if (!cleanItems.length) return null;

  return (
    <div>
      <p className={cn("text-xs font-medium uppercase tracking-wide mb-2", labelClassName ?? "text-slate-500")}>
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {cleanItems.map((item) => (
          <span
            key={item}
            className={cn(
              "px-2 py-0.5 text-xs rounded-md border",
              chipClassName,
              monospace && "font-mono"
            )}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
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
  const [searchResult, setSearchResult] = useState<{ count: number; message?: string; fromPool?: number } | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searchingPool, setSearchingPool] = useState(false);
  const [poolResult, setPoolResult] = useState<{ count: number; message?: string } | null>(null);
  const [poolError, setPoolError] = useState("");
  const [hasSerpApi, setHasSerpApi] = useState<boolean | null>(null);
  const [sources, setSources] = useState<{ serpapi: boolean; bing: boolean; pdl: boolean } | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<"ok" | "invalid" | "error" | "unconfigured" | null>(null);
  const [maxResults, setMaxResults] = useState(20);
  const [minScore] = useState(0);
  const [radiusKm, setRadiusKm] = useState(25);
  const [showMap, setShowMap] = useState(false); // eslint-disable-line @typescript-eslint/no-unused-vars
  const [locationLocked, setLocationLocked] = useState(false);
  const [customCenter, setCustomCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [showAddCandidate, setShowAddCandidate] = useState(false);
  const [scoringId, setScoringId] = useState<string | null>(null);
  // Per-candidate fetch status (keyed by candidateId).
  const [fetchStatuses, setFetchStatuses] = useState<Record<string, {
    state: "waiting" | "fetching" | "done" | "error";
    message: string;
  }>>({});
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
  const [bulkStatusChanging, setBulkStatusChanging] = useState(false);

  const [showBulkUpload, setShowBulkUpload] = useState(false);

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

  // Job ad generator modal
  const [showJobAd, setShowJobAd] = useState(false);
  const [jobAdLoading, setJobAdLoading] = useState(false);
  const [jobAdError, setJobAdError] = useState("");
  const [jobAd, setJobAd] = useState<{ headline: string; body: string } | null>(null);
  const [jobAdCopied, setJobAdCopied] = useState(false);

  // Per-candidate fetch tracking.
  interface FetchEntry {
    sessionId: string;
    candidateId: string;
    tab: Window | null;
    startedAt: number;
    done: boolean;
    pollInterval: ReturnType<typeof setInterval> | null;
  }
  const jobRef = useRef<Job | null>(null);
  const activeFetchesRef = useRef<Map<string, FetchEntry>>(new Map());
  // Stable fn-refs so setInterval callbacks always call the latest version.
  const pollCandidateFetchRef = useRef<(candidateId: string) => Promise<void>>(async () => {});
  const finishFetchRef = useRef<(candidateId: string, state: "done" | "error", message: string) => void>(() => {});
  const mapAutoOpenedRef = useRef(false);

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

  // Keep jobRef in sync so poll callbacks can read the latest job without stale closures.
  useEffect(() => { jobRef.current = job; }, [job]);

  useEffect(() => {
    return () => {
      // Clean up all active sessions and poll intervals on unmount.
      for (const entry of activeFetchesRef.current.values()) {
        if (entry.pollInterval) clearInterval(entry.pollInterval);
        void fetch(`/api/extension/fetch-session?sessionId=${encodeURIComponent(entry.sessionId)}`, {
          method: "DELETE",
        }).catch(() => {});
      }
      activeFetchesRef.current.clear();
    };
  }, []);

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

  // Auto-open the map the first time a job location with known coords loads.
  useEffect(() => {
    if (!job || mapAutoOpenedRef.current) return;
    const pr = safeParseJson<ParsedRole | null>(job.parsedRole, null);
    if (pr?.location && getCityCoords(pr.location)) {
      setShowMap(true);
      mapAutoOpenedRef.current = true;
    }
  }, [job]);

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
        body: JSON.stringify({
          maxResults,
          minScore,
          radiusKm,
          ...(customCenter ? { centerLat: customCenter.lat, centerLng: customCenter.lng } : {}),
        }),
      });
      const data = await res.json() as { count?: number; candidates?: Candidate[]; error?: string; message?: string; fromPool?: number };
      if (!res.ok || data.error) {
        setSearchError(data.error ?? "Search failed");
      } else {
        setSearchResult({ count: data.count ?? 0, message: data.message, fromPool: data.fromPool });
        await fetchJob();
      }
    } catch {
      setSearchError("Search failed. Check your connection.");
    } finally {
      setSearching(false);
    }
  };

  const handleSearchPool = async () => {
    setSearchingPool(true);
    setPoolError("");
    setPoolResult(null);
    try {
      const res = await fetch(`/api/jobs/${id}/candidates/talent-pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minScore,
          maxResults,
          radiusKm,
          ...(customCenter ? { centerLat: customCenter.lat, centerLng: customCenter.lng } : {}),
        }),
      });
      const data = await res.json() as { count?: number; candidates?: Candidate[]; error?: string; message?: string };
      if (!res.ok || data.error) {
        setPoolError(data.error ?? "Talent pool search failed");
      } else {
        setPoolResult({ count: data.count ?? 0, message: data.message });
        await fetchJob();
      }
    } catch {
      setPoolError("Talent pool search failed. Check your connection.");
    } finally {
      setSearchingPool(false);
    }
  };

  const handleScore = useCallback(async (candidateId: string) => {
    setScoringId(candidateId);
    try {
      const res = await fetch(`/api/jobs/${id}/candidates/${candidateId}/score`, { method: "POST" });
      if (res.ok) await fetchJob();
    } finally {
      setScoringId(null);
    }
  }, [fetchJob, id]);

  const clearCandidateStatus = (candidateId: string, delay: number, expectedState?: string) =>
    setTimeout(() => {
      setFetchStatuses((prev) => {
        if (expectedState && prev[candidateId]?.state !== expectedState) return prev;
        const next = { ...prev };
        delete next[candidateId];
        return next;
      });
    }, delay);

  // ---------------------------------------------------------------------------
  // Fetch helpers — fn-refs so setInterval callbacks always call latest version.
  // ---------------------------------------------------------------------------

  const finishFetch = (candidateId: string, state: "done" | "error", message: string) => {
    const entry = activeFetchesRef.current.get(candidateId);
    if (!entry || entry.done) return;
    entry.done = true;
    if (entry.pollInterval) clearInterval(entry.pollInterval);
    activeFetchesRef.current.delete(candidateId);
    void fetch(`/api/extension/fetch-session?sessionId=${encodeURIComponent(entry.sessionId)}`, {
      method: "DELETE",
    }).catch(() => {});
    setFetchStatuses((prev) => ({ ...prev, [candidateId]: { state, message } }));
    clearCandidateStatus(candidateId, state === "done" ? 4000 : 6000, state);
  };

  const pollCandidateFetch = async (candidateId: string) => {
    const entry = activeFetchesRef.current.get(candidateId);
    if (!entry || entry.done) return;
    if (Date.now() - entry.startedAt > 90_000) {
      finishFetchRef.current(
        candidateId,
        "error",
        "Capture timed out - try again. If it keeps failing, reload the Opera extension and check the extension popup for the real error."
      );
      return;
    }
    try {
      const res = await fetch(
        `/api/extension/fetch-session?sessionId=${encodeURIComponent(entry.sessionId)}`
      );
      if (!res.ok) {
        if (res.status === 404) {
          finishFetchRef.current(
            candidateId,
            "error",
            "Capture session expired before completion - try Fetch Profile again"
          );
          return;
        }
        if (res.status === 401) {
          finishFetchRef.current(
            candidateId,
            "error",
            "RecruitMe session expired - sign back in and try again"
          );
        }
        return;
      }
      const data = (await res.json()) as {
        status: "pending" | "processing" | "completed" | "error";
        message?: string;
        candidate?: Candidate;
        error?: string;
      };
      if (data.status === "processing") {
        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: { state: "fetching", message: data.message ?? "Scoring with AI..." },
        }));
        return;
      }
      if (data.status === "completed" && data.candidate) {
        setJob((prev) =>
          prev
            ? { ...prev, candidates: prev.candidates.map((c) => c.id === candidateId ? data.candidate as Candidate : c) }
            : prev
        );
        finishFetchRef.current(candidateId, "done", data.message ?? "Profile captured and scored");
        return;
      }
      if (data.status === "error") {
        finishFetchRef.current(candidateId, "error", data.error ?? data.message ?? "Capture failed");
        return;
      }
    } catch { /* network error — keep polling */ }
  };

  // Keep fn-refs current every render.
  pollCandidateFetchRef.current = pollCandidateFetch;
  finishFetchRef.current = finishFetch;

  // Must NOT be async — window.open is blocked after an await.
  const handleFetchProfile = useCallback((candidateId: string) => {
    const candidate = job?.candidates.find((c) => c.id === candidateId);
    if (!candidate?.linkedinUrl) return;
    if (activeFetchesRef.current.has(candidateId)) return;

    const electron = getElectronBridge();
    const useExternalBrowser = typeof electron?.openExternal === "function";
    const isOperaBrowser = typeof navigator !== "undefined" && /\bOPR\//.test(navigator.userAgent);
    if (!useExternalBrowser && !isOperaBrowser) {
      setFetchStatuses((prev) => ({
        ...prev,
        [candidateId]: {
          state: "error",
          message: "Open RecruitMe in Opera or use the desktop app - the browser build cannot force LinkedIn to open in Opera.",
        },
      }));
      clearCandidateStatus(candidateId, 7000, "error");
      return;
    }
    const tab = useExternalBrowser ? null : window.open("about:blank", `_rm-fetch-${candidateId}`);
    if (!useExternalBrowser && !tab) {
      setFetchStatuses((prev) => ({
        ...prev,
        [candidateId]: { state: "error", message: "Popup blocked - allow popups for this site and try again" },
      }));
      clearCandidateStatus(candidateId, 6000, "error");
      return;
    }

    setFetchStatuses((prev) => ({
      ...prev,
      [candidateId]: { state: "waiting", message: "Queueing LinkedIn capture..." },
    }));

    void (async () => {
      try {
        const start = await fetch("/api/extension/fetch-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: id, candidateId }),
        });
        const session = (await start.json()) as { sessionId?: string; error?: string };

        if (!start.ok || !session.sessionId) {
          try { tab?.close(); } catch { /* ignore */ }
          setFetchStatuses((prev) => ({
            ...prev,
            [candidateId]: { state: "error", message: session.error ?? "Could not start capture" },
          }));
          clearCandidateStatus(candidateId, 6000, "error");
          return;
        }

        if (useExternalBrowser) {
          const opened = await electron?.openExternal?.(candidate.linkedinUrl!);
          if (!opened) {
            await fetch(`/api/extension/fetch-session?sessionId=${encodeURIComponent(session.sessionId)}`, {
              method: "DELETE",
            }).catch(() => {});
            setFetchStatuses((prev) => ({
              ...prev,
              [candidateId]: { state: "error", message: "Opera not found — install Opera and the RecruitMe extension (see LinkedIn Setup)" },
            }));
            clearCandidateStatus(candidateId, 6000, "error");
            return;
          }
        } else if (tab && !tab.closed) {
          tab.location.href = candidate.linkedinUrl!;
        }

        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: {
            state: "waiting",
            message: useExternalBrowser
              ? "Queued - waiting for Opera extension to open and capture the LinkedIn profile..."
              : "LinkedIn tab requested - waiting for the extension to confirm capture...",
          },
        }));

        const entry: FetchEntry = {
          sessionId: session.sessionId,
          candidateId,
          tab,
          startedAt: Date.now(),
          done: false,
          pollInterval: null,
        };
        activeFetchesRef.current.set(candidateId, entry);
        entry.pollInterval = setInterval(() => {
          void pollCandidateFetchRef.current(candidateId);
        }, 1000);
      } catch {
        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: { state: "error", message: "Network error starting capture" },
        }));
        clearCandidateStatus(candidateId, 6000, "error");
      }
    })();
  }, [id, job]);

  const handleStatusChange = useCallback(async (candidateId: string, status: string) => {
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await fetchJob();
  }, [fetchJob, id]);

  const handleNotesChange = useCallback(async (candidateId: string, notes: string) => {
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    await fetchJob();
  }, [fetchJob, id]);

  const handleLinkedInChange = useCallback(async (candidateId: string, linkedinUrl: string) => {
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkedinUrl: linkedinUrl || null }),
    });
    await fetchJob();
  }, [fetchJob, id]);

  const handleScreeningDataChange = useCallback((_candidateId: string, data: string) => {
    setJob((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        candidates: prev.candidates.map((c) =>
          c.id === _candidateId ? { ...c, screeningData: data } : c
        ),
      };
    });
  }, []);

  const handleInterviewNotesChange = useCallback((_candidateId: string, notes: string) => {
    setJob((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        candidates: prev.candidates.map((c) =>
          c.id === _candidateId ? { ...c, interviewNotes: notes } : c
        ),
      };
    });
  }, []);

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

  const handleDelete = useCallback(async (candidateId: string) => {
    if (!confirm("Remove this candidate?")) return;
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, { method: "DELETE" });
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(candidateId); return next; });
    await fetchJob();
  }, [fetchJob, id]);

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

  const handleBulkStatusChange = async (status: string) => {
    if (selectedIds.size === 0) return;
    setBulkStatusChanging(true);
    await Promise.allSettled(
      [...selectedIds].map((candidateId) =>
        fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        })
      )
    );
    setSelectedIds(new Set());
    setBulkStatusChanging(false);
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

  const handleGenerateJobAd = async (force = false) => {
    setShowJobAd(true);
    if (jobAd && !force) return;
    setJobAd(null);
    setJobAdLoading(true);
    setJobAdError("");
    try {
      const res = await fetch(`/api/jobs/${id}/generate-ad`, { method: "POST" });
      const data = await res.json() as { headline?: string; body?: string; error?: string };
      if (!res.ok || data.error) {
        setJobAdError(data.error ?? "Failed to generate job ad");
      } else {
        setJobAd({ headline: data.headline ?? "", body: data.body ?? "" });
      }
    } catch {
      setJobAdError("Network error. Try again.");
    } finally {
      setJobAdLoading(false);
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
      // URL-only: open LinkedIn so the Opera extension can capture it
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


  const deferredSearchQuery = useDeferredValue(searchQuery);
  const jobCandidates = job?.candidates ?? [];
  const parsedRole = useMemo(
    () => safeParseJson<ParsedRole | null>(job?.parsedRole ?? null, null),
    [job?.parsedRole]
  );
  const senioritySource = parsedRole ? normalizeParsedRoleSource(parsedRole.seniority_source) : "";
  const locationSource = parsedRole
    ? normalizeParsedRoleSource(parsedRole.location_rules_source || parsedRole.location_source)
    : "";
  const salarySource: ParsedRoleSource =
    job?.salaryMin || job?.salaryMax
      ? "explicit"
      : parsedRole
        ? normalizeParsedRoleSource(parsedRole.salary_source)
        : "";
  const mustHaves = parsedRole?.must_haves?.length
    ? parsedRole.must_haves
    : (parsedRole?.skills_required ?? []);
  const niceToHaves = parsedRole?.nice_to_haves?.length
    ? parsedRole.nice_to_haves
    : (parsedRole?.skills_preferred ?? []);
  const jobCoords = useMemo(
    () => (parsedRole?.location ? getCityCoords(parsedRole.location) : null),
    [parsedRole?.location]
  );
  const requiresLocationLock = !!jobCoords && !locationLocked;
  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const filteredCandidates = useMemo(() => {
    return [...jobCandidates]
      .filter((candidate) => (filter === "all" ? true : candidate.status === filter))
      .filter((candidate) => {
        if (!normalizedSearchQuery) return true;
        return (
          candidate.name.toLowerCase().includes(normalizedSearchQuery) ||
          (candidate.headline ?? "").toLowerCase().includes(normalizedSearchQuery) ||
          (candidate.location ?? "").toLowerCase().includes(normalizedSearchQuery) ||
          (candidate.notes ?? "").toLowerCase().includes(normalizedSearchQuery)
        );
      })
      .sort((a, b) => {
        const scoreDiff = (b.matchScore ?? -1) - (a.matchScore ?? -1);
        if (scoreDiff !== 0) return scoreDiff;
        return (b.acceptanceScore ?? -1) - (a.acceptanceScore ?? -1);
      });
  }, [filter, jobCandidates, normalizedSearchQuery]);
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: jobCandidates.length };
    for (const candidate of jobCandidates) {
      counts[candidate.status] = (counts[candidate.status] ?? 0) + 1;
    }
    return counts;
  }, [jobCandidates]);
  const shortlistCount = statusCounts.shortlisted ?? 0;

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


      // Tiebreaker: acceptance score descending — "likely open" ranks above "may consider"


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
          <Button variant="outline" onClick={() => setShowBulkUpload(true)}>
            <Upload className="w-4 h-4" />
            Upload CVs
          </Button>
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
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleParse}
                    disabled={parsing}
                    className="text-xs text-slate-400 hover:text-blue-600 transition-colors flex items-center gap-1"
                  >
                    {parsing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    Re-analyse
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardBody className="space-y-4">

              {/* Meta row — seniority, location, salary */}
              <div className="grid grid-cols-3 gap-3">
                {parsedRole.seniority_band && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Seniority</p>
                      <SourceBadge source={senioritySource} />
                    </div>
                    <p className="text-sm text-slate-800">{parsedRole.seniority_band}</p>
                  </div>
                )}
                {(parsedRole.location_rules || parsedRole.location) && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Location / Remote</p>
                      <SourceBadge source={locationSource} />
                    </div>
                    <p className="text-sm text-slate-800">{parsedRole.location_rules || parsedRole.location}</p>
                  </div>
                )}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Salary (NZD)</p>
                      <SourceBadge source={salarySource} />
                    </div>
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

              <HiringBriefChipSection
                title="Explicitly Stated"
                items={parsedRole.explicitly_stated}
                labelClassName="text-emerald-700"
                chipClassName="bg-emerald-50 text-emerald-700 border-emerald-200"
              />

              <HiringBriefChipSection
                title="Strongly Inferred"
                items={parsedRole.strongly_inferred}
                labelClassName="text-blue-700"
                chipClassName="bg-blue-50 text-blue-700 border-blue-200"
              />

              {/* Knockout criteria */}
              <HiringBriefChipSection
                title="Knockout Criteria"
                items={parsedRole.knockout_criteria}
                labelClassName="text-red-600"
                chipClassName="bg-red-50 text-red-700 border-red-200 font-medium"
              />

              {/* Must-haves — fall back to skills_required for old jobs */}
              <HiringBriefChipSection
                title="Must-haves"
                items={mustHaves}
                chipClassName="bg-violet-50 text-violet-700 border-violet-100 font-medium"
              />

              {/* Nice-to-haves — fall back to skills_preferred */}
              <HiringBriefChipSection
                title="Nice-to-haves"
                items={niceToHaves}
                chipClassName="bg-slate-100 text-slate-600 border-slate-200"
              />

              {/* Visa / work rights — only show if not already covered by knockout criteria */}
              <HiringBriefChipSection
                title="Application / Screening"
                items={parsedRole.application_requirements}
                labelClassName="text-amber-700"
                chipClassName="bg-amber-50 text-amber-800 border-amber-200"
              />

              {parsedRole.visa_flags?.length > 0 && (() => {
                const knockoutText = (parsedRole.knockout_criteria ?? []).join(" ").toLowerCase();
                const extra = parsedRole.visa_flags.filter(
                  (f) => !knockoutText.includes(f.toLowerCase().slice(0, 12))
                );
                return (
                  <HiringBriefChipSection
                    title="Work Rights"
                    items={extra}
                    labelClassName="text-amber-700"
                    chipClassName="bg-amber-50 text-amber-800 border-amber-200"
                  />
                );
              })()}

              <HiringBriefChipSection
                title="Search Expansion"
                items={parsedRole.search_expansion}
                labelClassName="text-slate-600"
                chipClassName="bg-slate-50 text-slate-600 border-slate-200"
              />

              {/* Synonym titles searched */}
              <HiringBriefChipSection
                title="Titles Searched"
                items={parsedRole.synonym_titles}
                chipClassName="bg-slate-50 text-slate-500 border-slate-200"
                monospace
              />

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
                  <span className="font-semibold">{jobCandidates.length}</span>
                </button>
              ))}

              {/* Active pipeline */}
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wide px-3 pt-2 pb-0.5">Pipeline</p>
              {(["new", "reviewing", "shortlisted", "contacted", "interviewing", "offer_sent"] as const).map((s) => {
                const count = statusCounts[s] ?? 0;
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
                const count = statusCounts[s] ?? 0;
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
                              { key: "serpapi", label: "SerpAPI" },
                              { key: "claude",  label: "Claude" },
                            ].map(({ key, label }) => {
                              const isOk = key === "claude"
                                ? claudeStatus === "ok"
                                : (sources as Record<string, boolean>)[key];
                              const isError = key === "claude" && (claudeStatus === "invalid" || claudeStatus === "error");
                              return (
                                <span
                                  key={key}
                                  className={cn(
                                    "text-xs px-1.5 py-0.5 rounded font-medium border",
                                    isOk    ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                    isError ? "bg-red-50 text-red-600 border-red-200" :
                                              "bg-slate-50 text-slate-400 border-slate-200"
                                  )}
                                  title={
                                    key === "claude"
                                      ? claudeStatus === "ok"          ? "Claude API connected"
                                        : claudeStatus === "invalid"   ? "Claude API key invalid"
                                        : claudeStatus === "error"     ? "Claude API unreachable"
                                        : "Claude not configured"
                                      : isOk
                                        ? `${label} configured`
                                        : `${label} not configured — add API key to .env.local`
                                  }
                                >
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">
                        {searching
                          ? "Searching LinkedIn and importing provisional matches. Full scoring happens after profile capture."
                          : "Searches configured sources, imports likely LinkedIn profiles, and uses full scoring for captured profiles."
                        }
                      </p>
                      {searchResult && (
                        <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          {searchResult.count > 0
                            ? searchResult.fromPool && searchResult.fromPool > 0
                              ? `Found ${searchResult.count} candidates — ${searchResult.fromPool} from talent pool, ${searchResult.count - searchResult.fromPool} from LinkedIn`
                              : `Found and imported ${searchResult.count} candidates — scroll down to see them`
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
                      {poolResult && (
                        <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          {poolResult.count > 0
                            ? `Added ${poolResult.count} candidate${poolResult.count !== 1 ? "s" : ""} from talent pool — scroll down to see them`
                            : (poolResult.message ?? "No talent pool candidates matched this role.")
                          }
                        </p>
                      )}
                      {poolError && (
                        <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          {poolError}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 flex-shrink-0 items-end">
                    <Button
                      onClick={handleSearch}
                      loading={searching}
                      disabled={searching || searchingPool || job.status === "closed" || requiresLocationLock}
                      size="lg"
                      title={requiresLocationLock ? "Lock your search area on the map below before searching" : undefined}
                    >
                      <Search className="w-4 h-4" />
                      {searching ? "Searching..." : searchResult ? "Search Again" : "Search LinkedIn Now"}
                    </Button>
                    <Button
                      onClick={handleSearchPool}
                      loading={searchingPool}
                      disabled={searching || searchingPool || job.status === "closed" || requiresLocationLock}
                      size="sm"
                      variant="outline"
                      className="text-slate-600"
                      title={requiresLocationLock ? "Lock your search area on the map below before searching" : undefined}
                    >
                      <Users className="w-3.5 h-3.5" />
                      {searchingPool ? "Searching pool..." : "Search Talent Pool"}
                    </Button>
                    {requiresLocationLock && (
                      <p className="text-xs text-amber-600 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Lock the search area below first
                      </p>
                    )}
                  </div>
                </div>

                {/* Search controls */}
                {(() => {
                  const center = customCenter ?? (jobCoords ? { lat: jobCoords.lat, lng: jobCoords.lng } : null);
                  const nearbyNames = center ? getCityNamesWithinRadius(center.lat, center.lng, radiusKm) : [];
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
                      </div>

                      {/* Locked location banner */}
                      {locationLocked && jobCoords && (
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

                      {/* Radius map — always visible until location is locked */}
                      {!locationLocked && jobCoords && (
                        <div className="space-y-2">
                          <div className="overflow-hidden rounded-xl border border-slate-200">
                            <LocationRadiusMap
                              lat={customCenter?.lat ?? jobCoords.lat}
                              lng={customCenter?.lng ?? jobCoords.lng}
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
                <span className="text-xs font-medium text-slate-600">{selectedIds.size} selected</span>
                <select
                  onChange={(e) => { if (e.target.value) handleBulkStatusChange(e.target.value); e.target.value = ""; }}
                  disabled={bulkStatusChanging}
                  defaultValue=""
                  className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                >
                  <option value="" disabled>Move to…</option>
                  <option value="reviewing">Reviewing</option>
                  <option value="shortlisted">Shortlisted</option>
                  <option value="contacted">Contacted</option>
                  <option value="interviewing">Interviewing</option>
                  <option value="offer_sent">Offer sent</option>
                  <option value="hired">Hired</option>
                  <option value="rejected">Rejected</option>
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBulkDelete}
                  loading={bulkDeleting}
                  disabled={bulkDeleting || bulkStatusChanging}
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

        {/* Needs-profile notice — computed from live candidate list */}
        {(() => {
          const needsFetch = job.candidates.filter(
            (c) => c.linkedinUrl && !c.profileCapturedAt && (!c.profileText || c.profileText.length < 500)
          );
          const n = needsFetch.length;
          if (n === 0) return null;
          const scrollToFirst = () => {
            const sorted = [...needsFetch].sort((a, b) =>
              (a.name.split(" ")[0] ?? a.name).localeCompare(b.name.split(" ")[0] ?? b.name)
            );
            const target = document.getElementById(`candidate-${sorted[0].id}`);
            target?.scrollIntoView({ behavior: "smooth", block: "center" });
          };
          return (
            <button
              type="button"
              onClick={scrollToFirst}
              className="mb-3 w-full flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 hover:bg-amber-100 transition-colors text-left"
            >
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {n} candidate{n > 1 ? "s" : ""} {n > 1 ? "need" : "needs"} a full profile fetch — look for the amber <strong className="mx-0.5">Fetch profile</strong> button on each card.
            </button>
          );
        })()}

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
              <div key={candidate.id} id={`candidate-${candidate.id}`} className="flex items-start gap-3">
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
                    onLinkedInChange={handleLinkedInChange}
                    onScreeningDataChange={handleScreeningDataChange}
                    onInterviewNotesChange={handleInterviewNotesChange}
                    onDelete={handleDelete}
                    scoring={scoringId === candidate.id}
                    fetchingProfile={fetchStatuses[candidate.id] !== undefined}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <FetchQueueToast
        statuses={fetchStatuses}
        candidateNames={Object.fromEntries((job?.candidates ?? []).map((c) => [c.id, c.name]))}
        onDismiss={() => setFetchStatuses({})}
      />

      {/* Client Report Modal */}
      {showReport && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
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

      {/* Job Ad Generator Modal */}
      {showJobAd && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
              <div>
                <h3 className="font-semibold text-slate-900">Generated Job Ad</h3>
                <p className="text-xs text-slate-500 mt-0.5">AI-written advertisement based on parsed role requirements.</p>
              </div>
              <div className="flex items-center gap-2">
                {jobAd && (
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(`${jobAd.headline}\n\n${jobAd.body}`).then(() => {
                        setJobAdCopied(true);
                        setTimeout(() => setJobAdCopied(false), 2000);
                      });
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    {jobAdCopied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {jobAdCopied ? "Copied!" : "Copy All"}
                  </button>
                )}
                <button
                  onClick={() => { setShowJobAd(false); setJobAdError(""); }}
                  className="text-slate-400 hover:text-slate-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
              {jobAdLoading && (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                  <p className="text-sm text-slate-500">Writing your job ad…</p>
                </div>
              )}
              {jobAdError && !jobAdLoading && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700">{jobAdError}</p>
                </div>
              )}
              {jobAd && !jobAdLoading && (
                <>
                  <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
                    <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">Headline</p>
                    <p className="font-bold text-slate-900 text-lg leading-snug">{jobAd.headline}</p>
                  </div>
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Body</p>
                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{jobAd.body}</p>
                  </div>
                  <button
                    onClick={() => handleGenerateJobAd(true)}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Regenerate
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showBulkUpload && (
        <BulkUploadModal
          jobId={id}
          onClose={() => setShowBulkUpload(false)}
          onComplete={fetchJob}
        />
      )}

      {/* Add Candidate Modal */}
      {showAddCandidate && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1210] p-4">
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
