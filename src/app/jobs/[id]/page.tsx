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
  CheckCircle2,
  Trash2,
  Download,
  Upload,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { CandidateCard } from "@/components/candidate-card";
import { AiStatusBanner } from "@/components/ai-status-banner";
import { BulkUploadModal } from "@/components/bulk-upload-modal";
import { FetchQueueToast } from "@/components/fetch-queue-toast";
import { SearchCard } from "@/components/job/search-card";
import { PipelineCard } from "@/components/job/pipeline-card";
import { SkillNotesSection } from "@/components/job/skill-notes-section";
import { ParseHistoryCard } from "@/components/job/parse-history-card";
import { ClientReportModal, ClientReportButton } from "@/components/job/client-report-modal";
import { JobAdModal } from "@/components/job/job-ad-modal";
import { AddCandidateModal } from "@/components/job/add-candidate-modal";
import { cn, statusBadge, statusLabel, safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";
import { hasFullCandidateProfile } from "@/lib/candidate-profile";


interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  profileText: string | null;
  profileCapturedAt: string | null;
  matchScore: number | null;
  profileTextHash: string | null;
  matchReason: string | null;
  fetchPriorityScore: number | null;
  fetchPriorityReason: string | null;
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
  lastScoredAt: string | null;
  lastParsedAt: string | null;
  candidates: Candidate[];
}

