"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CandidateIdentityBlock } from "@/components/candidate/identity-block";
import { Badge } from "@/components/ui/badge";
import { useSearchRunStream } from "./use-search-run-stream";
import { SourceStatusPills } from "./source-status-pills";
import type { RunSnapshot, SearchRunResultDTO, SourceKey } from "@/lib/search-run";

const SOURCE_BADGE: Record<SourceKey, string> = {
  library: "bg-accent-subtle text-accent",
  linkedin: "bg-info-subtle text-info",
  seek: "bg-success-subtle text-success",
};

function ResultRow({ r, enriching }: { r: SearchRunResultDTO; enriching: boolean }) {
  const importable = !!r.candidateId;
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-separator last:border-0 hover:bg-surface-hover/40 transition-colors">
      <div className="flex-1 min-w-0">
        <CandidateIdentityBlock
          name={r.name ?? "Unknown"}
          headline={r.headline}
          location={r.location}
          photoUrl={r.photoUrl}
          score={r.matchScore}
          showScore={r.matchScore !== null}
          scoreFormat="tier"
          href={r.candidateId ? `/candidates/${r.candidateId}` : undefined}
          size="sm"
        />
        {r.snippet && (
          <p className="text-xs text-text-tertiary mt-1.5 line-clamp-2">{r.snippet}</p>
        )}
        {/* SEEK profile recency — a strong "worth contacting now" signal. */}
        {r.updatedAgo && (
          <p className="text-2xs text-text-tertiary mt-1">Profile updated {r.updatedAgo}</p>
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
        <div className="flex gap-1">
          {r.sources.map((s) => (
            <Badge key={s} className={SOURCE_BADGE[s]}>{s}</Badge>
          ))}
        </div>
        {/* Unscored scraper cards carry a local keyword-relevance estimate (used
            to interleave them with the scored library rows). Show it muted + as
            an estimate — never a "Strong/Good match" tier, which it hasn't earned. */}
        {r.matchScore === null && r.relevance !== null && (
          <span
            className="text-2xs text-text-tertiary"
            title="Keyword-relevance estimate — this card isn't fully scored yet, so it's ranked by how well its headline matches your query."
          >
            ~{Math.round(r.relevance * 100)}% rel
          </span>
        )}
        {!importable && r.profileUrl && (
          <a
            href={r.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-2xs text-text-tertiary hover:text-accent transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> Open profile
          </a>
        )}
        {/* Only show "fetching…" while this row can still be deep-scraped. SEEK cards and
            snippet-only LinkedIn results from a settled run are never enriched (credit-safe /
            by design), so the label would otherwise be permanently wrong and erode trust. */}
        {!importable && enriching && (
          <span className="text-2xs text-text-tertiary" title="Profile not yet fetched — will be importable once scraped">
            fetching…
          </span>
        )}
      </div>
    </div>
  );
}

export function SearchRunClient({ initial }: { initial: RunSnapshot }) {
  const router = useRouter();
  const snap = useSearchRunStream(initial.run.id, initial);
  const run = snap.run;
  const results = snap.results ?? initial.results ?? [];
  const [showReauth] = useState(true);

  const linkedinReauth = run.sourceStatus.linkedin === "failed";
  const seekReauth = run.sourceStatus.seek === "failed";
  const isLive = run.status === "queued" || run.status === "running";
  // Only LinkedIn rows get deep-scraped, and only while LinkedIn is still working.
  // SEEK rows and any row in a settled run will never be fetched, so don't promise it.
  const linkedinEnriching =
    run.sourceStatus.linkedin === "pending" || run.sourceStatus.linkedin === "running";

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <Link href="/search" className="text-xs text-accent hover:text-accent-hover">+ New search</Link>
        </div>
        <h1 className="text-lg font-semibold text-text-primary mt-2 break-words">{run.rawQuery}</h1>
        {run.location && <p className="text-sm text-text-secondary mt-0.5">📍 {run.location}</p>}
        {/* This standalone view is READ-ONLY: it feeds the shared library and lets
            you open profiles, but attaching candidates to a specific job happens in
            that job's "Search talent" panel (which carries the job context the
            import needs). Say so plainly so the missing "add" control isn't read as
            a bug. */}
        <p className="text-xs text-text-tertiary mt-1">
          View-only · results are saved to your library. To add candidates to a job, use{" "}
          <span className="text-text-secondary">Search talent</span> inside that job.
        </p>
        <div className="flex items-center gap-2 mt-3">
          <SourceStatusPills sources={run.sources} sourceStatus={run.sourceStatus} counts={run.counts} />
          {isLive && <span className="inline-flex items-center gap-1 text-xs text-text-tertiary"><Loader2 className="w-3 h-3 animate-spin" /> live</span>}
        </div>
      </div>

      {/* Re-auth banner — scraper session challenged */}
      {showReauth && (linkedinReauth || seekReauth) && (
        <div className="flex items-start gap-3 bg-warning-subtle text-warning rounded-md p-3 mb-4 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">
              {linkedinReauth && seekReauth ? "LinkedIn & SEEK" : linkedinReauth ? "LinkedIn" : "SEEK"} needs re-authentication
            </p>
            <p className="text-xs opacity-90 mt-0.5">
              The box&apos;s session was challenged. Library results below still stand.{" "}
              <Link href="/linkedin-setup" className="underline">Re-connect the session</Link> and re-run.
            </p>
          </div>
        </div>
      )}

      {/* Result count — while a live run is in flight, don't show a stark
          "0 results" (reads as broken); make it clear sources are still working. */}
      <p className="text-xs text-text-tertiary mb-2 data-mono">
        {isLive && run.counts.total === 0 ? (
          <span className="inline-flex items-center gap-1.5 text-accent"><Loader2 className="w-3 h-3 animate-spin" /> Searching live sources…</span>
        ) : (
          <>
            {run.counts.total} result{run.counts.total === 1 ? "" : "s"}
            {isLive && " so far · live sources still searching"}
            {run.counts.deduped > 0 && ` · ${run.counts.deduped} in multiple sources`}
          </>
        )}
      </p>

      {/* Results */}
      <div className="bg-surface-raised border border-separator rounded-md overflow-hidden">
        {results.length === 0 ? (
          <div className="text-center py-12 text-sm text-text-tertiary">
            {isLive ? (
              <span className="inline-flex flex-col items-center gap-1.5">
                <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Searching LinkedIn &amp; SEEK live…</span>
                <span className="text-2xs text-text-tertiary">Live scrapes take ~1–2 min — results appear here as they land. Tip: include Library for instant matches.</span>
              </span>
            ) : (
              "No matches."
            )}
          </div>
        ) : (
          results.map((r) => (
            <ResultRow
              key={r.id}
              r={r}
              enriching={linkedinEnriching && r.sources.includes("linkedin")}
            />
          ))
        )}
      </div>

      {run.status === "partial" && (
        <p className={cn("text-xs text-warning mt-3")}>
          Partial run — one or more sources failed; the results above are what completed.
        </p>
      )}
    </div>
  );
}
