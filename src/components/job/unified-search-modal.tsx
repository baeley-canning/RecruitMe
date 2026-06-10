"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import {
  X,
  Loader2,
  Search,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Library,
  Briefcase,
  FileText,
  HelpCircle,
  Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { CandidateIdentityBlock } from "@/components/candidate/identity-block";
import { CVPreview } from "@/components/candidate/cv-preview";
import { LinkedInIcon } from "@/components/candidate/icons";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { UnifiedResult } from "@/lib/talent-search/aggregate";
import { parsedRoleToBooleanQuery } from "@/lib/talent-search/role-query";
import type { ParsedRole } from "@/lib/ai";

// -----------------------------------------------------------------------------
// API response shape (mirrors POST /api/jobs/[id]/search/multi)
// -----------------------------------------------------------------------------
interface SearchResponse {
  query: {
    raw: string;
    mustHave: string[];
    anyOf: string[];
    mustNot: string[];
    hasErrors: boolean;
    errors: string[];
  };
  results: UnifiedResult[];
  counts: {
    libraryRaw: number;
    linkedinRaw: number;
    deduped: number;
    total: number;
  };
  /** Phase H — IDs of priority scraper jobs the client should poll. */
  liveJobs?: Array<{ id: string; platform: "linkedin" | "seek" }>;
  errors?: { library?: string; linkedin?: string };
}

// Phase H — per-job status response from /api/scraper/jobs/[id]/status.
interface LiveJobStatus {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  platform: string;
  searchQuery: string | null;
  error: string | null;
  urls: string[] | null;
  elapsedMs: number;
}

interface RowFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  type: string;
}

