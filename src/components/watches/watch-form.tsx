"use client";

import { useState } from "react";
import type { WatchedSearchDTO } from "@/lib/watched-search";

const MIN_INTERVAL = 30;
const MAX_INTERVAL = 1440;

/**
 * Watch setup form — CREATE or EDIT a profile-update watch.
 *
 * Create mode (no `watch`): POSTs /api/watches; clears + calls onCreated.
 * Edit mode (`watch` provided): pre-fills, PATCHes /api/watches/[id]; calls
 * onSaved. Same mono/terminal aesthetic as the /updates page. Only mounted on
 * /updates (which notFound()s when the flag is off), so it never reaches the
 * client in the dark state.
 */
export function WatchForm({
  watch,
  onCreated,
  onSaved,
  onCancel,
}: {
  watch?: WatchedSearchDTO;
  onCreated?: () => void;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const editing = !!watch;
  const [name, setName] = useState(watch?.name ?? "");
  const [query, setQuery] = useState(watch?.query ?? "");
  const [location, setLocation] = useState(watch?.location ?? "");
  const [intervalMinutes, setIntervalMinutes] = useState(watch?.intervalMinutes ?? 1440);
  const [active, setActive] = useState(watch?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clampedInterval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(intervalMinutes)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !query.trim()) {
      setError("name and query are required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        query: query.trim(),
        location: location.trim() || null,
        intervalMinutes: clampedInterval,
        active,
      };
      // notifyFrom is intentionally NOT sent — a watch always notifies from the
      // moment it's created (createWatch defaults it to now), so there's no
      // start-date picker to get wrong.

      if (editing) {
        const res = await fetch(`/api/watches/${watch!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: unknown };
          setError(typeof b.error === "string" ? b.error : `save failed (${res.status})`);
          return;
        }
        onSaved?.();
        return;
      }

      const res = await fetch("/api/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(typeof b.error === "string" ? b.error : `create failed (${res.status})`);
        return;
      }
      // The create endpoint always creates active; honour an unticked box.
      if (!active) {
        const created = (await res.json().catch(() => ({}))) as { watch?: { id?: string } };
        if (created.watch?.id) {
          await fetch(`/api/watches/${created.watch.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active: false }),
          }).catch(() => {});
        }
      }
      setName(""); setQuery(""); setLocation(""); setIntervalMinutes(1440); setActive(true);
      onCreated?.();
    } finally {
      setBusy(false);
    }
  }

  const fieldCls =
    "w-full px-2 py-1.5 text-xs rounded border border-separator bg-surface-base text-text-primary placeholder:text-text-tertiary font-mono focus:outline-none focus:border-accent transition-colors";

  return (
    <form onSubmit={submit} className="bg-surface-raised border border-separator rounded-md p-4 font-mono text-sm space-y-3">
      {!editing && <div className="text-text-tertiary uppercase text-2xs tracking-wider">New watch</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-2xs text-text-tertiary">name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Senior Java — Auckland" className={fieldCls} />
        </label>
        <label className="block">
          <span className="text-2xs text-text-tertiary">location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} placeholder="Auckland (optional)" className={fieldCls} />
        </label>
      </div>

      <label className="block">
        <span className="text-2xs text-text-tertiary">query (boolean)</span>
        <textarea value={query} onChange={(e) => setQuery(e.target.value)} maxLength={2000} rows={2} placeholder={'"Java" AND ("Spring" OR "Spring Boot")'} className={fieldCls + " resize-none"} />
      </label>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
        <label className="block">
          <span className="text-2xs text-text-tertiary">interval (min, {MIN_INTERVAL}–{MAX_INTERVAL})</span>
          <input
            type="number"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Number(e.target.value) || MAX_INTERVAL)}
            className={fieldCls}
          />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-xs text-text-secondary">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-accent" />
          active
        </label>
      </div>

      {error && <div className="text-2xs text-danger">{error}</div>}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="h-8 px-4 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
          {busy ? (editing ? "saving…" : "creating…") : (editing ? "save changes" : "create watch")}
        </button>
        {editing && onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="h-8 px-3 text-xs rounded border border-separator text-text-secondary hover:text-text-primary hover:bg-surface-hover disabled:opacity-50">
            cancel
          </button>
        )}
      </div>
    </form>
  );
}
