"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, Users, Briefcase, Star, UserPlus, FileText } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { timeAgo, cn } from "@/lib/utils";
import { scoreTier } from "@/lib/score-utils";
import { AddLibraryCandidateModal } from "@/components/add-library-candidate-modal";
import { CandidateIdentityBlock } from "@/components/candidate/identity-block";
import { candidateSourceBadge } from "@/components/candidate/helpers";
import { FileSummaryChip } from "@/components/candidate/file-summary-chip";
import { JobAdderBadge } from "@/components/candidate/icons";
import { getCandidatePhotoUrl } from "@/lib/candidate-photo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface CandidateFile {
  id: string;
  type: string;
  filename: string;
  size: number;
  createdAt: string;
}

interface LibraryCandidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobAdderUrl: string | null;
  phone: string | null;
  email: string | null;
  photoFileId: string | null;
  matchScore: number | null;
  source: string;
  importBatchId: string | null;
  status: string;
  notes: string | null;
  sharedFromOrgName: string | null;
  profileCapturedAt: string | null;
  createdAt: string;
  job: { id: string; title: string; company: string | null } | null;
  archivedJobTitle: string | null;
  archivedJobCompany: string | null;
  files: CandidateFile[];
}

function CandidateCard({ c }: { c: LibraryCandidate }) {
  const sourceBadge = candidateSourceBadge({ source: c.source, profileText: null });
  return (
    <Link
      href={`/candidates/${c.id}`}
      className="block bg-surface-raised rounded-md border border-separator p-4 hover:bg-surface-hover transition-colors group"
    >
      {/* Identity — consistent with all other candidate views */}
      <CandidateIdentityBlock
        name={c.name}
        headline={c.headline}
        location={c.location}
        phone={c.phone}
        email={c.email}
        linkedinUrl={c.linkedinUrl}
        photoUrl={getCandidatePhotoUrl({ candidateId: c.id, photoFileId: c.photoFileId })}
        score={c.matchScore}
        size="md"
        showScore={c.matchScore !== null}
        scoreFormat="tier"
        showPhone={!!c.phone}
        showLinkedIn={false}
        nameClassName="group-hover:text-accent transition-colors"
      />

      {/* Badges */}
      <div className="flex items-center gap-1.5 mt-3 flex-wrap">
        {/* Org name — only shown to owner, identifies cross-org candidates */}
        {c.sharedFromOrgName && (
          <Badge className="bg-accent-subtle text-accent">
            <span className="line-clamp-1 max-w-[120px]" title={`Organisation: ${c.sharedFromOrgName}`}>{c.sharedFromOrgName}</span>
          </Badge>
        )}
        {/* Job context */}
        <Badge>
          <Briefcase className="w-2.5 h-2.5" />
          <span className="line-clamp-1 max-w-[100px] ml-1">
            {c.job?.title ?? c.archivedJobTitle ?? (c.source === "manual" || c.source === "jobadder_import" ? "Library" : "Archived role")}
          </span>
        </Badge>

        {/* File counts (Phase E3) — replaces the old yes/no CV+Cover badges */}
        <FileSummaryChip files={c.files} />

        {/* No LinkedIn URL — may be duplicate */}
        {!c.linkedinUrl && (
          <span
            title="No LinkedIn URL — if this person appears twice, they may be a duplicate. Add their LinkedIn URL to enable deduplication."
            className="inline-flex items-center h-5 px-1.5 py-0.5 rounded-sm text-xs font-medium leading-none bg-warning-subtle text-warning cursor-help"
          >
            No LinkedIn
          </span>
        )}

        {/* Open in JobAdder (Phase E5) — pushed left of the source pill */}
        {c.jobAdderUrl && (
          <span className="ml-auto inline-flex" onClick={(e) => e.stopPropagation()}>
            <JobAdderBadge url={c.jobAdderUrl} />
          </span>
        )}

        {/* Source — colored per provenance (Phase E4) */}
        <Badge className={cn(c.jobAdderUrl ? "" : "ml-auto", sourceBadge.className)}>
          {sourceBadge.label}
        </Badge>
      </div>

      <p className="text-xs text-text-tertiary mt-2.5 text-right" suppressHydrationWarning>
        {c.profileCapturedAt
          ? `Captured ${timeAgo(new Date(c.profileCapturedAt))}`
          : `Added ${timeAgo(new Date(c.createdAt))}`}
      </p>
    </Link>
  );
}

interface CandidatesLibraryClientProps {
  candidates: LibraryCandidate[];
  /** Pagination cursor from SSR. Non-null when more rows exist past the take cap. */
  initialNextCursor?: string | null;
}

