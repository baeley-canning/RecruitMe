/**
 * GET /api/health — appliance liveness + dependency probe.
 *
 * Returns 200 when the FATAL dependencies (DB + scraper worker) are
 * reachable. Used by:
 *  - systemd healthcheck timer on the mini-PC (restarts the app on
 *    repeated failure)
 *  - the per-box heartbeat cron that POSTs to the admin portal
 *  - the on-box ops dashboard (/box-dashboard) for live status pills
 *
 * Shape:
 *   { ok: boolean,
 *     checks: { db, ollama, scraper },
 *     version: string,
 *     uptimeSec: number }
 *
 * Each check is { ok: boolean, detail?: string, lastSeenAt?: ISO }.
 * Ollama is skipped (reported `ok: true, skipped: true`) when no
 * OLLAMA_OFFLOAD_TASKS env is set — boxes without local LLM shouldn't
 * fail health for a service they don't depend on.
 *
 * Ollama is a BEST-EFFORT signal, not a fatal dependency: it's the
 * Claude failover, so the app still functions when it's down (Claude
 * stays primary). An unreachable Ollama is reported in `checks.ollama`
 * (ok:false) and surfaced via the `degraded` flag, but it does NOT flip
 * the overall status to 503 — otherwise the Railway/systemd healthcheck
 * would restart-loop the whole app over a non-critical local model.
 *
 * Status code: 200 when DB + scraper are ok (503 only when one of THOSE
 * fails). The body is always JSON so consumers can read why something's
 * down — or degraded — without branching on status.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isScraperDiscoveryEnabled, isLlamaScoreOffloadEnabled } from "@/lib/feature-flags";
import { probeBlobStore, getBlob } from "@/lib/blob-store";
import { isEncrypted, decryptCv } from "@/lib/cv-encryption";

interface CheckResult {
  ok: boolean;
  detail?: string;
  lastSeenAt?: string;
  skipped?: boolean;
}

interface HealthResponse {
  ok: boolean;
  /** True when a non-fatal dependency (Ollama) is unreachable but the
   *  app is still serving — i.e. ok stays true. Lets the ops dashboard
   *  show an amber pill without the healthcheck restarting the app. */
  degraded: boolean;
  checks: {
    db: CheckResult;
    ollama: CheckResult;
    scraper: CheckResult;
    blob: CheckResult;
    cv: CheckResult;
  };
  version: string;
  uptimeSec: number;
  timestamp: string;
  /** Operator-visible flag state so a deploy's effect is verifiable without
   *  app auth (e.g. confirm discovery actually flipped on). */
  flags: { discovery: boolean; scoreOffload: boolean };
}

const PROCESS_STARTED_AT = Date.now();
const SCRAPER_STALE_MS = 10 * 60 * 1000;

async function checkDb(): Promise<CheckResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "db ping failed" };
  }
}

