"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WatchForm } from "@/components/watches/watch-form";
import type { WatchedSearchDTO, ProfileUpdateHitDTO } from "@/lib/watched-search";

function fmtAgo(iso: string, nowMs: number): string {
  const sec = Math.round((nowMs - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

interface FeedPayload {
  hits: ProfileUpdateHitDTO[];
  unseen: number;
}

/**
 * Terminal-style live feed of profile-update hits (Stage D). Reuses the
 * box-dashboard mono aesthetic. Consumes /api/watches/feed/stream over SSE
 * (the EventSource auto-reconnects, so an app restart doesn't strand the feed),
 * with the GET feed as the initial paint + fallback. Per-watch filter (loaded
 * from /api/watches), mark-seen (PATCH the feed), and an `[open ↗]` link per
 * row → the local candidate page when we hold the candidate, else the SEEK
 * profile deep-link.
 *
 * Only ever mounted by the /updates server page, which notFound()s when the
 * profile-watch flag is off — so this never renders in the dark state.
 */
export function UpdatesFeed() {
  const [hits, setHits] = useState<ProfileUpdateHitDTO[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [connected, setConnected] = useState(false);
  const [watches, setWatches] = useState<WatchedSearchDTO[]>([]);
  const [watchFilter, setWatchFilter] = useState<string>(""); // "" = all
  const [now, setNow] = useState(() => Date.now());

  // Re-tick the relative timestamps every 30s without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const loadWatches = useCallback(async () => {
    const res = await fetch("/api/watches", { cache: "no-store" });
    if (res.ok) {
      const b = (await res.json()) as { watches?: WatchedSearchDTO[] };
      setWatches(b.watches ?? []);
    }
  }, []);

  useEffect(() => { void loadWatches(); }, [loadWatches]);

  // SSE feed, re-subscribed whenever the per-watch filter changes.
  const esRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const qs = watchFilter ? `?watchId=${encodeURIComponent(watchFilter)}` : "";
    const es = new EventSource(`/api/watches/feed/stream${qs}`);
    esRef.current = es;
    es.addEventListener("feed", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as FeedPayload;
        setHits(data.hits);
        setUnseen(data.unseen);
        setConnected(true);
      } catch { /* malformed payload; keep last known */ }
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => { es.close(); esRef.current = null; };
  }, [watchFilter]);

  const markSeen = useCallback(async (body: Record<string, unknown>) => {
    await fetch("/api/watches/feed", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
    // Optimistic: the SSE tick will re-emit the corrected snapshot shortly.
    setHits((prev) => prev.map((h) => ({ ...h, seen: true })));
    setUnseen(0);
  }, []);

  const filtered = hits;

  return (
    <div className="min-h-screen bg-surface-base text-text-primary p-6 font-mono text-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-separator pb-3 mb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">Profile updates</h1>
          {unseen > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded-full bg-accent text-white">{unseen} new</span>
          )}
        </div>
        <div className="text-text-tertiary text-xs">
          {connected ? <span className="text-success">● live</span> : <span className="text-warning">● reconnecting</span>}
        </div>
      </div>

      <div className="mb-4">
        <WatchForm onCreated={() => void loadWatches()} />
      </div>

      {/* Filter + actions */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          watch:
          <select
            value={watchFilter}
            onChange={(e) => setWatchFilter(e.target.value)}
            className="h-7 px-2 text-xs rounded border border-separator bg-surface-base text-text-primary font-mono"
          >
            <option value="">all</option>
            {watches.map((w) => (
              <option key={w.id} value={w.id}>{w.name}{w.active ? "" : " (paused)"}</option>
            ))}
          </select>
        </label>
        {unseen > 0 && (
          <button
            onClick={() => void markSeen(watchFilter ? { watchId: watchFilter } : { all: true })}
            className="h-7 px-3 text-xs rounded border border-separator text-text-secondary hover:text-text-primary hover:bg-surface-hover"
          >
            mark all seen
          </button>
        )}
      </div>

      {/* Feed */}
      <div className="bg-surface-raised border border-separator rounded-md p-4">
        {filtered.length === 0 ? (
          <p className="text-xs text-text-tertiary py-6 text-center">
            No profile updates yet. Watches surface candidates who recently updated their SEEK profile.
          </p>
        ) : (
          <div className="divide-y divide-separator">
            {filtered.map((h) => {
              const href = h.candidateId ? `/candidates/${h.candidateId}` : h.profileUrl;
              const external = !h.candidateId;
              return (
                <div key={h.id} className="py-2 flex items-start gap-3">
                  <span className="text-text-tertiary w-12 text-right text-xs shrink-0" title={new Date(h.flaggedAt).toLocaleString()}>
                    {fmtAgo(h.flaggedAt, now)}
                  </span>
                  <span className={`w-1.5 shrink-0 text-xs ${h.seen ? "text-transparent" : "text-accent"}`} title={h.seen ? "seen" : "new"}>●</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-text-primary text-xs truncate">
                      {h.name ?? `SEEK profile ${h.seekId}`}
                      {h.updatedAgo && <span className="text-text-tertiary"> · updated {h.updatedAgo}</span>}
                    </div>
                    {h.headline && <div className="text-2xs text-text-secondary truncate">{h.headline}</div>}
                    <div className="text-2xs text-text-tertiary truncate">
                      {h.watchName && <span>{h.watchName}</span>}
                      {h.location && <span> · {h.location}</span>}
                    </div>
                  </div>
                  <a
                    href={href}
                    target={external ? "_blank" : undefined}
                    rel={external ? "noopener noreferrer" : undefined}
                    className="text-2xs text-accent hover:underline shrink-0 self-center"
                  >
                    [open{external ? " ↗" : ""}]
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
