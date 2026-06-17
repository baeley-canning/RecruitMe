"use client";

import { useDeferredValue, useEffect, useMemo, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  RefreshCw,
  Search,
  UserPlus,
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
import { confirm } from "@/components/ui/confirm-dialog";
import { CandidateCard } from "@/components/candidate-card";
import { AiStatusBanner } from "@/components/ai-status-banner";
import { BulkUploadModal } from "@/components/bulk-upload-modal";
import { FetchQueuePanel } from "@/components/fetch-queue-panel";
import type { FetchStatus } from "@/components/fetch-queue-panel";
import { SearchFunnelCard } from "@/components/job/search-funnel-card";
import { SavedSearchesCard } from "@/components/job/saved-searches-card";
import { OnboardingCard } from "@/components/job/onboarding-card";
import { JobWeightsCard } from "@/components/job/job-weights-card";
import { TopCandidatesCard } from "@/components/job/top-candidates-card";
import { BrowseLibraryModal } from "@/components/job/browse-library-modal";
import { UnifiedSearchModal } from "@/components/job/unified-search-modal";
import { PipelineStepper, type PipelineStage } from "@/components/job/pipeline-stepper";
import { SkillNotesSection } from "@/components/job/skill-notes-section";
import { ParseHistoryCard } from "@/components/job/parse-history-card";
import { ClientReportModal } from "@/components/job/client-report-modal";
import { AddCandidateModal } from "@/components/job/add-candidate-modal";
import { SubmitToClientModal } from "@/components/job/submit-to-client-modal";
import { SubmissionsCard } from "@/components/job/submissions-card";
import { cn, statusLabel, safeParseJson } from "@/lib/utils";
import type { ParsedRole } from "@/lib/ai";


interface Candidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  seekUrl: string | null;
  phone: string | null;
  email: string | null;
  photoFileId: string | null;
  // Optional: stripped from the GET /api/jobs/[id] candidate select (payload
  // size) — undefined on the list, hydrated on a per-candidate fetch. Optional
  // typing forces null-safe access (see candidate-card.tsx + job-candidate-select.ts).
  profileText?: string | null;
  /** Cross-job presence: this candidate's LinkedIn URL also matches one or
   *  more OTHER active jobs in the same org. Empty array = unique to this job. */
  otherActiveJobs?: Array<{ jobId: string; title: string; company: string | null; matchScore: number | null }>;
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
  scoreBreakdown?: string | null;
  notes: string | null;
  screeningData?: string | null;
  interviewNotes?: string | null;
  status: string;
  statusHistory?: string | null;
  tagAssignments?: Array<{ tag: { id: string; label: string; color: string } }>;
  source: string;
  createdAt: string;
}

