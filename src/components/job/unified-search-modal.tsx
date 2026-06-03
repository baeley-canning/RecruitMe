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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { CandidateIdentityBlock } from "@/components/candidate/identity-block";
import { CVPreview } from "@/components/candidate/cv-preview";
import { LinkedInIcon } from "@/components/candidate/icons";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { UnifiedResult } from "@/lib/talent-search/aggregate";

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
  onComplete: () => void;
  onClose: () => void;
}

export function UnifiedSearchModal({
  jobId,
  jobLocation,
  onComplete,
  onClose,
}: UnifiedSearchModalProps) {
  // Form state
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState(jobLocation ?? "");
  const [useLibrary, setUseLibrary] = useState(true);
  const [useLinkedIn, setUseLinkedIn] = useState(true);
  // SEEK Talent Search defaults OFF — it costs SEEK credits, so it only fires
  // when the recruiter explicitly ticks it ("both as toggles").
  const [useSeek, setUseSeek] = useState(false);

  // Results state
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
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

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    if (query.trim().length === 0) {
      showToast("Enter a search query first", "info");
      return;
    }
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
          query: query.trim(),
          location: location.trim() || null,
          sources: sourcesPicked,
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
            searchQuery: query.trim(),
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
            Search talent
          </h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Boolean search across your library and LinkedIn. Pick candidates to add to this job.
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

        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          <SyntaxHelp />
          <span>Boolean syntax: quoted phrases, OR, AND, NOT, -term, ( )</span>
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
            Enter a boolean query above and hit Search.
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
