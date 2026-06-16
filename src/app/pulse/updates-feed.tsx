"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { WatchForm } from "@/components/watches/watch-form";
import { WatchList } from "@/components/watches/watch-list";
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
 * Terminal-style live feed of profile-update hits. Reuses the box-dashboard mono
 * aesthetic. Consumes /api/watches/feed/stream over SSE (auto-reconnecting),
 * shows a "listening" heartbeat pulse while connected, animates new rows in, and
 * carries an interactive watch list (edit / pause / check-now / delete / filter).
 * Only mounted by the /updates page, which notFound()s when the flag is off.
 */
export function UpdatesFeed() {
  const [hits, setHits] = useState<ProfileUpdateHitDTO[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [connected, setConnected] = useState(false);
  const [watches, setWatches] = useState<WatchedSearchDTO[]>([]);
  const [watchFilter, setWatchFilter] = useState<string>(""); // "" = all
  const [showCreate, setShowCreate] = useState(false);
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
  // No watches yet → open the create form so the page isn't empty.
  useEffect(() => { if (watches.length === 0) setShowCreate(true); }, [watches.length]);

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
    setHits((prev) => prev.map((h) => ({ ...h, seen: true })));
    setUnseen(0);
  }, []);

  const filterName = watchFilter ? watches.find((w) => w.id === watchFilter)?.name ?? "—" : null;

  return (
    <div className="min-h-screen bg-surface-base text-text-primary p-6 font-mono text-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-separator pb-3 mb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">Profile updates</h1>
          {unseen > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded-full bg-accent text-white animate-pulse">{unseen} new</span>
          )}
        </div>
        {/* Live "listening" heartbeat pulse */}
        <div className="text-xs">
          {connected ? (
            <span className="flex items-center gap-1.5 text-success" title="Connected — listening for profile updates">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              <span className="animate-breathe">listening</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-warning" title="Reconnecting…">
              <span className="h-2 w-2 rounded-full bg-warning animate-pulse" /> reconnecting…
            </span>
          )}
        </div>
      </div>

      {/* Watches — interactive list (edit / pause / check / delete / filter) */}
      <WatchList
        watches={watches}
        activeFilter={watchFilter}
        onFilter={(id) => setWatchFilter(id)}
        onChanged={() => void loadWatches()}
      />

      {/* Create watch — collapsible */}
      <div className="mb-4">
        {showCreate ? (
          <div className="space-y-2">
            <WatchForm onCreated={() => { setShowCreate(false); void loadWatches(); }} />
            {watches.length > 0 && (
              <button onClick={() => setShowCreate(false)} className="text-2xs text-text-tertiary hover:text-text-secondary">cancel</button>
            )}
          </div>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1 h-8 px-3 text-xs rounded border border-separator text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> new watch
          </button>
        )}
      </div>

      {/* Filter status + mark-seen */}
      <div className="flex items-center justify-between gap-3 mb-3 text-xs">
        <div className="text-text-tertiary">
          {filterName ? (
            <span>showing <span className="text-text-primary">{filterName}</span> · <button onClick={() => setWatchFilter("")} className="text-accent hover:underline">show all</button></span>
          ) : (
            <span>showing all watches</span>
          )}
        </div>
        {unseen > 0 && (
          <button
            onClick={() => void markSeen(watchFilter ? { watchId: watchFilter } : { all: true })}
            className="h-7 px-3 rounded border border-separator text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            mark all seen
          </button>
        )}
      </div>

      {/* Feed */}
      <div className="bg-surface-raised border border-separator rounded-md p-4">
        {hits.length === 0 ? (
          <p className="text-xs text-text-tertiary py-6 text-center">
            No profile updates yet. Watches surface candidates who recently updated their SEEK profile — hit the ↻ on a watch to check now.
          </p>
        ) : (
          <div className="divide-y divide-separator">
            {hits.map((h) => {
              const href = h.candidateId ? `/candidates/${h.candidateId}` : h.profileUrl;
              const external = !h.candidateId;
              return (
                <div key={h.id} className="py-2 flex items-start gap-3 animate-feed-in">
                  <span className="text-text-tertiary w-12 text-right text-xs shrink-0" title={new Date(h.flaggedAt).toLocaleString()}>
                    {fmtAgo(h.flaggedAt, now)}
                  </span>
                  <span className={`w-1.5 shrink-0 text-xs ${h.seen ? "text-transparent" : "text-accent animate-pulse"}`} title={h.seen ? "seen" : "new"}>●</span>
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