interface Job {
  id: string;
  title: string;
  company: string | null;
  excludedCompanies: string | null;
  location: string | null;
  location2: string | null;
  rawJd: string;
  parsedRole: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  status: string;
  lastScoredAt: string | null;
  lastParsedAt: string | null;
  candidates: Candidate[];
  /** Server-resolved feature flag — gates CRM-only UI (e.g. Submit to client). */
  crmEnabled?: boolean;
  /** Reminders/Tags feature flag — gates tag chips/editor on cards. */
  remindersEnabled?: boolean;
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
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide",
        normalized === "explicit"
          ? "bg-success-subtle text-success"
          : "bg-accent-subtle text-accent"
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
      <p className={cn("text-2xs font-medium uppercase tracking-wide mb-2", labelClassName ?? "text-text-tertiary")}>
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {cleanItems.map((item) => (
          <span
            key={item}
            className={cn(
              "px-1.5 py-0.5 text-xs rounded-sm",
              chipClassName,
              monospace && "font-mono tabular-nums"
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
    addCandidate:  false,
    browseLibrary: false,
    bulkUpload:    false,
    report:        false,
    multiSearch:   false,
  });
  const openModal  = useCallback((k: keyof typeof modals) => setModals(m => ({ ...m, [k]: true  })), []);
  const closeModal = useCallback((k: keyof typeof modals) => setModals(m => ({ ...m, [k]: false })), []);

  // CRM "Submit to client" — tracks which candidate's modal is open.
  const [submitCandidateId, setSubmitCandidateId] = useState<string | null>(null);
  const handleSubmitToClient = useCallback((cid: string) => setSubmitCandidateId(cid), []);
  // Bumped after a successful submit so the SubmissionsCard refetches.
  const [submissionsRefreshKey, setSubmissionsRefreshKey] = useState(0);

  // Overflow (⋯) menu for low-frequency header actions
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  // Jobs whose role search has already auto-fired this session — so re-opening
  // the search modal doesn't re-enqueue a fresh live LinkedIn scrape each time.
  const autoRanJobsRef = useRef<Set<string>>(new Set());

  // The job's latest durable search run. Drives the "resume" affordance: the
  // search lives server-side on the box, so reopening the modal continues it and
  // the page shows whether one is still running even after a tab close.
  const [latestRun, setLatestRun] = useState<{ id: string; status: string; total: number } | null>(null);
  const fetchLatestRun = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${id}/search/latest`);
      if (!res.ok) return;
      const data = (await res.json()) as { run: { id: string; status: string; counts: { total: number } } | null };
      setLatestRun(data.run ? { id: data.run.id, status: data.run.status, total: data.run.counts.total } : null);
    } catch {
      /* non-fatal — the resume affordance just won't show */
    }
  }, [id]);
  useEffect(() => { void fetchLatestRun(); }, [fetchLatestRun]);
  // While a run is in flight, poll so the page banner reflects completion even
  // with the modal closed. Stops once the run reaches a terminal status.
  const runInFlight = latestRun?.status === "queued" || latestRun?.status === "running";
  useEffect(() => {
    if (!runInFlight) return;
    const t = setInterval(() => { void fetchLatestRun(); }, 5000);
    return () => clearInterval(t);
  }, [runInFlight, fetchLatestRun]);

  // Signature of the funnel's inputs (each candidate's status + scored-ness) so
  // the Discovery funnel REFETCHES when a candidate is shortlisted/contacted/
  // rejected or scored — not only when the count changes. Keying on
  // job.candidates.length missed status changes, so shortlisting showed
  // "SHORTLISTED 0" until a full reload (a stale-render bug, not lost data).
  const funnelRefreshKey = useMemo(
    () => (job ? job.candidates.map((c) => `${c.status}:${c.matchScore == null ? "" : "s"}`).join("|") : ""),
    [job],
  );

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
  // Each Fetch click creates its own server session immediately and the
  // extension paces actual LinkedIn captures via its own rate limiter — so
  // there is no client-side queue. The recruiter can have N sessions in
  // flight; the extension grinds through them in age order.
  // PipelineStepper-driven stage filter. "all" = no filter; a stage value
  // narrows the candidate list to that pipeline bucket (see filteredCandidates
  // below for the stage→status mapping). Replaces the previous string-array
  // filter while preserving all downstream behaviour (Top Candidates, empty
  // states, bulk select pruning).
  const [selectedStage, setSelectedStage] = useState<PipelineStage | "all">("all");
  // Progressive rendering — render the first N candidates initially, expand on
  // recruiter request. Each CandidateCard is heavy (1600+ line component);
  // rendering 500 of them on a job page creates a noticeable initial-paint
  // delay. Capping the first batch keeps the page snappy at any scale; the
  // "Show all" button reveals the rest when needed.
  const RENDER_BATCH_SIZE = 50;
  const [renderCap, setRenderCap] = useState<number>(RENDER_BATCH_SIZE);
  const [searchQuery, setSearchQuery] = useState("");
  // Minimum match-score filter — recruiter's "call list today" lever. Default
  // 0 = show everything. Set above 0 and the candidate list collapses to
  // only candidates at or above that score, so the recruiter can isolate
  // (say) the top-quartile in two clicks. Unscored candidates are always
  // shown when minScoreFilter is 0 and hidden when it's >0.
  const [minScoreFilter, setMinScoreFilter] = useState<number>(0);
  // Snippet-only candidates are partial-profile data. Some recruiters want
  // to focus on candidates with full profiles; others want the wider net.
  // Default off (show both).
  const [hideSnippetOnly, setHideSnippetOnly] = useState(false);
  const [rescoringAll, setRescoringAll] = useState(false);
  const [rescoreResult, setRescoreResult] = useState<{ scored: number; total: number; failedIds?: string[]; partial?: boolean } | null>(null);
  const [rescoreProgress, setRescoreProgress] = useState<{ scored: number; total: number } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkStatusChanging, setBulkStatusChanging] = useState(false);
  const [bulkCapturing, setBulkCapturing] = useState(false);
  const [salaryMin, setSalaryMin] = useState<string>("");
  const [salaryMax, setSalaryMax] = useState<string>("");
  const [editingSalary, setEditingSalary] = useState(false);
  const [savingSalary, setSavingSalary] = useState(false);
  const [salaryError, setSalaryError] = useState("");
  const [editingLocation, setEditingLocation] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationDraft, setLocationDraft] = useState("");
  const [location2Draft, setLocation2Draft] = useState("");
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
    // Set by handleCancelFetch when the user cancels before the session POST
    // resolves, so the orchestrator's .then can short-circuit instead of
    // navigating an orphan tab and starting a stale poll loop.
    aborted: boolean;
  }
  const jobRef = useRef<Job | null>(null);
  const activeFetchesRef = useRef<Map<string, FetchEntry>>(new Map());
  // Stable fn-refs so setInterval callbacks always call the latest version.
  const pollCandidateFetchRef = useRef<(candidateId: string) => Promise<void>>(async () => {});
  const finishFetchRef = useRef<(candidateId: string, state: "done" | "error", message: string) => void>(() => {});

  const fetchJob = useCallback(async (signal?: AbortSignal) => {
    try {
      // no-store so a post-add / post-status-change refetch never serves the
      // browser's cached (stale) list — that's what forced a manual reload.
      const res = await fetch(`/api/jobs/${id}`, { signal, cache: "no-store" });
      if (signal?.aborted) return;
      if (res.ok) {
        const data = await res.json() as Job;
        if (signal?.aborted) return;
        setJob(data);
        // Inputs are in FULL NZD dollars (e.g. 100000), matching the "$" prefix.
        setSalaryMin(data.salaryMin ? String(data.salaryMin) : "");
        setSalaryMax(data.salaryMax ? String(data.salaryMax) : "");
        setFetchError(false);
      } else {
        setFetchError(true);
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setFetchError(true);
    } finally {
      if (signal?.aborted) return;
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFetchError(false);
    setJob(null);
    void fetchJob(controller.signal);
    return () => controller.abort();
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
        const entry: FetchEntry = {
          sessionId: s.sessionId,
          candidateId: s.candidateId,
          startedAt: serverCreatedAt,
          processingStartedAt: s.status === "processing" ? serverUpdatedAt : null,
          lastKnownStatus: s.status as "pending" | "processing",
          done: false,
          pollInterval: null,
          consecutiveNetworkErrors: 0,
          aborted: false,
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
      // Unmount can be a route change, refresh, or React remount while the
      // extension is still working. Clear local timers only; the server
      // session is recovered on the next mount via the resume effect above.
      for (const entry of ref.values()) {
        if (entry.pollInterval) clearInterval(entry.pollInterval);
      }
      ref.clear();
    };
  }, []);

  const handleSaveSalary = async () => {
    if (!job) return;
    // Inputs are FULL NZD dollars (e.g. 100000 = $100k) — stored as-is.
    const min = salaryMin ? Math.round(parseFloat(salaryMin)) : null;
    const max = salaryMax ? Math.round(parseFloat(salaryMax)) : null;
    if ((min != null && (Number.isNaN(min) || min < 0)) || (max != null && (Number.isNaN(max) || max < 0))) {
      setSalaryError("Enter a valid amount in NZD");
      return;
    }
    if (min != null && max != null && min > max) {
      setSalaryError("Minimum cannot exceed maximum");
      return;
    }
    const MAX_SALARY = 2_000_000;
    if ((min != null && min > MAX_SALARY) || (max != null && max > MAX_SALARY)) {
      setSalaryError("Amount looks too large — enter the full salary in NZD (e.g. 120000)");
      return;
    }
    setSalaryError("");
    setSavingSalary(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salaryMin: min, salaryMax: max }),
      });
      if (res.ok) {
        const updated = await res.json() as Job;
        setJob((prev) => prev ? { ...prev, salaryMin: updated.salaryMin, salaryMax: updated.salaryMax } : prev);
        setEditingSalary(false);
      } else {
        // Never fail silently — surface why the save didn't take.
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setSalaryError(typeof body.error === "string" ? body.error : `Couldn't save salary (${res.status})`);
      }
    } catch {
      setSalaryError("Couldn't save salary — check your connection and try again");
    } finally {
      setSavingSalary(false);
    }
  };

