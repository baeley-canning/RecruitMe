/**
 * GET /api/health — appliance liveness + dependency probe.
 *
 * Returns 200 only when DB, Ollama, and the scraper worker are all
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
 * Status code: 200 when overall.ok = true, 503 otherwise. The body is
 * always JSON so consumers can read why something's down without
 * branching on status.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

interface CheckResult {
  ok: boolean;
  detail?: string;
  lastSeenAt?: string;
  skipped?: boolean;
}

interface HealthResponse {
  ok: boolean;
  checks: {
    db: CheckResult;
    ollama: CheckResult;
    scraper: CheckResult;
  };
  version: string;
  uptimeSec: number;
  timestamp: string;
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

export async function GET() {
  const [db, ollama, scraper] = await Promise.all([
    checkDb(),
    checkOllama(),
    checkScraper(),
  ]);

  const overallOk = db.ok && ollama.ok && scraper.ok;
  const body: HealthResponse = {
    ok: overallOk,
    checks: { db, ollama, scraper },
    version: process.env.RECRUITME_VERSION ?? "dev",
    uptimeSec: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: overallOk ? 200 : 503 });
}
