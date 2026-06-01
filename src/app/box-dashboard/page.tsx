/**
 * /box-dashboard — on-box ops monitor (Phase I1).
 *
 * Read-only kiosk page for an optional HDMI display attached to the
 * mini-PC appliance. Shows: today's stats, system bars (CPU/RAM/disk),
 * network (WiFi signal + Tailscale), live scraper status, recent
 * activity, AI backend.
 *
 * Auto-launched by Chromium kiosk on the box itself (Openbox + xinit).
 * Driven by Server-Sent Events from /api/box-dashboard/stream — when the
 * connection drops the EventSource auto-reconnects, so a Next restart
 * doesn't permanently break the screen.
 *
 * NOT a recruiter-facing page. Carries zero PII (no candidate names,
 * no query content — just counts and activity-type labels). Gated to
 * loopback / Tailscale via middleware so it can't be hit from the
 * customer LAN.
 */

"use client";

import { useEffect, useRef, useState } from "react";

interface Stats {
  ts: string;
  system: {
    uptimeSec: number;
    loadAvg: [number, number, number];
    cpuCount: number;
    ram: { total: number; used: number; usedPct: number };
    swap: { usedPct: number };
    disk: { total: number; used: number; usedPct: number };
    network: { wifiSignal: number | null; tailscaleOnline: boolean };
    cpuTempC: number | null;
  };
  services: {
    app: { ok: boolean; detail?: string };
    db: { ok: boolean; detail?: string };
    ollama: { ok: boolean; detail?: string };
    scraper: { ok: boolean; detail?: string };
  };
  today: {
    searches: number;
    candidatesAdded: number;
    scrapeOk: number;
    scrapeFailed: number;
    aiCalls: number;
  };
  activity: Array<{ kind: string; label: string; at: string }>;
  scraper: { inProgress: { platform: string; kind: string; query?: string | null } | null; queueDepth: number };
  ai: { ollamaModel: string | null; lastCallAgoMs: number | null };
  version: string;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)}M`;
  return `${(n / 1024).toFixed(0)}K`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtAgo(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function wifiBars(dbm: number | null): string {
  if (dbm === null) return "▯▯▯▯▯";
  if (dbm >= -50) return "▮▮▮▮▮";
  if (dbm >= -60) return "▮▮▮▮▯";
  if (dbm >= -70) return "▮▮▮▯▯";
  if (dbm >= -80) return "▮▮▯▯▯";
  return "▮▯▯▯▯";
}

function Bar({ pct, danger = 0.85, warn = 0.7 }: { pct: number; danger?: number; warn?: number }) {
  const tone = pct >= danger ? "bg-danger" : pct >= warn ? "bg-warning" : "bg-success";
  return (
    <div className="h-2 w-full rounded-sm bg-surface-sunken overflow-hidden">
      <div className={tone + " h-full transition-all"} style={{ width: `${Math.max(2, Math.min(100, pct * 100))}%` }} />
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={ok ? "text-success" : "text-danger"}>●</span>;
}

export default function BoxDashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const lastTickRef = useRef<number>(0);

  useEffect(() => {
    const tickClock = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tickClock);
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/box-dashboard/stream");
    es.addEventListener("stats", (e) => {
      try {
        setStats(JSON.parse((e as MessageEvent).data) as Stats);
        setConnected(true);
        lastTickRef.current = Date.now();
      } catch { /* malformed payload; keep last known */ }
    });
    es.addEventListener("error", () => setConnected(false));
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => es.close();
  }, []);

  if (!stats) {
    return (
      <div className="min-h-screen bg-surface-base text-text-primary flex items-center justify-center">
        <div className="text-center">
          <p className="text-md text-text-secondary mb-2">RecruitMe Box</p>
          <p className="text-xs text-text-tertiary">Connecting to local stats stream…</p>
        </div>
      </div>
    );
  }

  const s = stats;
  const allOk = s.services.app.ok && s.services.db.ok && s.services.ollama.ok && s.services.scraper.ok;
  const wifiDbm = s.system.network.wifiSignal;

  return (
    <div className="min-h-screen bg-surface-base text-text-primary p-6 font-mono text-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-separator pb-3 mb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">RecruitMe Box</h1>
          <span className="text-text-tertiary text-xs">v{s.version}</span>
        </div>
        <div className="text-text-tertiary text-xs">
          {now.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          {!connected && <span className="ml-2 text-warning">● reconnecting</span>}
        </div>
      </div>

      {/* Status banner */}
      <div className={`rounded-md p-3 mb-4 ${allOk ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger"}`}>
        <div className="flex items-center justify-between">
          <span className="font-semibold">{allOk ? "▓▓▓▓▓▓▓▓▓▓ ALL SYSTEMS OK" : "⚠ ATTENTION REQUIRED"}</span>
          <span className="text-xs opacity-70">uptime {fmtUptime(s.system.uptimeSec)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Today */}
        <div className="bg-surface-raised border border-separator rounded-md p-4">
          <h2 className="text-text-tertiary uppercase text-2xs tracking-wider mb-3">Today</h2>
          <table className="w-full">
            <tbody className="text-text-secondary text-xs">
              <tr><td className="py-1">Searches run</td><td className="text-right text-text-primary">{s.today.searches}</td></tr>
              <tr><td className="py-1">Candidates added</td><td className="text-right text-text-primary">{s.today.candidatesAdded}</td></tr>
              <tr><td className="py-1">Scrapes ok / failed</td><td className="text-right text-text-primary">{s.today.scrapeOk} / <span className={s.today.scrapeFailed > 0 ? "text-warning" : ""}>{s.today.scrapeFailed}</span></td></tr>
              <tr><td className="py-1">AI calls</td><td className="text-right text-text-primary">{s.today.aiCalls}</td></tr>
            </tbody>
          </table>
        </div>

        {/* Network */}
        <div className="bg-surface-raised border border-separator rounded-md p-4">
          <h2 className="text-text-tertiary uppercase text-2xs tracking-wider mb-3">Network</h2>
          <div className="space-y-2 text-xs text-text-secondary">
            <div className="flex justify-between"><span>WiFi</span><span className="text-text-primary">{wifiBars(wifiDbm)} {wifiDbm !== null ? `${wifiDbm} dBm` : "(ethernet)"}</span></div>
            <div className="flex justify-between"><span>Tailscale</span><span className="text-text-primary"><StatusDot ok={s.system.network.tailscaleOnline} /> {s.system.network.tailscaleOnline ? "online" : "offline"}</span></div>
          </div>
        </div>

        {/* Resources */}
        <div className="bg-surface-raised border border-separator rounded-md p-4 md:col-span-2">
          <h2 className="text-text-tertiary uppercase text-2xs tracking-wider mb-3">Resources</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <div className="flex justify-between text-text-secondary mb-1"><span>CPU load</span><span className="text-text-primary">{(s.system.loadAvg[0] * 100 / s.system.cpuCount).toFixed(0)}%</span></div>
              <Bar pct={Math.min(1, s.system.loadAvg[0] / s.system.cpuCount)} />
              <div className="text-2xs text-text-tertiary mt-1">load {s.system.loadAvg.map(n => n.toFixed(2)).join("  ")}</div>
            </div>
            <div>
              <div className="flex justify-between text-text-secondary mb-1"><span>RAM</span><span className="text-text-primary">{(s.system.ram.usedPct * 100).toFixed(0)}% — {fmtBytes(s.system.ram.used)} / {fmtBytes(s.system.ram.total)}</span></div>
              <Bar pct={s.system.ram.usedPct} />
              <div className="text-2xs text-text-tertiary mt-1">swap {(s.system.swap.usedPct * 100).toFixed(0)}%</div>
            </div>
            <div>
              <div className="flex justify-between text-text-secondary mb-1"><span>Disk</span><span className="text-text-primary">{(s.system.disk.usedPct * 100).toFixed(0)}% — {fmtBytes(s.system.disk.used)} / {fmtBytes(s.system.disk.total)}</span></div>
              <Bar pct={s.system.disk.usedPct} />
              <div className="text-2xs text-text-tertiary mt-1">&nbsp;</div>
            </div>
            <div>
              <div className="flex justify-between text-text-secondary mb-1"><span>CPU temp</span><span className="text-text-primary">{s.system.cpuTempC !== null ? `${s.system.cpuTempC}°C` : "—"}</span></div>
              <Bar pct={s.system.cpuTempC !== null ? s.system.cpuTempC / 100 : 0} warn={0.75} danger={0.9} />
              <div className="text-2xs text-text-tertiary mt-1">{s.system.cpuTempC === null ? "no sensor" : s.system.cpuTempC >= 90 ? "hot — throttle risk" : s.system.cpuTempC >= 75 ? "warm" : "nominal"}</div>
            </div>
          </div>
        </div>

        {/* Scraper */}
        <div className="bg-surface-raised border border-separator rounded-md p-4">
          <h2 className="text-text-tertiary uppercase text-2xs tracking-wider mb-3">Scraper</h2>
          <div className="text-xs space-y-1.5 text-text-secondary">
            <div className="flex justify-between"><span>Status</span><span className="text-text-primary"><StatusDot ok={s.services.scraper.ok} /> {s.services.scraper.detail ?? (s.services.scraper.ok ? "ok" : "down")}</span></div>
            <div className="flex justify-between"><span>Queue depth</span><span className="text-text-primary">{s.scraper.queueDepth}</span></div>
            {s.scraper.inProgress && (
              <div>
                <div className="text-2xs text-text-tertiary mt-2 uppercase tracking-wide">In progress</div>
                <div className="text-text-primary">
                  {s.scraper.inProgress.platform} {s.scraper.inProgress.kind}
                  {s.scraper.inProgress.query && <div className="text-text-secondary text-2xs truncate">&ldquo;{s.scraper.inProgress.query}&rdquo;</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* AI backend */}
        <div className="bg-surface-raised border border-separator rounded-md p-4">
          <h2 className="text-text-tertiary uppercase text-2xs tracking-wider mb-3">AI backend</h2>
          <div className="text-xs space-y-1.5 text-text-secondary">
            <div className="flex justify-between"><span>Ollama</span><span className="text-text-primary"><StatusDot ok={s.services.ollama.ok} /> {s.ai.ollamaModel ?? "—"}</span></div>
            <div className="flex justify-between"><span>Hosted</span><span className="text-text-primary"><StatusDot ok /> Claude</span></div>
            <div className="flex justify-between"><span>Last AI call</span><span className="text-text-primary">{s.ai.lastCallAgoMs !== null ? `${Math.round(s.ai.lastCallAgoMs / 1000)}s ago` : "none yet"}</span></div>
          </div>
        </div>
      </div>

      {/* Activity log */}
      <div className="bg-surface-raised border border-separator rounded-md p-4">
        <h2 className="text-text-tertiary uppercase text-2xs tracking-wider mb-3">Recent activity</h2>
        {s.activity.length === 0 && <p className="text-xs text-text-tertiary">Nothing yet.</p>}
        <div className="space-y-1">
          {s.activity.map((a, i) => (
            <div key={i} className="flex gap-3 text-xs">
              <span className="text-text-tertiary w-12 text-right">{fmtAgo(a.at)}</span>
              <span className="text-text-tertiary w-16">{a.kind}</span>
              <span className="text-text-primary flex-1 truncate">{a.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
