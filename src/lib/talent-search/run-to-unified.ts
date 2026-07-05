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
import { isLinkedInProfileUrl } from "../linkedin";

/** Map a durable run result row to the modal's UnifiedResult. */
export function runResultToUnified(r: SearchRunResultDTO): UnifiedResult {
  // Preserve the real source tags (library / linkedin / seek) so the UI labels
  // SEEK results as SEEK — not "LinkedIn" — and the import can route them.
  const sources = Array.from(new Set(r.sources)) as Array<"library" | "linkedin" | "seek">;
  if (sources.length === 0) sources.push(r.candidateId ? "library" : "linkedin");

  const isLinkedinUrl = !!r.profileUrl && isLinkedInProfileUrl(r.profileUrl);
  const isSeek = !!r.profileUrl && /(^|\.)seek\.com/i.test(r.profileUrl);

  return {
    id: r.mergeKey, // stable across re-runs of the same query (identity merge key)
    name: r.name ?? "Unnamed profile",
    headline: r.headline,
    location: r.location,
    // Only a GENUINE linkedin.com/in URL goes in linkedinUrl — the run's single
    // `profileUrl` column also holds SEEK URLs, and feeding one to the import's
    // linkedin normaliser produced the mangled `linkedin.com/in/https://…seek…`
    // links. SEEK URLs go to seekUrl so the import can attach them as SEEK rows.
    linkedinUrl: isLinkedinUrl ? r.profileUrl : null,
    seekUrl: isSeek ? r.profileUrl : null,
    jobAdderUrl: null,
    updatedAgo: r.updatedAgo ?? null,
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
