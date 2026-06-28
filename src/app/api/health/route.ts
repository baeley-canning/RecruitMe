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
import { getAuth } from "@/lib/session";

interface CheckResult {
  ok: boolean;
  detail?: string;
  lastSeenAt?: string;
  skipped?: boolean;
  /** ok=true but worth an amber top-level `degraded` flag (e.g. a stale scraper
   *  heartbeat on an idle queue — the box is offline but mustn't 503 the app). */
  degraded?: boolean;
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
    const [pending, lastTouched, hb] = await Promise.all([
      prisma.scrapeJob.count({ where: { status: "pending" } }),
      prisma.scrapeJob.findFirst({
        where: { status: { in: ["processing", "completed", "failed"] } },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      }),
      prisma.scraperHeartbeat.findFirst({ orderBy: { updatedAt: "desc" } }),
    ]);

    // Phase I2 — explicit worker heartbeat. When present it's the real liveness
    // signal (works even with an idle queue). A STALE heartbeat is only FATAL
    // when a backlog is also piling up (genuinely stuck); a stale heartbeat with
    // an idle queue means the box is simply offline and must NOT 503 the app —
    // surface it in the detail / dashboard instead.
    if (hb) {
      const hbAgeMs = Date.now() - hb.updatedAt.getTime();
      const fresh = hbAgeMs <= SCRAPER_STALE_MS;
      if (!fresh && pending > 0) {
        return { ok: false, lastSeenAt: hb.updatedAt.toISOString(), detail: `worker silent ${Math.round(hbAgeMs / 60000)}m, ${pending} pending` };
      }
      const note = fresh
        ? `heartbeat ${Math.round(hbAgeMs / 1000)}s ago`
        : `heartbeat STALE ${Math.round(hbAgeMs / 60000)}m (box may be offline)`;
      // Stale-but-idle stays ok (no 503) but flips `degraded` so an offline box
      // is visible at the top level, not buried in the detail string.
      return { ok: true, degraded: !fresh, lastSeenAt: hb.updatedAt.toISOString(), detail: `${note} · ${pending} pending · ${hb.pollErrors} poll errors` };
    }

    // Fallback (no heartbeat row yet): the original queue-stuck heuristic.
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: "cv decrypt check timed out" }), 5000);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  // FATAL = only what the WEB APP itself needs to serve a request: the database.
  // The box scraper runs on a SEPARATE machine (the mini-PC); the website serves
  // perfectly well without it. Treating the scraper as fatal here was a migration
  // artifact from when the app + scraper co-ran on the box — and because
  // railway.toml uses /api/health as the DEPLOY healthcheck, a box/scraper outage
  // flipped this to 503 and Railway restart-looped/failed the entire website (a
  // box outage cascading into "can't open the app"). A down scraper is now
  // DEGRADED (amber), never a 503 — its real state stays visible in
  // checks.scraper.ok and the ops dashboard, but it can't take the site down.
  const overallOk = db.ok;
  const degraded = overallOk && (!ollama.ok || !blob.ok || !cv.ok || !scraper.ok || !!scraper.degraded);

  // Unauthenticated callers get LIVENESS ONLY — boolean per-check pills plus the
  // 200/503 status the systemd / Railway / updater healthchecks read (they don't
  // parse the body). The detailed fields (git SHA, feature-flag states, uptime,
  // and the per-check `detail` strings that can carry internal URLs/errors) are
  // reconnaissance material, so they're gated behind an authenticated session.
  const auth = await getAuth();
  if (!auth) {
    return NextResponse.json(
      {
        ok: overallOk,
        degraded,
        checks: {
          db: { ok: db.ok },
          ollama: { ok: ollama.ok, ...(ollama.skipped ? { skipped: true } : {}) },
          scraper: { ok: scraper.ok, ...(scraper.degraded ? { degraded: true } : {}) },
          blob: { ok: blob.ok },
          cv: { ok: cv.ok },
        },
        timestamp: new Date().toISOString(),
      },
      { status: overallOk ? 200 : 503 },
    );
  }

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
