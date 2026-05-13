/**
 * Contact-sheet sync — pure planner + DB executor.
 *
 * The planner is pure (no I/O) so the matching + status-mapping rules
 * are fully unit-testable. The executor applies the plan to Prisma,
 * with idempotency on both the status update (only changes when delta)
 * and the ContactEvent creation (skipped when one already exists for
 * the same candidate + type + date).
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db";
import { mapSheetStatusToCandidateStatus, isProtectedStatus, normaliseSheetLinkedInUrl, pickBestJob } from "./normalize";
import type { RowPlan, SheetRow, SkipReason, SyncSummary } from "./types";

const SYNC_USER_ID   = "contact-sheet-sync";
const SYNC_USER_NAME = "Contact-sheet sync";

interface JobLookup {
  id: string;
  title: string;
  /** Job.orgId is nullable in the schema but the planner only needs it
   *  for logging — leave it as the schema's type. */
  orgId: string | null;
}

interface CandidateLookup {
  id: string;
  jobId: string | null;
  linkedinUrl: string;
  status: string;
  notes: string | null;
}

/**
 * Pure planner: given parsed sheet rows + the active jobs + the
 * candidates already in those jobs, decide what to do for every row
 * without touching the database.
 *
 * Exported separately so tests can drive every branch with synthetic
 * inputs and zero mocking.
 */
export function planSync(args: {
  /** Tab-name → rows. Each tab corresponds to a job. */
  tabs: Map<string, SheetRow[]>;
  /** Active jobs scoped to the syncing org. */
  activeJobs: JobLookup[];
  /** All candidates indexed by `${jobId}::${normalisedLinkedInUrl}`. */
  candidatesByKey: Map<string, CandidateLookup>;
  /** ContactEvents already in place, keyed by
   *  `${candidateId}::${YYYY-MM-DD}` so the planner can mark
   *  addContactEvent=false when an event for that day already exists. */
  contactEventDayKeys: Set<string>;
  /** Tabs that should NEVER be synced. */
  skipTabs?: string[];
  /** Fallback date for ContactEvent when the row has no "Last contacted"
   *  value. Defaults to today. */
  fallbackContactDate?: Date;
}): { plans: RowPlan[]; unmatchedTabs: string[] } {
  const {
    tabs,
    activeJobs,
    candidatesByKey,
    contactEventDayKeys,
    skipTabs = ["Template"],
    fallbackContactDate = new Date(),
  } = args;

  const plans: RowPlan[] = [];
  const unmatchedTabs: string[] = [];
  const skipTabSet = new Set(skipTabs.map((t) => t.toLowerCase()));

  for (const [tabName, rows] of tabs) {
    if (skipTabSet.has(tabName.toLowerCase())) continue;
    const job = pickBestJob(tabName, activeJobs);
    if (!job) {
      unmatchedTabs.push(tabName);
      for (const row of rows) {
        plans.push({ action: "skip", reason: "no_job_match", sheetRow: row });
      }
      continue;
    }
    for (const row of rows) {
      plans.push(planRow(row, job.id, candidatesByKey, contactEventDayKeys, fallbackContactDate));
    }
  }

  return { plans, unmatchedTabs };
}

function planRow(
  row: SheetRow,
  jobId: string,
  candidatesByKey: Map<string, CandidateLookup>,
  contactEventDayKeys: Set<string>,
  fallbackContactDate: Date,
): RowPlan {
  const url = normaliseSheetLinkedInUrl(row.linkedinUrl);
  if (!url) return { action: "skip", reason: "empty_linkedin_url", sheetRow: row };
  if (!row.status.trim()) return { action: "skip", reason: "empty_status", sheetRow: row };

  const mapping = mapSheetStatusToCandidateStatus(row.status);
  if (mapping.mapped === "unknown") {
    return { action: "skip", reason: "unknown_status", sheetRow: row };
  }

  const candidate = candidatesByKey.get(`${jobId}::${url}`);
  if (!candidate) return { action: "skip", reason: "candidate_not_found", sheetRow: row };

  // Status decision — only write when delta AND not protected.
  let newStatus: string | undefined;
  if (mapping.mapped === "contacted" || mapping.mapped === "declined") {
    if (isProtectedStatus(candidate.status)) {
      // Pipeline state set manually by recruiter — never overwrite.
      // We still create the ContactEvent (recruiter wants to see the touch)
      // but skip the status flip.
      newStatus = undefined;
    } else if (candidate.status !== mapping.mapped) {
      newStatus = mapping.mapped;
    }
  }

  // ContactEvent decision — only add when the row represents a touch AND
  // we don't already have one for the same day. Day-level idempotency is
  // the right grain because the sheet's "Last contacted" is a date, not
  // a timestamp.
  let addContactEvent = false;
  if (mapping.isContactTouch) {
    const date = row.lastContacted ?? fallbackContactDate;
    const dayKey = `${candidate.id}::${date.toISOString().slice(0, 10)}`;
    if (!contactEventDayKeys.has(dayKey)) addContactEvent = true;
  }

  // Note append — only add when there's content AND it isn't already
  // present verbatim in candidate.notes.
  let noteToAppend: string | null = null;
  if (row.notes && row.notes.trim()) {
    const existing = candidate.notes ?? "";
    if (!existing.includes(row.notes.trim())) {
      noteToAppend = row.notes.trim();
    }
  }

  if (!newStatus && !addContactEvent && !noteToAppend) {
    return { action: "skip", reason: "no_change_needed", sheetRow: row };
  }

  // Status was suppressed because of protection — surface that
  // explicitly so the audit log shows we deliberately didn't overwrite.
  if (
    !newStatus &&
    !addContactEvent &&
    !noteToAppend &&
    isProtectedStatus(candidate.status)
  ) {
    return { action: "skip", reason: "terminal_status_protected", sheetRow: row };
  }

  return {
    action: "update",
    candidateId: candidate.id,
    jobId,
    sheetRow: row,
    newStatus,
    addContactEvent,
    noteToAppend,
  };
}

