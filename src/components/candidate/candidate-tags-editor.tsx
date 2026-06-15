"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { TagChip } from "./tag-chip";
import type { TagDto } from "@/lib/tags";

/**
 * Inline tag editor for the candidate drawer / detail page. Loads the org's
 * tags, shows the candidate's current tags as removable chips, and a "+ Add"
 * picker (with inline create). Assignment uses PUT /api/candidates/[id]/tags
 * with the FULL new tagIds array (replace-set semantics).
 */
export function CandidateTagsEditor({
  candidateId,
  initialTags,
  onChange,
}: {
  candidateId: string;
  initialTags: TagDto[];
  onChange?: (tags: TagDto[]) => void;
}) {
  const [tags, setTags] = useState<TagDto[]>(initialTags);
  const [allTags, setAllTags] = useState<TagDto[]>([]);
  const [picking, setPicking] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    const res = await fetch("/api/candidates/tags", { cache: "no-store" });
    if (res.ok) setAllTags(await res.json());
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const persist = useCallback(async (next: TagDto[]) => {
    setSaving(true);
    const prev = tags;
    setTags(next);
    onChange?.(next);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagIds: next.map((t) => t.id) }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setTags(prev); onChange?.(prev);
      showToast("Failed to update tags", "error");
    } finally {
      setSaving(false);
    }
  }, [candidateId, tags, onChange]);

  const remove = (id: string) => void persist(tags.filter((t) => t.id !== id));
  const add = (tag: TagDto) => {
    if (tags.some((t) => t.id === tag.id)) return;
    void persist([...tags, tag]);
    setPicking(false);
  };

  async function createAndAdd() {
    const label = newLabel.trim();
    if (!label) return;
    const res = await fetch("/api/candidates/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (res.ok) {
      const tag = (await res.json()) as TagDto;
      setAllTags((a) => [...a, tag]);
      setNewLabel("");
      add(tag);
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(typeof body.error === "string" ? body.error : "Couldn't create tag", "error");
    }
  }

  const available = allTags.filter((t) => !tags.some((x) => x.id === t.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <TagChip key={t.id} tag={t} onRemove={saving ? undefined : () => remove(t.id)} />
      ))}

      <div className="relative">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-2xs border border-separator text-text-tertiary hover:text-text-secondary hover:border-accent transition-colors"
        >
          <Plus className="w-2.5 h-2.5" /> Tag
        </button>

        {picking && (
          <div className="absolute z-20 mt-1 w-52 max-h-64 overflow-auto rounded-lg border border-separator bg-surface-overlay shadow-xl p-2 space-y-1">
            {available.length === 0 && (
              <p className="text-2xs text-text-tertiary px-1 py-0.5">No more tags — create one below.</p>
            )}
            {available.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => add(t)}
                className="w-full text-left px-1 py-0.5 rounded hover:bg-surface-hover"
              >
                <TagChip tag={t} />
              </button>
            ))}
            <div className="flex items-center gap-1 pt-1 border-t border-separator">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void createAndAdd(); }}
                placeholder="New tag…"
                maxLength={50}
                className="flex-1 min-w-0 h-6 px-2 text-2xs rounded border border-separator bg-surface-sunken text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
              />
              <button type="button" onClick={() => void createAndAdd()} disabled={!newLabel.trim()} className="text-2xs text-accent disabled:opacity-40 px-1">Add</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
