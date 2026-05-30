/**
 * Command handlers — the dispatch table for the remote control plane.
 *
 * Each handler:
 *   - takes a plain args object (already parsed from the portal payload)
 *   - returns { ok: boolean, ... } that the agent POSTs back
 *   - MUST NOT shell out with values from args without explicit allow-listing
 *
 * No arbitrary shell execution. Every command is a named dispatch entry
 * with an allow-list of expected args. A compromised portal therefore
 * can't `rm -rf /` via a crafted command name — the worst it can do is
 * trigger one of the predefined ops.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const RESTARTABLE = new Set([
  "recruitme-app",
  "recruitme-scraper",
  "ollama",
  "caddy",
  "all",
]);

async function handleServicesRestart(args) {
  const target = String(args.target ?? "");
  if (!RESTARTABLE.has(target)) {
    return { ok: false, error: `target not allowed: ${target}` };
  }
  try {
    if (target === "all") {
      await exec("sudo", ["systemctl", "restart", "recruitme-app", "recruitme-scraper", "ollama"]);
    } else {
      await exec("sudo", ["systemctl", "restart", target]);
    }
    return { ok: true, restarted: target };
  } catch (err) {
    return { ok: false, error: err?.message ?? "restart failed" };
  }
}

const TAIL_SERVICES = new Set([
  "recruitme-app",
  "recruitme-scraper",
  "ollama",
  "caddy",
  "recruitme-healthcheck",
  "recruitme-backup",
  "recruitme-heartbeat",
  "recruitme-control-agent",
]);

async function handleLogsTail(args) {
  const service = String(args.service ?? "");
  const lines = Math.max(10, Math.min(2000, Number(args.lines ?? 200)));
  if (!TAIL_SERVICES.has(service)) {
    return { ok: false, error: `service not allowed: ${service}` };
  }
  try {
    const { stdout } = await exec("sudo", [
      "journalctl",
      "-u", service,
      "-n", String(lines),
      "--no-pager",
    ]);
    return { ok: true, service, lines, log: stdout.slice(-50_000) };
  } catch (err) {
    return { ok: false, error: err?.message ?? "tail failed" };
  }
}

async function handleHealthDeep() {
  try {
    const r = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(10_000) });
    const body = await r.json();
    return { ok: r.ok, status: r.status, body };
  } catch (err) {
    return { ok: false, error: err?.message ?? "health probe failed" };
  }
}

async function handleUpdateNow() {
  // Phase J4 wires this. For now: kick the updater script if present.
  try {
    await exec("sudo", ["systemctl", "start", "recruitme-update.service"]);
    return { ok: true, queued: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? "updater not installed yet (Phase J4)" };
  }
}

async function handleScraperReauth(args) {
  // Implementation deferred — needs a visible Chromium + noVNC bridge.
  return { ok: false, error: `scraper.reauth not yet implemented (${args.platform})` };
}

export const handlers = {
  "services.restart":  handleServicesRestart,
  "logs.tail":         handleLogsTail,
  "health.deep":       handleHealthDeep,
  "update.now":        handleUpdateNow,
  "scraper.reauth":    handleScraperReauth,
};
