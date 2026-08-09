/**
 * /api/box-dashboard/control — the box steering endpoint.
 *
 * GET  → config for the dashboard Control panel ({ enabled, noVNC params }).
 *        Returns { enabled: false } anywhere BOX_CONTROL!=1 (i.e. Railway),
 *        so the panel simply never renders off-box.
 * POST → run one allowlisted control action (wifi-reassoc, restart-scraper,
 *        reboot, logs, login). Guarded box-only + same-origin.
 *
 * Security: BOX_CONTROL=1 lives only in the box's boxdash.env; this whole
 * /api/box-dashboard/* prefix is already middleware-restricted to
 * loopback/Tailscale. boxdash runs as root, so executors act directly.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import {
  boxControlEnabled,
  reassocWifi,
  restartScraper,
  rebootBox,
  tailLogs,
  startLogin,
} from "@/lib/box-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!boxControlEnabled()) return NextResponse.json({ enabled: false });
  return NextResponse.json({
    enabled: true,
    // noVNC connects WS back through Caddy's /novnc/* -> websockify route.
    novncPath: "novnc/websockify",
    novncPassword: process.env.BOX_VNC_PASSWORD ?? "",
    // The dashboard must echo this back on control POSTs. Safe to serve here:
    // this GET is behind the same loopback/Tailscale gate, and it is the same
    // trust level as the noVNC password already returned above.
    controlSecret: process.env.BOX_CONTROL_SECRET ?? "",
  });
}

export async function POST(req: Request) {
  if (!boxControlEnabled()) {
    return NextResponse.json({ error: "not_box" }, { status: 404 });
  }
  // Reject cross-origin POSTs (defence-in-depth against CSRF from another
  // tab on a tailnet device). Same-origin requests omit Origin or match Host.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "cross_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }

  // Shared-secret gate. These actions run as ROOT (restart / reboot / wifi /
  // logs / launch a login browser), and until now the ONLY thing standing in
  // front of them was the middleware IP check — a control whose correctness
  // rests on assumptions outside this codebase (Next never directly
  // LAN-reachable, Caddy pinning trusted_proxies). Requiring a secret makes the
  // endpoint self-sufficient: network position alone is no longer authority.
  //
  // Opt-in by design: when BOX_CONTROL_SECRET is unset the behaviour is exactly
  // as before, so an existing box keeps working until its env is updated. Set it
  // in boxdash.env and the dashboard sends it — then the IP gate becomes
  // defence-in-depth rather than the whole defence.
  const required = process.env.BOX_CONTROL_SECRET?.trim();
  if (required) {
    const provided = req.headers.get("x-box-control-secret") ?? "";
    const a = Buffer.from(provided);
    const b = Buffer.from(required);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const action = String(body.action ?? "");
  try {
    switch (action) {
      case "wifi-reassoc":
        return NextResponse.json({ ok: true, detail: await reassocWifi() });
      case "restart-scraper":
        return NextResponse.json({ ok: true, detail: await restartScraper() });
      case "reboot":
        if (body.confirm !== true) {
          return NextResponse.json({ error: "confirm_required" }, { status: 400 });
        }
        return NextResponse.json({ ok: true, detail: rebootBox() });
      case "logs":
        return NextResponse.json({
          ok: true,
          logs: await tailLogs(String(body.service ?? ""), Number(body.lines) || 120),
        });
      case "login":
        return NextResponse.json({ ok: true, detail: startLogin(String(body.platform ?? "")) });
      default:
        return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
