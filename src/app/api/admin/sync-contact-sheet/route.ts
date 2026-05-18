/**
 * Sync the Google "Sourcing" sheet into RecruitMe.
 *
 * Reads every tab in the configured Google Sheet (one tab per job),
 * fuzzy-matches the tab name against an active Job.title, looks up each
 * row's LinkedIn URL against existing candidates in that job, and
 * applies the planner's decisions: flip Candidate.status to "contacted"
 * / "declined" per the sheet's Status column, create a ContactEvent for
 * each touch row (deduped per day), and append the Notes / Market
 * Feedback cell to the candidate's notes when present.
 *
 * Auth:
 *   - **Admin POST** (owner-only, NextAuth session) — for manual runs
 *     + debugging. Returns the full summary.
 *   - **Cron POST** — also accepts a shared-secret header
 *     `x-cron-secret: $CONTACT_SYNC_CRON_SECRET` so a Railway scheduled
 *     job can hit this endpoint without a user session.
 *
 * Env vars required:
 *   - GOOGLE_SHEETS_SHEET_ID         — sheet ID from the URL
 *   - GOOGLE_SERVICE_ACCOUNT_JSON    — full service-account credentials JSON
 *   - CONTACT_SYNC_CRON_SECRET       — shared secret for the cron path
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { getAuth } from "@/lib/session";
import { normaliseLinkedInUrl } from "@/lib/linkedin";
import { fetchAllTabs } from "@/lib/contact-sheet/fetch-google";
import { executePlan, planSync, summarisePlans } from "@/lib/contact-sheet/sync";
import type { SyncSummary } from "@/lib/contact-sheet/types";
import { tryAcquireLock, releaseLock } from "@/lib/db-lock";
import { reportError } from "@/lib/error-reporting";

// Large sheets (the live deployment has 30+ tabs, hundreds of rows each) take
// minutes to fetch + reconcile. 300s matches the cron job's grace window so a
// scheduled run never gets truncated mid-plan-execution — the advisory lock
// below already guards against concurrent runs.
export const maxDuration = 300;

const SYNC_LOCK_NAME = "contact-sheet-sync";

/** Constant-time compare that bails on length mismatch before timingSafeEqual
 *  (which throws on unequal-length buffers). Both args required to be non-empty. */
function secretsMatch(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<NextResponse<SyncSummary | { error: string }>> {
  const cronSecret = req.headers.get("x-cron-secret");
  const expectedSecret = process.env.CONTACT_SYNC_CRON_SECRET;
  const cronAuth = secretsMatch(cronSecret, expectedSecret);

  let orgId: string | null = null;
  if (!cronAuth) {
    // Fall back to user-session auth — admin/owner only.
    const auth = await getAuth();
    if (!auth?.isOwner) {
      return NextResponse.json({ error: "Owner-only endpoint" }, { status: 401 });
    }
    orgId = auth.orgId;
  } else {
    // Cron path — derive orgId from env (single-org deployments) or
    // require it in the query string. Most RecruitMe deploys are
    // single-org so we default to the first org we find.
    const cronOrgId = process.env.CONTACT_SYNC_ORG_ID ?? null;
    if (cronOrgId) {
      orgId = cronOrgId;
    } else {
      const firstOrg = await prisma.org.findFirst({ select: { id: true } });
      orgId = firstOrg?.id ?? null;
    }
  }
  if (!orgId) {
    return NextResponse.json({ error: "No organisation resolved — set CONTACT_SYNC_ORG_ID or run as an owner with an org" }, { status: 500 });
  }
  const resolvedOrgId: string = orgId;

  const sheetId = process.env.GOOGLE_SHEETS_SHEET_ID?.trim();
  const creds   = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!sheetId || !creds) {
    return NextResponse.json(
      { error: "GOOGLE_SHEETS_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON must be set" },
      { status: 500 },
    );
  }

  // Prevent concurrent runs. Railway cron may retry, and the user can hit
  // this manually mid-cron — both would double-write ContactEvents.
  const lockAcquired = await tryAcquireLock(SYNC_LOCK_NAME);
  if (!lockAcquired) {
    return NextResponse.json(
      { error: "Sync already in progress — try again in a minute" },
      { status: 409 },
    );
  }

  try {
    const startedAt = new Date();

    // 1. Pull the sheet.
    let tabs: Awaited<ReturnType<typeof fetchAllTabs>>;
    try {
      tabs = await fetchAllTabs({ sheetId, credentials: creds });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportError(err, { route: "sync-contact-sheet:fetch", orgId: resolvedOrgId });
      return NextResponse.json({ error: `Sheet fetch failed: ${msg}` }, { status: 502 });
    }

    // 2. Load active jobs + candidates in this org so the planner can
    //    decide everything without further DB chatter.
    const activeJobs = await prisma.job.findMany({
      where: { orgId: resolvedOrgId, status: "active" },
      select: { id: true, title: true, orgId: true },
    });
    const jobIds = activeJobs.map((j) => j.id);

    const candidates = jobIds.length > 0
      ? await prisma.candidate.findMany({
          where: { jobId: { in: jobIds }, linkedinUrl: { not: null } },
          select: { id: true, jobId: true, linkedinUrl: true, status: true, notes: true },
        })
      : [];

    const candidatesByKey = new Map<string, { id: string; jobId: string; linkedinUrl: string; status: string; notes: string | null }>();
    for (const c of candidates) {
      if (!c.linkedinUrl || !c.jobId) continue;
      const norm = normaliseLinkedInUrl(c.linkedinUrl);
      candidatesByKey.set(`${c.jobId}::${norm}`, { ...c, jobId: c.jobId, linkedinUrl: norm });
    }

    // ContactEvents are queried by (candidateId, type, day) — pull all
    // existing events for these candidates in one query and bucket them
    // by `${candidateId}::${YYYY-MM-DD}` so the planner can skip dupes.
    const candidateIds = candidates.map((c) => c.id);
    const existingEvents = candidateIds.length > 0
      ? await prisma.contactEvent.findMany({
          where: { candidateId: { in: candidateIds }, orgId: resolvedOrgId },
          select: { candidateId: true, createdAt: true },
        })
      : [];
    const contactEventDayKeys = new Set(
      existingEvents.map((e) => `${e.candidateId}::${e.createdAt.toISOString().slice(0, 10)}`),
    );

    // 3. Plan + execute.
    const { plans, unmatchedTabs } = planSync({
      tabs,
      activeJobs,
      candidatesByKey,
      contactEventDayKeys,
    });
    const { updated } = await executePlan({ plans, orgId });

    const finishedAt = new Date();
    const summary = summarisePlans(plans, unmatchedTabs, startedAt, finishedAt, updated);
    summary.tabsProcessed = tabs.size;

    console.log(
      `[contact-sheet] sync done — tabs=${summary.tabsProcessed} rows=${summary.rowsScanned} ` +
      `updated=${summary.rowsUpdated} skipped=${summary.rowsSkipped} ` +
      `unmatched_tabs=${unmatchedTabs.length} duration=${summary.durationMs}ms`,
    );
    return NextResponse.json(summary);
  } finally {
    await releaseLock(SYNC_LOCK_NAME);
  }
}
