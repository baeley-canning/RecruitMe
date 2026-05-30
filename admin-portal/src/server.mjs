/**
 * RecruitMe admin portal — fleet monitor for deployed boxes.
 *
 * Single-file Hono server with SQLite. Tracks: registered boxes,
 * heartbeat history (last 7 days), and pending control commands for
 * each box (Phase I4 long-poll target).
 *
 * Designed for Fly.io (~$3/mo on a shared-1x VM with LiteFS persistence)
 * but runs anywhere with Node 20+ and a writable disk for the SQLite
 * file. See ../Dockerfile + ../fly.toml.
 *
 * Endpoints:
 *   POST /api/heartbeat            — boxes push vitals every 5 min
 *   GET  /api/control/:boxId       — boxes long-poll for signed commands
 *   POST /api/admin/boxes          — seller registers a new box (returns token)
 *   POST /api/admin/boxes/:id/cmd  — seller queues a command (Phase I4)
 *   GET  /                         — fleet dashboard
 *   GET  /boxes/:id                — per-box history
 *
 * Auth:
 *   - Box-facing: per-box bearer token (issued at /api/admin/boxes)
 *   - Seller-facing (/api/admin/*, /, /boxes/*): basic auth with
 *     ADMIN_USERNAME + ADMIN_PASSWORD env. v2 = upgrade to a real session.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { basicAuth } from "hono/basic-auth";
import { html } from "hono/html";
import Database from "better-sqlite3";
import { randomUUID, randomBytes, createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "/data/portal.sqlite";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD env required");
  process.exit(1);
}

// ── DB ───────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS boxes (
    id            TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    notes         TEXT,
    revoked_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS heartbeats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    box_id      TEXT NOT NULL REFERENCES boxes(id),
    payload     TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS heartbeats_box_received
    ON heartbeats(box_id, received_at DESC);
  CREATE TABLE IF NOT EXISTS commands (
    id          TEXT PRIMARY KEY,
    box_id      TEXT NOT NULL REFERENCES boxes(id),
    command     TEXT NOT NULL,
    args_json   TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|completed|failed
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    result_json TEXT
  );
  CREATE INDEX IF NOT EXISTS commands_box_status
    ON commands(box_id, status);
`);

// Retention: prune heartbeats older than 7 days every hour.
setInterval(() => {
  try {
    db.prepare("DELETE FROM heartbeats WHERE received_at < datetime('now', '-7 days')").run();
  } catch (err) {
    console.error("[retention] prune failed:", err);
  }
}, 60 * 60 * 1000);

// ── Helpers ──────────────────────────────────────────────────────────────────
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function findBoxByToken(token) {
  const h = hashToken(token);
  return db.prepare("SELECT * FROM boxes WHERE token_hash = ? AND revoked_at IS NULL").get(h);
}

function relativeAgo(iso) {
  const sec = Math.round((Date.now() - new Date(iso + "Z").getTime()) / 1000);
  if (Number.isNaN(sec)) return "?";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

const STALE_MS = 30 * 60 * 1000;

// ── App ──────────────────────────────────────────────────────────────────────
const app = new Hono();

// Box-facing endpoints (no admin auth, but each carries its own bearer)
app.post("/api/heartbeat", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return c.json({ error: "missing token" }, 401);
  const box = findBoxByToken(token);
  if (!box) return c.json({ error: "unknown box" }, 401);
  const body = await c.req.text();
  try {
    db.prepare("INSERT INTO heartbeats (box_id, payload) VALUES (?, ?)").run(box.id, body);
  } catch (err) {
    return c.json({ error: "store failed" }, 500);
  }
  return c.json({ ok: true });
});

// Long-poll command channel (Phase I4 — see appliance/control-agent).
// Box opens a 25s GET; portal returns immediately if a command is queued,
// otherwise blocks until one arrives or timeout. Box then issues
// POST /api/control/:cmdId/result with the outcome.
app.get("/api/control/:boxId", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const box = findBoxByToken(token);
  const boxId = c.req.param("boxId");
  if (!box || box.id !== boxId) return c.json({ error: "unknown box" }, 401);

  const deadline = Date.now() + 25_000;
  const stmt = db.prepare(`
    SELECT * FROM commands WHERE box_id = ? AND status = 'pending'
    ORDER BY created_at ASC LIMIT 1
  `);
  while (Date.now() < deadline) {
    const cmd = stmt.get(boxId);
    if (cmd) {
      db.prepare("UPDATE commands SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(cmd.id);
      return c.json({
        id: cmd.id,
        command: cmd.command,
        args: cmd.args_json ? JSON.parse(cmd.args_json) : {},
      });
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return c.json({ command: null });
});

app.post("/api/control/:cmdId/result", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const box = findBoxByToken(token);
  if (!box) return c.json({ error: "unknown box" }, 401);
  const cmdId = c.req.param("cmdId");
  const body = await c.req.json().catch(() => ({}));
  const status = body.ok === false ? "failed" : "completed";
  db.prepare(`
    UPDATE commands SET status = ?, result_json = ?
    WHERE id = ? AND box_id = ?
  `).run(status, JSON.stringify(body), cmdId, box.id);
  return c.json({ ok: true });
});

// Seller-facing — basic auth
const adminGuard = basicAuth({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
app.use("/api/admin/*", adminGuard);
app.use("/", adminGuard);
app.use("/boxes/*", adminGuard);

app.post("/api/admin/boxes", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.customer_name) return c.json({ error: "customer_name required" }, 422);
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO boxes (id, customer_name, token_hash, notes) VALUES (?, ?, ?, ?)")
    .run(id, body.customer_name, hashToken(token), body.notes ?? null);
  // ONE TIME — token is returned only on creation. Burn it into the box.
  return c.json({ id, customer_name: body.customer_name, token });
});

app.post("/api/admin/boxes/:id/cmd", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.command) return c.json({ error: "command required" }, 422);
  const boxId = c.req.param("id");
  const box = db.prepare("SELECT id FROM boxes WHERE id = ? AND revoked_at IS NULL").get(boxId);
  if (!box) return c.json({ error: "unknown box" }, 404);
  const cmdId = randomUUID();
  db.prepare("INSERT INTO commands (id, box_id, command, args_json) VALUES (?, ?, ?, ?)")
    .run(cmdId, boxId, body.command, JSON.stringify(body.args ?? {}));
  return c.json({ id: cmdId, status: "queued" });
});

app.post("/api/admin/boxes/:id/revoke", (c) => {
  const boxId = c.req.param("id");
  db.prepare("UPDATE boxes SET revoked_at = datetime('now') WHERE id = ?").run(boxId);
  return c.json({ ok: true });
});

// Fleet dashboard
app.get("/", (c) => {
  const boxes = db.prepare(`
    SELECT b.*, h.payload AS latest_payload, h.received_at AS latest_at
    FROM boxes b
    LEFT JOIN heartbeats h ON h.id = (
      SELECT id FROM heartbeats WHERE box_id = b.id ORDER BY received_at DESC LIMIT 1
    )
    WHERE b.revoked_at IS NULL
    ORDER BY b.customer_name
  `).all();

  const rows = boxes.map((b) => {
    const payload = b.latest_payload ? JSON.parse(b.latest_payload) : null;
    const ageMs = b.latest_at ? Date.now() - new Date(b.latest_at + "Z").getTime() : Infinity;
    const isStale = ageMs > STALE_MS;
    const isUnseen = !b.latest_at;
    const status = isUnseen ? "UNSEEN" : isStale ? "STALE" : "OK";
    const tone = status === "OK" ? "ok" : "alert";
    return { ...b, payload, ageMs, isStale, isUnseen, status, tone };
  });

  const healthy = rows.filter((r) => r.status === "OK").length;
  const alert = rows.length - healthy;

  return c.html(html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RecruitMe Admin — Fleet</title>
  <style>
    body { background: #0f1115; color: #e6e8eb; font-family: ui-monospace, "SF Mono", Menlo, monospace; margin: 0; padding: 24px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: #8a8f99; font-size: 12px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #2a2d35; font-size: 13px; }
    th { color: #8a8f99; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    tr:hover td { background: #1a1d23; }
    .ok { color: #4ade80; }
    .alert { color: #f59e0b; }
    .muted { color: #8a8f99; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer { color: #8a8f99; font-size: 12px; margin-top: 16px; text-align: right; }
  </style>
</head>
<body>
  <h1>RecruitMe Fleet</h1>
  <div class="sub">${rows.length} box${rows.length === 1 ? "" : "es"} · ${healthy} healthy · <span class="${alert > 0 ? "alert" : "ok"}">${alert} alert${alert === 1 ? "" : "s"}</span></div>
  <table>
    <thead>
      <tr>
        <th>Customer</th><th>Box ID</th><th>Version</th><th>Last seen</th>
        <th>Today (search / ingest)</th><th>Disk</th><th>RAM</th><th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => html`
        <tr>
          <td><a href="/boxes/${r.id}">${r.customer_name}</a></td>
          <td class="muted">${r.id.slice(0, 8)}</td>
          <td class="muted">${r.payload?.version ?? "—"}</td>
          <td class="${r.isStale ? "alert" : ""}">${r.isUnseen ? "—" : relativeAgo(r.latest_at)}</td>
          <td>${r.payload?.stats_today?.searches ?? "—"} / ${r.payload?.stats_today?.ingested ?? "—"}</td>
          <td>${r.payload ? ((r.payload.system?.disk_used_pct ?? 0) * 100).toFixed(0) + "%" : "—"}</td>
          <td>${r.payload ? ((r.payload.system?.ram_used_pct ?? 0) * 100).toFixed(0) + "%" : "—"}</td>
          <td class="${r.tone}">● ${r.status}</td>
        </tr>
      `)}
    </tbody>
  </table>
  <div class="footer">RecruitMe Admin Portal · ${new Date().toISOString()}</div>
</body>
</html>`);
});

app.get("/boxes/:id", (c) => {
  const boxId = c.req.param("id");
  const box = db.prepare("SELECT * FROM boxes WHERE id = ?").get(boxId);
  if (!box) return c.text("Not found", 404);
  const heartbeats = db.prepare(`
    SELECT received_at, payload FROM heartbeats
    WHERE box_id = ? ORDER BY received_at DESC LIMIT 50
  `).all(boxId);
  const commands = db.prepare(`
    SELECT id, command, status, created_at, delivered_at FROM commands
    WHERE box_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(boxId);
  return c.html(html`<!doctype html>
<html><head><title>${box.customer_name} — RecruitMe Box</title>
<style>body{background:#0f1115;color:#e6e8eb;font-family:ui-monospace,monospace;margin:0;padding:24px}h1{font-size:18px;margin:0 0 16px}h2{font-size:13px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.05em;margin:24px 0 8px}table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #2a2d35;font-size:12px}.muted{color:#8a8f99}a{color:#60a5fa;text-decoration:none}pre{font-size:11px;background:#1a1d23;padding:8px;border-radius:4px;overflow-x:auto;max-width:800px}</style>
</head>
<body>
  <a href="/">← Fleet</a>
  <h1>${box.customer_name}</h1>
  <div class="muted">${box.id} · created ${box.created_at}</div>
  <h2>Last 50 heartbeats</h2>
  <table><thead><tr><th>Received</th><th>Snapshot</th></tr></thead>
  <tbody>
  ${heartbeats.map((h) => html`<tr><td class="muted">${h.received_at}</td><td><pre>${h.payload}</pre></td></tr>`)}
  </tbody></table>
  <h2>Commands</h2>
  <table><thead><tr><th>ID</th><th>Command</th><th>Status</th><th>Created</th></tr></thead>
  <tbody>
  ${commands.map((cmd) => html`<tr><td class="muted">${cmd.id.slice(0, 8)}</td><td>${cmd.command}</td><td>${cmd.status}</td><td class="muted">${cmd.created_at}</td></tr>`)}
  </tbody></table>
</body></html>`);
});

serve({ fetch: app.fetch, port: PORT });
console.log(`[admin-portal] listening on :${PORT}`);
