/**
 * Box Control panel — the "steer the device from the dashboard" surface.
 *
 * Renders ONLY when /api/box-dashboard/control reports enabled (BOX_CONTROL=1,
 * i.e. on the box). Gives the operator:
 *   - a live noVNC view of the scraper's Chromium (display :99), so logins to
 *     LinkedIn/SEEK/JobAdder are done by clicking in the dashboard, never RDP;
 *   - one-click device controls: re-associate WiFi (the MCS0 stall fix),
 *     restart scraper, reboot, and log tails.
 *
 * Everything posts to /api/box-dashboard/control, which is box-only +
 * Tailscale-gated by middleware.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ControlConfig {
  enabled: boolean;
  novncPath?: string;
  novncPassword?: string;
}

const LOG_SERVICES = [
  "recruitme-scraper",
  "box-x11vnc",
  "box-websockify",
  "box-xvfb",
  "caddy",
  "recruitme-boxdash",
];

function Btn({
  children,
  onClick,
  busy,
  tone = "default",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  tone?: "default" | "accent" | "danger";
  title?: string;
}) {
  const toneCls =
    tone === "danger"
      ? "border-danger/40 text-danger hover:bg-danger-subtle"
      : tone === "accent"
        ? "border-accent/40 text-accent hover:bg-accent-subtle"
        : "border-separator text-text-secondary hover:bg-surface-hover";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      className={`rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${toneCls}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

export default function ControlPanel() {
  const [cfg, setCfg] = useState<ControlConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [logService, setLogService] = useState(LOG_SERVICES[0]);
  const [logs, setLogs] = useState<string>("");
  const [showView, setShowView] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetch("/api/box-dashboard/control")
      .then((r) => r.json())
      .then((c: ControlConfig) => setCfg(c))
      .catch(() => setCfg({ enabled: false }));
  }, []);

  const run = useCallback(
    async (key: string, body: Record<string, unknown>, label: string) => {
      setBusy(key);
      setResult(null);
      try {
        const res = await fetch("/api/box-dashboard/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          setResult({ ok: true, msg: `${label}: ${data.detail ?? "done"}` });
          if (typeof data.logs === "string") setLogs(data.logs);
        } else {
          setResult({ ok: false, msg: `${label} failed: ${data.error ?? res.status}` });
        }
      } catch (e) {
        setResult({ ok: false, msg: `${label} failed: ${e instanceof Error ? e.message : "network"}` });
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  if (!cfg) return null; // still loading
  if (!cfg.enabled) return null; // off-box — panel hidden entirely

  const novncSrc =
    `/novnc/vnc.html?autoconnect=1&resize=scale&reconnect=1` +
    `&path=${encodeURIComponent(cfg.novncPath ?? "novnc/websockify")}` +
    (cfg.novncPassword ? `&password=${encodeURIComponent(cfg.novncPassword)}` : "");

  return (
    <div className="bg-surface-raised border border-separator rounded-md p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-text-tertiary uppercase text-2xs tracking-wider">Remote control</h2>
        <button
          type="button"
          onClick={() => setShowView((v) => !v)}
          className="text-2xs text-text-tertiary hover:text-text-primary"
        >
          {showView ? "hide live view" : "show live view"}
        </button>
      </div>

      {/* Live browser view (the scraper's Chromium on :99) */}
      {showView && (
        <div className="mb-3">
          <div className="relative w-full overflow-hidden rounded-md border border-separator bg-black" style={{ aspectRatio: "16 / 9" }}>
            <iframe
              ref={iframeRef}
              src={novncSrc}
              title="Box browser (live)"
              className="absolute inset-0 h-full w-full"
            />
          </div>
          <p className="mt-1.5 text-2xs text-text-tertiary">
            Live view of the scraper&rsquo;s browser. Click a login below, then complete it right here — it
            auto-saves the session the moment you&rsquo;re in.
          </p>
        </div>
      )}

      {/* Login launchers */}
      <div className="mb-3">
        <div className="text-2xs uppercase tracking-wide text-text-tertiary mb-1.5">Log in (opens in the view above)</div>
        <div className="flex flex-wrap gap-2">
          <Btn tone="accent" busy={busy === "login-linkedin"} onClick={() => run("login-linkedin", { action: "login", platform: "linkedin" }, "LinkedIn login")}>LinkedIn</Btn>
          <Btn tone="accent" busy={busy === "login-seek"} onClick={() => run("login-seek", { action: "login", platform: "seek" }, "SEEK login")}>SEEK</Btn>
          <Btn tone="accent" busy={busy === "login-jobadder"} onClick={() => run("login-jobadder", { action: "login", platform: "jobadder" }, "JobAdder login")}>JobAdder</Btn>
        </div>
      </div>

      {/* Device controls */}
      <div className="mb-3">
        <div className="text-2xs uppercase tracking-wide text-text-tertiary mb-1.5">Device</div>
        <div className="flex flex-wrap gap-2">
          <Btn busy={busy === "wifi"} onClick={() => run("wifi", { action: "wifi-reassoc" }, "WiFi re-associate")} title="Fix the Intel rate-control stall (rx rate stuck at the floor)">Re-associate WiFi</Btn>
          <Btn busy={busy === "scraper"} onClick={() => run("scraper", { action: "restart-scraper" }, "Restart scraper")}>Restart scraper</Btn>
          <Btn
            tone="danger"
            busy={busy === "reboot"}
            onClick={() => {
              if (window.confirm("Reboot the box now? It will drop offline for ~1 minute.")) {
                run("reboot", { action: "reboot", confirm: true }, "Reboot");
              }
            }}
          >
            Reboot box
          </Btn>
        </div>
      </div>

      {/* Logs */}
      <div>
        <div className="text-2xs uppercase tracking-wide text-text-tertiary mb-1.5">Logs</div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={logService}
            onChange={(e) => setLogService(e.target.value)}
            className="rounded-md border border-separator bg-surface-base px-2 py-1.5 text-xs text-text-secondary"
          >
            {LOG_SERVICES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Btn busy={busy === "logs"} onClick={() => run("logs", { action: "logs", service: logService, lines: 150 }, "Logs")}>Tail</Btn>
        </div>
        {logs && (
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-separator bg-surface-base p-2 text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap">
            {logs}
          </pre>
        )}
      </div>

      {result && (
        <div className={`mt-3 text-xs ${result.ok ? "text-success" : "text-danger"}`}>{result.msg}</div>
      )}
    </div>
  );
}
