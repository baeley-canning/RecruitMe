/**
 * Box vitals collector (Phase I1).
 *
 * Shared by /api/box-dashboard/stats (one-shot) and
 * /api/box-dashboard/stream (SSE, calls this each tick). Both invoke
 * `collectBoxStats()` IN-PROCESS — the stream route deliberately does NOT
 * HTTP-fetch the stats route, because that hairpin (Next → Caddy → Next)
 * deadlocks the connection pool when a browser holds the SSE stream open,
 * which silently starves the EventSource of data. Direct function call =
 * no hairpin, no deadlock.
 *
 * Returns counts + system gauges only — no candidate PII. The activity
 * feed carries candidate names (it's the on-box screen, single-tenant,
 * loopback-gated) but the seller heartbeat strips those before upload.
 */

import { prisma } from "@/lib/db";
import { readFile, statfs, readdir } from "node:fs/promises";
import os from "node:os";

export interface ServiceCheck { ok: boolean; detail?: string }

export interface BoxStats {
  ts: string;
  system: {
    uptimeSec: number;
    loadAvg: [number, number, number];
    cpuCount: number;
    ram: { total: number; free: number; used: number; usedPct: number };
    swap: { total: number; free: number; usedPct: number };
    disk: { total: number; free: number; used: number; usedPct: number };
    network: { wifiSignal: number | null; tailscaleOnline: boolean };
    /** CPU package temperature in °C (null if no readable sensor). */
    cpuTempC: number | null;
  };
  services: {
    app: ServiceCheck;
    db: ServiceCheck;
    ollama: ServiceCheck;
    scraper: ServiceCheck;
  };
  today: {
    searches: number;
    candidatesAdded: number;
    scrapeOk: number;
    scrapeFailed: number;
    aiCalls: number;
  };
  activity: Array<{ kind: "scrape" | "ai" | "candidate"; label: string; at: string }>;
  scraper: {
    inProgress: { platform: string; kind: string; query?: string | null } | null;
    queueDepth: number;
  };
  ai: { ollamaModel: string | null; lastCallAgoMs: number | null };
  version: string;
}

async function readMemoryInfo() {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf-8");
    const parse = (key: string) => {
      const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
      return m ? Number(m[1]) * 1024 : 0;
    };
    return {
      total:     parse("MemTotal"),
      avail:     parse("MemAvailable"),
      swapTotal: parse("SwapTotal"),
      swapFree:  parse("SwapFree"),
    };
  } catch {
    return { total: os.totalmem(), avail: os.freemem(), swapTotal: 0, swapFree: 0 };
  }
}

async function readWifiSignal(): Promise<number | null> {
  try {
    const proc = await readFile("/proc/net/wireless", "utf-8");
    const lines = proc.split("\n").slice(2).filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const raw = parts[3].replace(/\.$/, "");
      const n = Number(raw);
      if (!Number.isNaN(n)) return n;
    }
    return null;
  } catch {
    return null;
  }
}

async function readTailscaleOnline(): Promise<boolean> {
  try {
    const dev = await readFile("/proc/net/dev", "utf-8");
    return /\btailscale0:/.test(dev);
  } catch {
    return false;
  }
}

async function readDiskUsage() {
  try {
    const s = await statfs("/");
    const total = Number(s.blocks) * Number(s.bsize);
    const free  = Number(s.bavail) * Number(s.bsize);
    return { total, free, used: total - free, usedPct: total ? 1 - free / total : 0 };
  } catch {
    return { total: 0, free: 0, used: 0, usedPct: 0 };
  }
}

/**
 * CPU temperature from /sys/class/thermal (values are milli-°C). Prefers the
 * CPU package sensor (x86_pkg_temp / coretemp); falls back to the hottest
 * acpitz zone. No lm-sensors dependency. Returns null if nothing readable.
 */
async function readCpuTemp(): Promise<number | null> {
  try {
    const base = "/sys/class/thermal";
    const zones = (await readdir(base)).filter((e) => /^thermal_zone\d+$/.test(e));
    let pkg: number | null = null;
    let acpiMax: number | null = null;
    for (const z of zones) {
      const type = (await readFile(`${base}/${z}/type`, "utf-8").catch(() => "")).trim();
      const raw = Number((await readFile(`${base}/${z}/temp`, "utf-8").catch(() => "")).trim());
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const c = Math.round(raw / 1000);
      if (type === "x86_pkg_temp" || type.startsWith("coretemp")) pkg = c;
      else if (type === "acpitz") acpiMax = Math.max(acpiMax ?? 0, c);
    }
    return pkg ?? acpiMax;
  } catch {
    return null;
  }
}