  const handleSaveLocation = async () => {
    if (!job) return;
    setSavingLocation(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Empty string clears location2 (recruiter removed the second city).
        body: JSON.stringify({
          location:  locationDraft.trim(),
          location2: location2Draft.trim() || null,
        }),
      });
      if (res.ok) {
        const updated = await res.json() as Job;
        setJob((prev) => prev ? { ...prev, location: updated.location, location2: updated.location2 } : prev);
        setEditingLocation(false);
      } else {
        showToast("Failed to save location — please try again", "error");
      }
    } finally {
      setSavingLocation(false);
    }
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
      } else {
        showToast("Failed to save job description — please try again", "error");
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
      if (res.ok) {
        await fetchJob();
      } else {
        showToast("Failed to accept alternative — please try again", "error");
      }
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
    setParseChanges([]);
    try {
      const res = await fetch(`/api/jobs/${id}/parse`, { method: "POST" });
      // .catch(() => ({})) so an empty 500 body doesn't crash res.json() —
      // we want the recruiter to see SOMETHING after a re-analyse, never
      // a silent spinner-stop with no banner.
      const data = await res.json().catch(() => ({})) as {
        parsedRole?: ParsedRole;
        changes?: string[];
        error?: string;
        warning?: string;
      };
      if (!res.ok || data.error) {
        setParseError(data.error ?? `Parsing failed (HTTP ${res.status})`);
      } else if (data.warning) {
        // The route emits `warning` when the AI parse fell back to the
        // regex-minimal path (Claude couldn't extract requirements but the
        // JD itself was probably fine). Surface it — without this the
        // recruiter just sees the spinner stop with no feedback.
        setParseChanges([data.warning]);
        await fetchJob();
      } else if (data.changes?.length) {
        setParseChanges(data.changes);
        await fetchJob();
      } else {
        setParseChanges(["Re-analysed — requirements are the same as before"]);
        await fetchJob();
      }
    } catch (err) {
      console.error("[parse] handleParse threw:", err);
      setParseError(`Parsing failed — ${err instanceof Error ? err.message : "check your connection and try again"}.`);
    } finally {
      setParsing(false);
    }
  };

  const handleCancelFetch = useCallback((candidateId: string) => {
    const entry = activeFetchesRef.current.get(candidateId);
    if (entry) {
      // Mark aborted so the in-flight orchestrator .then bails out instead of
      // navigating the tab and starting a polling interval.
      entry.aborted = true;
      if (entry.pollInterval) clearInterval(entry.pollInterval);
    }
    activeFetchesRef.current.delete(candidateId);
    // Cancel the session on the server only if we actually have one — the
    // POST may not have resolved yet, in which case the orchestrator's
    // aborted-branch handles the eventual DELETE.
    if (entry?.sessionId) {
      fetch(`/api/extension/fetch-session?sessionId=${encodeURIComponent(entry.sessionId)}`, {
        method: "DELETE", credentials: "include",
      }).catch(() => {});
    }
    setFetchStatuses((prev) => { const next = { ...prev }; delete next[candidateId]; return next; });
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
    // happens for 3 minutes the extension probably isn't running.
    // Processing = extension is capturing, possibly navigating to LinkedIn's
    // /details/experience page, then saving + scoring. Allow 7 minutes.
    const PENDING_LIMIT    = 180_000;  // 3 min
    const PROCESSING_LIMIT = 420_000;  // 7 min
    if (entry.lastKnownStatus === "processing") {
      const processingStartedAt = entry.processingStartedAt ?? now;
      if (now - processingStartedAt > PROCESSING_LIMIT) {
        finishFetchRef.current(
          candidateId,
          "error",
          "Capture started but took too long to finish — refresh the job to resume tracking, or re-score if the profile saved."
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

  // The Fetch click handler MUST NOT await before window.open — losing the
  // user-gesture flag triggers the popup blocker. We open a blank tab inside
  // the gesture, POST the session, then navigate the existing tab to
  // LinkedIn. Race fix: opening LinkedIn directly meant the extension's
  // /pending check could fire before the session existed, bailing in
  // manual-only mode.
  // Fetch a full profile via the BOX scraper (mini-PC), NOT the browser
  // extension. Enqueues a priority profile job through the same proven path as
  // Bulk Capture, then polls until the worker scrapes + ingests the profile onto
  // this candidate row. No LinkedIn tab, no extension — the recruiter can walk
  // away and the box finishes it. handleCancelFetch just stops the UI poll (the
  // queued job is harmless / deduped if re-requested).
  const handleFetchProfile = useCallback((candidateId: string) => {
    const candidate = job?.candidates.find((c) => c.id === candidateId);
    if (!candidate?.linkedinUrl) return;
    if (activeFetchesRef.current.has(candidateId)) return;
    setFetchPanelDismissed(false);

    const placeholder: FetchEntry = {
      sessionId: "", // no extension session — box path
      candidateId,
      startedAt: Date.now(),
      processingStartedAt: null,
      lastKnownStatus: "pending",
      done: false,
      pollInterval: null,
      consecutiveNetworkErrors: 0,
      aborted: false,
    };
    activeFetchesRef.current.set(candidateId, placeholder);
    setFetchStatuses((prev) => ({
      ...prev,
      [candidateId]: { state: "waiting", message: "Queued on the box…", startedAt: placeholder.startedAt },
    }));

    const finishBox = (state: "done" | "error", message: string) => {
      const e = activeFetchesRef.current.get(candidateId);
      if (e?.pollInterval) clearInterval(e.pollInterval);
      activeFetchesRef.current.delete(candidateId);
      setFetchStatuses((prev) => ({ ...prev, [candidateId]: { state, message } }));
      if (state === "done") void fetchJob();
      clearCandidateStatus(candidateId, state === "done" ? 4000 : 7000, state);
    };

    void (async () => {
      try {
        // Reuse the Bulk Capture endpoint with a single id — it enqueues a paced
        // box profile job (deduped on the URL) tied to this candidateId.
        const res = await fetch(`/api/jobs/${id}/candidates/bulk-capture`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [candidateId] }),
        });
        const data = (await res.json().catch(() => null)) as
          | { enqueued?: number; alreadyFull?: number; alreadyQueued?: number; noCapturableUrl?: number }
          | null;
        if (placeholder.aborted) return;
        if (!res.ok || !data) { finishBox("error", "Couldn't queue the fetch on the box"); return; }
        if (data.alreadyFull) { finishBox("done", "Already fetched"); return; }
        if (data.noCapturableUrl) { finishBox("error", "No LinkedIn URL to fetch"); return; }

        // Enqueued (or already in flight) → poll the job's capture progress until
        // the profile lands on the candidate row.
        setFetchStatuses((prev) => ({
          ...prev,
          [candidateId]: { state: "fetching", message: "Fetching on the box…", startedAt: placeholder.startedAt },
        }));
        const interval = setInterval(() => {
          const e = activeFetchesRef.current.get(candidateId);
          if (!e || e.aborted) { clearInterval(interval); return; }
          // The box scrapes at ~30–40s/profile; give it a generous ceiling
          // before telling the recruiter to check back.
          if (Date.now() - e.startedAt > 6 * 60_000) {
            finishBox("error", "Still queued on the box — check back shortly");
            return;
          }
          void fetch(`/api/jobs/${id}/candidates/bulk-capture?ids=${encodeURIComponent(candidateId)}`, { credentials: "include" })
            .then((r) => (r.ok ? (r.json() as Promise<{ total: number; captured: number }>) : null))
            .then((p) => { if (p && p.captured >= 1) finishBox("done", "Profile fetched"); })
            .catch(() => {/* transient — next tick retries */});
        }, 4000);
        placeholder.pollInterval = interval;
        if (placeholder.aborted) clearInterval(interval);
      } catch {
        if (!placeholder.aborted) finishBox("error", "Network error queuing the fetch");
      }
    })();
  }, [id, job]);  // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleSeekChange = useCallback(
    (candidateId: string, seekUrl: string) =>
      patchCandidate(candidateId, { seekUrl: seekUrl || null }, "SEEK URL saved").then(() => undefined),
    [patchCandidate]
  );

  const handleNameChange = useCallback(
    (candidateId: string, name: string) =>
      patchCandidate(candidateId, { name: name || null }, "Name saved").then(() => undefined),
    [patchCandidate]
  );

  const handleHeadlineChange = useCallback(
    (candidateId: string, headline: string) =>
      patchCandidate(candidateId, { headline: headline || null }, "Headline saved").then(() => undefined),
    [patchCandidate]
  );

  const handleLocationChange = useCallback(
    (candidateId: string, location: string) =>
      patchCandidate(candidateId, { location: location || null }, "Location saved").then(() => undefined),
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

  const handleRescoreAll = async (force = false) => {
    setRescoringAll(true);
    setRescoreResult(null);
    setRescoreProgress(null);

    // The stream can be cut by a proxy/duration timeout on a big run. The server
    // commits each candidate's score as it goes and a re-run SKIPS already-scored
    // candidates (the profileTextHash cache), so we AUTO-RESUME instead of making
    // the user re-run and watch the counter restart. Resume passes always use the
    // cache (force=false) — so work already done is skipped, never re-billed.
    // Progress shows scored+cached (cumulative done), so it visibly picks up where
    // it left off rather than looking like it restarted at 0.
    const MAX_ITERS = 20;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let total = 0;
    let bestDone = 0;          // high-water mark of (scored+cached) across passes
    let finishedClean = false;
    let failedIds: string[] = [];
    let cappedMsg: string | null = null;
    let hardError: string | null = null;
    let noGain = 0;            // consecutive streamed passes with no new progress

    try {
      for (let iter = 0; iter < MAX_ITERS; iter++) {
        const useForce = force && iter === 0; // only the FIRST pass forces; resumes skip the done
        const res = await fetch(`/api/jobs/${id}/candidates/score-all${useForce ? "?force=1" : ""}`, { method: "POST" });

        if (res.status === 429) {
          // Run-claim cooldown still active (the prior pass's server run hasn't
          // aged out / is still finishing). Wait and resume — do NOT restart.
          if (bestDone > 0) { await sleep(10_000); continue; }
          const data = await res.json().catch(() => ({})) as { error?: string };
          hardError = data.error || "Score-all is already running. Try again in a minute.";
          break;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          hardError = data.error || "Scoring failed — please try again";
          break;
        }
        if (!res.body) break;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let passDone = 0;          // (scored+cached) within this pass
        let passFinished = false;
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
                const msg = JSON.parse(line) as { scored: number; cached?: number; total: number; done?: boolean; failedIds?: string[]; capped?: boolean; error?: string };
                total = msg.total;
                passDone = msg.scored + (msg.cached ?? 0);
                setRescoreProgress({ scored: Math.max(bestDone, passDone), total: msg.total });
                if (msg.capped) cappedMsg = msg.error ?? "Daily AI spend cap reached.";
                if (msg.done) { passFinished = true; failedIds = msg.failedIds ?? []; }
              } catch { /* ignore malformed lines */ }
            }
          }
        } catch { /* stream dropped mid-pass — fall through to the resume decision */ }

        const gained = passDone > bestDone;
        bestDone = Math.max(bestDone, passDone);

        if (passFinished) { finishedClean = true; break; }   // server sent done:true
        if (cappedMsg) break;                                  // spend cap hit — stop
        // Stream dropped without finishing. Stop if two passes in a row made no
        // forward progress (a candidate stuck mid-pass), else loop to resume.
        noGain = gained ? 0 : noGain + 1;
        if (noGain >= 2) break;
        await sleep(1_500);
      }

      if (hardError && bestDone === 0) {
        showToast(hardError, "error");
      } else if (cappedMsg) {
        setRescoreResult({ scored: bestDone, total, failedIds: [], partial: true });
        showToast(cappedMsg, "error");
      } else if (finishedClean) {
        setRescoreResult({ scored: bestDone, total, failedIds });
      } else {
        // Couldn't fully finish even after auto-resume — show what's done; a
        // manual re-run will pick up the remainder (cache skips the done).
        setRescoreResult({ scored: bestDone, total, failedIds: [], partial: true });
      }
      await fetchJob();
    } finally {
      setRescoringAll(false);
      setRescoreProgress(null);
    }
  };

  const handleDelete = useCallback(async (candidateId: string) => {
    if (!await confirm({ message: "Remove this candidate?", danger: true, confirmLabel: "Remove" })) return;
    const res = await fetch(`/api/jobs/${id}/candidates/${candidateId}`, { method: "DELETE" });
    if (!res.ok) { showToast("Delete failed — please try again", "error"); return; }
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(candidateId); return next; });
    await fetchJob();
  }, [fetchJob, id]);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!await confirm({ title: "Bulk delete?", message: `Delete ${selectedIds.size} candidate${selectedIds.size > 1 ? "s" : ""}? This cannot be undone.`, danger: true, confirmLabel: "Delete all" })) return;
    setBulkDeleting(true);
    const res = await fetch(`/api/jobs/${id}/candidates/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selectedIds] }),
    });
    if (!res.ok) {
      showToast("Bulk delete failed — please try again", "error");
    }
    setSelectedIds(new Set());
    setBulkDeleting(false);
    await fetchJob();
  };

  // Action-plan #6: bulk profile capture. Enqueues paced LinkedIn/JobAdder
  // profile fetches for the selected thin candidates (SEEK excluded — credits).
  // The single-browser scraper works through them at a safe pace, so it's
  // honest about timing: they hydrate over the next several minutes, then can
  // be re-scored. No polling UI in v1 — refresh to see them fill in.
  const handleBulkCapture = async () => {
    if (selectedIds.size === 0) return;
    setBulkCapturing(true);
    try {
      const res = await fetch(`/api/jobs/${id}/candidates/bulk-capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      if (!res.ok) { showToast("Couldn't start profile capture — please try again", "error"); return; }
      const data = await res.json() as { enqueued: number; alreadyFull: number; alreadyQueued: number; noCapturableUrl: number };
      if (data.enqueued === 0) {
        showToast(
          data.noCapturableUrl > 0
            ? "No LinkedIn/JobAdder profile to capture for those (SEEK isn't supported yet)."
            : "Nothing to capture — those already have full profiles or a fetch is in progress.",
          "info",
        );
      } else {
        showToast(`Capturing ${data.enqueued} full profile${data.enqueued > 1 ? "s" : ""} — the scraper works through them at a safe pace (~½–1 min each), so they'll fill in over the next several minutes. Refresh to see them, then Re-score.`, "success");
        setSelectedIds(new Set());
      }
    } catch {
      showToast("Couldn't start profile capture — please try again", "error");
    } finally {
      setBulkCapturing(false);
    }
  };

  const handleBulkStatusChange = async (status: string) => {
    if (selectedIds.size === 0) return;
    if (!await confirm({ message: `Move ${selectedIds.size} candidate${selectedIds.size > 1 ? "s" : ""} to "${statusLabel(status)}"?`, confirmLabel: "Move" })) return;
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
      showToast(`${failCount} of ${selectedIds.size} status updates failed — refresh and retry`, "error");
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
      .filter((candidate) => {
        // Stage → status mapping (mirrors the buckets surfaced by
        // PipelineStepper). "fetched" deliberately includes "scored" rows
        // because the stepper renders both — clicking Fetched should still
        // show those candidates.
        if (selectedStage === "all") return true;
        if (selectedStage === "fetched") {
          return candidate.status === "new" || candidate.status === "reviewing";
        }
        if (selectedStage === "scored") {
          return (
            (candidate.status === "new" || candidate.status === "reviewing") &&
            (candidate.matchScore ?? 0) > 0
          );
        }
        if (selectedStage === "shortlisted") return candidate.status === "shortlisted";
        if (selectedStage === "contacted") {
          return (
            candidate.status === "contacted" ||
            candidate.status === "interviewing" ||
            candidate.status === "offer_sent"
          );
        }
        if (selectedStage === "hired") return candidate.status === "hired";
        return true;
      })
      .filter((candidate) => {
        if (!normalizedSearchQuery) return true;
        return (
          candidate.name.toLowerCase().includes(normalizedSearchQuery) ||
          (candidate.headline ?? "").toLowerCase().includes(normalizedSearchQuery) ||
          (candidate.location ?? "").toLowerCase().includes(normalizedSearchQuery) ||
          (candidate.notes ?? "").toLowerCase().includes(normalizedSearchQuery)
        );
      })
      .filter((candidate) => {
        // Min-score filter. When 0, pass everything. Above 0, require a
        // numeric matchScore at or above the threshold. UNSCORED candidates
        // (null) are KEPT visible — adversarial-review caught that hiding
        // them creates a false "empty list" impression when the recruiter
        // has unscored candidates in the pipeline. They sort to the bottom
        // by the existing tiebreakers (profile completeness, etc.) and
        // their "needs scoring" affordance is visible on the card.
        if (minScoreFilter <= 0) return true;
        if (candidate.matchScore == null) return true;
        return candidate.matchScore >= minScoreFilter;
      })
      .filter((candidate) => {
        // Snippet/partial-profile filter — recruiters who only want to call
        // candidates with verified full profiles can toggle this. NB: the API
        // strips profileText from the list payload, so key on profileCapturedAt
        // (a full profile was actually captured) — checking profileText here
        // matched NOTHING and made the "Full profiles only" toggle hide everything.
        if (!hideSnippetOnly) return true;
        return Boolean(candidate.profileCapturedAt);
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
        // profileText is stripped from the list payload — use profileCapturedAt
        // (full profile captured) as the completeness signal instead.
        const aComplete = (a.profileCapturedAt ? 1 : 0) + (a.headline ? 1 : 0) + (a.location ? 1 : 0);
        const bComplete = (b.profileCapturedAt ? 1 : 0) + (b.headline ? 1 : 0) + (b.location ? 1 : 0);
        return bComplete - aComplete;
      });
  }, [selectedStage, jobCandidates, normalizedSearchQuery, minScoreFilter, hideSnippetOnly]);

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

  // Pipeline-stepper bucket counts. "fetched" includes everything pre-shortlist
  // (new + reviewing). "scored" is a subset of fetched with matchScore > 0
  // (the stepper is fine rendering both — same source data, two lenses).
  const pipelineCounts = useMemo<Record<PipelineStage, number>>(() => {
    let fetched = 0, scored = 0, shortlisted = 0, contacted = 0, hired = 0;
    for (const c of jobCandidates) {
      if (c.status === "new" || c.status === "reviewing") {
        fetched += 1;
        if ((c.matchScore ?? 0) > 0) scored += 1;
      } else if (c.status === "shortlisted") {
        shortlisted += 1;
      } else if (c.status === "contacted" || c.status === "interviewing" || c.status === "offer_sent") {
        contacted += 1;
      } else if (c.status === "hired") {
        hired += 1;
      }
    }
    return { fetched, scored, shortlisted, contacted, hired };
  }, [jobCandidates]);
  const rejectedCount =
    (statusCounts.declined ?? 0) + (statusCounts.rejected ?? 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="p-6 text-center">
        <AlertCircle className="w-7 h-7 text-danger mx-auto mb-3" />
        <p className="text-text-primary font-medium mb-1">Failed to load job</p>
        <p className="text-text-tertiary text-sm mb-4">Check your connection and try again.</p>
        <button
          onClick={() => { setLoading(true); setFetchError(false); fetchJob(); }}
          className="h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="px-4 py-6 text-center text-text-tertiary">
        Job not found.{" "}
        <Link href="/dashboard" className="text-accent hover:text-accent-hover">Back to dashboard</Link>
      </div>
    );
  }

  const jobStatusPillClass =
    job.status === "active"
      ? "bg-success-subtle text-success"
      : job.status === "closed"
        ? "bg-surface-hover text-text-secondary"
        : "bg-surface-hover text-text-secondary";

  return (
    <div className="max-w-5xl mx-auto">
      {/* Toolbar — 36px page chrome. Title left, actions right. */}
      <div className="toolbar -mx-4 sm:mx-0 sm:rounded-md mb-3">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <h1 className="text-md font-semibold text-text-primary truncate">{job.title}</h1>
          <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium uppercase tracking-wide flex-shrink-0", jobStatusPillClass)}>
            {statusLabel(job.status)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {shortlistCount > 0 && (
            <Link
              href={`/jobs/${id}/shortlist`}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-md font-medium text-warning bg-warning-subtle hover:bg-warning/25 transition-colors"
            >
              <Star className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Shortlist</span>
              <span className="data-mono">{shortlistCount}</span>
            </Link>
          )}
          <Button variant="secondary" size="md" onClick={() => openModal("bulkUpload")}>
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Upload CVs</span>
          </Button>
          <Button variant="secondary" size="md" onClick={() => openModal("browseLibrary")}>
            <Users className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Library</span>
          </Button>
          <Button variant="secondary" size="md" onClick={() => openModal("multiSearch")}>
            {runInFlight ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="hidden sm:inline">Search running…</span>
              </>
            ) : (
              <>
                <Search className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Search talent</span>
              </>
            )}
          </Button>
          <Button onClick={() => openModal("addCandidate")}>
            <UserPlus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Add Candidate</span>
            <span className="sm:hidden">Add</span>
          </Button>
          {/* Overflow ⋯ */}
          <div className="relative" ref={overflowRef}>
            <button
              onClick={() => setOverflowOpen((o) => !o)}
              className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
              title="More options"
              aria-label="More options"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {overflowOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-52 bg-surface-overlay border border-separator rounded-md shadow-overlay py-1 z-20">
                <button
                  onClick={() => { handleExportJdPdf(); setOverflowOpen(false); }}
                  className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-base text-text-primary hover:bg-surface-hover"
                >
                  <Download className="w-3.5 h-3.5 text-text-tertiary" />
                  Export JD as PDF
                </button>
                {shortlistCount > 0 && (
                  <button
                    onClick={() => { openModal("report"); setOverflowOpen(false); }}
                    className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-base text-text-primary hover:bg-surface-hover"
                  >
                    <Star className="w-3.5 h-3.5 text-text-tertiary" />
                    Client report
                  </button>
                )}
                {job.status === "active" && (
                  <>
                    <div className="my-1 border-t border-separator" />
                    <button
                      onClick={() => { handleToggleStatus(); setOverflowOpen(false); }}
                      disabled={togglingStatus}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-base text-danger hover:bg-danger-subtle disabled:opacity-50"
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
      </div>

      {/* Page body */}
      <div className="px-4 pb-6">
      {/* Meta row — company, location (editable) */}
      <div className="mb-3 flex items-center gap-3 text-sm text-text-secondary flex-wrap">
        {job.company && (
          <span className="flex items-center gap-1">
            <Briefcase className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            {job.company}
          </span>
        )}
        {editingLocation ? (
          <span className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <input
              type="text"
              value={locationDraft}
              onChange={(e) => setLocationDraft(e.target.value)}
              placeholder="Primary location"
              className="h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent w-32 transition-all"
              autoFocus
            />
            <span className="text-text-tertiary">/</span>
            <input
              type="text"
              value={location2Draft}
              onChange={(e) => setLocation2Draft(e.target.value)}
              placeholder="Second location (optional)"
              className="h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent w-36 transition-all"
            />
            <button
              onClick={handleSaveLocation}
              disabled={savingLocation}
              className="text-xs text-accent hover:text-accent-hover disabled:text-text-tertiary"
            >
              {savingLocation ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditingLocation(false)}
              className="text-xs text-text-tertiary hover:text-text-secondary"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <MapPin className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            {job.location || <span className="italic text-text-tertiary">No location</span>}
            {job.location2 && <span> / {job.location2}</span>}
            <button
              onClick={() => {
                setLocationDraft(job.location ?? "");
                setLocation2Draft(job.location2 ?? "");
                setEditingLocation(true);
              }}
              className="ml-1 text-2xs text-accent hover:text-accent-hover"
              title="Edit locations"
            >
              edit
            </button>
          </span>
        )}
      </div>

      {/* Closed job banner */}
      {job.status === "closed" && (
        <div className="mb-4 flex items-center justify-between gap-4 px-3 py-2 bg-surface-raised border border-separator rounded-md">
          <p className="text-sm text-text-secondary">
            This job is <span className="font-medium text-text-primary">closed</span> — searching and scoring are disabled.
          </p>
          <button
            onClick={handleToggleStatus}
            disabled={togglingStatus}
            className="text-xs text-accent hover:text-accent-hover font-medium whitespace-nowrap disabled:opacity-50"
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
        <Card className="mb-4">
          <CardBody className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 bg-accent-subtle rounded flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-accent" />
              </div>
              <div>
                <p className="font-medium text-text-primary text-md">Step 1 — Analyse Job Description</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  AI reads the JD and extracts what to look for in candidates.
                </p>
                {parseError && (
                  <p className="text-xs text-danger mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {parseError}
                  </p>
                )}
                {parseChanges.length > 0 && !parseError && (
                  <div className="mt-2 p-2 bg-accent-subtle border border-separator rounded">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-medium text-accent">What changed</p>
                      <button onClick={() => setParseChanges([])} className="text-2xs text-text-tertiary hover:text-text-primary">dismiss</button>
                    </div>
                    <ul className="space-y-0.5">
                      {parseChanges.map((c, i) => (
                        <li key={i} className="text-xs text-text-secondary">· {c}</li>
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

      {/* Pipeline stepper — primary status filter for the candidate list below. */}
      {parsedRole && (
        <div className="mb-3">
          <PipelineStepper
            counts={pipelineCounts}
            rejectedCount={rejectedCount}
            selectedStage={selectedStage}
            onStageChange={setSelectedStage}
          />
        </div>
      )}

      {/* Main layout once parsed */}
      {parsedRole && (
        <div className="mb-4">
          {/* Hiring brief */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-text-primary text-md">Hiring Brief</h2>
                <div className="flex items-center gap-3">
                  {!editingJd && (
                    <button
                      onClick={() => { setJdDraft(job.rawJd); setEditingJd(true); }}
                      className="text-xs text-text-tertiary hover:text-accent transition-colors flex items-center gap-1"
                    >
                      <Pencil className="w-3 h-3" />
                      Edit JD
                    </button>
                  )}
                  <button
                    onClick={handleParse}
                    disabled={parsing}
                    className="text-xs text-text-tertiary hover:text-accent transition-colors flex items-center gap-1"
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
                    className="w-full px-3 py-2 text-sm bg-surface-sunken border border-separator rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus font-mono leading-relaxed resize-y transition-all"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={async () => {
                        if (jdDraft !== job.rawJd && !await confirm({ message: "Discard unsaved changes to the job description?", confirmLabel: "Discard" })) return;
                        setEditingJd(false);
                      }}
                      className="h-7 px-3 rounded bg-surface-hover hover:bg-[#3a3a3c] text-text-primary text-md border border-separator transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveJd}
                      disabled={savingJd || !jdDraft.trim()}
                      className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-md font-medium transition-colors"
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
                      <p className="text-2xs font-medium text-text-tertiary uppercase tracking-wide">Seniority</p>
                      <SourceBadge source={senioritySource} />
                    </div>
                    <p className="text-sm text-text-primary">{parsedRole.seniority_band}</p>
                  </div>
                )}
                {(parsedRole.location_rules || parsedRole.location) && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-2xs font-medium text-text-tertiary uppercase tracking-wide">Location / Remote</p>
                      <SourceBadge source={locationSource} />
                    </div>
                    <p className="text-sm text-text-primary">{parsedRole.location_rules || parsedRole.location}</p>
                  </div>
                )}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-2xs font-medium text-text-tertiary uppercase tracking-wide">Salary (NZD)</p>
                      <SourceBadge source={salarySource} />
                    </div>
                    {!editingSalary && (
                      <button onClick={() => setEditingSalary(true)} className="text-xs text-accent hover:text-accent-hover">
                        {job.salaryMin || job.salaryMax ? "Edit" : "Set"}
                      </button>
                    )}
                  </div>
                  {editingSalary ? (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="relative w-24">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-xs">$</span>
                          <input
                            type="number"
                            placeholder="Min"
                            value={salaryMin}
                            onChange={(e) => setSalaryMin(e.target.value)}
                            className="w-full h-7 pl-5 pr-2 text-md bg-surface-sunken border border-separator rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-all data-mono"
                          />
                        </div>
                        <span className="text-text-tertiary text-sm">–</span>
                        <div className="relative w-24">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-xs">$</span>
                          <input
                            type="number"
                            placeholder="Max"
                            value={salaryMax}
                            onChange={(e) => setSalaryMax(e.target.value)}
                            className="w-full h-7 pl-5 pr-2 text-md bg-surface-sunken border border-separator rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-all data-mono"
                          />
                        </div>
                        <span className="text-text-tertiary text-xs">NZD</span>
                        <button onClick={handleSaveSalary} disabled={savingSalary} className="h-7 px-3 bg-accent hover:bg-accent-hover text-white text-md font-medium rounded disabled:opacity-50 transition-colors">
                          {savingSalary ? "…" : "Save"}
                        </button>
                        <button onClick={() => { setEditingSalary(false); setSalaryError(""); }} className="h-7 w-7 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {salaryError && <p className="text-xs text-danger mt-1">{salaryError}</p>}
                    </>
                  ) : (
                    <p className="text-sm text-text-primary data-mono">
                      {job.salaryMin && job.salaryMax
                        ? `$${(job.salaryMin / 1000).toFixed(0)}k – $${(job.salaryMax / 1000).toFixed(0)}k`
                        : job.salaryMin ? `From $${(job.salaryMin / 1000).toFixed(0)}k`
                        : job.salaryMax ? `Up to $${(job.salaryMax / 1000).toFixed(0)}k`
                        : parsedRole.salary_band
                        ? <span className="text-text-tertiary italic text-xs font-sans">{parsedRole.salary_band} (est.)</span>
                        : <span className="text-text-tertiary italic font-sans">Not set</span>}
                    </p>
                  )}
                </div>
              </div>

              <HiringBriefChipSection
                title="Explicitly Stated"
                items={parsedRole.explicitly_stated}
                labelClassName="text-success"
                chipClassName="bg-success-subtle text-success"
              />

              <HiringBriefChipSection
                title="Strongly Inferred"
                items={parsedRole.strongly_inferred}
                labelClassName="text-accent"
                chipClassName="bg-accent-subtle text-accent"
              />

              {/* Knockout criteria — each item can be dismissed to remove it from scoring */}
              {(parsedRole.knockout_criteria?.length ?? 0) > 0 && (() => {
                const dismissed = parsedRole.dismissed_knockout_criteria ?? [];
                return (
                  <div>
                    <p className="text-2xs font-medium uppercase tracking-wide mb-2 text-danger" title="Binary gates — candidates who fail these are excluded regardless of other qualifications. Click × to relax a requirement (treats it as informational only for this search).">Hard Requirements</p>
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
                              "inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm font-medium transition-colors",
                              isDismissed
                                ? "bg-surface-hover text-text-tertiary line-through"
                                : "bg-danger-subtle text-danger"
                            )}
                          >
                            {item}
                            {isPending ? (
                              <Loader2 className="w-2.5 h-2.5 animate-spin flex-shrink-0" />
                            ) : isDismissed ? (
                              <button
                                onClick={() => handleRequirementAction("restore-knockout", item)}
                                title="Re-enable as hard requirement"
                                className="text-text-tertiary hover:text-danger transition-colors flex-shrink-0"
                              >
                                <RotateCcw className="w-2.5 h-2.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRequirementAction("dismiss-knockout", item)}
                                title="Relax this requirement (still shown but won't exclude candidates)"
                                className="text-danger/60 hover:text-danger transition-colors flex-shrink-0"
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
                chipClassName="bg-accent-subtle text-accent font-medium"
              />

              {/* Nice-to-haves — fall back to skills_preferred */}
              <HiringBriefChipSection
                title="Nice-to-haves"
                items={niceToHaves}
                chipClassName="bg-surface-hover text-text-secondary"
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
                labelClassName="text-warning"
                chipClassName="bg-warning-subtle text-warning"
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
                    <p className="text-2xs font-medium uppercase tracking-wide mb-2 text-warning">Work Rights</p>
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
                              "inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm transition-colors",
                              isPromoted
                                ? "bg-accent-subtle text-accent font-medium"
                                : "bg-warning-subtle text-warning"
                            )}
                          >
                            {item}
                            {isPending ? (
                              <Loader2 className="w-2.5 h-2.5 animate-spin flex-shrink-0" />
                            ) : isPromoted ? (
                              <button
                                onClick={() => handleRequirementAction("demote-visa-flag", item)}
                                title="Remove from must-haves"
                                className="text-accent/60 hover:text-accent transition-colors flex-shrink-0"
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleRequirementAction("promote-visa-flag", item)}
                                title="Enforce as a must-have in scoring"
                                className="text-warning/60 hover:text-warning transition-colors flex-shrink-0"
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
                labelClassName="text-text-tertiary"
                chipClassName="bg-surface-hover text-text-secondary"
              />

              {/* Synonym titles searched */}
              <HiringBriefChipSection
                title="Titles Searched"
                items={parsedRole.synonym_titles}
                chipClassName="bg-surface-hover text-text-tertiary"
                monospace
              />

            </CardBody>
          </Card>
        </div>
      )}

      {parsedRole && (
        <div id="job-search-card">
          {/* Action-plan #3 (design-panel winner: "Inline Modal-Based Unified
              Search"). The old SearchCard's "Find Candidates" box returned
              recycled pool results + fired invisible background discovery + told
              the recruiter to "re-run in a few minutes" — a dead end. This
              prominent CTA opens the WORKING multi-source search (the same modal
              the "Search talent" button uses): pool instantly + live LinkedIn/
              SEEK with visible streaming status. The legacy SearchCard component
              + its /api/jobs/[id]/search route are left intact in git for a
              one-commit rollback. */}
          <Card>
            <CardBody className="flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-accent-subtle text-accent flex items-center justify-center flex-shrink-0">
                  <Search className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-md font-semibold text-text-primary">Step 2 — Find Candidates</h3>
                  <p className="text-sm text-text-secondary">Search your library plus live LinkedIn &amp; SEEK in one place — results stream in as they arrive.</p>
                </div>
              </div>
              <Button
                variant="primary"
                size="md"
                onClick={() => openModal("multiSearch")}
                disabled={job.status === "closed"}
              >
                <Search className="w-3.5 h-3.5" />
                Find candidates for this role
              </Button>
            </CardBody>
          </Card>
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

      {parsedRole && <SearchFunnelCard jobId={id} refreshKey={funnelRefreshKey} />}

      {job.crmEnabled && <div className="mb-4"><SubmissionsCard jobId={id} refreshKey={submissionsRefreshKey} /></div>}

      {parsedRole && <JobWeightsCard jobId={id} />}

      {parsedRole && <ParseHistoryCard jobId={id} />}

      {/* Top matches card — surfaces best unreviewed candidates so recruiter doesn't have to scroll */}
      {selectedStage === "all" && (
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
                className="w-4 h-4 rounded-sm accent-accent cursor-pointer"
                checked={filteredCandidates.length > 0 && filteredCandidates.every((c) => selectedIds.has(c.id))}
                onChange={(e) => {
                  if (e.target.checked) setSelectedIds(new Set(filteredCandidates.map((c) => c.id)));
                  else setSelectedIds(new Set());
                }}
                title="Select all"
              />
            )}
            <h2 className="text-md font-semibold text-text-primary">
              Candidates
              {filteredCandidates.length > 0 && (
                <span className="ml-2 text-sm font-normal text-text-secondary data-mono">
                  ({filteredCandidates.length})
                </span>
              )}
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            {selectedIds.size > 0 ? (
              <>
                <span className="text-xs font-medium text-text-secondary">
                  <span className="data-mono">{selectedIds.size}</span> selected
                </span>
                <select
                  onChange={(e) => { if (e.target.value) handleBulkStatusChange(e.target.value); e.target.value = ""; }}
                  disabled={bulkStatusChanging}
                  defaultValue=""
                  className="h-7 text-xs bg-surface-sunken border border-separator rounded px-2 text-text-primary focus:outline-none focus:border-accent disabled:opacity-50 transition-all"
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
                  size="md"
                  variant="secondary"
                  onClick={handleBulkCapture}
                  loading={bulkCapturing}
                  disabled={bulkCapturing || bulkDeleting || bulkStatusChanging}
                  title="Fetch full LinkedIn / JobAdder profiles for the selected candidates (paced to stay safe; SEEK not included)"
                >
                  {bulkCapturing ? "Starting…" : `Capture ${selectedIds.size}`}
                </Button>
                <Button
                  size="md"
                  variant="danger"
                  onClick={handleBulkDelete}
                  loading={bulkDeleting}
                  disabled={bulkDeleting || bulkStatusChanging}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {bulkDeleting ? "Deleting…" : `Delete ${selectedIds.size}`}
                </Button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs text-text-tertiary hover:text-text-primary"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                {selectedStage !== "all" && (
                  <button
                    onClick={() => setSelectedStage("all")}
                    className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                  >
                    <X className="w-3 h-3" />
                    Clear filter
                  </button>
                )}
                {parsedRole && job.candidates.length > 0 && (
                  <Button
                    size="md"
                    variant="secondary"
                    onClick={() => handleRescoreAll(false)}
                    loading={rescoringAll}
                    disabled={rescoringAll}
                    title="Re-score all candidates with current job requirements (skips ones that haven't changed)"
                  >
                    {!rescoringAll && <Sparkles className="w-3.5 h-3.5" />}
                    {rescoringAll
                      ? rescoreProgress
                        ? `Scoring ${rescoreProgress.scored} of ${rescoreProgress.total}…`
                        : "Scoring…"
                      : "Re-score all"}
                  </Button>
                )}
                {parsedRole && job.candidates.length > 0 && (
                  <Button
                    size="md"
                    variant="outline"
                    onClick={async () => {
                      if (!await confirm({
                        title: "Force re-score everyone?",
                        message: "Re-runs the AI on EVERY candidate, even ones that haven't changed — ignores the cache and uses AI credits. Use when you want a guaranteed fresh score.",
                        confirmLabel: "Force re-score",
                      })) return;
                      void handleRescoreAll(true);
                    }}
                    disabled={rescoringAll}
                    title="Force a fresh AI score on EVERY candidate, ignoring the unchanged-profile cache"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Force re-score
                  </Button>
                )}
                {filteredCandidates.length > 0 && (
                  <Button
                    size="md"
                    variant="secondary"
                    onClick={handleExportCsv}
                    title="Download candidates as CSV"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export CSV
                  </Button>
                )}
                <Button size="md" variant="secondary" onClick={() => openModal("addCandidate")}>
                  <UserPlus className="w-3.5 h-3.5" />
                  Add manually
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Keyword search */}
        {job.candidates.length > 0 && (
          <div className="mb-3 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, role, location, or notes…"
                className="w-full h-7 pl-7 pr-7 text-md bg-surface-sunken border border-separator rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Quality filters — score floor + full-profile-only.
                Designed for the "who do I call today?" workflow: set the score
                floor to 60+, optionally hide snippet-only profiles, and the
                list collapses to the candidates worth picking up the phone for.
                Active filters get a "Clear filters" affordance so the recruiter
                can't get stuck on a too-strict filter and assume the list is
                empty. */}
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <label className="flex items-center gap-2 text-text-secondary select-none">
                <span className="font-medium">Min match</span>
                <input
                  type="range"
                  min={0}
                  max={90}
                  step={5}
                  value={minScoreFilter}
                  onChange={(e) => setMinScoreFilter(Number(e.target.value))}
                  className="w-32 accent-accent"
                />
                <span className={cn("data-mono w-9 text-right", minScoreFilter > 0 ? "text-accent font-semibold" : "text-text-tertiary")}>
                  {minScoreFilter > 0 ? `${minScoreFilter}%` : "off"}
                </span>
              </label>

              <label className="flex items-center gap-1.5 text-text-secondary select-none cursor-pointer ml-2">
                <input
                  type="checkbox"
                  checked={hideSnippetOnly}
                  onChange={(e) => setHideSnippetOnly(e.target.checked)}
                  className="w-3.5 h-3.5 accent-accent"
                />
                Full profiles only
              </label>

              {(minScoreFilter > 0 || hideSnippetOnly) && (
                <button
                  onClick={() => { setMinScoreFilter(0); setHideSnippetOnly(false); }}
                  className="ml-auto text-accent hover:text-accent-hover underline underline-offset-2"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        )}

        {/* Needs-profile notice. The list-view API strips profileText (it's
            10-50KB per candidate), so hasFullCandidateProfile would read
            undefined and flag every candidate — even ones that have already
            been captured. Use profileCapturedAt as the in-list signal: it's
            set the moment extension capture stage 1 succeeds, and matches
            what candidate-card uses to show/hide the amber Fetch button. */}
        {(() => {
          const needsFetchSet = new Set(
            job.candidates
              .filter(
                (c) => c.linkedinUrl &&
                       !c.profileCapturedAt &&
                       fetchStatuses[c.id]?.state !== "waiting" &&
                       fetchStatuses[c.id]?.state !== "fetching"
              )
              .map((c) => c.id)
          );
          const n = needsFetchSet.size;
          if (n === 0) return null;
          const scrollToFirst = () => {
            // Walk the visible list in display order so we land on the first
            // amber Fetch button the recruiter actually sees, not the first
            // alphabetically.
            const target = filteredCandidates.find((c) => needsFetchSet.has(c.id))
              ?? job.candidates.find((c) => needsFetchSet.has(c.id));
            if (!target) return;
            const el = document.getElementById(`candidate-${target.id}`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
          };
          return (
            <button
              type="button"
              onClick={scrollToFirst}
              className="mb-3 w-full flex items-center gap-1.5 text-xs text-warning bg-warning-subtle border border-separator rounded px-3 py-2 hover:bg-warning/25 transition-colors text-left"
            >
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="data-mono">{n}</span> candidate{n > 1 ? "s" : ""} {n > 1 ? "need" : "needs"} a full profile fetch — look for the amber <strong className="mx-0.5">Fetch profile</strong> button on each card.
            </button>
          );
        })()}

        {/* Stale-score warning: requirements updated since last score-all */}
        {job && job.lastParsedAt && job.lastScoredAt && job.candidates.length > 0 && !rescoringAll && !rescoreResult && (() => {
          const parsedMs  = new Date(job.lastParsedAt!).getTime();
          const scoredMs  = new Date(job.lastScoredAt!).getTime();
          return parsedMs > scoredMs ? (
            <div className="mb-3 flex items-center justify-between gap-3 text-xs rounded px-3 py-2 border text-warning bg-warning-subtle border-separator">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Requirements updated since last score — re-score all to apply new criteria.</span>
              </div>
              <button
                onClick={() => handleRescoreAll(false)}
                disabled={rescoringAll}
                className="h-6 text-xs font-medium px-3 rounded bg-warning text-text-inverse hover:bg-warning-hover disabled:opacity-50 transition-colors"
              >
                Re-score all now
              </button>
            </div>
          ) : null;
        })()}

        {/* Re-score result */}
        {rescoreResult && !rescoringAll && (
          <div className={cn(
            "mb-3 flex items-center gap-1.5 text-xs rounded px-3 py-2 border border-separator",
            rescoreResult.partial
              ? "text-warning bg-warning-subtle"
              : "text-success bg-success-subtle"
          )}>
            {rescoreResult.partial
              ? <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              : <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />}
            {rescoreResult.partial
              ? <span><span className="data-mono">{rescoreResult.scored}</span> of <span className="data-mono">{rescoreResult.total}</span> done — couldn&apos;t finish the rest; click Re-score all to resume (it skips what&apos;s already scored)</span>
              : <span>Scored <span className="data-mono">{rescoreResult.scored}</span> of <span className="data-mono">{rescoreResult.total}</span> candidates</span>}
            {!rescoreResult.partial && rescoreResult.failedIds && rescoreResult.failedIds.length > 0 && (
              <span className="ml-2 text-warning">· <span className="data-mono">{rescoreResult.failedIds.length}</span> failed</span>
            )}
          </div>
        )}

        {filteredCandidates.length === 0 ? (
          <div className="text-center py-10 px-6 bg-surface-raised rounded-md border border-separator border-dashed">
            <Users className="w-9 h-9 text-text-tertiary mx-auto mb-3" />
            <p className="text-text-primary text-md font-semibold mb-1">
              {selectedStage === "all"
                ? (jobCandidates.length === 0 ? "No candidates yet" : "No candidates match your filter")
                : `No candidates in ${selectedStage}`}
            </p>
            {selectedStage === "all" && jobCandidates.length === 0 && parsedRole && (
              <>
                <p className="text-text-secondary text-xs mt-1 mb-4">
                  Find candidates from the role brief, or add them manually below.
                </p>
                <button
                  onClick={() => document.getElementById("job-search-card")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium transition-colors"
                >
                  Find candidates
                </button>
              </>
            )}
            {selectedStage === "all" && jobCandidates.length === 0 && !parsedRole && (
              <p className="text-text-secondary text-xs mt-1">
                Paste a job description above and click <strong>Analyse</strong> to start.
              </p>
            )}
            {selectedStage !== "all" && (
              <button
                onClick={() => setSelectedStage("all")}
                className="text-accent hover:text-accent-hover text-xs underline underline-offset-2 mt-2"
              >
                Clear filter
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredCandidates.slice(0, renderCap).map((candidate) => (
              <div key={candidate.id} id={`candidate-${candidate.id}`} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-4 w-4 h-4 rounded-sm accent-accent cursor-pointer flex-shrink-0"
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
                    onSeekChange={handleSeekChange}
                    onNameChange={handleNameChange}
                    onHeadlineChange={handleHeadlineChange}
                    onLocationChange={handleLocationChange}
                    onScreeningDataChange={handleScreeningDataChange}
                    onInterviewNotesChange={handleInterviewNotesChange}
                    onDelete={handleDelete}
                    scoring={scoringId === candidate.id}
                    fetchingProfile={
                      fetchStatuses[candidate.id]?.state === "waiting" ||
                      fetchStatuses[candidate.id]?.state === "fetching"
                    }
                    fetchQueueState={fetchStatuses[candidate.id]?.state}
                    contactCount={candidate._count?.contactEvents ?? 0}
                    onSubmitToClient={job.crmEnabled ? handleSubmitToClient : undefined}
                    remindersEnabled={job.remindersEnabled}
                  />
                </div>
              </div>
            ))}
            {renderCap < filteredCandidates.length && (
              <div className="flex items-center justify-center gap-3 py-4">
                <button
                  onClick={() => setRenderCap((n) => n + RENDER_BATCH_SIZE)}
                  className="h-7 px-3 text-md font-medium text-accent bg-accent-subtle hover:bg-accent/25 rounded transition-colors"
                >
                  Show {Math.min(RENDER_BATCH_SIZE, filteredCandidates.length - renderCap)} more
                </button>
                <button
                  onClick={() => setRenderCap(filteredCandidates.length)}
                  className="text-xs text-text-tertiary hover:text-text-primary underline underline-offset-2"
                >
                  Show all <span className="data-mono">{filteredCandidates.length}</span>
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

      {modals.multiSearch && (
        <UnifiedSearchModal
          jobId={id}
          jobLocation={job.location ?? null}
          parsedRole={parsedRole}
          autoRun={!autoRanJobsRef.current.has(id)}
          onAutoRan={() => autoRanJobsRef.current.add(id)}
          excludedCompanies={job.excludedCompanies ?? null}
          // Resume the job's latest durable run on open (the "leave tab, come
          // back" path) rather than firing a fresh search every time.
          resumeRunId={latestRun?.id ?? null}
          onClose={() => { closeModal("multiSearch"); void fetchLatestRun(); }}
          onComplete={() => { fetchJob(); void fetchLatestRun(); }}
        />
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

      {submitCandidateId && (() => {
        const c = job.candidates.find((x) => x.id === submitCandidateId);
        if (!c) return null;
        return (
          <SubmitToClientModal
            jobId={id}
            candidate={{ id: c.id, name: c.name, matchScore: c.matchScore }}
            onClose={() => setSubmitCandidateId(null)}
            onSubmitted={() => { setSubmitCandidateId(null); setSubmissionsRefreshKey((k) => k + 1); void fetchJob(); }}
          />
        );
      })()}
      </div>
    </div>
  );
}
