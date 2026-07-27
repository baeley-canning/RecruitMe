/**
 * Where the operator opens the box control panel (live browser view + the
 * LinkedIn/SEEK/JobAdder login launchers).
 *
 * WHY THIS EXISTS: when a SEEK session dies, the fix is a human clicking
 * "SEEK login" on the box dashboard and typing the MFA code. Before this, that
 * URL lived only in someone's head — so a dead session ran for nine days
 * (incident 2026-07-28). The app should hand you the door, not make you
 * remember where it is.
 *
 * The box dashboard is reachable over the TAILNET only (the /api/box-dashboard/*
 * prefix is middleware-gated to loopback + Tailscale CGNAT), so this is a plain
 * link the operator's own machine resolves — never proxied through the app.
 * Override per-deployment with NEXT_PUBLIC_BOX_DASHBOARD_URL.
 */

/** Tailnet address of the operator box's dashboard (port 3000, not 443). */
const DEFAULT_BOX_DASHBOARD_URL = "http://100.103.190.8:3000/box-dashboard";

export function boxDashboardUrl(): string {
  const raw = process.env.NEXT_PUBLIC_BOX_DASHBOARD_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_BOX_DASHBOARD_URL;
}