// -----------------------------------------------------------------------------
// Per-row inline CV preview — library rows only (LinkedIn rows have no
// candidateId, so there's no /files endpoint to hit). Mirrors the same
// lazy-fetch pattern as `LibraryRowCVPreview` in browse-library-modal.tsx
// so the recruiter UX is consistent across both modals.
// -----------------------------------------------------------------------------
function RowCVPreview({ candidateId }: { candidateId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<RowFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = (e: MouseEvent) => {
    e.stopPropagation();
    if (!expanded && files === null && !loading) {
      setLoading(true);
      fetch(`/api/candidates/${candidateId}/files`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load files"))))
        .then((data: RowFile[]) => setFiles(data))
        .catch(() => setError("Couldn't load CV"))
        .finally(() => setLoading(false));
    }
    setExpanded((v) => !v);
  };

  const cvFile = files?.find((f) => f.type === "cv" && f.mimeType === "application/pdf");

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={handleToggle}
        className="mt-1 inline-flex items-center gap-1 text-2xs text-text-tertiary hover:text-accent transition-colors"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <FileText className="w-3 h-3" />
        {expanded ? "Hide CV" : "Show CV"}
      </button>
      {expanded && (
        <div className="mt-2">
          {loading && (
            <p className="text-xs text-text-tertiary flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading files…
            </p>
          )}
          {error && <p className="text-xs text-warning">{error}</p>}
          {!loading && !error && files && !cvFile && (
            <p className="text-xs text-text-tertiary">No PDF CV attached to this candidate.</p>
          )}
          {cvFile && <CVPreview candidateId={candidateId} file={cvFile} height={420} />}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Source pill — neutral for library, accent-tinted for LinkedIn.
// -----------------------------------------------------------------------------
function SourcePill({ source }: { source: "library" | "linkedin" }) {
  if (source === "library") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-surface-hover text-text-secondary border border-separator">
        <Library className="w-2.5 h-2.5" /> Library
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-accent-subtle text-accent">
      <LinkedInIcon className="w-2.5 h-2.5" /> LinkedIn
    </span>
  );
}

// -----------------------------------------------------------------------------
// Boolean syntax cheatsheet — `?` icon with click-toggle popover. Tiny so it
// doesn't bloat the form chrome. Click-toggle (not hover) because hover-only
// popovers are inaccessible on touch.
// -----------------------------------------------------------------------------
function SyntaxHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Boolean syntax help"
        className="text-text-tertiary hover:text-accent transition-colors"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          className="absolute left-0 top-5 z-10 w-64 p-2 rounded-md bg-surface-overlay border border-separator shadow-popover text-2xs text-text-secondary"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="font-semibold text-text-primary mb-1">Boolean syntax</p>
          <ul className="space-y-0.5">
            <li><code className="data-mono text-accent">&quot;Quoted phrases&quot;</code> — exact match</li>
            <li><code className="data-mono text-accent">OR</code> — either term</li>
            <li><code className="data-mono text-accent">AND</code> — both terms (default)</li>
            <li><code className="data-mono text-accent">NOT</code> or <code className="data-mono text-accent">-term</code> — exclude</li>
            <li><code className="data-mono text-accent">( )</code> — group</li>
          </ul>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------
interface UnifiedSearchModalProps {
  jobId: string;
  jobLocation?: string | null;
  /** When present, the modal searches STRAIGHT FROM THE ROLE: it auto-builds a
   *  boolean from the parsed JD and runs the search on open — no boolean typed.
   *  The boolean field is demoted to a collapsed "Refine (advanced)" control.
   *  Null/absent (unparsed job) → manual boolean mode (the original behaviour). */
  parsedRole?: ParsedRole | null;
  /** Whether to auto-fire the role search on open. The parent passes false on
   *  re-opens of the same job so a plain re-open doesn't re-enqueue a fresh live
   *  LinkedIn scrape — the boolean stays pre-filled, the recruiter hits Search. */
  autoRun?: boolean;
  /** Called once when the role search actually auto-fires, so the parent can
   *  remember it ran for this job (and pass autoRun=false next time). */
  onAutoRan?: () => void;
  /** The job's stored excluded companies (comma-separated). Seeds the exclude
   *  field; edits are sent with the search + persisted back to the job. */
  excludedCompanies?: string | null;
  onComplete: () => void;
  onClose: () => void;
}

export function UnifiedSearchModal({
  jobId,
  jobLocation,
  parsedRole,
  autoRun = true,
  onAutoRan,
  excludedCompanies,
  onComplete,
  onClose,
}: UnifiedSearchModalProps) {
  // Build the role boolean once. Role-driven mode is gated on a NON-EMPTY query:
  // a parsed role that yields nothing (e.g. a title that cleans away) falls back
  // to manual entry, NOT a permanent "Searching…" dead-end.
  const roleQuery = useMemo(() => (parsedRole ? parsedRoleToBooleanQuery(parsedRole) : ""), [parsedRole]);
  const roleMode = !!roleQuery;
  // Form state — pre-fill the boolean from the role so the (collapsed) Refine
  // field and the manual Search button both work even when we don't auto-run.
  const [query, setQuery] = useState(roleQuery);
  const [location, setLocation] = useState(jobLocation ?? "");
  // Company exclusion (the client you're hiring for + named competitors).
  const [excludeInput, setExcludeInput] = useState(excludedCompanies ?? "");
  const excludeList = useMemo(
    () => excludeInput.split(",").map((s) => s.trim()).filter(Boolean),
    [excludeInput],
  );
  const [useLibrary, setUseLibrary] = useState(true);
  const [useLinkedIn, setUseLinkedIn] = useState(true);
  // SEEK Talent Search defaults OFF — it costs SEEK credits, so it only fires
  // when the recruiter explicitly ticks it ("both as toggles").
  const [useSeek, setUseSeek] = useState(false);

  // Results state
  const [response, setResponse] = useState<SearchResponse | null>(null);
  // Start in the searching state when we're about to auto-run, so the spinner
  // shows from the first paint instead of flashing the empty-state copy first.
  const [searching, setSearching] = useState(roleMode && autoRun);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Phase H — live scraper status. Keyed by job id; updates as the
  // poll loop ticks. UI reads liveJobStatuses[id] to show pills like
  // "LinkedIn live · 14 urls" while scraping is in progress.
  const [liveJobStatuses, setLiveJobStatuses] = useState<Record<string, LiveJobStatus>>({});
  const pollAbortRef = useRef<AbortController | null>(null);

  // Selection state — keyed by UnifiedResult.id (stable across results).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const sourcesPicked = useMemo(() => {
    const out: Array<"library" | "linkedin" | "seek"> = [];
    if (useLibrary) out.push("library");
    if (useLinkedIn) out.push("linkedin");
    if (useSeek) out.push("seek");
    return out;
  }, [useLibrary, useLinkedIn, useSeek]);

  const canSubmit = !searching && sourcesPicked.length > 0;

  const runSearch = async (searchQuery: string) => {
    const q = searchQuery.trim();
    if (!q || sourcesPicked.length === 0) return;
    setSearching(true);
    setSearchError(null);
    setResponse(null);
    setSelected(new Set());
    setHasSearched(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/search/multi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          location: location.trim() || null,
          sources: sourcesPicked,
          excludeCompanies: excludeList,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        const msg = typeof body?.error === "string" ? body.error : `Search failed (HTTP ${res.status})`;
        setSearchError(msg);
        return;
      }
      const data = (await res.json()) as SearchResponse;
      setResponse(data);
      // Seed status map so the UI shows "queued" pills immediately while the
      // first poll cycle is in flight. The useEffect below drives the rest.
      setLiveJobStatuses(
        Object.fromEntries(
          (data.liveJobs ?? []).map((j) => [j.id, {
            id: j.id,
            status: "pending" as const,
            platform: j.platform,
            searchQuery: q,
            error: null,
            urls: null,
            elapsedMs: 0,
          }]),
        ),
      );
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    if (query.trim().length === 0) {
      showToast("Enter a search query first", "info");
      return;
    }
    await runSearch(query);
  };

  // Role-driven auto-run: fire the role search ONCE on open — the recruiter
  // searches straight from the role, no boolean typed. Gated on `autoRun` (the
  // parent passes false on re-opens so a plain re-open doesn't re-enqueue a live
  // scrape) and on roleMode (a non-empty produced query). One-shot ref guard.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!autoRun || !roleMode || autoRanRef.current) return;
    autoRanRef.current = true;
    onAutoRan?.();
    void runSearch(roleQuery);
    // runSearch/onAutoRan intentionally excluded: the autoRanRef one-shot guard
    // makes any re-run on their identity change a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, roleMode, roleQuery]);

  // Phase H — poll active scraper jobs until each settles.
  //
  // Cancels the prior poll loop whenever the user re-searches. Each tick
  // queries the IDs that are still pending/processing; once all are settled
  // the loop exits. Backs off (3s → 5s) as wall time grows so we don't
  // hammer the box for slow scrapes.
  useEffect(() => {
    const inflight = Object.values(liveJobStatuses).filter(
      (s) => s.status === "pending" || s.status === "processing",
    );
    if (inflight.length === 0) return;

    pollAbortRef.current?.abort();
    const ctrl = new AbortController();
    pollAbortRef.current = ctrl;

    let cancelled = false;
    const startedAt = Date.now();

    const tick = async () => {
      while (!cancelled && !ctrl.signal.aborted) {
        const stillRunning = Object.values(liveJobStatuses).filter(
          (s) => s.status === "pending" || s.status === "processing",
        );
        if (stillRunning.length === 0) return;
        const results = await Promise.all(
          stillRunning.map((s) =>
            fetch(`/api/scraper/jobs/${s.id}/status`, { signal: ctrl.signal })
              .then((r) => (r.ok ? r.json() as Promise<LiveJobStatus> : null))
              .catch(() => null),
          ),
        );
        if (cancelled || ctrl.signal.aborted) return;
        setLiveJobStatuses((prev) => {
          const next = { ...prev };
          for (const r of results) if (r) next[r.id] = r;
          return next;
        });
        const stillRunningAfter = results.some(
          (r) => r && (r.status === "pending" || r.status === "processing"),
        );
        if (!stillRunningAfter) return;
        // Backoff: 3s for first 30s, then 5s.
        const wait = Date.now() - startedAt < 30_000 ? 3_000 : 5_000;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    };
    void tick();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // We intentionally depend only on the keys of liveJobStatuses — each
    // tick reads the latest values via the setLiveJobStatuses callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(liveJobStatuses).join(",")]);

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAdd = async () => {
    if (selected.size === 0 || !response) return;
    setAdding(true);
    try {
      // The bulk-import endpoint lands in Day 5. We send the full result
      // payload so the server doesn't have to re-run the search to materialise
      // the LinkedIn-only rows it needs to create Candidate records for.
      const pickedResults = response.results.filter((r) => selected.has(r.id));
      const res = await fetch(`/api/jobs/${jobId}/search/multi/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultIds: selectedIds, results: pickedResults }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        const msg = typeof body?.error === "string" ? body.error : `Add failed (HTTP ${res.status})`;
        showToast(msg, "error");
        return;
      }
      showToast(`Added ${selected.size} candidate${selected.size === 1 ? "" : "s"}`, "success");
      onComplete();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Add failed", "error");
    } finally {
      setAdding(false);
    }
  };

  const dedupedCount = response?.counts.deduped ?? 0;
  const totalCount = response?.counts.total ?? 0;

  return (
    <Modal
      open={true}
      onClose={onClose}
      labelledBy="unified-search-title"
      dismissable={!searching && !adding}
      className="bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-4xl max-h-[90vh] flex flex-col"
    >
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-3 border-b border-separator">
        <div>
          <h3 id="unified-search-title" className="text-md font-semibold text-text-primary">
            {roleMode ? "Find candidates for this role" : "Search talent"}
          </h3>
          <p className="text-xs text-text-secondary mt-0.5">
            {roleMode
              ? "Searching straight from this role across your library and LinkedIn — tick SEEK to include it. Pick the best matches to add, then Score for this role to rank them."
              : "Boolean search across your library and LinkedIn. Pick candidates to add to this job."}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-text-tertiary hover:text-text-primary transition-colors mt-1"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search form */}
      <form onSubmit={handleSubmit} className="px-5 py-3 border-b border-separator space-y-2">
        {roleMode ? (
          // Role-driven mode: the boolean is auto-built from the JD and demoted
          // to an optional "Refine" disclosure. Editing it + Search re-runs.
          <details className="group">
            <summary className="cursor-pointer select-none flex items-center gap-1 text-2xs text-text-tertiary hover:text-text-primary">
              <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
              Refine (advanced) — edit the search and re-run
            </summary>
            <div className="relative mt-2">
              <Search className="w-3.5 h-3.5 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`"Tech Lead" OR "Engineering Manager"`}
                className="w-full h-8 pl-8 pr-3 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
              />
            </div>
          </details>
        ) : (
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`"Tech Lead" OR "Engineering Manager"`}
              autoFocus
              className="w-full h-8 pl-8 pr-3 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
            />
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location (optional)"
            className="h-7 px-3 rounded bg-surface-sunken border border-separator text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus flex-1 min-w-[140px]"
          />

          {/* Source toggles — segmented checkbox pills */}
          <div className="flex items-center gap-1">
            <SourceToggle
              label="Library"
              icon={<Library className="w-3 h-3" />}
              checked={useLibrary}
              onChange={setUseLibrary}
            />
            <SourceToggle
              label="LinkedIn"
              icon={<LinkedInIcon className="w-3 h-3" />}
              checked={useLinkedIn}
              onChange={setUseLinkedIn}
            />
            <SourceToggle
              label="SEEK"
              icon={<Briefcase className="w-3 h-3" />}
              checked={useSeek}
              onChange={setUseSeek}
            />
          </div>

          <Button type="submit" size="sm" disabled={!canSubmit}>
            {searching ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
              </>
            ) : (
              <>
                <Search className="w-3.5 h-3.5" /> Search
              </>
            )}
          </Button>
        </div>

        {/* Company exclusion — drop candidates whose current employer (in their
            headline) matches. The client you're hiring for + named competitors. */}
        <div className="relative">
          <Ban className="w-3.5 h-3.5 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={excludeInput}
            onChange={(e) => setExcludeInput(e.target.value)}
            placeholder="Exclude companies (comma-separated) — e.g. DNA, Somar"
            title="Candidates currently at these companies are excluded from results. Applied on the next Search."
            className="w-full h-7 pl-8 pr-3 rounded bg-surface-sunken border border-separator text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
          />
        </div>

        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          {!roleMode && <SyntaxHelp />}
          {!roleMode && <span>Boolean syntax: quoted phrases, OR, AND, NOT, -term, ( )</span>}
          {sourcesPicked.length === 0 && (
            <span className="ml-auto text-warning">Select at least one source.</span>
          )}
        </div>
      </form>

      {/* Results area */}
      <div className="flex-1 overflow-y-auto">
        {/* Initial empty state (before first search) */}
        {!hasSearched && !searching && (
          <div className="text-center py-16 text-base text-text-tertiary">
            {roleMode ? "Hit Search to find candidates for this role." : "Enter a boolean query above and hit Search."}
          </div>
        )}

        {/* Loading spinner */}
        {searching && (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Loader2 className="w-4 h-4 text-text-tertiary animate-spin" />
            <p className="text-xs text-text-secondary">Searching…</p>
          </div>
        )}

        {/* Hard error (HTTP failure) */}
        {!searching && searchError && (
          <div className="mx-5 mt-3 p-3 rounded-md bg-danger-subtle border border-danger/30 text-sm text-danger flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{searchError}</span>
          </div>
        )}

        {/* Successful response */}
        {!searching && !searchError && response && (
          <div className="px-5 py-3 space-y-3">
            {/* Boolean-query parse warnings */}
            {response.query.hasErrors && response.query.errors.length > 0 && (
              <div className="p-2.5 rounded-md bg-warning-subtle border border-warning/30 text-xs text-warning flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium mb-0.5">Query parsed with warnings:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {response.query.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Per-source failures */}
            {response.errors?.library && (
              <PartialFailureBanner source="Library" message={response.errors.library} />
            )}
            {response.errors?.linkedin && (
              <PartialFailureBanner source="LinkedIn" message={response.errors.linkedin} />
            )}

            {/* Results count */}
            {response.results.length > 0 && (
              <p className="text-xs text-text-secondary">
                <span className="data-mono">{totalCount}</span> result
                {totalCount === 1 ? "" : "s"}
                {dedupedCount > 0 && (
                  <>
                    {" "}
                    — <span className="data-mono">{dedupedCount}</span> appear in both library and
                    LinkedIn
                  </>
                )}
              </p>
            )}

            {/* Phase H — live scraper status pills. One per active scraper job
                enqueued at priority=100. Shown only while the job hasn't
                settled (pending/processing); on completion the URL count is
                displayed; on failure the error string. */}
            {Object.values(liveJobStatuses).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {Object.values(liveJobStatuses).map((s) => {
                  const isInflight = s.status === "pending" || s.status === "processing";
                  const tone = isInflight
                    ? "bg-warning-subtle text-warning"
                    : s.status === "completed"
                    ? "bg-success-subtle text-success"
                    : "bg-danger-subtle text-danger";
                  const label = isInflight
                    ? `${s.platform} live · ${s.status}…`
                    : s.status === "completed"
                    ? `${s.platform} live · ${s.urls?.length ?? 0} url${s.urls?.length === 1 ? "" : "s"}`
                    : `${s.platform} live · ${s.error || "failed"}`;
                  return (
                    <span
                      key={s.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-2xs font-medium ${tone}`}
                      title={`Job ${s.id} · ${Math.round(s.elapsedMs / 1000)}s`}
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            )}

            {/* No results */}
            {response.results.length === 0 && (
              <div className="text-center py-12 text-base text-text-tertiary">
                <p>No candidates matched. Try broadening the query{!useLinkedIn ? " or adding LinkedIn" : ""}.</p>
                {!useLinkedIn && (
                  <button
                    type="button"
                    onClick={() => setUseLinkedIn(true)}
                    className="mt-2 text-sm text-accent hover:underline"
                  >
                    Turn on LinkedIn search
                  </button>
                )}
              </div>
            )}

            {/* Result rows */}
            <div className="rounded-md border border-separator overflow-hidden">
              {response.results.map((r) => (
                <ResultRow
                  key={r.id}
                  result={r}
                  selected={selected.has(r.id)}
                  onToggle={() => toggleRow(r.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sticky footer */}
      <div className="px-5 py-3 border-t border-separator flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <p className="text-xs text-text-secondary">
            <span className="data-mono">{selected.size}</span> selected
          </p>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs text-text-tertiary hover:text-accent transition-colors"
            >
              Clear selection
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onClose} size="sm" variant="outline" disabled={adding}>
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            loading={adding}
            disabled={adding || selected.size === 0}
            size="sm"
          >
            Add {selected.size > 0 ? selected.size : ""} to job
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
// Source toggle pill (segmented control)
// -----------------------------------------------------------------------------
function SourceToggle({
  label,
  icon,
  checked,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-sm font-medium border transition-colors",
        checked
          ? "bg-accent-subtle text-accent border-accent/40"
          : "bg-surface-sunken text-text-tertiary border-separator hover:text-text-primary",
      )}
    >
      <span
        className={cn(
          "w-3 h-3 rounded-sm border flex items-center justify-center",
          checked ? "bg-accent border-accent" : "border-separator-strong",
        )}
      >
        {checked && <CheckCircle2 className="w-2.5 h-2.5 text-white" />}
      </span>
      {icon}
      {label}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Partial-failure banner (one source down, other still served)
// -----------------------------------------------------------------------------
function PartialFailureBanner({ source, message }: { source: string; message: string }) {
  return (
    <div className="p-2.5 rounded-md bg-warning-subtle border border-warning/30 text-xs text-warning flex items-start gap-2">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
      <span>
        <strong className="font-semibold">{source} search failed</strong> — {message}. Other sources
        shown below.
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Result row — clickable for selection, with inline source pills, optional
// score badge (via IdentityBlock's scoreFormat="tier"), and a lazy CV preview
// expander for library rows.
// -----------------------------------------------------------------------------
function ResultRow({
  result,
  selected,
  onToggle,
}: {
  result: UnifiedResult;
  selected: boolean;
  onToggle: () => void;
}) {
  // TODO(phase 2a): dedupe against candidates already on this job so the
  // recruiter doesn't have to mentally filter. Day 5's bulk-add route will
  // gracefully handle re-adds, but the UI label would still be nicer here.
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "w-full text-left px-4 py-3 border-b border-separator last:border-b-0 hover:bg-surface-hover transition-colors flex items-start gap-3",
        selected && "bg-accent-subtle",
      )}
    >
      <div
        className={cn(
          "mt-1 w-4 h-4 rounded-sm border flex items-center justify-center flex-shrink-0",
          selected ? "bg-accent border-accent" : "border-separator-strong",
        )}
      >
        {selected && <CheckCircle2 className="w-3 h-3 text-white" />}
      </div>

      <div className="flex-1 min-w-0">
        <CandidateIdentityBlock
          name={result.name}
          headline={result.headline}
          location={result.location}
          photoUrl={result.photoUrl}
          score={result.matchScore}
          size="sm"
          showScore
          scoreFormat="tier"
        />

        {/* Source pills */}
        <div className="flex items-center gap-1.5 mt-1.5">
          {result.sources.map((s) => (
            <SourcePill key={s} source={s} />
          ))}
        </div>

        {/* Lazy CV preview — library rows only */}
        {result.candidateId && <RowCVPreview candidateId={result.candidateId} />}
      </div>
    </button>
  );
}
