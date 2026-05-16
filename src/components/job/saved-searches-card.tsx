"use client";

import { useEffect, useState, useCallback } from "react";
import { Bookmark, Plus, Play, Loader2, Trash2, MapPin, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

interface SavedSearch {
  id: string;
  name: string;
  queries: string;          // JSON: string[]
  location: string;
  target: number;
  lastRunAt: string | null;
  lastResultCount: number | null;
  createdAt: string;
}

interface SavedSearchesCardProps {
  jobId: string;
  jobStatus: string;
  defaultLocation: string;
  defaultTarget: number;
  defaultQueries?: string[];
  onComplete: () => void;
}

function parseQueries(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
  } catch {
    return [];
  }
}

export function SavedSearchesCard({
  jobId,
  jobStatus,
  defaultLocation,
  defaultTarget,
  defaultQueries,
  onComplete,
}: SavedSearchesCardProps) {
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [queriesText, setQueriesText] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [target, setTarget] = useState(defaultTarget);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/jobs/${jobId}/saved-searches`);
    if (res.ok) {
      const data = (await res.json()) as SavedSearch[];
      setSearches(Array.isArray(data) ? data : []);
    }
    setLoaded(true);
  }, [jobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reset form fields when the user opens the +Add panel.
  useEffect(() => {
    if (showAdd) {
      setName("");
      setQueriesText((defaultQueries ?? []).join("\n"));
      setLocation(defaultLocation);
      setTarget(defaultTarget);
      setError("");
    }
  }, [showAdd, defaultLocation, defaultTarget, defaultQueries]);

  const handleSave = async () => {
    setError("");
    const queries = queriesText
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean);
    if (!name.trim()) { setError("Name is required."); return; }
    if (queries.length === 0) { setError("Add at least one search query (one per line)."); return; }
    if (!location.trim()) { setError("Location is required."); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/saved-searches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), queries, location: location.trim(), target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to save.");
        return;
      }
      setShowAdd(false);
      await refresh();
    } catch {
      setError("Failed to save. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async (search: SavedSearch) => {
    setRunningId(search.id);
    try {
      const queries = parseQueries(search.queries);
      const res = await fetch(`/api/jobs/${jobId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxResults: search.target,
          locationOverride: search.location,
          queriesOverride: queries,
          savedSearchId: search.id,
        }),
      });
      const data = await res.json() as { sessionId?: string; error?: string };
      if (!res.ok || !data.sessionId) {
        setError(data.error ?? "Failed to start saved search.");
        return;
      }
      // Poll briefly to refresh lastResultCount; rely on onComplete to refresh candidate list.
      const sessionId = data.sessionId;
      const deadline = Date.now() + 8 * 60 * 1000;
      const poll = async () => {
        if (Date.now() > deadline) return;
        try {
          const pollRes = await fetch(`/api/jobs/${jobId}/search?sessionId=${sessionId}`);
          const pollData = await pollRes.json() as { status?: string };
          if (pollData.status === "running") { setTimeout(poll, 4000); }
          else { onComplete(); void refresh(); setRunningId(null); }
        } catch { setRunningId(null); }
      };
      setTimeout(poll, 4000);
    } catch {
      setError("Failed to start saved search. Check your connection.");
      setRunningId(null);
    }
  };

  const handleDelete = async (search: SavedSearch) => {
    if (!await confirm({ message: `Delete saved search "${search.name}"?`, danger: true, confirmLabel: "Delete" })) return;
    const res = await fetch(`/api/jobs/${jobId}/saved-searches/${search.id}`, { method: "DELETE" });
    if (res.ok) await refresh();
  };

  if (!loaded) return null;
  if (searches.length === 0 && !showAdd) {
    return (
      <div className="mb-6 rounded-md border border-separator bg-surface-raised px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-base text-text-secondary">
          <Bookmark className="w-3.5 h-3.5 text-text-tertiary" />
          <span>No saved searches. Save the current search to re-run it later.</span>
        </div>
        <Button onClick={() => setShowAdd(true)} size="sm" variant="outline" disabled={jobStatus === "closed"}>
          <Plus className="w-3.5 h-3.5" />
          Save current
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-md border border-separator bg-surface-raised">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-separator">
        <div className="flex items-center gap-2">
          <Bookmark className="w-3.5 h-3.5 text-text-tertiary" />
          <p className="text-md font-semibold text-text-primary">Saved searches</p>
          <span className="text-xs text-text-tertiary data-mono">({searches.length})</span>
        </div>
        {!showAdd && (
          <Button onClick={() => setShowAdd(true)} size="sm" variant="outline" disabled={jobStatus === "closed"}>
            <Plus className="w-3.5 h-3.5" />
            New
          </Button>
        )}
      </div>

      {showAdd && (
        <div className="px-4 py-3 border-b border-separator space-y-2 bg-surface-sunken">
          <input
            type="text"
            placeholder="Name (e.g. React leads in Auckland)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
          />
          <textarea
            placeholder="Queries (one per line) — e.g.&#10;senior react developer auckland&#10;react typescript lead nz"
            value={queriesText}
            onChange={(e) => setQueriesText(e.target.value)}
            rows={4}
            className="w-full text-xs font-mono px-2.5 py-1.5 rounded bg-surface-sunken border border-separator text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
          />
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="flex-1 h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
            />
            <select
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
              className="h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary focus:outline-none focus:border-accent focus:shadow-focus tabular-nums"
            >
              {[10, 20, 30, 50, 75, 100].map((n) => <option key={n} value={n}>{n} max</option>)}
            </select>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center gap-2 pt-1">
            <Button onClick={handleSave} loading={saving} disabled={saving} size="sm">Save</Button>
            <Button onClick={() => setShowAdd(false)} size="sm" variant="outline">Cancel</Button>
          </div>
        </div>
      )}

      {searches.map((s) => {
        const queries = parseQueries(s.queries);
        const isRunning = runningId === s.id;
        const lastRun = s.lastRunAt
          ? new Date(s.lastRunAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : null;
        return (
          <div key={s.id} className="px-4 py-3 border-b border-separator last:border-0">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-md font-medium text-text-primary truncate">{s.name}</p>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-text-tertiary flex-wrap">
                  <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{s.location}</span>
                  <span>up to <span className="data-mono">{s.target}</span></span>
                  {lastRun && (
                    <span className="flex items-center gap-1 tabular-nums" suppressHydrationWarning>
                      <Clock className="w-3 h-3" />
                      ran {lastRun}
                      {s.lastResultCount !== null ? ` · ${s.lastResultCount} found` : ""}
                    </span>
                  )}
                </div>
                {queries.length > 0 && (
                  <p className={cn(
                    "text-xs text-text-secondary mt-1 font-mono truncate",
                  )} title={queries.join(" · ")}>
                    {queries.slice(0, 2).join(" · ")}{queries.length > 2 ? ` +${queries.length - 2}` : ""}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <Button
                  onClick={() => handleRun(s)}
                  loading={isRunning}
                  disabled={isRunning || jobStatus === "closed"}
                  size="sm"
                >
                  {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {isRunning ? "Running..." : "Run"}
                </Button>
                <button
                  onClick={() => handleDelete(s)}
                  className="text-text-tertiary hover:text-danger p-1.5"
                  title="Delete saved search"
                  aria-label="Delete saved search"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
