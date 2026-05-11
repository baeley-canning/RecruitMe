/**
 * Background phone enrichment for candidate records.
 *
 * Called fire-and-forget from save sites (extension capture, manual add,
 * search, talent-pool import, library import). On the bulk-enrich endpoint
 * this is invoked synchronously with concurrency-limited waves.
 *
 * Idempotency: skips when phone is already present OR when last lookup was
 * within FIRMABLE_REFRESH_WINDOW_MS. Force refresh via `force: true`.
 */

import { prisma } from "./db";
import { enrichByLinkedIn, isEnrichmentFresh, isFirmableConfigured } from "./firmable";

export interface EnrichOutcome {
  candidateId: string;
  status: "enriched" | "skipped_already_has_phone" | "skipped_recently_enriched" | "skipped_no_linkedin" | "no_match" | "not_configured" | "error";
  phone?: string | null;
}

interface EnrichCandidateOptions {
  /** Skip phone-present and recent-enrichment guards. Used by the bulk
   *  endpoint when the recruiter explicitly clicks "Re-enrich". */
  force?: boolean;
  /** Already-loaded candidate row to avoid an extra DB read. */
  candidate?: { id: string; linkedinUrl: string | null; phone: string | null; firmableEnrichedAt: Date | null };
}

export async function enrichCandidate(
  candidateId: string,
  options: EnrichCandidateOptions = {},
): Promise<EnrichOutcome> {
  if (!isFirmableConfigured()) {
    return { candidateId, status: "not_configured" };
  }

  let row = options.candidate;
  if (!row) {
    row = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, linkedinUrl: true, phone: true, firmableEnrichedAt: true },
    }) ?? undefined;
    if (!row) return { candidateId, status: "error" };
  }

  if (!row.linkedinUrl?.trim()) {
    return { candidateId, status: "skipped_no_linkedin" };
  }
  if (!options.force) {
    if (row.phone?.trim()) {
      return { candidateId, status: "skipped_already_has_phone", phone: row.phone };
    }
    if (isEnrichmentFresh(row.firmableEnrichedAt)) {
      return { candidateId, status: "skipped_recently_enriched" };
    }
  }

  try {
    const result = await enrichByLinkedIn(row.linkedinUrl);
    if (!result) {
      // Stamp firmableEnrichedAt so we don't pound Firmable retrying the same
      // missing person on every save. Phone stays null.
      await prisma.candidate.update({
        where: { id: row.id },
        data: { firmableEnrichedAt: new Date() },
      }).catch((err) => console.warn("[firmable-enrich] stamp-on-no-match failed:", err));
      return { candidateId, status: "no_match" };
    }

    await prisma.candidate.update({
      where: { id: row.id },
      data: {
        phone: result.primaryPhone,
        firmableData: JSON.stringify(result.raw),
        firmableEnrichedAt: new Date(),
      },
    });
    return { candidateId, status: "enriched", phone: result.primaryPhone };
  } catch (err) {
    console.warn(`[firmable-enrich] failed for candidate ${row.id}:`, err instanceof Error ? err.message : err);
    return { candidateId, status: "error" };
  }
}

/**
 * Fire-and-forget background enrich. Use at save sites where you don't want
 * to block the response on a Firmable round-trip. Errors are logged, not
 * thrown — the candidate save has already succeeded.
 */
export function enrichCandidateInBackground(
  candidateId: string,
  options: EnrichCandidateOptions = {},
): void {
  if (!isFirmableConfigured()) return;
  void enrichCandidate(candidateId, options).catch((err) => {
    console.warn(`[firmable-enrich] background enrich failed for ${candidateId}:`, err);
  });
}

/**
 * Concurrency-limited bulk enrich. Used by the bulk-enrich endpoint to
 * backfill an entire job's candidates without spamming Firmable.
 * Default concurrency = 5; well under the 50 req/sec rate limit and gives
 * plenty of headroom for other traffic.
 */
export async function enrichCandidatesBulk(
  candidateIds: string[],
  options: { force?: boolean; concurrency?: number } = {},
): Promise<EnrichOutcome[]> {
  if (!isFirmableConfigured()) {
    return candidateIds.map((id) => ({ candidateId: id, status: "not_configured" as const }));
  }

  const concurrency = Math.max(1, Math.min(10, options.concurrency ?? 5));
  const results: EnrichOutcome[] = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < candidateIds.length) {
      const idx = cursor++;
      const id = candidateIds[idx];
      const outcome = await enrichCandidate(id, { force: options.force });
      results.push(outcome);
    }
  });
  await Promise.all(workers);
  return results;
}
