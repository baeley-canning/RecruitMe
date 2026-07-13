"use client";

/**
 * ApplianceStatus — owner-facing live health of the sourcing appliance.
 *
 * The mini-PC scraper box, the AI backend, and the database all have rich
 * liveness signals in /api/health (heartbeat age, queue depth, poll errors,
 * AI credit state), but until now the ONLY consumer was the on-box kiosk
 * (/box-dashboard), which the operator can't see remotely. This card surfaces
 * the same signal inside the owner Admin page so "is my box online / is SEEK
 * dead / am I out of AI credit" is answerable without SSH.
 *
 * Read-only: it GETs the authed /api/health (owner session already required to
 * be on this page) and polls every 30s. No new route, no mutation, no PII.
 */

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";

interface Check {
  ok: boolean;
  detail?: string;
  lastSeenAt?: string;
  skipped?: boolean;
  degraded?: boolean;
}

interface Health {
  ok: boolean;
  degraded: boolean;
  checks: { db: Check; ollama: Check; scraper: Check; blob: Check; cv: Check; ai: Check };
  version: string;
  uptimeSec: number;
  timestamp: string;
  flags: { discovery: boolean };
}

/** Amber when ok-but-degraded, green when ok, red when down. */
function tone(c: Check): "ok" | "warn" | "down" {
  if (!c.ok) return "down";
  if (c.degraded) return "warn";
  return "ok";
}

const DOT: Record<"ok" | "warn" | "down", string> = {
  ok: "text-success",
  warn: "text-warning",
  down: "text-danger",
};

function ago(iso?: string): string | null {
  if (!iso) return null;
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function Row({ label, check, extra }: { label: string; check: Check; extra?: string | null }) {
  const t = tone(check);
  const state = check.skipped ? "not used" : t === "ok" ? "ok" : t === "warn" ? "degraded" : "down";
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-separator-subtle last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className={check.skipped ? "text-text-tertiary" : DOT[t]}>●</span>
        <span className="text-base text-text-primary">{label}</span>
      </div>
      <div className="text-right min-w-0">
        <div className="text-xs text-text-secondary capitalize">{state}</div>
        {(check.detail || extra) && (
          <div className="text-2xs text-text-tertiary truncate max-w-[16rem]" title={check.detail ?? extra ?? ""}>
            {extra ?? check.detail}
          </div>
        )}
      </div>
    </div>
  );
}

export function ApplianceStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      // Non-fatal deps down still return a JSON body (503 only on DB failure).
      const data = (await res.json()) as Health;
      setHealth(data);
      setErr(false);
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const banner = !health
    ? { text: "—", cls: "bg-surface-hover text-text-tertiary" }
    : !health.ok
      ? { text: "System down — database unreachable", cls: "bg-danger-subtle text-danger" }
      : health.degraded
        ? { text: "Degraded — one or more services need attention", cls: "bg-warning-subtle text-warning" }
        : { text: "All systems operational", cls: "bg-success-subtle text-success" };

  const scraperExtra = health
    ? [ago(health.checks.scraper.lastSeenAt) && `checked in ${ago(health.checks.scraper.lastSeenAt)}`, health.checks.scraper.detail]
        .filter(Boolean)
        .join(" · ") || null
    : null;

  return (
    <section>
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 text-text-secondary" />
            Appliance status
          </h2>
          <p className="text-xs text-text-tertiary mt-0.5">
            Live health of the scraper box, AI backend, and storage. Refreshes every 30s.
          </p>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
          title="Refresh now"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      <Card>
        <CardBody>
          {err && !health ? (
            <p className="text-xs text-danger">Could not reach /api/health.</p>
          ) : !health ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
            </div>
          ) : (
            <>
              <div className={`rounded-md px-3 py-2 mb-3 text-sm font-medium ${banner.cls}`}>
                <div className="flex items-center justify-between">
                  <span>{banner.text}</span>
                  <span className="text-xs opacity-70 data-mono">
                    v{health.version} · discovery {health.flags.discovery ? "on" : "off"}
                  </span>
                </div>
              </div>
              <div>
                <Row label="Scraper box" check={health.checks.scraper} extra={scraperExtra} />
                <Row label="AI (Claude)" check={health.checks.ai} />
                <Row label="Local AI (Ollama)" check={health.checks.ollama} />
                <Row label="Database" check={health.checks.db} />
                <Row label="CV storage" check={health.checks.blob} />
                <Row label="CV encryption" check={health.checks.cv} />
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}
