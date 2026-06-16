"use client";

import { useState } from "react";
import { Pencil, Trash2, Play, Pause, RefreshCw } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { confirm } from "@/components/ui/confirm-dialog";
import { WatchForm } from "./watch-form";
import type { WatchedSearchDTO } from "@/lib/watched-search";

function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 0) return `in ${Math.round(-sec / 60)}m`;
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/**
 * Interactive list of watches under the feed. Each watch can be: clicked (name)
 * to FILTER the feed to it, edited inline (reuses WatchForm in edit mode),
 * paused/resumed, "checked now" (runs a SEEK pass immediately), or deleted.
 * Active watches show a breathing "listening" dot. Mutations call onChanged so
 * the parent reloads the list + feed.
 */
export function WatchList({
  watches,
  activeFilter,
  onFilter,
  onChanged,
}: {
  watches: WatchedSearchDTO[];
  activeFilter: string;
  onFilter: (id: string) => void;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);

  const isBusy = (id: string, action?: string) =>
    busy?.id === id && (action ? busy.action === action : true);

  async function patch(w: WatchedSearchDTO, body: Record<string, unknown>, action: string, okMsg?: string) {
    setBusy({ id: w.id, action });
    try {
      const res = await fetch(`/api/watches/${w.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) { if (okMsg) showToast(okMsg, "success"); onChanged(); }
      else showToast("Couldn't update watch", "error");
    } finally { setBusy(null); }
  }

  async function checkNow(w: WatchedSearchDTO) {
    setBusy({ id: w.id, action: "check" });
    try {
      const res = await fetch(`/api/watches/${w.id}/check`, { method: "POST" });
      if (res.ok) showToast(`Checking "${w.name}" now — new matches will appear in the feed`, "success");
      else {
        const b = await res.json().catch(() => ({}));
        showToast(typeof b.error === "string" ? b.error : "Check failed", "error");
      }
      onChanged();
    } finally { setBusy(null); }
  }

  async function remove(w: WatchedSearchDTO) {
    const ok = await confirm({
      title: "Delete watch?",
      message: `Delete "${w.name}"? Its alert history will be removed too. This can't be undone.`,
      danger: true, confirmLabel: "Delete",
    });
    if (!ok) return;
    setBusy({ id: w.id, action: "delete" });
    try {
      const res = await fetch(`/api/watches/${w.id}`, { method: "DELETE" });
      if (res.ok) { showToast("Watch deleted", "success"); onChanged(); }
      else showToast("Couldn't delete watch", "error");
    } finally { setBusy(null); }
  }

  if (watches.length === 0) return null;

  return (
    <div className="bg-surface-raised border border-separator rounded-md p-4 font-mono text-sm mb-3">
      <div className="text-text-tertiary uppercase text-2xs tracking-wider mb-2">
        Watches ({watches.length})
      </div>
      <div className="divide-y divide-separator">
        {watches.map((w) => {
          if (editingId === w.id) {
            return (
              <div key={w.id} className="py-3">
                <WatchForm
                  watch={w}
                  onSaved={() => { setEditingId(null); showToast("Watch saved", "success"); onChanged(); }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            );
          }
          const selected = activeFilter === w.id;
          return (
            <div key={w.id} className={`py-2 flex items-center gap-3 ${selected ? "bg-surface-hover -mx-1 px-1 rounded" : ""}`}>
              {/* Listening indicator: breathing accent dot when active, dim when paused. */}
              <span className="relative flex h-2 w-2 shrink-0" title={w.active ? "listening" : "paused"}>
                {w.active && <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${w.active ? "bg-success" : "bg-text-tertiary"}`} />
              </span>

              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => onFilter(selected ? "" : w.id)}
                  className="text-left text-xs text-text-primary hover:text-accent truncate max-w-full transition-colors"
                  title={selected ? "clear filter" : "filter feed to this watch"}
                >
                  {w.name}
                </button>
                <div className="text-2xs text-text-tertiary truncate">
                  <span className="text-text-secondary">{w.query}</span>
                  {w.location && <span> · {w.location}</span>}
                  <span> · every {w.intervalMinutes}m · checked {fmtWhen(w.lastRunAt)}</span>
                  {!w.active && <span className="text-warning"> · paused</span>}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0 text-text-tertiary">
                <button type="button" onClick={() => void checkNow(w)} disabled={isBusy(w.id)} title="Check now"
                  className="h-7 w-7 rounded flex items-center justify-center hover:text-accent hover:bg-surface-hover disabled:opacity-40">
                  <RefreshCw className={`w-3.5 h-3.5 ${isBusy(w.id, "check") ? "animate-spin" : ""}`} />
                </button>
                <button type="button" onClick={() => void patch(w, { active: !w.active }, "toggle", w.active ? "Watch paused" : "Watch resumed")} disabled={isBusy(w.id)} title={w.active ? "Pause" : "Resume"}
                  className="h-7 w-7 rounded flex items-center justify-center hover:text-text-primary hover:bg-surface-hover disabled:opacity-40">
                  {w.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </button>
                <button type="button" onClick={() => setEditingId(w.id)} disabled={isBusy(w.id)} title="Edit"
                  className="h-7 w-7 rounded flex items-center justify-center hover:text-text-primary hover:bg-surface-hover disabled:opacity-40">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => void remove(w)} disabled={isBusy(w.id)} title="Delete"
                  className="h-7 w-7 rounded flex items-center justify-center hover:text-danger hover:bg-surface-hover disabled:opacity-40">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
