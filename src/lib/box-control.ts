/**
 * Box control plane (steer the mini-PC appliance from the dashboard).
 *
 * These executors run privileged box operations — WiFi re-association,
 * service restarts, reboot, log tails, and launching the interactive
 * `login.ts` so an operator can log Chromium into LinkedIn/SEEK/JobAdder
 * from the dashboard's embedded noVNC view instead of touching the box.
 *
 * GATING: every executor is reachable ONLY through the /api/box-dashboard/
 * control route, which is (a) hard-gated to BOX_CONTROL=1 — an env set only
 * in the box's boxdash.env, never on Railway, so the route 404s in prod;
 * (b) inside the /api/box-dashboard/* prefix that middleware already
 * restricts to loopback/Tailscale. The boxdash service runs as root, so
 * these exec directly (no sudo). All inputs are allowlisted — no
 * user-supplied shell strings reach a shell.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

export function boxControlEnabled(): boolean {
  return process.env.BOX_CONTROL === "1";
}

const WIFI_IFACE = process.env.BOX_WIFI_IFACE ?? "wlp2s0";
const WIFI_CONN = process.env.BOX_WIFI_CONN ?? "Lord Artius";
const SCRAPER_DIR = process.env.BOX_SCRAPER_DIR ?? "/home/baeley/scraper-worker";
const SCRAPER_USER = process.env.BOX_SCRAPER_USER ?? "baeley";
const BOX_DISPLAY = process.env.BOX_DISPLAY ?? ":99";

// Only these units may be tailed — no arbitrary journalctl targets.
const LOG_SERVICES = new Set([
  "recruitme-scraper",
  "recruitme-boxdash",
  "box-xvfb",
  "box-x11vnc",
  "box-websockify",
  "caddy",
]);

const PLATFORMS = new Set(["linkedin", "seek", "jobadder"]);

/**
 * Re-associate WiFi — the fix for the Intel iwlwifi MCS0 rate-control stall
 * (rx rate locks to the 6.5 Mbit floor, throughput collapses to ~KB/s while
 * latency balloons). Disconnect + bring the saved connection back up forces
 * a fresh rate negotiation. No-op-safe if already healthy.
 */
export async function reassocWifi(): Promise<string> {
  await pexecFile("nmcli", ["device", "disconnect", WIFI_IFACE]).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const { stdout } = await pexecFile("nmcli", ["connection", "up", WIFI_CONN]);
  return stdout.trim() || "re-associated";
}

export async function restartScraper(): Promise<string> {
  const { stdout } = await pexecFile("systemctl", ["restart", "recruitme-scraper"]);
  return stdout.trim() || "scraper restarted";
}

/** Fire-and-forget reboot; the box drops its link immediately. */
export function rebootBox(): string {
  spawn("systemctl", ["reboot"], { detached: true, stdio: "ignore" }).unref();
  return "reboot issued";
}

export async function tailLogs(service: string, lines = 120): Promise<string> {
  if (!LOG_SERVICES.has(service)) throw new Error(`log service not allowed: ${service}`);
  const n = Math.max(10, Math.min(500, Math.trunc(lines) || 120));
  const { stdout } = await pexecFile("journalctl", [
    "-u", service, "-n", String(n), "--no-pager", "--no-hostname",
  ]);
  return stdout;
}

/**
 * Launch the existing interactive login.ts as the scraper user, rendered to
 * the scraper's Xvfb (:99 by default) so the operator drives the login from
 * the dashboard's noVNC view. login.ts auto-saves the encrypted session the
 * instant it detects the platform's auth cookie, then exits — so no stdin /
 * ENTER is needed. Detached: the request returns immediately while the
 * browser window stays open (up to ~8 min) for the operator to log in.
 */
export function startLogin(platform: string): string {
  if (!PLATFORMS.has(platform)) throw new Error(`bad platform: ${platform}`);
  // tsx + login.ts path are fixed; platform is allowlisted above. No user
  // string reaches the shell beyond the validated platform token.
  const cmd = `cd ${SCRAPER_DIR} && exec node_modules/.bin/tsx login.ts ${platform}`;
  const child = spawn(
    "runuser",
    ["-u", SCRAPER_USER, "--", "env", `DISPLAY=${BOX_DISPLAY}`, "OZONE=x11", "bash", "-lc", cmd],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return `login window opening for ${platform} — log in via the live view`;
}