export function CandidatesLibraryClient({ candidates: initialCandidates, initialNextCursor }: CandidatesLibraryClientProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [showAddModal, setShowAddModal] = useState(false);

  // Cursor pagination state. `candidates` starts with the SSR page and grows
  // as the user clicks "Load more". `nextCursor` tracks where to resume.
  const [candidates, setCandidates] = useState<LibraryCandidate[]>(initialCandidates);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const res = await fetch(`/api/candidates?cursor=${encodeURIComponent(nextCursor)}`);
      if (!res.ok) {
        setLoadMoreError("Failed to load more — try again.");
        return;
      }
      const data = await res.json() as { candidates: LibraryCandidate[]; nextCursor: string | null };
      setCandidates((prev) => [...prev, ...data.candidates]);
      setNextCursor(data.nextCursor);
    } catch {
      setLoadMoreError("Failed to load more — check your connection.");
    } finally {
      setLoadingMore(false);
    }
  };

  // Import-batch filter (Phase E4). Null = no filter, show all batches.
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [batches, setBatches] = useState<Array<{ batchId: string; count: number; latestAt: string; source: string }>>([]);
  useEffect(() => {
    fetch("/api/candidates/import-batches")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { batches: typeof batches }) => setBatches(d.batches))
      .catch(() => {/* chip row stays empty if the call fails; not user-facing */});
  }, []);

  // ── Server-side boolean search (Phase F) ───────────────────────────────
  // When the search box is non-empty, hit /api/candidates/library/search
  // (Postgres FTS via Candidate.searchTsv). Replaces the prior client-side
  // substring filter, which only saw the rows already in memory — useless
  // at 14k+ rows. Empty query falls back to the SSR-loaded recency list.
  const [searchResults, setSearchResults] = useState<LibraryCandidate[] | null>(null);
  const [searchingServer, setSearchingServer] = useState(false);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  useEffect(() => {
    const q = deferred.trim();
    if (!q) {
      setSearchResults(null);
      setParseErrors([]);
      return;
    }
    let cancelled = false;
    setSearchingServer(true);
    fetch(`/api/candidates/library/search?q=${encodeURIComponent(q)}&limit=200`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { candidates: LibraryCandidate[]; parsed?: { hasErrors: boolean; errors: string[] } }) => {
        if (cancelled) return;
        setSearchResults(d.candidates);
        setParseErrors(d.parsed?.hasErrors ? d.parsed.errors : []);
      })
      .catch(() => {
        if (cancelled) return;
        setSearchResults([]);
        setParseErrors([]);
      })
      .finally(() => {
        if (!cancelled) setSearchingServer(false);
      });
    return () => { cancelled = true; };
  }, [deferred]);

  const filtered = useMemo(() => {
    let rows = searchResults ?? candidates;
    if (selectedBatchId) rows = rows.filter((c) => c.importBatchId === selectedBatchId);
    return rows;
  }, [candidates, searchResults, selectedBatchId]);

  // Single-pass reducer for stats — was 3 separate full-array scans (every
  // keystroke triggered ~42k iterations through 14k candidates). Now ~14k.
  // strongMatches counts via canonical scoreTier so the "Strong" label here
  // matches every other tier display in the app (>= 80 = strong).
  const { withCV, withProfile, strongMatches } = useMemo(() => {
    let cv = 0, strong = 0;
    for (const c of candidates) {
      if (c.files.some((f) => f.type === "cv")) cv++;
      if (c.matchScore !== null && scoreTier(c.matchScore, "match") === "strong") strong++;
    }
    return { withCV: cv, withProfile: candidates.length, strongMatches: strong };
  }, [candidates]);

  // ── Virtualization ──
  // Track viewport width to pick a column count that matches the Tailwind
  // breakpoints used in the grid (1 col mobile / 2 col sm / 3 col lg).
  // Without this we'd render all 14k cards as DOM nodes on initial mount
  // and freeze the tab.
  const [columns, setColumns] = useState(3);
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      setColumns(w >= 1024 ? 3 : w >= 640 ? 2 : 1);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const rowCount = Math.ceil(filtered.length / columns);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 156, // card height incl. gap; resized dynamically
    overscan: 4,
  });

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Candidates Library</h1>
          <p className="text-text-secondary text-sm mt-1">
            All captured profiles — reused automatically in future job searches
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)} variant="primary" size="md">
          <UserPlus className="w-3.5 h-3.5" />
          Add Candidate
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <Card className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-accent-subtle rounded-md flex items-center justify-center">
            <Users className="w-4 h-4 text-accent" />
          </div>
          <div>
            <p className="text-lg font-semibold text-text-primary data-mono">{withProfile}</p>
            <p className="text-xs text-text-secondary">People</p>
          </div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-success-subtle rounded-md flex items-center justify-center">
            <Star className="w-4 h-4 text-success" />
          </div>
          <div>
            <p className="text-lg font-semibold text-text-primary data-mono">{strongMatches}</p>
            <p className="text-xs text-text-secondary">Strong matches (80%+)</p>
          </div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-warning-subtle rounded-md flex items-center justify-center">
            <FileText className="w-4 h-4 text-warning" />
          </div>
          <div>
            <p className="text-lg font-semibold text-text-primary data-mono">{withCV}</p>
            <p className="text-xs text-text-secondary">With CV</p>
          </div>
        </Card>
      </div>

      {/* Search — Phase F boolean FTS via /api/candidates/library/search.
          Accepts the same syntax as the multi-source job search:
            (java OR python) AND senior NOT junior "machine learning"
          Hits Postgres' searchTsv tsvector when non-empty, falls back to
          the SSR-loaded recency list otherwise. */}
      <div className="relative mb-1">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search — try  (java OR python) AND senior NOT junior  "machine learning"`}
          className="w-full h-8 pl-8 pr-16 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
        />
        {searchingServer && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-2xs text-text-tertiary uppercase tracking-wide">Searching…</span>
        )}
      </div>
      {parseErrors.length > 0 && (
        <p className="text-xs text-warning mb-2">
          Query issue{parseErrors.length === 1 ? "" : "s"}: {parseErrors.join("; ")}
        </p>
      )}
      <div className="mb-3" />

      {/* Import-batch filter chips (Phase E4). One pill per recent batch +
          an "All" reset. Hidden entirely if no batches have been recorded. */}
      {batches.length > 0 && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          <span className="text-2xs text-text-tertiary mr-1 uppercase tracking-wide">Imported batch:</span>
          <button
            type="button"
            onClick={() => setSelectedBatchId(null)}
            className={cn(
              "inline-flex items-center h-6 px-2 rounded-sm text-xs font-medium transition-colors",
              selectedBatchId === null
                ? "bg-accent text-text-inverse"
                : "bg-surface-hover text-text-secondary hover:bg-surface-raised",
            )}
          >
            All
          </button>
          {batches.map((b) => {
            const sourceBadge = candidateSourceBadge({ source: b.source, profileText: null });
            const isSel = selectedBatchId === b.batchId;
            return (
              <button
                key={b.batchId}
                type="button"
                onClick={() => setSelectedBatchId(isSel ? null : b.batchId)}
                title={`${b.count.toLocaleString()} candidates · ${timeAgo(new Date(b.latestAt))}`}
                className={cn(
                  "inline-flex items-center gap-1.5 h-6 px-2 rounded-sm text-xs font-medium transition-colors",
                  isSel
                    ? "bg-accent text-text-inverse"
                    : cn(sourceBadge.className, "hover:opacity-80"),
                )}
              >
                <span>{sourceBadge.label}</span>
                <span className="opacity-70">· {b.count.toLocaleString()}</span>
                <span className="opacity-70" suppressHydrationWarning>· {timeAgo(new Date(b.latestAt))}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Results count */}
      {search && (
        <p className="text-xs text-text-tertiary mb-3 data-mono">
          {filtered.length} of {candidates.length} people
        </p>
      )}

      {/* Grid */}
      {candidates.length === 0 ? (
        <Card className="text-center py-16 border-dashed">
          <div className="w-14 h-14 bg-accent-subtle rounded-full flex items-center justify-center mx-auto mb-4">
            <Users className="w-7 h-7 text-accent" />
          </div>
          <h3 className="text-md font-semibold text-text-primary mb-2">No profiles yet</h3>
          <p className="text-text-secondary text-sm max-w-xs mx-auto mb-4">
            Candidates appear here once their LinkedIn profile has been captured via the browser extension or a search.
          </p>
          <div className="flex justify-center">
            <Button onClick={() => setShowAddModal(true)} variant="primary" size="md">
              <UserPlus className="w-3.5 h-3.5" />
              Add Candidate via CV
            </Button>
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-text-tertiary text-sm">
          No candidates match &ldquo;{search}&rdquo;
        </div>
      ) : (
        // Virtualized row scroller: only the rows in view (+ overscan)
        // are mounted, so a 14k library no longer freezes the tab on
        // initial render. Height is capped to the viewport; the scroll
        // container scrolls internally.
        <div
          ref={scrollParentRef}
          className="overflow-auto"
          style={{ height: "calc(100vh - 340px)", minHeight: 400 }}
        >
          <div
            style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const start = virtualRow.index * columns;
              const rowCands = filtered.slice(start, start + columns);
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pb-3"
                >
                  {rowCands.map((c) => <CandidateCard key={c.id} c={c} />)}
                </div>
              );
            })}
          </div>
          {nextCursor && (
            <div className="mt-4 flex flex-col items-center gap-2">
              {loadMoreError && (
                <p className="text-xs text-danger">{loadMoreError}</p>
              )}
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="px-4 py-2 rounded-md border border-separator bg-surface-raised hover:bg-surface-hover text-text-primary text-md disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more candidates"}
              </button>
              <p className="text-xs text-text-tertiary">
                Showing {candidates.length} — your library has more.
              </p>
            </div>
          )}
        </div>
      )}

      {showAddModal && (
        <AddLibraryCandidateModal
          onComplete={() => {
            setShowAddModal(false);
            router.refresh();
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
