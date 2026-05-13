/**
 * Shared types for the contact-sheet sync.
 *
 * The Google Sheet has one tab per job. Each row tracks one candidate's
 * contact state (Status column drives the action) plus optional notes
 * and last-contacted date. The tab name is the job identifier — fuzzy-
 * matched against Job.title in RecruitMe.
 */

/** One parsed row from a Google Sheet tab. */
export interface SheetRow {
  /** 1-indexed row number in the sheet (for log lines + audit). */
  rowNumber: number;
  /** Raw LinkedIn URL as it appears in the sheet. */
  linkedinUrl: string;
  /** Optional display name — used in logs and as a fallback if we ever
   *  decide to auto-create candidates not yet in RecruitMe. */
  candidateName: string | null;
  /** Optional company. Currently logged only — not written. */
  company: string | null;
  /** Free-form notes — appended to Candidate.notes when present. */
  notes: string | null;
  /** Free-form owner name — logged only in v1; no user mapping. */
  owner: string | null;
  /** Status cell, lowercased + trimmed; "" when empty. Drives the
   *  status mapping in normalize.ts. */
  status: string;
  /** "Last contacted" cell as a Date when parseable, else null. */
  lastContacted: Date | null;
}

/** Sync planner output for one row — pure decision, no side effects. */
export type RowPlan =
  | {
      action: "update";
      candidateId: string;
      jobId: string;
      sheetRow: SheetRow;
      /** Status to write — undefined if no status change required. */
      newStatus?: string;
      /** Whether to add a ContactEvent for this row. */
      addContactEvent: boolean;
      /** Note text to append to Candidate.notes, if non-empty. */
      noteToAppend: string | null;
    }
  | {
      action: "skip";
      reason: SkipReason;
      sheetRow: SheetRow;
    };

export type SkipReason =
  | "empty_status"          // row has no Status filled in — nothing to apply
  | "empty_linkedin_url"    // row missing the LinkedIn URL — nothing to look up
  | "unknown_status"        // Status value doesn't map to any known action
  | "candidate_not_found"   // LinkedIn URL doesn't match any candidate in the matched job
  | "no_job_match"          // tab name didn't fuzzy-match any active job
  | "terminal_status_protected" // candidate already hired/offer_sent/interviewing/shortlisted — sheet won't downgrade
  | "no_change_needed";     // status and contact event already in place (idempotency hit)

/** Aggregate result returned by the sync run. */
export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tabsProcessed: number;
  rowsScanned: number;
  rowsUpdated: number;
  rowsSkipped: number;
  /** Per-skip-reason counts so the recruiter can see at a glance what
   *  fell through. */
  skipCounts: Record<SkipReason, number>;
  /** Tabs that we couldn't match to an active RecruitMe job. */
  unmatchedTabs: string[];
  /** Up to 20 specific unmatched rows for triage. */
  unmatchedRowsSample: Array<{ tab: string; rowNumber: number; reason: SkipReason; linkedinUrl: string }>;
}
