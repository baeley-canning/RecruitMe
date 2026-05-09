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
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { showToast } from "@/components/ui/toast";
import { CandidateCard } from "@/components/candidate-card";
import { AiStatusBanner } from "@/components/ai-status-banner";
import { BulkUploadModal } from "@/components/bulk-upload-modal";
import { FetchQueuePanel } from "@/components/fetch-queue-panel";
import type { FetchStatus } from "@/components/fetch-queue-panel";
import { SearchCard } from "@/components/job/search-card";
import { SearchFunnelCard } from "@/components/job/search-funnel-card";
import { SavedSearchesCard } from "@/components/job/saved-searches-card";
import { OnboardingCard } from "@/components/job/onboarding-card";
import { JobWeightsCard } from "@/components/job/job-weights-card";
import { TopCandidatesCard } from "@/components/job/top-candidates-card";
import { BrowseLibraryModal } from "@/components/job/browse-library-modal";
import { PipelineCard } from "@/components/job/pipeline-card";
import { SkillNotesSection } from "@/components/job/skill-notes-section";
import { ParseHistoryCard } from "@/components/job/parse-history-card";
import { ClientReportModal } from "@/components/job/client-report-modal";
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
  captureMetadata: string | null;
  _count?: { contactEvents: number };
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
  // Modal open/close state consolidated into one object so toggling two at
  // once (e.g. close A, open B) is a single setState instead of two async
  // batches that can fire in wrong order.
  const [modals, setModals] = useState({
    addCandidate: false,
    browseLibrary: false,
    bulkUpload:    false,
    report:        false,
  });
  const openModal  = useCallback((k: keyof typeof modals) => setModals(m => ({ ...m, [k]: true  })), []);
  const closeModal = useCallback((k: keyof typeof modals) => setModals(m => ({ ...m, [k]: false })), []);

  // Overflow (⋯) menu for low-frequency header actions
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!overflowOpen) return;
    const close = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [overflowOpen]);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const [fetchStatuses, setFetchStatuses] = useState<Record<string, FetchStatus>>({});
  const [fetchPanelDismissed, setFetchPanelDismissed] = useState(false);
  // Local FIFO queue of candidateIds waiting to be fetched.
  // Only one fetch fires at a time — drainFetchQueue picks up the next
  // item whenever a fetch slot becomes free.
  const fetchQueueRef = useRef<string[]>([]);
  const MAX_CONCURRENT_FETCHES = 1;
  // Empty array = no filter (show all). Multiple entries = OR-filter across statuses.
  const [filter, setFilter] = useState<string[]>([]);
  // Progressive rendering — render the first N candidates initially, expand on
  // recruiter request. Each CandidateCard is heavy (1600+ line component);
  // rendering 500 of them on a job page creates a noticeable initial-paint
  // delay. Capping the first batch keeps the page snappy at any scale; the
  // "Show all" button reveals the rest when needed.
  const RENDER_BATCH_SIZE = 50;
  const [renderCap, setRenderCap] = useState<number>(RENDER_BATCH_SIZE);
  const [searchQuery, setSearchQuery] = useState("");
  const [rescoringAll, setRescoringAll] = useState(false);
  const [rescoreResult, setRescoreResult] = useState<{ scored: number; total: number; failedIds?: string[]; partial?: boolean } | null>(null);
  const [rescoreProgress, setRescoreProgress] = useState<{ scored: number; total: number } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkStatusChanging, setBulkStatusChanging] = useState(false);
  const [salaryMin, setSalaryMin] = useState<string>("");
  const [salaryMax, setSalaryMax] = useState<string>("");
  const [editingSalary, setEditingSalary] = useState(false);
  const [savingSalary, setSavingSalary] = useState(false);
  const [salaryError, setSalaryError] = useState("");
  const [togglingStatus, setTogglingStatus] = useState(false);
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

  // On mount: resume polling for any captures still in-progress. Recovers
  // tracking state after the user refreshed the tab while the extension was
  // partway through a profile.
  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/extension/fetch-session?jobId=${encodeURIComponent(id)}`, { credentials: "include" }).catch(() => null);
      if (!res?.ok) return;
      const data = await res.json().catch(() => null) as {
        sessions?: Array<{ sessionId: string; candidateId: string; status: string; message?: string; updatedAt?: string; createdAt?: string }>;
      } | null;
      if (!data?.sessions) return;
      for (const s of data.sessions) {
        if (!s.candidateId || activeFetchesRef.current.has(s.candidateId)) continue;
        if (s.status !== "pending" && s.status !== "processing") continue;
        // Use the SESSION's actual createdAt / updatedAt so the timeout is
        // anchored to when the server transitioned states, not when the
        // recruiter's tab happens to mount. Otherwise a session that's been
        // in "processing" for 4 min server-side gets a fresh 5-min timeout
        // every time the page reloads.
        const serverCreatedAt = s.createdAt ? new Date(s.createdAt).getTime() : Date.now() - 60_000;
        const serverUpdatedAt = s.updatedAt ? new Date(s.updatedAt).getTime() : serverCreatedAt;
        const entry = {
          sessionId: s.sessionId,
          candidateId: s.candidateId,
          startedAt: serverCreatedAt,
          processingStartedAt: s.status === "processing" ? serverUpdatedAt : null,
          lastKnownStatus: s.status as "pending" | "processing",
          done: false,
          pollInterval: null as ReturnType<typeof setInterval> | null,
          consecutiveNetworkErrors: 0,
        };
        activeFetchesRef.current.set(s.candidateId, entry);
        setFetchStatuses((prev) => ({
          ...prev,
          [s.candidateId]: { state: "waiting", message: s.message ?? "Capture still running — resumed tracking", startedAt: serverCreatedAt },
        }));
        entry.pollInterval = setInterval(() => {
          void pollCandidateFetchRef.current(s.candidateId);
        }, 3000);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Keep jobRef in sync so poll callbacks can read the latest job without stale closures.
  useEffect(() => { jobRef.current = job; }, [job]);

  // Fire an immediate catchup poll on every active fetch when the tab becomes
  // visible again. The polling interval skips while document.hidden is true
  // (saves API quota), so without this the recruiter waits up to 2.5s after
  // returning to the tab before the "fetching..." panel updates to "done".
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      for (const [candidateId, entry] of activeFetchesRef.current) {
        if (!entry.done) {
          void pollCandidateFetchRef.current(candidateId);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

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

  // Dismiss is session-only — tips come back on reload or re-analyse.
  // Clicking X just means "not right now", not "never show this again".
  const handleDismissNote = (skill: string) => {
    setPendingDismissed((prev) => new Set([...prev, skill]));
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
        if (data.changes?.length) {
          setParseChanges(data.changes);
        } else {
          setParseChanges(["Re-analysed — requirements are the same as before"]);
        }
        await fetchJob();
      }
    } catch {
      setParseError("Parsing failed — check that your Claude API key is set in Settings and try again.");
    } finally {
      setParsing(false);
    }
  };

  const handleCancelFetch = useCallback((candidateId: string) => {
    // Stop polling
    const entry = activeFetchesRef.current.get(candidateId);
    if (entry?.pollInterval) clearInterval(entry.pollInterval);
    activeFetchesRef.current.delete(candidateId);
    // Remove from local queue
    fetchQueueRef.current = fetchQueueRef.current.filter((id) => id !== candidateId);
    // Cancel the session on the server
    if (entry?.sessionId) {
      fetch(`/api/extension/fetch-session?sessionId=${encodeURIComponent(entry.sessionId)}`, {
        method: "DELETE", credentials: "include",
      }).catch(() => {});
    }
    setFetchStatuses((prev) => { const next = { ...prev }; delete next[candidateId]; return next; });
    drainFetchQueueRef.current();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Slot freed — start next item from the queue
    drainFetchQueueRef.current();
  };

  const pollCandidateFetch = async (candidateId: string) => {
    // Skip when the tab is hidden — saves API quota and Railway compute when
    // the recruiter has stepped away. The poll resumes naturally when the
    // tab is foregrounded again.
    if (typeof document !== "undefined" && document.hidden) return;
    const entry = activeFetchesRef.current.get(candidateId);
    if (!entry || entry.done) return;
    const now = Date.now();
    // Pending = waiting for the extension to claim the session. If nothing
    // happens for 2 minutes the extension probably isn't running.
    // Processing = extension is capturing + AI scoring. Allow 5 minutes.
    const PENDING_LIMIT    = 120_000;  // 2 min
    const PROCESSING_LIMIT = 300_000;  // 5 min
    if (entry.lastKnownStatus === "processing") {
      const processingStartedAt = entry.processingStartedAt ?? now;
      if (now - processingStartedAt > PROCESSING_LIMIT) {
        finishFetchRef.current(
          candidateId,
          "error",
          "Profile reached RecruitMe but AI scoring took too long — refresh the job and re-score if needed."
        );
        return;
      }
    } else if (now - entry.startedAt > PENDING_LIMIT) {
      finishFetchRef.current(
        candidateId,
        "error",
        "Capture timed out — make sure the RecruitMe LinkedIn extension is installed and try again."
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
  // Drain: while there's a free fetch slot and queue items, start the next one.
  // The active count is re-read every iteration so we don't over-drain when
  // multiple slots free at once (with MAX=1 a stale read would empty the queue
  // in one shot and dispatch every queued item simultaneously).
  const drainFetchQueueRef = useRef<() => void>(() => {});
  drainFetchQueueRef.current = () => {
    while (
      activeFetchesRef.current.size < MAX_CONCURRENT_FETCHES &&
      fetchQueueRef.current.length > 0
    ) {
      const nextId = fetchQueueRef.current.shift()!;
      fetchQueueRef.current.forEach((id, i) => {
        setFetchStatuses((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], queuePosition: i + 1 } } : prev);
      });
      startFetchRef.current(nextId);
    }
  };
  const startFetchRef = useRef<(candidateId: string) => void>(() => {});

  const handleFetchProfile = useCallback((candidateId: string) => {
    const candidate = job?.candidates.find((c) => c.id === candidateId);
    if (!candidate?.linkedinUrl) return;
    if (activeFetchesRef.current.has(candidateId)) return;
    if (fetchQueueRef.current.includes(candidateId)) return;
    setFetchPanelDismissed(false); // show panel when a new fetch starts

    // Always open the LinkedIn profile here, inside the user gesture, so Chrome
    // doesn't block the popup. Even when the candidate is queued behind capacity
    // we open the tab now — the drain runs from a poll callback, which has no
    // user-gesture context, so window.open from there would be blocked. Result:
    // user sees a tab per click; the queue paces server-side capture sessions.
    window.open(candidate.linkedinUrl, "_blank", "noopener,noreferrer");

    // If at capacity, add to queue
    if (activeFetchesRef.current.size >= MAX_CONCURRENT_FETCHES) {
      const pos = fetchQueueRef.current.length + 1;
      fetchQueueRef.current.push(candidateId);
      setFetchStatuses((prev) => ({
        ...prev,
        [candidateId]: { state: "queued", message: "Waiting in queue", queuePosition: pos },
      }));
      return;
    }
    startFetchRef.current(candidateId);
  }, [job]);  // eslint-disable-line react-hooks/exhaustive-deps

  // The real fetch logic, extracted so drainFetchQueue can also call it.
  const handleFetchProfileImplRef = useRef<(candidateId: string) => void>(() => {});
  startFetchRef.current = (candidateId: string) => handleFetchProfileImplRef.current(candidateId);

  const handleFetchProfileImpl = useCallback((candidateId: string) => {
    const candidate = job?.candidates.find((c) => c.id === candidateId);
    if (!candidate?.linkedinUrl) return;
    if (activeFetchesRef.current.has(candidateId)) return;

    // Reserve the slot SYNCHRONOUSLY. Without this, the drain's while-loop
    // re-reads activeFetchesRef.current.size and sees the stale 0 between
    // iterations because the real entry is only set inside the async POST
    // block below — the loop would then dispatch every queued candidate at
    // once instead of one per slot.
    const placeholder: FetchEntry = {
      sessionId: "",
      candidateId,
      startedAt: Date.now(),
      processingStartedAt: null,
      lastKnownStatus: "pending",
      done: false,
      pollInterval: null,
      consecutiveNetworkErrors: 0,
    };
    activeFetchesRef.current.set(candidateId, placeholder);

    setFetchStatuses((prev) => ({
      ...prev,
      [candidateId]: { state: "waiting", message: "Starting capture...", startedAt: Date.now() },
    }));

    void (async () => {
      try {
        const start = await fetch("/api/extension/fetch-session", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: id, candidateId }),
        });
        const session = (await start.json()) as { sessionId?: string; error?: string; message?: string; status?: string };

        if (!start.ok || !session.sessionId) {
          // Free the slot we reserved so the queue can advance.
          activeFetchesRef.current.delete(candidateId);
          drainFetchQueueRef.current();
          setFetchStatuses((prev) => ({
            ...prev,
            [candidateId]: { state: "error", message: session.error ?? "Could not start capture" },
          }));
          clearCandidateStatus(candidateId, 6000, "error");
          return;
        }

        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: {
            state: "waiting",
            message: session.message ?? "Waiting for browser extension to capture",
            startedAt: Date.now(),
          },
        }));

        // Promote the placeholder to the real entry now that we have the sessionId.
        placeholder.sessionId = session.sessionId;
        // 2500ms balances UI responsiveness against API hammering. With the
        // tab-hidden gate inside pollCandidateFetch, idle tabs cost nothing.
        placeholder.pollInterval = setInterval(() => {
          void pollCandidateFetchRef.current(candidateId);
        }, 2500);
      } catch {
        // Free the slot we reserved so the queue can continue.
        activeFetchesRef.current.delete(candidateId);
        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: { state: "error", message: "Network error starting capture" },
        }));
        clearCandidateStatus(candidateId, 6000, "error");
        drainFetchQueueRef.current();
      }
    })();
  }, [id, job]);
  handleFetchProfileImplRef.current = handleFetchProfileImpl;

  // Wrap a candidate PATCH with consistent error handling + success toast.
  // Recruiter does these every minute; silent failures here are how lost
  // work happens. Toast surfaces both happy-path confirmation and failures.
  const patchCandidate = useCallback(
    async (candidateId: string, body: Record<string, unknown>, successMessage: string) => {
      try {
        const res = await fetch(`/api/jobs/${id}/candidates/${candidateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          showToast(data.error || `Save failed (${res.status}) — try again`, "error");
          return false;
        }
        showToast(successMessage);
        await fetchJob();
        return true;
      } catch {
        showToast("Network error — change not saved. Check your connection and try again.", "error");
        return false;
      }
    },
    [fetchJob, id]
  );

  const handleStatusChange = useCallback(
    (candidateId: string, status: string) =>
      patchCandidate(candidateId, { status }, `Moved to ${statusLabel(status)}`).then(() => undefined),
    [patchCandidate]
  );

  const handleNotesChange = useCallback(
    (candidateId: string, notes: string) =>
      patchCandidate(candidateId, { notes }, "Notes saved").then(() => undefined),
    [patchCandidate]
  );

  const handleLinkedInChange = useCallback(
    (candidateId: string, linkedinUrl: string) =>
      patchCandidate(candidateId, { linkedinUrl: linkedinUrl || null }, "LinkedIn URL saved").then(() => undefined),
    [patchCandidate]
  );

  const handleJobAdderChange = useCallback(
    (candidateId: string, jobAdderUrl: string) =>
      patchCandidate(candidateId, { jobAdderUrl: jobAdderUrl || null }, "JobAdder URL saved").then(() => undefined),
    [patchCandidate]
  );

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
    // Terminal statuses go to the bottom of the list — recruiter doesn't want
    // hired / rejected mixed in with the active pipeline they're still working.
    const TERMINAL_STATUSES = new Set(["hired", "declined", "rejected"]);
    return [...jobCandidates]
      .filter((candidate) => (filter.length === 0 ? true : filter.includes(candidate.status)))
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
        // 1. Active before terminal — moves hired/rejected to the bottom of the
        //    "all" view rather than mixing them with new/shortlisted candidates.
        const aTerminal = TERMINAL_STATUSES.has(a.status) ? 1 : 0;
        const bTerminal = TERMINAL_STATUSES.has(b.status) ? 1 : 0;
        if (aTerminal !== bTerminal) return aTerminal - bTerminal;

        // 2. Within active: candidates that haven't been fetched yet but have a
        //    high search-priority score surface first, so the recruiter knows
        //    "fetch these next, they look promising".
        const aInitialLead = !a.profileCapturedAt && a.fetchPriorityScore != null;
        const bInitialLead = !b.profileCapturedAt && b.fetchPriorityScore != null;
        if (aInitialLead && bInitialLead) {
          const priorityDiff = (b.fetchPriorityScore ?? -1) - (a.fetchPriorityScore ?? -1);
          if (priorityDiff !== 0) return priorityDiff;
        }
        // 3. Match score desc — primary signal.
        const scoreDiff = (b.matchScore ?? -1) - (a.matchScore ?? -1);
        if (scoreDiff !== 0) return scoreDiff;

        // 4. Acceptance score desc — when match scores tie, surface the more
        //    likely-to-accept candidate first.
        const acceptDiff = (b.acceptanceScore ?? -1) - (a.acceptanceScore ?? -1);
        if (acceptDiff !== 0) return acceptDiff;

        // 5. Profile completeness — full profile beats placeholder.
        const aComplete = (a.profileText ? 1 : 0) + (a.headline ? 1 : 0) + (a.location ? 1 : 0);
        const bComplete = (b.profileText ? 1 : 0) + (b.headline ? 1 : 0) + (b.location ? 1 : 0);
        return bComplete - aComplete;
      });
  }, [filter, jobCandidates, normalizedSearchQuery]);

  // Prune selectedIds when candidates leave the filtered view (filter change,
  // search filter, candidate removed). Otherwise bulk-delete or bulk-move
  // would silently target candidates the recruiter can't see.
  useEffect(() => {
    const visibleIds = new Set(filteredCandidates.map((c) => c.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredCandidates]);

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
    return <div className="px-4 py-6 text-center text-slate-500">Job not found.</div>;
  }

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        {/* Title row */}
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight">{job.title}</h1>
              <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0", statusBadge(job.status))}>
                {statusLabel(job.status)}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-500 flex-wrap">
              {job.company && (
                <span className="flex items-center gap-1">
                  <Briefcase className="w-3.5 h-3.5 flex-shrink-0" />
                  {job.company}
                </span>
              )}
              {job.location && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                  {job.location}
                </span>
              )}
            </div>
          </div>
          {/* Overflow ⋯ always visible, even on mobile */}
          <div className="relative flex-shrink-0" ref={overflowRef}>
            <button
              onClick={() => setOverflowOpen((o) => !o)}
              className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors"
              title="More options"
              aria-label="More options"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {overflowOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-20">
                <button
                  onClick={() => { handleExportJdPdf(); setOverflowOpen(false); }}
                  className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <Download className="w-3.5 h-3.5 text-slate-400" />
                  Export JD as PDF
                </button>
                {shortlistCount > 0 && (
                  <button
                    onClick={() => { openModal("report"); setOverflowOpen(false); }}
                    className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <Star className="w-3.5 h-3.5 text-slate-400" />
                    Client report
                  </button>
                )}
                {job.status === "active" && (
                  <>
                    <div className="my-1 border-t border-slate-100" />
                    <button
                      onClick={() => { handleToggleStatus(); setOverflowOpen(false); }}
                      disabled={togglingStatus}
                      className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {togglingStatus
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <X className="w-3.5 h-3.5" />}
                      {togglingStatus ? "Closing…" : "Close job"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons — wrap on mobile */}
        <div className="flex items-center gap-2 flex-wrap mt-3">
          {shortlistCount > 0 && (
            <Link
              href={`/jobs/${id}/shortlist`}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
            >
              <Star className="w-3.5 h-3.5" />
              Shortlist ({shortlistCount})
            </Link>
          )}
          <Button variant="outline" size="sm" onClick={() => openModal("bulkUpload")}>
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Upload CVs</span>
            <span className="sm:hidden">Upload</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => openModal("browseLibrary")}>
            <Users className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">From Library</span>
            <span className="sm:hidden">Library</span>
          </Button>
          <Button onClick={() => openModal("addCandidate")}>
            <UserPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Add Candidate</span>
            <span className="sm:hidden">Add</span>
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

      {/* Onboarding stepper — first card so new users see "what next?" without
          scrolling past the empty pipeline. Auto-dismisses once all steps tick. */}
      <OnboardingCard
        jobId={id}
        hasParsedRole={Boolean(parsedRole)}
        candidateCount={job.candidates.length}
        scoredCount={job.candidates.filter((c) => c.matchScore !== null).length}
      />

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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="relative w-24">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                          <input
                            type="number"
                            placeholder="Min"
                            value={salaryMin}
                            onChange={(e) => setSalaryMin(e.target.value)}
                            className="w-full pl-5 pr-2 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                        <span className="text-slate-400 text-sm">–</span>
                        <div className="relative w-24">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                          <input
                            type="number"
                            placeholder="Max"
                            value={salaryMax}
                            onChange={(e) => setSalaryMax(e.target.value)}
                            className="w-full pl-5 pr-2 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                        <span className="text-slate-400 text-xs">k NZD</span>
                        <button onClick={handleSaveSalary} disabled={savingSalary} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 disabled:opacity-50">
                          {savingSalary ? "…" : "Save"}
                        </button>
                        <button onClick={() => { setEditingSalary(false); setSalaryError(""); }} className="p-1.5 text-slate-400 hover:text-slate-600">
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
                    <p className="text-xs font-medium uppercase tracking-wide mb-2 text-red-600" title="Binary gates — candidates who fail these are excluded regardless of other qualifications. Click × to relax a requirement (treats it as informational only for this search).">Hard Requirements</p>
                    <div className="flex flex-wrap gap-1.5">
                      {parsedRole.knockout_criteria.map((item) => {
                        const isDismissed = dismissed.includes(item);
                        const pendingKey = isDismissed ? `restore-knockout:${item}` : `dismiss-knockout:${item}`;
                        const isPending = pendingReqAction.has(pendingKey);
                        return (
                          <span
                            key={item}
                            title={isDismissed ? "Click ↺ to re-enable this as a hard requirement" : "Click × to relax — candidates without this will still be scored (not automatically excluded)"}
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
                                title="Re-enable as hard requirement"
                                className="text-slate-400 hover:text-red-600 transition-colors flex-shrink-0"
                              >
                                <RotateCcw className="w-2.5 h-2.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRequirementAction("dismiss-knockout", item)}
                                title="Relax this requirement (still shown but won't exclude candidates)"
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

              {/* AI search tips — legacy/rare tech with suggested modern alternatives.
                  Dismissal is session-only (tips reappear on reload / re-analyse). */}
              {(parsedRole.skill_notes?.length ?? 0) > 0 && (
                <SkillNotesSection
                  notes={parsedRole.skill_notes ?? []}
                  dismissedSkills={[]}
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
        <div id="job-search-card">
          <SearchCard
            jobId={id}
            parsedRole={parsedRole}
            jobLocation={job.location}
            jobStatus={job.status}
            onComplete={fetchJob}
          />
        </div>
      )}

      {parsedRole && (
        <SavedSearchesCard
          jobId={id}
          jobStatus={job.status}
          defaultLocation={parsedRole.location?.trim() || job.location?.trim() || "New Zealand"}
          defaultTarget={20}
          defaultQueries={[...(parsedRole.search_queries ?? []), ...(parsedRole.google_queries ?? [])].slice(0, 5)}
          onComplete={fetchJob}
        />
      )}

      {parsedRole && <SearchFunnelCard jobId={id} refreshKey={job.candidates.length} />}

      {parsedRole && <JobWeightsCard jobId={id} />}

      {parsedRole && <ParseHistoryCard jobId={id} />}

      {/* Top matches card — surfaces best unreviewed candidates so recruiter doesn't have to scroll */}
      {filter.length === 0 && (
        <TopCandidatesCard
          candidates={jobCandidates}
          onShortlist={(cid) => handleStatusChange(cid, "shortlisted")}
          onView={(cid) => {
            const el = document.getElementById(`candidate-${cid}`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        />
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
                {filter.length > 0 && (
                  <button
                    onClick={() => setFilter([])}
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
                <Button size="sm" variant="outline" onClick={() => openModal("addCandidate")}>
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

        {/* Needs-profile notice — computed from live candidate list.
            Excludes candidates whose fetch is already in-flight so the
            banner clears as soon as the queue drains, not only after a
            full page reload. */}
        {(() => {
          const needsFetch = job.candidates.filter(
            (c) => c.linkedinUrl &&
                   !hasFullCandidateProfile(c) &&
                   fetchStatuses[c.id]?.state !== "waiting" &&
                   fetchStatuses[c.id]?.state !== "fetching"
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
        {job && job.lastParsedAt && job.lastScoredAt && job.candidates.length > 0 && !rescoringAll && !rescoreResult && (() => {
          const parsedMs  = new Date(job.lastParsedAt!).getTime();
          const scoredMs  = new Date(job.lastScoredAt!).getTime();
          return parsedMs > scoredMs ? (
            <div className="mb-3 flex items-center justify-between gap-3 text-xs rounded-lg px-3 py-2 border text-amber-700 bg-amber-50 border-amber-200">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Requirements updated since last score — re-score all to apply new criteria.</span>
              </div>
              <button
                onClick={handleRescoreAll}
                disabled={rescoringAll}
                className="text-xs font-medium px-3 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:bg-slate-300"
              >
                Re-score all now
              </button>
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
          <div className="text-center py-12 px-6 bg-white rounded-xl border border-slate-200 border-dashed">
            <Users className="w-10 h-10 text-slate-400 mx-auto mb-3" />
            <p className="text-slate-700 text-sm font-semibold mb-1">
              {filter.length === 0
                ? (jobCandidates.length === 0 ? "No candidates yet" : "No candidates match your filter")
                : (filter.length === 1
                    ? `No ${statusLabel(filter[0]).toLowerCase()} candidates`
                    : `No candidates in the ${filter.length} selected statuses`)}
            </p>
            {filter.length === 0 && jobCandidates.length === 0 && parsedRole && (
              <>
                <p className="text-slate-500 text-xs mt-1 mb-4">
                  Find candidates from the role brief, or add them manually below.
                </p>
                <button
                  onClick={() => document.getElementById("job-search-card")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Find candidates
                </button>
              </>
            )}
            {filter.length === 0 && jobCandidates.length === 0 && !parsedRole && (
              <p className="text-slate-500 text-xs mt-1">
                Paste a job description above and click <strong>Analyse</strong> to start.
              </p>
            )}
            {filter.length > 0 && (
              <button
                onClick={() => setFilter([])}
                className="text-blue-600 hover:text-blue-700 text-xs underline underline-offset-2 mt-2"
              >
                Clear filter
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredCandidates.slice(0, renderCap).map((candidate) => (
              <div key={candidate.id} id={`candidate-${candidate.id}`} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-4 w-4 h-4 rounded border-slate-300 text-blue-600 cursor-pointer flex-shrink-0"
                  checked={selectedIds.has(candidate.id)}
                  onChange={() => toggleSelect(candidate.id)}
                  aria-label={`Select ${candidate.name}`}
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
                      fetchStatuses[candidate.id]?.state === "fetching" ||
                      fetchStatuses[candidate.id]?.state === "queued"
                    }
                    fetchQueueState={fetchStatuses[candidate.id]?.state}
                    fetchQueuePosition={fetchStatuses[candidate.id]?.queuePosition}
                    contactCount={candidate._count?.contactEvents ?? 0}
                  />
                </div>
              </div>
            ))}
            {renderCap < filteredCandidates.length && (
              <div className="flex items-center justify-center gap-3 py-4">
                <button
                  onClick={() => setRenderCap((n) => n + RENDER_BATCH_SIZE)}
                  className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
                >
                  Show {Math.min(RENDER_BATCH_SIZE, filteredCandidates.length - renderCap)} more
                </button>
                <button
                  onClick={() => setRenderCap(filteredCandidates.length)}
                  className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
                >
                  Show all {filteredCandidates.length}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!fetchPanelDismissed && (
        <FetchQueuePanel
          statuses={fetchStatuses}
          candidateNames={Object.fromEntries((job?.candidates ?? []).map((c) => [c.id, c.name]))}
          onDismiss={() => setFetchPanelDismissed(true)}
          onCancel={handleCancelFetch}
        />
      )}

      {modals.report && (
        <ClientReportModal
          jobId={id}
          jobTitle={job.title}
          jobParsedRole={job.parsedRole}
          candidates={job.candidates}
          onClose={() => closeModal("report")}
        />
      )}

      {modals.bulkUpload && (
        <BulkUploadModal jobId={id} onClose={() => closeModal("bulkUpload")} onComplete={fetchJob} />
      )}

      {modals.browseLibrary && (
        <BrowseLibraryModal jobId={id} onClose={() => closeModal("browseLibrary")} onComplete={fetchJob} />
      )}

      {modals.addCandidate && (
        <AddCandidateModal
          jobId={id}
          parsedRole={parsedRole}
          onClose={() => closeModal("addCandidate")}
          onComplete={(createdId) => {
            closeModal("addCandidate");
            fetchJob().then(() => {
              if (createdId) handleFetchProfile(createdId);
            });
          }}
        />
      )}
    </div>
  );
}
