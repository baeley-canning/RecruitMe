"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { confirm } from "@/components/ui/confirm-dialog";
import { TagChip } from "@/components/candidate/tag-chip";
import { TAG_PRESET_COLORS, type TagWithCount } from "@/lib/tags";

export function TagManager() {
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState<string>(TAG_PRESET_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editColor, setEditColor] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/candidates/tags", { cache: "no-store" });
    if (res.ok) setTags(await res.json());
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    const label = newLabel.trim();
    if (!label) return;
    const res = await fetch("/api/candidates/tags", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, color: newColor }),
    });
    if (res.ok) { setNewLabel(""); showToast("Tag created", "success"); void load(); }
    else { const b = await res.json().catch(() => ({})); showToast(typeof b.error === "string" ? b.error : "Couldn't create tag", "error"); }
  }

  async function saveEdit(id: string) {
    const res = await fetch(`/api/candidates/tags/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: editLabel.trim(), color: editColor }),
    });
    if (res.ok) { setEditingId(null); void load(); }
    else { const b = await res.json().catch(() => ({})); showToast(typeof b.error === "string" ? b.error : "Couldn't save", "error"); }
  }

  async function remove(t: TagWithCount) {
    const ok = await confirm({
      title: "Delete tag?",
      message: `Delete "${t.label}"? It will be removed from ${t._count.assignments} candidate${t._count.assignments === 1 ? "" : "s"}.`,
      danger: true, confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await fetch(`/api/candidates/tags/${t.id}`, { method: "DELETE" });
    if (res.ok) { showToast("Tag deleted", "success"); void load(); }
    else showToast("Couldn't delete tag", "error");
  }

  const Swatches = ({ value, onPick }: { value: string; onPick: (c: string) => void }) => (
    <div className="flex items-center gap-1">
      {TAG_PRESET_COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onPick(c)}
          className={`w-5 h-5 rounded-full border-2 ${value.toLowerCase() === c.toLowerCase() ? "border-text-primary" : "border-transparent"}`}
          style={{ backgroundColor: c }} aria-label={`Colour ${c}`} />
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Create */}
      <div className="border border-separator rounded-xl p-4 bg-surface-raised space-y-3">
        <p className="text-sm font-medium text-text-primary">New tag</p>
        <div className="flex items-center gap-2">
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={50}
            onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
            placeholder="Tag name" className="flex-1 h-8 px-3 text-sm rounded-lg border border-separator bg-surface-sunken text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent" />
          <button onClick={() => void create()} disabled={!newLabel.trim()}
            className="inline-flex items-center gap-1 px-3 h-8 text-sm bg-accent text-text-inverse rounded-lg hover:bg-accent-hover disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
        <div className="flex items-center gap-3">
          <Swatches value={newColor} onPick={setNewColor} />
          {newLabel.trim() && <TagChip tag={{ id: "preview", label: newLabel.trim(), color: newColor }} />}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <p className="text-sm text-text-tertiary text-center py-6">Loading…</p>
      ) : tags.length === 0 ? (
        <p className="text-sm text-text-tertiary text-center py-6">No tags yet — create your first above.</p>
      ) : (
        <div className="space-y-1.5">
          {tags.map((t) => (
            <div key={t.id} className="group flex items-center gap-3 border border-separator rounded-lg px-3 py-2 bg-surface-raised">
              {editingId === t.id ? (
                <>
                  <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} maxLength={50} autoFocus
                    className="flex-1 h-7 px-2 text-sm rounded border border-accent bg-surface-sunken text-text-primary focus:outline-none" />
                  <Swatches value={editColor} onPick={setEditColor} />
                  <button onClick={() => void saveEdit(t.id)} className="text-success" aria-label="Save"><Check className="w-4 h-4" /></button>
                  <button onClick={() => setEditingId(null)} className="text-text-tertiary hover:text-text-secondary" aria-label="Cancel"><X className="w-4 h-4" /></button>
                </>
              ) : (
                <>
                  <TagChip tag={t} />
                  <span className="flex-1 text-xs text-text-tertiary">used on {t._count.assignments} candidate{t._count.assignments === 1 ? "" : "s"}</span>
                  <button onClick={() => { setEditingId(t.id); setEditLabel(t.label); setEditColor(t.color); }}
                    className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text-secondary" aria-label="Edit tag"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => void remove(t)}
                    className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-danger" aria-label="Delete tag"><Trash2 className="w-3.5 h-3.5" /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
