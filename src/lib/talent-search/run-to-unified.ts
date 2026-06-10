/**
 * Adapter: SearchRunResultDTO (durable SearchRun engine) → UnifiedResult (the
 * shape the job search modal already renders + imports).
 *
 * The job search now runs THROUGH the durable SearchRun engine so it survives a
 * tab close (see [[project-durable-job-search]]). The modal's rendering and its
 * bulk-import flow were written against `UnifiedResult`; rather than rewrite all
 * of that, we map the run's result rows into the same shape on both the server
 * (initial response) and the client (SSE stream deltas) via this one function.
 */

import type { SearchRunResultDTO } from "../search-run";
import type { UnifiedResult } from "./aggregate";

/** Map a durable run result row to the modal's UnifiedResult. */
export function runResultToUnified(r: SearchRunResultDTO): UnifiedResult {
  // The modal's source union is ("library" | "linkedin")[]; the run also tracks
  // "seek". Collapse seek → linkedin for the badge (both are "external scrape").
  const sources = Array.from(
    new Set(r.sources.map((s) => (s === "library" ? "library" : "linkedin"))),
  ) as Array<"library" | "linkedin">;
  if (sources.length === 0) sources.push(r.candidateId ? "library" : "linkedin");

  return {
    id: r.mergeKey, // stable across re-runs of the same query (identity merge key)
    name: r.name ?? "Unnamed profile",
    headline: r.headline,
    location: r.location,
    // The external profile link (LinkedIn / SEEK). The run stores it in one
    // `profileUrl` column; the modal keys its "open profile" affordance + import
    // off `linkedinUrl`, so route it there.
    linkedinUrl: r.profileUrl,
    jobAdderUrl: null,
    photoUrl: r.photoUrl,
    matchScore: r.matchScore,
    sources,
    candidateId: r.candidateId,
    candidateIdentityId: r.candidateIdentityId,
    snippet: r.snippet,
    linkedinPage: null,
    relevance: r.relevance,
  };
}
