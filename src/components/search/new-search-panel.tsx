"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseBooleanQuery } from "@/lib/boolean-query";
import { NZ_LOCATIONS } from "@/lib/nz-locations";
import { Button } from "@/components/ui/button";

type Source = "library" | "linkedin" | "seek";

const SOURCE_META: Array<{ key: Source; label: string; hint: string }> = [
  { key: "library", label: "Library", hint: "Your saved candidates (instant)" },
  { key: "linkedin", label: "LinkedIn", hint: "Live scrape via the box" },
  { key: "seek", label: "SEEK", hint: "Live scrape via the box" },
];

export function NewSearchPanel() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [sources, setSources] = useState<Set<Source>>(new Set<Source>(["library", "linkedin", "seek"]));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live parse for inline syntax feedback.
  const parseErrors = useMemo(() => {
    if (!query.trim()) return [];
    const p = parseBooleanQuery(query);
    return p.hasErrors ? p.errors : [];
  }, [query]);

  const toggle = (s: Source) =>
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const canSubmit = !submitting && query.trim().length > 0 && sources.size > 0;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), location: location.trim() || null, sources: [...sources] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(typeof body?.error === "string" ? body.error : `Search failed (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as { runId: string };
      router.push(`/search/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-surface-raised border border-separator rounded-md p-5">
      <label className="block text-xs text-text-tertiary uppercase tracking-wide mb-2">Boolean query</label>
      <div className="relative">
        <Search className="absolute left-3 top-3.5 w-4 h-4 text-text-tertiary" />
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          rows={2}
          placeholder={`(java OR python) AND senior NOT junior  "machine learning"`}
          className="w-full pl-9 pr-3 py-3 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all resize-none"
        />
      </div>
      {parseErrors.length > 0 && (
        <p className="text-xs text-warning mt-1.5">Query issue{parseErrors.length === 1 ? "" : "s"}: {parseErrors.join("; ")}</p>
      )}

      <div className="flex flex-wrap items-center gap-3 mt-4">
        <label htmlFor="search-location" className="sr-only">Location</label>
        <select
          id="search-location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="h-9 px-3 rounded bg-surface-sunken border border-separator text-md text-text-primary focus:outline-none focus:border-accent transition-all flex-1 min-w-[200px]"
        >
          {NZ_LOCATIONS.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <span className="text-xs text-text-tertiary uppercase tracking-wide mr-1">Sources:</span>
        {SOURCE_META.map(({ key, label, hint }) => {
          const on = sources.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              title={hint}
              className={cn(
                "inline-flex items-center h-8 px-3 rounded-sm text-sm font-medium border transition-colors",
                on
                  ? "bg-accent text-text-inverse border-accent"
                  : "bg-surface-raised text-text-secondary border-separator hover:bg-surface-hover",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error && <p className="text-sm text-danger mt-3">{error}</p>}

      <div className="flex items-center gap-3 mt-5">
        <Button type="submit" variant="primary" size="md" disabled={!canSubmit}>
          {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          {submitting ? "Starting…" : "Search"}
        </Button>
        <span className="text-xs text-text-tertiary">⌘/Ctrl+Enter to run · the search keeps running if you leave this page</span>
      </div>
    </form>
  );
}