async function checkOllama(): Promise<ServiceCheck & { model?: string }> {
  if (!process.env.OLLAMA_OFFLOAD_TASKS) return { ok: true, detail: "not in use" };
  const baseURL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
  try {
    const r = await fetch(`${baseURL.replace(/\/v1$/, "")}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const data = await r.json() as { models?: Array<{ name: string }> };
    return { ok: true, model: data.models?.[0]?.name };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "unreachable" };
  }
}

export async function collectBoxStats(): Promise<BoxStats> {
  const [mem, wifi, tsOnline, disk, ollama, cpuTempC] = await Promise.all([
    readMemoryInfo(),
    readWifiSignal(),
    readTailscaleOnline(),
    readDiskUsage(),
    checkOllama(),
    readCpuTemp(),
  ]);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // These DB reads run in BATCHES of 4 rather than one 12-wide Promise.all:
  // the pool is 10 connections shared with score-all (CONCURRENCY=3), and a
  // 12-wide fan-out here could exhaust it under overlap (pool_timeout 500s).
  // Counts/findFirst are fast, so 3 sequential batches add negligible latency.
  const [dbOk, searchesToday, candidatesToday, scrapeOkToday] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    prisma.scrapeJob.count({ where: { kind: "search", createdAt: { gte: todayStart } } }).catch(() => 0),
    prisma.candidate.count({ where: { createdAt: { gte: todayStart } } }).catch(() => 0),
    prisma.scrapeJob.count({ where: { status: "completed", updatedAt: { gte: todayStart } } }).catch(() => 0),
  ]);
  const [scrapeFailedToday, aiCallsToday, inProgress, pendingCount] = await Promise.all([
    prisma.scrapeJob.count({ where: { status: "failed", updatedAt: { gte: todayStart } } }).catch(() => 0),
    prisma.usageEvent.count({ where: { type: "ai_call", createdAt: { gte: todayStart } } }).catch(() => 0),
    prisma.scrapeJob.findFirst({
      where: { status: "processing" },
      orderBy: { updatedAt: "desc" },
      select: { platform: true, kind: true, searchQuery: true },
    }).catch(() => null),
    prisma.scrapeJob.count({ where: { status: "pending" } }).catch(() => 0),
  ]);
  const [recentScrapes, recentCandidates, lastAiCall, lastScraperUpdate] = await Promise.all([
    prisma.scrapeJob.findMany({
      where: { status: { in: ["completed", "failed"] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { platform: true, kind: true, searchQuery: true, status: true, updatedAt: true },
    }).catch(() => []),
    prisma.candidate.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { name: true, source: true, createdAt: true },
    }).catch(() => []),
    prisma.usageEvent.findFirst({
      where: { type: "ai_call" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }).catch(() => null),
    prisma.scrapeJob.findFirst({
      where: { status: { in: ["processing", "completed", "failed"] } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }).catch(() => null),
  ]);

  const scraperFresh: ServiceCheck = pendingCount === 0
    ? { ok: true, detail: "queue idle" }
    : lastScraperUpdate && Date.now() - lastScraperUpdate.updatedAt.getTime() < 5 * 60 * 1000
      ? { ok: true, detail: `${pendingCount} pending` }
      : { ok: false, detail: `${pendingCount} pending, worker stalled?` };

  const activity: BoxStats["activity"] = [
    ...recentCandidates.map((c) => ({
      kind: "candidate" as const,
      label: `${c.source} → ${c.name}`,
      at: c.createdAt.toISOString(),
    })),
    ...recentScrapes.map((s) => ({
      kind: "scrape" as const,
      label: `${s.platform} ${s.kind}${s.searchQuery ? `: ${s.searchQuery.slice(0, 60)}` : ""} ${s.status === "failed" ? "✗" : "✓"}`,
      at: s.updatedAt.toISOString(),
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10);

  return {
    ts: new Date().toISOString(),
    system: {
      uptimeSec: Math.round(os.uptime()),
      loadAvg: os.loadavg() as [number, number, number],
      cpuCount: os.cpus().length,
      ram: {
        total: mem.total,
        free: mem.avail,
        used: mem.total - mem.avail,
        usedPct: mem.total ? 1 - mem.avail / mem.total : 0,
      },
      swap: {
        total: mem.swapTotal,
        free: mem.swapFree,
        usedPct: mem.swapTotal ? 1 - mem.swapFree / mem.swapTotal : 0,
      },
      disk,
      network: { wifiSignal: wifi, tailscaleOnline: tsOnline },
      cpuTempC,
    },
    services: {
      app: { ok: true },
      db: { ok: dbOk, detail: dbOk ? undefined : "ping failed" },
      ollama: { ok: ollama.ok, detail: ollama.detail },
      scraper: scraperFresh,
    },
    today: {
      searches: searchesToday,
      candidatesAdded: candidatesToday,
      scrapeOk: scrapeOkToday,
      scrapeFailed: scrapeFailedToday,
      aiCalls: aiCallsToday,
    },
    activity,
    scraper: {
      inProgress: inProgress
        ? { platform: inProgress.platform, kind: inProgress.kind, query: inProgress.searchQuery }
        : null,
      queueDepth: pendingCount,
    },
    ai: {
      ollamaModel: ollama.model ?? null,
      lastCallAgoMs: lastAiCall ? Date.now() - lastAiCall.createdAt.getTime() : null,
    },
    version: process.env.RECRUITME_VERSION ?? "dev",
  };
}
