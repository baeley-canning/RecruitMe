"use client";

import { useState } from "react";

export interface WatchFormValues {
  name: string;
  query: string;
  location: string;
  notifyFrom: string; // datetime-local value ("" = default to now server-side)
  intervalMinutes: number;
  active: boolean;
}

const MIN_INTERVAL = 30;
const MAX_INTERVAL = 1440;

/**
 * Watch setup form (Stage D). A controlled form for creating a profile-update
 * watch: name + boolean query + location + notifyFrom date + intervalMinutes +
 * active. POSTs to /api/watches; on success calls onCreated so the parent feed
 * can refresh. Mirrors the mono/terminal aesthetic of the /updates page.
 *
 * Renders nothing itself when the feature is off — the parent only mounts it on
 * the /updates page, which already notFound()s when isProfileWatchEnabled() is
 * false, so this component never reaches the client in the dark state.
 */
export function WatchForm({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [notifyFrom, setNotifyFrom] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [active, setActive] = useState(true);
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
      // Only send notifyFrom when the recruiter set one; omit → server defaults to now.
      if (notifyFrom) body.notifyFrom = new Date(notifyFrom).toISOString();

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
      // If active was unticked, the create endpoint always makes it active; patch it off.
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
      setName("");
      setQuery("");
      setLocation("");
      setNotifyFrom("");
      setIntervalMinutes(1440);
      setActive(true);
      onCreated?.();
    } finally {
      setBusy(false);
    }
  }

  const fieldCls =
    "w-full px-2 py-1.5 text-xs rounded border border-separator bg-surface-base text-text-primary placeholder:text-text-tertiary font-mono focus:outline-none focus:border-accent";

  return (
    <form onSubmit={submit} className="bg-surface-raised border border-separator rounded-md p-4 font-mono text-sm space-y-3">
      <div className="text-text-tertiary uppercase text-2xs tracking-wider">New watch</div>

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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <label className="block">
          <span className="text-2xs text-text-tertiary">notify from</span>
          <input type="datetime-local" value={notifyFrom} onChange={(e) => setNotifyFrom(e.target.value)} className={fieldCls} />
        </label>
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

      <button type="submit" disabled={busy} className="h-8 px-4 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
        {busy ? "creating…" : "create watch"}
      </button>
    </form>
  );
}