interface ElectronBridge {
  platform?: string;
  openExternal?: (url: string) => Promise<{ ok: boolean; browser?: string | null } | boolean>;
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
  const [fetchError, setFetchError] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [parseChanges, setParseChanges] = useState<string[]>([]);
  const [showAddCandidate, setShowAddCandidate] = useState(false);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const [fetchStatuses, setFetchStatuses] = useState<Record<string, {
    state: "waiting" | "fetching" | "done" | "error";
    message: string;
  }>>({});
  const [filter, setFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [rescoringAll, setRescoringAll] = useState(false);
  const [rescoreResult, setRescoreResult] = useState<{ scored: number; total: number; failedIds?: string[]; partial?: boolean } | null>(null);
  const [rescoreProgress, setRescoreProgress] = useState<{ scored: number; total: number } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkStatusChanging, setBulkStatusChanging] = useState(false);
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [salaryMin, setSalaryMin] = useState<string>("");
  const [salaryMax, setSalaryMax] = useState<string>("");
  const [editingSalary, setEditingSalary] = useState(false);
  const [savingSalary, setSavingSalary] = useState(false);
  const [salaryError, setSalaryError] = useState("");
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showJobAd, setShowJobAd] = useState(false);
  const [editingJd, setEditingJd] = useState(false);
  const [jdDraft, setJdDraft] = useState("");
  const [savingJd, setSavingJd] = useState(false);
  const [pendingAccepted, setPendingAccepted] = useState<Set<string>>(new Set());
  const [pendingDismissed, setPendingDismissed] = useState<Set<string>>(new Set());
  const [pendingReqAction, setPendingReqAction] = useState<Set<string>>(new Set());

  // Per-candidate fetch tracking.
  interface FetchEntry {
    sessionId: string;
    candidateId: string;
    tab: Window | null;
    startedAt: number;
    processingStartedAt: number | null;
    lastKnownStatus: "pending" | "processing";
    done: boolean;
    pollInterval: ReturnType<typeof setInterval> | null;
    consecutiveNetworkErrors: number;
  }
  const jobRef = useRef<Job | null>(null);
  const activeFetchesRef = useRef<Map<string, FetchEntry>>(new Map());
  // Stable fn-refs so setInterval callbacks always call the latest version.
  const pollCandidateFetchRef = useRef<(candidateId: string) => Promise<void>>(async () => {});
  const finishFetchRef = useRef<(candidateId: string, state: "done" | "error", message: string) => void>(() => {});

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.ok) {
        const data = await res.json() as Job;
        setJob(data);
        setSalaryMin(data.salaryMin ? String(data.salaryMin / 1000) : "");
        setSalaryMax(data.salaryMax ? String(data.salaryMax / 1000) : "");
        setFetchError(false);
      } else {
        setFetchError(true);
      }
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  // Keep jobRef in sync so poll callbacks can read the latest job without stale closures.
  useEffect(() => { jobRef.current = job; }, [job]);

  // Warn before browser-level navigation (refresh/close tab) when JD has unsaved edits.
  useEffect(() => {
    if (!editingJd) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editingJd]);

  useEffect(() => {
    const ref = activeFetchesRef.current;
    return () => {
      // Clean up all active sessions and poll intervals on unmount.
      for (const entry of ref.values()) {
        if (entry.pollInterval) clearInterval(entry.pollInterval);
        void fetch(`/api/extension/fetch-session?sessionId=${encodeURIComponent(entry.sessionId)}`, {
          method: "DELETE",
          credentials: "include",
        }).catch(() => {});
      }
      ref.clear();
    };
  }, []);

  const handleSaveSalary = async () => {
    if (!job) return;
    const min = salaryMin ? Math.round(parseFloat(salaryMin) * 1000) : null;
    const max = salaryMax ? Math.round(parseFloat(salaryMax) * 1000) : null;
    if (min != null && max != null && min > max) {
      setSalaryError("Minimum cannot exceed maximum");
      return;
    }
    setSalaryError("");
    setSavingSalary(true);
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

  const handleSaveJd = async () => {
    if (!job) return;
    setSavingJd(true);
    try {
      const res = await fetch(`/api/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawJd: jdDraft }),
      });
      if (res.ok) {
        await fetchJob();
        setEditingJd(false);
        // Re-analyse automatically so scoring criteria reflect the updated JD
        handleParse();
      }
    } finally {
      setSavingJd(false);
    }
  };

  const handleAcceptAlternative = async (skill: string, alternative: string) => {
    setPendingAccepted((prev) => new Set([...prev, alternative]));
    try {
      const res = await fetch(`/api/jobs/${id}/skill-note-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill, action: "accept", alternative }),
      });
      if (res.ok) await fetchJob();
    } finally {
      setPendingAccepted((prev) => { const next = new Set(prev); next.delete(alternative); return next; });
    }
  };

  const handleDismissNote = async (skill: string) => {
    setPendingDismissed((prev) => new Set([...prev, skill]));
    const res = await fetch(`/api/jobs/${id}/skill-note-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill, action: "dismiss" }),
    });
    if (res.ok) {
      await fetchJob();
    } else {
      // Revert optimistic hide on failure
      setPendingDismissed((prev) => { const next = new Set(prev); next.delete(skill); return next; });
    }
  };

  const handleRequirementAction = async (
    action: "dismiss-knockout" | "restore-knockout" | "promote-visa-flag" | "demote-visa-flag",
    item: string
  ) => {
    const key = `${action}:${item}`;
    setPendingReqAction((prev) => new Set([...prev, key]));
    try {
      const res = await fetch(`/api/jobs/${id}/requirement-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, item }),
      });
      if (res.ok) await fetchJob();
    } finally {
      setPendingReqAction((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
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
      const data = await res.json() as { parsedRole?: ParsedRole; changes?: string[]; error?: string };
      if (!res.ok || data.error) {
        setParseError(data.error ?? "Parsing failed");
      } else {
        if (data.changes?.length) setParseChanges(data.changes);
        await fetchJob();
      }
    } catch {
      setParseError("Parsing failed. Make sure Ollama is running.");
    } finally {
      setParsing(false);
    }
  };

  const handleScore = useCallback(async (candidateId: string) => {
    setScoringId(candidateId);
    try {
      const res = await fetch(`/api/jobs/${id}/candidates/${candidateId}/score`, { method: "POST" });
      if (res.ok) {
        await fetchJob();
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: { state: "error", message: body.error ?? "Scoring failed — try again" },
        }));
        setTimeout(() => setFetchStatuses((prev) => {
          const next = { ...prev };
          delete next[candidateId];
          return next;
        }), 5000);
      }
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
      credentials: "include",
    }).catch(() => {});
    setFetchStatuses((prev) => ({ ...prev, [candidateId]: { state, message } }));
    clearCandidateStatus(candidateId, state === "done" ? 4000 : 6000, state);
  };

  const pollCandidateFetch = async (candidateId: string) => {
    const entry = activeFetchesRef.current.get(candidateId);
    if (!entry || entry.done) return;
    const now = Date.now();
    if (entry.lastKnownStatus === "processing") {
      const processingStartedAt = entry.processingStartedAt ?? now;
      if (now - processingStartedAt > 300_000) {
        finishFetchRef.current(
          candidateId,
          "error",
          "Profile reached RecruitMe but AI scoring took too long - refresh the job and re-score if needed."
        );
        return;
      }
    } else if (now - entry.startedAt > 120_000) {
      finishFetchRef.current(
        candidateId,
        "error",
        "Capture timed out - try again. If it keeps failing, reload the extension and check the extension popup for the real error."
      );
      return;
    }
    try {
      const res = await fetch(
        `/api/extension/fetch-session?sessionId=${encodeURIComponent(entry.sessionId)}`,
        { credentials: "include" }
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
      entry.consecutiveNetworkErrors = 0; // reset on any successful response
      if (data.status === "processing") {
        entry.lastKnownStatus = "processing";
        entry.processingStartedAt ??= Date.now();
        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: { state: "fetching", message: data.message ?? "Scoring with AI..." },
        }));
        return;
      }
      if (data.status === "completed") {
        if (data.candidate) {
          setJob((prev) =>
            prev
              ? { ...prev, candidates: prev.candidates.map((c) => c.id === candidateId ? data.candidate as Candidate : c) }
              : prev
          );
        } else {
          // Candidate not embedded in session — reload the whole job to pick up the saved profile.
          void fetchJob();
        }
        finishFetchRef.current(candidateId, "done", data.message ?? "Profile captured and scored");
        return;
      }
      if (data.status === "error") {
        finishFetchRef.current(candidateId, "error", data.error ?? data.message ?? "Capture failed");
        return;
      }
    } catch {
      // Network error — track consecutive failures; after 3 in a row pause for
      // 30s then reset the counter so polling can resume automatically.
      entry.consecutiveNetworkErrors = (entry.consecutiveNetworkErrors ?? 0) + 1;
      if (entry.consecutiveNetworkErrors >= 3) {
        entry.consecutiveNetworkErrors = 0;
        // Brief pause to let transient network issues resolve before retrying.
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
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
          credentials: "include",
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
          const launchResult = await electron?.openExternal?.(candidate.linkedinUrl!);
          const opened = typeof launchResult === "boolean" ? launchResult : Boolean(launchResult?.ok);
          if (!opened) {
            await fetch(`/api/extension/fetch-session?sessionId=${encodeURIComponent(session.sessionId)}`, {
              method: "DELETE",
              credentials: "include",
            }).catch(() => {});
            setFetchStatuses((prev) => ({
              ...prev,
              [candidateId]: {
                state: "error",
                message: "No supported browser found — install Chrome, Opera, Edge, or Brave and load the RecruitMe extension (see LinkedIn Setup)",
              },
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
              ? "Queued - waiting for the extension to open and capture the LinkedIn profile..."
              : "LinkedIn tab requested - waiting for the extension to confirm capture...",
          },
        }));

        const entry: FetchEntry = {
          sessionId: session.sessionId,
          candidateId,
          tab,
          startedAt: Date.now(),
          processingStartedAt: null,
          lastKnownStatus: "pending",
          done: false,
          pollInterval: null,
          consecutiveNetworkErrors: 0,
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

  const handleJobAdderChange = useCallback(async (candidateId: string, jobAdderUrl: string) => {
    await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobAdderUrl: jobAdderUrl || null }),
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
    setRescoreProgress(null);
    try {
      const res = await fetch(`/api/jobs/${id}/candidates/score-all`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        console.error("score-all failed:", data.error);
        // rescoringAll reset happens in finally — no stuck spinner
        return;
      }
      if (!res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamFinished = false;
      let lastProgress: { scored: number; total: number } | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as { scored: number; total: number; done?: boolean; failedIds?: string[] };
              lastProgress = { scored: msg.scored, total: msg.total };
              setRescoreProgress(lastProgress);
              if (msg.done) {
                setRescoreResult({ scored: msg.scored, total: msg.total, failedIds: msg.failedIds });
                streamFinished = true;
              }
            } catch { /* ignore malformed lines */ }
          }
        }
      } catch {
        // Network dropped mid-stream — fall through to partial result below
      }

      // If the stream ended without a done:true message, show a partial result
      // so the user knows something was scored (not complete silence on failure).
      if (!streamFinished && lastProgress) {
        setRescoreResult({ scored: lastProgress.scored, total: lastProgress.total, failedIds: [], partial: true });
      }

      await fetchJob();
    } finally {
      setRescoringAll(false);
      setRescoreProgress(null);
    }
  };

  const handleDelete = useCallback(async (candidateId: string) => {
    if (!confirm("Remove this candidate?")) return;
    const res = await fetch(`/api/jobs/${id}/candidates/${candidateId}`, { method: "DELETE" });
    if (!res.ok) { alert("Delete failed — please try again."); return; }
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(candidateId); return next; });
    await fetchJob();
  }, [fetchJob, id]);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} candidate${selectedIds.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setBulkDeleting(true);
    const res = await fetch(`/api/jobs/${id}/candidates/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selectedIds] }),
    });
    if (!res.ok) {
      alert(`Delete failed — please try again.`);
    }
    setSelectedIds(new Set());
    setBulkDeleting(false);
    await fetchJob();
  };

  const handleBulkStatusChange = async (status: string) => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Move ${selectedIds.size} candidate${selectedIds.size > 1 ? "s" : ""} to "${statusLabel(status)}"?`)) return;
    setBulkStatusChanging(true);
    const results = await Promise.allSettled(
      [...selectedIds].map((candidateId) =>
        fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        })
      )
    );
    const failCount = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
    if (failCount > 0) {
      alert(`${failCount} of ${selectedIds.size} updates failed — refresh and try again for those candidates.`);
    }
    setSelectedIds(new Set());
    setBulkStatusChanging(false);
    await fetchJob();
  };

  const handleExportJdPdf = () => {
    if (!job) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const toHtml = (text: string) => {
      const lines = text.split("\n");
      const out: string[] = [];
      let inList = false;
      for (const line of lines) {
        const t = line.trim();
        if (/^#{1,3}\s/.test(t)) {
          if (inList) { out.push("</ul>"); inList = false; }
          const lv = (t.match(/^(#{1,3})/)?.[1].length ?? 2) + 1;
          out.push(`<h${lv}>${esc(t.replace(/^#{1,3}\s*/, "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</h${lv}>`);
        } else if (/^[-*]\s/.test(t)) {
          if (!inList) { out.push("<ul>"); inList = true; }
          out.push(`<li>${esc(t.replace(/^[-*]\s*/, "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</li>`);
        } else if (t === "") {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push("<br>");
        } else {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push(`<p>${esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`);
        }
      }
      if (inList) out.push("</ul>");
      return out.join("\n");
    };

    const meta = [
      job.company,
      job.location,
      (job.salaryMin || job.salaryMax)
        ? `$${Math.round((job.salaryMin ?? 0) / 1000)}k–$${Math.round((job.salaryMax ?? 0) / 1000)}k NZD`
        : "",
    ].filter(Boolean).join(" · ");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(job.title)}</title>
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
<h1>${esc(job.title)}</h1>
${meta ? `<p class="meta">${esc(meta)}</p>` : ""}
${toHtml(job.rawJd)}
</body></html>`;

    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
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

  const toggleSelect = (candidateId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const jobCandidates = useMemo(() => job?.candidates ?? [], [job?.candidates]);
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
        const aInitialLead = !a.profileCapturedAt && a.fetchPriorityScore != null;
        const bInitialLead = !b.profileCapturedAt && b.fetchPriorityScore != null;
        if (aInitialLead && bInitialLead) {
          const priorityDiff = (b.fetchPriorityScore ?? -1) - (a.fetchPriorityScore ?? -1);
          if (priorityDiff !== 0) return priorityDiff;
        }
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

  if (fetchError) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
        <p className="text-slate-700 font-medium mb-1">Failed to load job</p>
        <p className="text-slate-400 text-sm mb-4">Check your connection and try again.</p>
        <button
          onClick={() => { setLoading(true); setFetchError(false); fetchJob(); }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Retry
        </button>
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
          <button
            onClick={handleExportJdPdf}
            title="Export job description as PDF"
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg text-sm font-medium transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export JD
          </button>
          {shortlistCount > 0 && (
            <>
              <ClientReportButton shortlistCount={shortlistCount} onClick={() => setShowReport(true)} />
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
                {parseChanges.length > 0 && !parseError && (
                  <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[11px] font-medium text-blue-700">What changed</p>
                      <button onClick={() => setParseChanges([])} className="text-[10px] text-blue-400 hover:text-blue-600">dismiss</button>
                    </div>
                    <ul className="space-y-0.5">
                      {parseChanges.map((c, i) => (
                        <li key={i} className="text-[11px] text-blue-600">· {c}</li>
                      ))}
                    </ul>
                  </div>
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
                  {!editingJd && (
                    <button
                      onClick={() => { setJdDraft(job.rawJd); setEditingJd(true); }}
                      className="text-xs text-slate-400 hover:text-blue-600 transition-colors flex items-center gap-1"
                    >
                      <Pencil className="w-3 h-3" />
                      Edit JD
                    </button>
                  )}
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

              {/* Inline JD editor */}
              {editingJd && (
                <div className="space-y-2">
                  <textarea
                    value={jdDraft}
                    onChange={(e) => setJdDraft(e.target.value)}
                    rows={16}
                    className="w-full px-3 py-2.5 text-sm border border-blue-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono leading-relaxed resize-y"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => {
                        if (jdDraft !== job.rawJd && !confirm("Discard unsaved changes to the job description?")) return;
                        setEditingJd(false);
                      }}
                      className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-800 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveJd}
                      disabled={savingJd || !jdDraft.trim()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                    >
                      {savingJd ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      {savingJd ? "Saving…" : "Save & Re-analyse"}
                    </button>
                  </div>
                </div>
              )}

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
                    <>
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
                        <button onClick={() => { setEditingSalary(false); setSalaryError(""); }} className="text-slate-400 hover:text-slate-600">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {salaryError && <p className="text-xs text-red-500 mt-1">{salaryError}</p>}
                    </>
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

              {/* Knockout criteria — each item can be dismissed to remove it from scoring */}
              {(parsedRole.knockout_criteria?.length ?? 0) > 0 && (() => {
                const dismissed = parsedRole.dismissed_knockout_criteria ?? [];
                return (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide mb-2 text-red-600">Knockout Criteria</p>
                    <div className="flex flex-wrap gap-1.5">
                      {parsedRole.knockout_criteria.map((item) => {
                        const isDismissed = dismissed.includes(item);
                        const pendingKey = isDismissed ? `restore-knockout:${item}` : `dismiss-knockout:${item}`;
                        const isPending = pendingReqAction.has(pendingKey);
                        return (
                          <span
                            key={item}
                            title={isDismissed ? "Click to re-enable as a scoring gate" : "Click × to disable this gate (informational only)"}
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md border font-medium transition-colors",
                              isDismissed
                                ? "bg-slate-50 text-slate-400 border-slate-200 line-through"
                                : "bg-red-50 text-red-700 border-red-200"
                            )}
                          >
                            {item}
                            {isPending ? (
                              <Loader2 className="w-2.5 h-2.5 animate-spin flex-shrink-0" />
                            ) : isDismissed ? (
                              <button
                                onClick={() => handleRequirementAction("restore-knockout", item)}
                                title="Re-enable as knockout gate"
                                className="text-slate-400 hover:text-red-600 transition-colors flex-shrink-0"
                              >
                                <RotateCcw className="w-2.5 h-2.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRequirementAction("dismiss-knockout", item)}
                                title="Disable — treat as informational only"
                                className="text-red-300 hover:text-red-600 transition-colors flex-shrink-0"
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

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

              {/* AI search tips — legacy/rare tech with suggested modern alternatives */}
              {(parsedRole.skill_notes?.length ?? 0) > 0 && (
                <SkillNotesSection
                  notes={parsedRole.skill_notes ?? []}
                  dismissedSkills={parsedRole.dismissed_skill_notes ?? []}
                  niceToHaves={niceToHaves}
                  pendingAccepted={pendingAccepted}
                  pendingDismissed={pendingDismissed}
                  onAccept={handleAcceptAlternative}
                  onDismiss={handleDismissNote}
                />
              )}

              {/* Visa / work rights — only show if not already covered by knockout criteria */}
              <HiringBriefChipSection
                title="Application / Screening"
                items={parsedRole.application_requirements}
                labelClassName="text-amber-700"
                chipClassName="bg-amber-50 text-amber-800 border-amber-200"
              />

              {/* Work Rights / visa flags — items can be promoted into must_haves */}
              {parsedRole.visa_flags?.length > 0 && (() => {
                const knockoutText = (parsedRole.knockout_criteria ?? []).join(" ").toLowerCase();
                const items = parsedRole.visa_flags.filter(
                  (f) => !knockoutText.includes(f.toLowerCase().slice(0, 12))
                );
                if (items.length === 0) return null;
                const promoted = parsedRole.promoted_visa_flags ?? [];
                return (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide mb-2 text-amber-700">Work Rights</p>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map((item) => {
                        const isPromoted = promoted.includes(item);
                        const pendingKey = isPromoted ? `demote-visa-flag:${item}` : `promote-visa-flag:${item}`;
                        const isPending = pendingReqAction.has(pendingKey);
                        return (
                          <span
                            key={item}
                            title={isPromoted ? "Enforced as a must-have — click × to relax" : "Click + to enforce as a scoring must-have"}
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md border transition-colors",
                              isPromoted
                                ? "bg-violet-50 text-violet-700 border-violet-200 font-medium"
                                : "bg-amber-50 text-amber-800 border-amber-200"
                            )}
                          >
                            {item}
                            {isPending ? (
                              <Loader2 className="w-2.5 h-2.5 animate-spin flex-shrink-0" />
                            ) : isPromoted ? (
                              <button
                                onClick={() => handleRequirementAction("demote-visa-flag", item)}
                                title="Remove from must-haves"
                                className="text-violet-400 hover:text-violet-700 transition-colors flex-shrink-0"
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRequirementAction("promote-visa-flag", item)}
                                title="Enforce as a must-have in scoring"
                                className="text-amber-400 hover:text-amber-700 transition-colors flex-shrink-0"
                              >
                                <Plus className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
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

          <PipelineCard
            totalCount={jobCandidates.length}
            statusCounts={statusCounts}
            filter={filter}
            onFilterChange={setFilter}
          />
        </div>
      )}

      {parsedRole && (
        <SearchCard
          jobId={id}
          parsedRole={parsedRole}
          jobLocation={job.location}
          jobStatus={job.status}
          onComplete={fetchJob}
        />
      )}

      {parsedRole && <ParseHistoryCard jobId={id} />}

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
                    {rescoringAll
                      ? rescoreProgress
                        ? `Scoring ${rescoreProgress.scored} of ${rescoreProgress.total}…`
                        : "Scoring…"
                      : "Re-score all"}
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
            (c) => c.linkedinUrl && !hasFullCandidateProfile(c)
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

        {/* Stale-score warning: requirements updated since last score-all */}
        {job && job.lastParsedAt && job.candidates.length > 0 && !rescoringAll && !rescoreResult && (() => {
          const parsedMs  = new Date(job.lastParsedAt).getTime();
          const scoredMs  = job.lastScoredAt ? new Date(job.lastScoredAt).getTime() : 0;
          return parsedMs > scoredMs ? (
            <div className="mb-3 flex items-center gap-1.5 text-xs rounded-lg px-3 py-2 border text-amber-700 bg-amber-50 border-amber-200">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              Requirements updated since last score — Re-score all to apply new criteria.
            </div>
          ) : null;
        })()}

        {/* Re-score result */}
        {rescoreResult && !rescoringAll && (
          <div className={cn(
            "mb-3 flex items-center gap-1.5 text-xs rounded-lg px-3 py-2 border",
            rescoreResult.partial
              ? "text-amber-700 bg-amber-50 border-amber-200"
              : "text-emerald-700 bg-emerald-50 border-emerald-200"
          )}>
            {rescoreResult.partial
              ? <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              : <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />}
            {rescoreResult.partial
              ? `Scored ${rescoreResult.scored} of ${rescoreResult.total} — connection dropped, re-run to finish`
              : `Re-scored ${rescoreResult.scored} of ${rescoreResult.total} candidates`}
            {!rescoreResult.partial && rescoreResult.failedIds && rescoreResult.failedIds.length > 0 && (
              <span className="ml-2 text-amber-600">· {rescoreResult.failedIds.length} failed</span>
            )}
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
                Click &ldquo;Search LinkedIn Now&rdquo; above to find candidates automatically, or add them manually below.
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
                    onJobAdderChange={handleJobAdderChange}
                    onScreeningDataChange={handleScreeningDataChange}
                    onInterviewNotesChange={handleInterviewNotesChange}
                    onDelete={handleDelete}
                    scoring={scoringId === candidate.id}
                    fetchingProfile={
                      fetchStatuses[candidate.id]?.state === "waiting" ||
                      fetchStatuses[candidate.id]?.state === "fetching"
                    }
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

      {showReport && (
        <ClientReportModal
          jobId={id}
          jobTitle={job.title}
          jobParsedRole={job.parsedRole}
          candidates={job.candidates}
          onClose={() => setShowReport(false)}
        />
      )}

      {showJobAd && (
        <JobAdModal jobId={id} onClose={() => setShowJobAd(false)} />
      )}

      {showBulkUpload && (
        <BulkUploadModal jobId={id} onClose={() => setShowBulkUpload(false)} onComplete={fetchJob} />
      )}

      {showAddCandidate && (
        <AddCandidateModal
          jobId={id}
          parsedRole={parsedRole}
          onClose={() => setShowAddCandidate(false)}
          onComplete={(createdId) => {
            setShowAddCandidate(false);
            fetchJob().then(() => {
              if (createdId) handleFetchProfile(createdId);
            });
          }}
        />
      )}
    </div>
  );
}
