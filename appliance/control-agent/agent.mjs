#!/usr/bin/env node
/**
 * RecruitMe Box control agent — Phase I4.
 *
 * Long-polls the admin portal for commands and executes them locally.
 * Runs as a systemd service alongside recruitme-app and recruitme-scraper.
 *
 * Loop: GET portal/api/control/<box_id> with a 25s timeout. The portal
 * blocks until a command is queued or the timeout fires. On command:
 * dispatch to the local handler, POST the result back. On empty
 * response or timeout: immediately re-poll. Sleep 5s on network error.
 *
 * Supported commands (handlers in ./handlers.mjs):
 *   - services.restart         {target: app|scraper|ollama|all}
 *   - logs.tail                {service, lines}
 *   - health.deep              (no args)
 *   - update.now               (Phase J4 wires this)
 *   - scraper.reauth           {platform} — opens visible Chromium with
 *                                a public NoVNC URL the seller can drive
 *                                to log in to LinkedIn / SEEK. Out of
 *                                scope for v1; queued and replies "not_implemented".
 *
 * Auth: shares the box's BOX_TOKEN from /etc/recruitme/box.env. Same
 * token used by the heartbeat — single per-box secret.
 *
 * Safety: every command result is recorded (success/failure) so a
 * compromised command channel leaves an audit trail in the portal DB.
 * The handlers themselves are intentionally simple — no arbitrary
 * shell execution from a command payload; each command is a named
 * dispatch table entry.
 */

import { readFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { handlers } from "./handlers.mjs";

function loadConfig() {
  const path = process.env.RECRUITME_BOX_CONFIG ?? "/etc/recruitme/box.env";
  let raw = "";
  try { raw = readFileSync(path, "utf-8"); } catch { return {}; }
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const cfg = loadConfig();
const { ADMIN_PORTAL_URL, BOX_TOKEN, BOX_ID } = cfg;

if (!ADMIN_PORTAL_URL || !BOX_TOKEN || !BOX_ID) {
  console.log("[control-agent] BOX_ID/BOX_TOKEN/ADMIN_PORTAL_URL not set — idling. The agent will exit; systemd will re-check on next restart.");
  process.exit(0);
}

async function poll() {
  while (true) {
    try {
      const ctrl = new AbortController();
      // Portal blocks up to 25s; we give it 30s before assuming network issue.
      const t = setTimeout(() => ctrl.abort(), 30_000);
      const r = await fetch(`${ADMIN_PORTAL_URL}/api/control/${BOX_ID}`, {
        headers: { authorization: `Bearer ${BOX_TOKEN}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) {
        console.error(`[control-agent] portal HTTP ${r.status} — backoff 30s`);
        await sleep(30_000);
        continue;
      }
      const body = await r.json();
      if (!body.command) continue; // empty — re-poll immediately
      console.log(`[control-agent] received command: ${body.command} id=${body.id}`);
      const handler = handlers[body.command];
      let result;
      if (!handler) {
        result = { ok: false, error: `unknown command: ${body.command}` };
      } else {
        try {
          result = await handler(body.args ?? {});
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      // POST result back — best-effort. If the portal is down, the command
      // stays in "delivered" state and the seller can re-queue.
      await fetch(`${ADMIN_PORTAL_URL}/api/control/${body.id}/result`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BOX_TOKEN}`,
        },
        body: JSON.stringify(result),
      }).catch((err) => console.error("[control-agent] result POST failed:", err));
    } catch (err) {
      if (err?.name === "AbortError") continue; // long-poll timeout, expected
      console.error("[control-agent] poll error:", err?.message ?? err);
      await sleep(5_000);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

poll();