// ─── Executor ─────────────────────────────────────────────────────────────

/**
 * Apply a list of RowPlans to the database. Idempotent — running with
 * the same plans repeatedly is a no-op after the first run because
 * status will already match + contact events will already exist.
 */
export async function executePlan(args: {
  plans: RowPlan[];
  orgId: string;
  fallbackContactDate?: Date;
  client?: PrismaClient;
}): Promise<{ updated: number }> {
  const db = args.client ?? defaultPrisma;
  const fallback = args.fallbackContactDate ?? new Date();
  let updated = 0;

  for (const plan of args.plans) {
    if (plan.action !== "update") continue;

    const updates: Record<string, unknown> = {};
    if (plan.newStatus) updates.status = plan.newStatus;
    if (plan.noteToAppend) {
      // Append on the DB side via a raw fragment-style update isn't worth
      // the complexity — re-read the candidate's notes, append, write back.
      const fresh = await db.candidate.findUnique({
        where: { id: plan.candidateId },
        select: { notes: true },
      });
      const prefix = fresh?.notes?.trim() ? `${fresh.notes}\n` : "";
      updates.notes = `${prefix}[sheet ${new Date().toISOString().slice(0, 10)}] ${plan.noteToAppend}`;
    }

    if (Object.keys(updates).length > 0) {
      await db.candidate.update({ where: { id: plan.candidateId }, data: updates });
    }

    if (plan.addContactEvent) {
      const date = plan.sheetRow.lastContacted ?? fallback;
      await db.contactEvent.create({
        data: {
          candidateId: plan.candidateId,
          orgId: args.orgId,
          userId: SYNC_USER_ID,
          userName: SYNC_USER_NAME,
          jobId: plan.jobId,
          type: "email",
          note: plan.sheetRow.notes?.trim() || null,
          createdAt: date,
        },
      });
    }

    updated++;
  }

  return { updated };
}

// ─── Plan summary ─────────────────────────────────────────────────────────

/** Aggregate plans into the audit summary returned by the route. */
export function summarisePlans(
  plans: RowPlan[],
  unmatchedTabs: string[],
  startedAt: Date,
  finishedAt: Date,
  appliedCount: number,
): SyncSummary {
  const skipCounts: Record<SkipReason, number> = {
    empty_status: 0,
    empty_linkedin_url: 0,
    unknown_status: 0,
    candidate_not_found: 0,
    no_job_match: 0,
    terminal_status_protected: 0,
    no_change_needed: 0,
  };
  const unmatchedRowsSample: SyncSummary["unmatchedRowsSample"] = [];

  let rowsSkipped = 0;
  for (const p of plans) {
    if (p.action !== "skip") continue;
    rowsSkipped++;
    skipCounts[p.reason]++;
    if (
      unmatchedRowsSample.length < 20 &&
      (p.reason === "candidate_not_found" || p.reason === "unknown_status" || p.reason === "no_job_match")
    ) {
      unmatchedRowsSample.push({
        tab: "—", // tab-level info isn't carried per-row; route can enrich if needed
        rowNumber: p.sheetRow.rowNumber,
        reason: p.reason,
        linkedinUrl: p.sheetRow.linkedinUrl,
      });
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    tabsProcessed: 0, // route fills in
    rowsScanned: plans.length,
    rowsUpdated: appliedCount,
    rowsSkipped,
    skipCounts,
    unmatchedTabs,
    unmatchedRowsSample,
  };
}
