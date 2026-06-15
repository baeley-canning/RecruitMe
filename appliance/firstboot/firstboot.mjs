#!/usr/bin/env node
/**
 * RecruitMe Box first-boot wizard.
 *
 * Runs ONCE per box, before recruitme-app starts. Serves a wizard at
 * http://recruitme-box.local (mDNS) where the customer's IT person:
 *   1. Confirms company name + admin user details
 *   2. Generates per-box secrets (DATABASE_URL pw, NEXTAUTH_SECRET, etc.)
 *   3. Drives the LinkedIn login through an embedded Patchright browser
 *      (their 2FA code goes to THEIR phone — seller never sees it)
 *   4. Repeats for SEEK
 *   5. Joins the seller's Tailnet (auth-key burned in at packer build)
 *   6. Writes /etc/recruitme/.firstboot-done and exits — recruitme-app
 *      starts; the wizard service disables itself on next boot
 *
 * Idempotent within a single boot — refresh-and-resume works. Persists
 * intermediate state to /var/lib/recruitme/firstboot.json so a crash
 * mid-wizard doesn't force the customer to restart from step 1.
 *
 * Security: the wizard only listens on the LAN (port 80, default route)
 * during this boot. After completion the wizard service exits, Caddy
 * + the main app take over, and ufw blocks anything but :443.
 */

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const STATE_DIR = "/var/lib/recruitme";
const STATE_FILE = `${STATE_DIR}/firstboot.json`;
const CONFIG_DIR = "/etc/recruitme";
const APP_ENV = `${CONFIG_DIR}/app.env`;
const BOX_ENV = `${CONFIG_DIR}/box.env`;
const WORKER_ENV = "/opt/recruitme/scraper-worker/.env";
const FIRSTBOOT_DONE = `${CONFIG_DIR}/.firstboot-done`;
const PORT = 80;

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

function loadState() {
  if (!existsSync(STATE_FILE)) return { step: "company" };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch { return { step: "company" }; }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  // Holds the admin password (until finalize deletes it) — keep it root-only;
  // the default umask would otherwise leave it world-readable (0644).
  chmodSync(STATE_FILE, 0o600);
}

function randHex(n) { return randomBytes(n).toString("hex"); }
function randB64(n) { return randomBytes(n).toString("base64url"); }

const state = loadState();

// One-time setup PIN — an out-of-band secret gating the privileged wizard
// steps. The wizard listens unauthenticated on the LAN during first boot, so
// without this any host on the same network could POST the admin password or a
// tailnet key. The PIN is printed to the box console/journal and written
// root-only to /etc/recruitme/setup-pin.txt; the on-site installer reads it off
// the box (the LinkedIn/SEEK steps already require physical access to the box).
const SETUP_PIN = randHex(3).toUpperCase(); // 6 hex chars
try {
  writeFileSync(`${CONFIG_DIR}/setup-pin.txt`, SETUP_PIN + "\n");
  chmodSync(`${CONFIG_DIR}/setup-pin.txt`, 0o600);
} catch { /* CONFIG_DIR is created above; the console line below still shows the PIN */ }
console.log(`\n========================================\n  RecruitMe Box — SETUP PIN: ${SETUP_PIN}\n  Enter this on the first wizard screen.\n========================================\n`);

function pinOk(params) {
  return (params.get("setup_pin") ?? "").trim().toUpperCase() === SETUP_PIN;
}