async function checkOllama(): Promise<CheckResult> {
  if (!process.env.OLLAMA_OFFLOAD_TASKS) return { ok: true, skipped: true };
  const baseURL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
  try {
    const r = await fetch(`${baseURL.replace(/\/v1$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok) return { ok: false, detail: `ollama HTTP ${r.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "ollama unreachable" };
  }
}

async function checkScraper(): Promise<CheckResult> {
  // The scraper-worker is healthy when EITHER (a) there's nothing pending
  // (queue idle is fine — many recruiters won't trigger searches for hours),
  // or (b) there ARE pending jobs and at least one of them has been picked
  // up / progressed recently. A pending job sitting untouched for >10 min
  // is the real failure signal — the worker stalled or crashed.
  //
  // Phase I2 will add an explicit worker-heartbeat row updated each poll
  // cycle, which lets us flag a dead worker even when the queue is empty.
  // Until then, this is the closest proxy.
  try {
    const [pending, lastTouched] = await Promise.all([
      prisma.scrapeJob.count({ where: { status: "pending" } }),
      prisma.scrapeJob.findFirst({
        where: { status: { in: ["processing", "completed", "failed"] } },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      }),
    ]);
    if (pending === 0) return { ok: true, detail: "queue idle" };
    if (!lastTouched) {
      return { ok: false, detail: `${pending} pending job(s) and worker has never run` };
    }
    const ageMs = Date.now() - lastTouched.updatedAt.getTime();
    if (ageMs > SCRAPER_STALE_MS) {
      return {
        ok: false,
        detail: `${pending} pending, worker last active ${Math.round(ageMs / 1000)}s ago`,
        lastSeenAt: lastTouched.updatedAt.toISOString(),
      };
    }
    return { ok: true, lastSeenAt: lastTouched.updatedAt.toISOString(), detail: `${pending} pending` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "scraper check failed" };
  }
}

// Decrypt health-check (NON-fatal / degraded). Verifies CV_ENCRYPTION_KEY can
// actually decrypt a real stored CV — bucket-aware: most prod CVs are
// blob-offloaded (storageKey set + the v1: envelope lives in the bucket, NOT in
// inline `data`), so a data-only check would miss them all. A missing/wrong key
// silently makes every CV unreadable; this surfaces it as amber instead of a
// silent total-loss. Degraded, never fatal — one bad CV must not 503/restart
// the app. Timeout-guarded so a slow bucket can't hang the healthcheck.
async function checkCvEncryption(): Promise<CheckResult> {
  const run = (async (): Promise<CheckResult> => {
    try {
      const sample = await prisma.candidateFile.findFirst({
        where: { OR: [{ storageKey: { not: null } }, { data: { startsWith: "v1:" } }] },
        select: { data: true, storageKey: true },
      });
      if (!sample) return { ok: true, skipped: true, detail: "no encrypted CVs" };
      const stored = sample.storageKey ? await getBlob(sample.storageKey) : sample.data;
      if (!stored || !isEncrypted(stored)) return { ok: true, detail: "sample not encrypted (legacy plaintext)" };
      await decryptCv(stored); // throws if the key is missing or wrong
      return { ok: true, detail: "decrypt ok" };
    } catch (err) {
      return { ok: false, detail: `CV decrypt failed — CV_ENCRYPTION_KEY missing/wrong: ${err instanceof Error ? err.message : "error"}` };
    }
  })();
  const timeout = new Promise<CheckResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, detail: "cv decrypt check timed out" }), 5000));
  return Promise.race([run, timeout]);
}

export async function GET() {
  const [db, ollama, scraper, blob, cv] = await Promise.all([
    checkDb(),
    checkOllama(),
    checkScraper(),
    probeBlobStore(),
    checkCvEncryption(),
  ]);

  // Only DB + scraper are FATAL. Ollama (Claude failover) and the blob store
  // are reported but NON-fatal for the healthcheck: a transient R2 blip
  // shouldn't restart-loop the app. But a blob-store outage means every CV
  // download is failing, so it MUST surface — `degraded` flips amber so the
  // ops dashboard / alerting catches it instead of /api/health staying green.
  const overallOk = db.ok && scraper.ok;
  const degraded = overallOk && (!ollama.ok || !blob.ok || !cv.ok);
  // Report the deployed commit SHA so a deploy is verifiable from /api/health.
  // RECRUITME_VERSION stays the highest-priority explicit override; otherwise
  // fall back to the build's git SHA (Railway sets RAILWAY_GIT_COMMIT_SHA;
  // GIT_SHA is the generic fallback), truncated to 7 chars, then "dev" locally.
  const version = process.env.RECRUITME_VERSION
    ?? (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? "dev").slice(0, 7);
  const body: HealthResponse = {
    ok: overallOk,
    degraded,
    checks: { db, ollama, scraper, blob, cv },
    version,
    uptimeSec: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
    timestamp: new Date().toISOString(),
    flags: { discovery: isScraperDiscoveryEnabled(), scoreOffload: isLlamaScoreOffloadEnabled() },
  };
  return NextResponse.json(body, { status: overallOk ? 200 : 503 });
}