const page = (body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>RecruitMe Box — Setup</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { background: #0f1115; color: #e6e8eb; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 40px 20px; }
  .card { max-width: 520px; margin: 0 auto; background: #1a1d23; border: 1px solid #2a2d35; border-radius: 12px; padding: 32px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  .step { color: #8a8f99; font-size: 12px; margin-bottom: 24px; text-transform: uppercase; letter-spacing: 0.05em; }
  label { display: block; margin: 16px 0 6px; font-size: 13px; color: #a8acb4; }
  input { width: 100%; padding: 10px 12px; background: #0f1115; border: 1px solid #2a2d35; border-radius: 6px; color: #e6e8eb; font-size: 14px; box-sizing: border-box; }
  button { margin-top: 24px; padding: 12px 20px; background: #3b82f6; border: 0; border-radius: 6px; color: white; font-size: 14px; cursor: pointer; }
  button:hover { background: #2563eb; }
  p.help { font-size: 12px; color: #8a8f99; line-height: 1.5; margin: 0 0 16px; }
  .progress { display: flex; gap: 4px; margin-bottom: 24px; }
  .pip { flex: 1; height: 4px; background: #2a2d35; border-radius: 2px; }
  .pip.done { background: #4ade80; }
  .pip.now  { background: #3b82f6; }
</style></head>
<body><div class="card">${body}</div></body></html>`;

function progress(step) {
  const order = ["company", "linkedin", "seek", "tailscale", "done"];
  const idx = order.indexOf(step);
  return `<div class="progress">${order.map((s, i) =>
    `<div class="pip ${i < idx ? "done" : i === idx ? "now" : ""}"></div>`
  ).join("")}</div><div class="step">Step ${idx + 1} of ${order.length} · ${step}</div>`;
}

function renderCompany() {
  return page(`${progress("company")}
  <h1>Welcome to RecruitMe Box</h1>
  <p class="help">Just a few details to set up your agency. This takes about 5 minutes.</p>
  <form method="post" action="/company">
    <label>Setup PIN (shown on this box's screen)</label>
    <input name="setup_pin" required placeholder="6-character PIN" autocomplete="off">
    <label>Agency name</label>
    <input name="agency_name" required value="${state.agency_name ?? ""}" placeholder="Acme Recruiting">
    <label>Admin email (your login)</label>
    <input name="admin_email" type="email" required value="${state.admin_email ?? ""}">
    <label>Admin password (min 12 chars)</label>
    <input name="admin_password" type="password" required minlength="12">
    <button type="submit">Continue</button>
  </form>`);
}

function renderLinkedIn() {
  return page(`${progress("linkedin")}
  <h1>Connect your LinkedIn</h1>
  <p class="help">The box scrapes your LinkedIn Recruiter session to find candidates. Open this URL on a device that can see your 2FA code, then log in:</p>
  <input value="http://${state.box_hostname ?? "recruitme-box.local"}/login/linkedin" readonly>
  <p class="help" style="margin-top:16px">A Chromium window will open on the box's display. Drive it from there. When you see the LinkedIn feed, come back here and click Continue.</p>
  <form method="post" action="/linkedin-done"><button type="submit">I'm logged in — continue</button></form>
  <p class="help" style="margin-top:24px"><a style="color:#60a5fa" href="/skip/linkedin">Skip for now</a></p>`);
}

function renderSeek() {
  return page(`${progress("seek")}
  <h1>Connect your SEEK</h1>
  <p class="help">Same flow as LinkedIn — driver a SEEK Talent Search login on the box's display so the scraper can use it.</p>
  <input value="http://${state.box_hostname ?? "recruitme-box.local"}/login/seek" readonly>
  <form method="post" action="/seek-done"><button type="submit">I'm logged in — continue</button></form>
  <p class="help" style="margin-top:24px"><a style="color:#60a5fa" href="/skip/seek">Skip for now</a></p>`);
}

function renderTailscale() {
  return page(`${progress("tailscale")}
  <h1>Connect to the support network</h1>
  <p class="help">This lets your reseller help you remotely (and pushes updates). No customer data leaves the box — only system health.</p>
  <form method="post" action="/tailscale">
    <label>Tailscale auth key (provided by your reseller)</label>
    <input name="tskey" required placeholder="tskey-auth-...">
    <button type="submit">Connect</button>
  </form>
  <p class="help" style="margin-top:24px"><a style="color:#60a5fa" href="/skip/tailscale">Skip for now (no remote support)</a></p>`);
}

function renderDone() {
  return page(`${progress("done")}
  <h1>Box is ready</h1>
  <p class="help">The RecruitMe app is starting now. Open it at:</p>
  <input value="https://${state.box_hostname ?? "recruitme-box.local"}" readonly>
  <p class="help" style="margin-top:24px">This wizard will not run again. To re-run setup, SSH in and remove <code>/etc/recruitme/.firstboot-done</code>.</p>`);
}

function writeBaseConfig() {
  const dbPassword = randHex(16);
  // ONE shared secret the worker presents and the app validates — it must be
  // identical in both env blocks below. A second randHex(32) call would mint a
  // mismatched value and 401 every worker->app call on the box.
  const scraperSecret = randHex(32);
  const env = [
    "# Generated at first boot — do not edit by hand.",
    `DATABASE_URL=postgres://recruitme:${dbPassword}@localhost:5432/recruitme`,
    `NEXTAUTH_SECRET=${randHex(32)}`,
    `NEXTAUTH_URL=https://${state.box_hostname ?? "recruitme-box.local"}`,
    `NEXT_PUBLIC_APP_URL=https://${state.box_hostname ?? "recruitme-box.local"}`,
    `SCRAPER_SECRET=${scraperSecret}`,
    `CONTACT_SYNC_CRON_SECRET=${randHex(16)}`,
    `SEED_OWNER_USERNAME=${state.admin_email}`,
    `SEED_OWNER_PASSWORD=${state.admin_password}`,
    "AI_PROVIDER=claude",
    "ANTHROPIC_MODEL=claude-haiku-4-5-20251001",
    "OPENAI_MODEL=gpt-4o-mini",
    "NODE_ENV=production",
    "PORT=3001",
    "SCRAPER_DISCOVERY_ENABLED=true",
    "SCRAPER_JOBADDER_ENABLED=false",
    "OLLAMA_OFFLOAD_TASKS=cv_clean,info_extract",
    "OPT_IN_CANDIDATE_POOL=false",   // Phase J5 — schema present, pipe inactive
  ].join("\n") + "\n";
  writeFileSync(APP_ENV, env);
  chmodSync(APP_ENV, 0o640);

  // Create the postgres role + db with the random password
  try {
    execFileSync("sudo", ["-u", "postgres", "psql", "-c", `CREATE USER recruitme WITH PASSWORD '${dbPassword}';`], { stdio: "inherit" });
    execFileSync("sudo", ["-u", "postgres", "psql", "-c", "CREATE DATABASE recruitme OWNER recruitme;"], { stdio: "inherit" });
  } catch { /* idempotent re-run ok */ }

  // Worker .env shares some secrets with the app
  const workerEnv = [
    `RAILWAY_API_URL=http://localhost:3001`,
    `SCRAPER_SECRET=${scraperSecret}`,
    `SESSION_ENCRYPTION_KEY=${randHex(32)}`,
    "LOG_LEVEL=info",
    "POLL_INTERVAL_MS=15000",
    "SCRAPER_DISCOVERY_ENABLED=true",
    "SCRAPER_JOBADDER_ENABLED=false",
    "HEADLESS=true",
  ].join("\n") + "\n";
  writeFileSync(WORKER_ENV, workerEnv);
  chmodSync(WORKER_ENV, 0o640);
}

function writeBoxIdentity() {
  // Phase J3: per-box identity. UUID + signed JWT generated at FIRST
  // CALL to the seller portal — we store just the placeholder here.
  // The seller's admin portal `POST /api/admin/boxes` returns the real
  // token at provisioning time, but for unattended boxes we need a
  // stable id to claim against.
  const boxId = randomUUID();
  const env = [
    `BOX_ID=${boxId}`,
    `RECRUITME_VERSION=0.1.0`,
    "# BOX_TOKEN and ADMIN_PORTAL_URL are populated when the seller",
    "# registers this BOX_ID with /api/admin/boxes and the response is",
    "# written here. Until then heartbeat + control-agent stay idle.",
    "ADMIN_PORTAL_URL=",
    "BOX_TOKEN=",
  ].join("\n") + "\n";
  writeFileSync(BOX_ENV, env);
  chmodSync(BOX_ENV, 0o640);
  console.log(`[firstboot] generated BOX_ID=${boxId}`);
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, headers = { "Content-Type": "text/html; charset=utf-8" }) => {
    res.writeHead(status, headers);
    res.end(body);
  };

  const route = `${req.method} ${req.url.split("?")[0]}`;

  // Gate every privileged/state-changing route behind the one-time PIN. Only
  // viewing the wizard and submitting the company step (where the PIN itself is
  // checked) are reachable before verification — so a random LAN host can't
  // drive setup during the unauthenticated first-boot window.
  const isPublic = route === "GET /" || route === "GET /index.html" || route === "POST /company";
  if (!isPublic && !state.pinVerified) {
    return send(403, page(`<h1>Setup locked</h1><p class="help">Enter the setup PIN on the first screen to begin. <a style="color:#60a5fa" href="/">Start setup</a>.</p>`));
  }

  if (route === "GET /" || route === "GET /index.html") {
    const renders = {
      company:   renderCompany,
      linkedin:  renderLinkedIn,
      seek:      renderSeek,
      tailscale: renderTailscale,
      done:      renderDone,
    };
    return send(200, (renders[state.step] ?? renderCompany)());
  }

  if (route === "POST /company") {
    const body = await new Promise((r) => { let s = ""; req.on("data", (d) => s += d); req.on("end", () => r(s)); });
    const params = new URLSearchParams(body);
    if (!pinOk(params)) {
      return send(403, page(`${progress("company")}<h1>Wrong setup PIN</h1><p class="help">The setup PIN is printed on this box's screen/console. <a style="color:#60a5fa" href="/">Try again</a>.</p>`));
    }
    Object.assign(state, {
      agency_name:    params.get("agency_name") ?? "",
      admin_email:    params.get("admin_email") ?? "",
      admin_password: params.get("admin_password") ?? "",
      box_hostname:   "recruitme-box.local",
      pinVerified:    true,
      step: "linkedin",
    });
    saveState(state);
    writeBaseConfig();
    return send(303, "", { Location: "/" });
  }

  if (route === "POST /linkedin-done") {
    state.step = "seek";
    saveState(state);
    return send(303, "", { Location: "/" });
  }
  if (route === "GET /skip/linkedin") {
    state.step = "seek"; saveState(state); return send(303, "", { Location: "/" });
  }

  if (route === "POST /seek-done") {
    state.step = "tailscale";
    saveState(state);
    return send(303, "", { Location: "/" });
  }
  if (route === "GET /skip/seek") {
    state.step = "tailscale"; saveState(state); return send(303, "", { Location: "/" });
  }

  if (route === "POST /tailscale") {
    const body = await new Promise((r) => { let s = ""; req.on("data", (d) => s += d); req.on("end", () => r(s)); });
    const tskey = new URLSearchParams(body).get("tskey")?.trim();
    if (tskey) {
      try {
        execFileSync("sudo", ["tailscale", "up", "--auth-key", tskey, "--ssh", "--accept-routes"], { stdio: "inherit" });
      } catch (err) { console.error("[firstboot] tailscale up failed:", err.message); }
    }
    writeBoxIdentity();
    state.step = "done";
    saveState(state);
    return send(303, "", { Location: "/" });
  }
  if (route === "GET /skip/tailscale") {
    writeBoxIdentity();
    state.step = "done"; saveState(state); return send(303, "", { Location: "/" });
  }

  if (route === "GET /quit") {
    finalize();
    return send(200, "ok");
  }

  return send(404, "Not Found");
});

function finalize() {
  writeFileSync(FIRSTBOOT_DONE, new Date().toISOString());
  // The state file held the admin password in plaintext during setup — remove
  // it (and the setup PIN) now that config is written, so neither lingers on
  // disk for the life of the box.
  try { unlinkSync(STATE_FILE); } catch { /* already gone — fine */ }
  try { unlinkSync(`${CONFIG_DIR}/setup-pin.txt`); } catch { /* already gone — fine */ }
  console.log("[firstboot] complete — enabling main services");
  try {
    execFileSync("sudo", ["systemctl", "disable", "recruitme-firstboot.service"], { stdio: "inherit" });
    execFileSync("sudo", ["systemctl", "enable", "--now", "recruitme-app.service", "recruitme-scraper.service", "ollama.service", "caddy.service", "recruitme-heartbeat.timer", "recruitme-control-agent.service"], { stdio: "inherit" });
  } catch (err) { console.error("[firstboot] finalize failed:", err.message); }
  setTimeout(() => process.exit(0), 1_000);
}

// When the user clicks the final "Done" page, the next GET / lands on
// renderDone(); we wait 30s for them to see it, then exit and let the
// main app take over.
let doneAt = null;
setInterval(() => {
  if (state.step === "done" && !doneAt) doneAt = Date.now();
  if (doneAt && Date.now() - doneAt > 30_000) finalize();
}, 5_000);

server.listen(PORT, () => console.log(`[firstboot] listening on :${PORT}`));
