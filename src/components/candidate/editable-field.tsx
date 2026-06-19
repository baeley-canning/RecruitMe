"use client";

import { useState } from "react";
import { Pencil, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/ui/toast";

/**
 * Inline-editable Profile-details field. Matches DetailField's markup (label +
 * value row), but adds a hover pencil to edit → input with save/cancel that
 * PATCHes /api/candidates/[id] with `{ [field]: value }` (empty string clears).
 * The parent owns the candidate state and reflects the save via `onSaved`.
 * Read-only display uses `renderValue` (link/badge) when a value is present.
 */
export function EditableField({
  candidateId,
  field,
  value,
  label,
  emptyLabel = "Not set",
  type = "text",
  placeholder,
  validate,
  renderValue,
  onSaved,
}: {
  candidateId: string;
  field: string;
  value: string | null;
  label: string;
  emptyLabel?: string;
  type?: string;
  placeholder?: string;
  /** Return an error string to block the save, or null when ok. */
  validate?: (v: string) => string | null;
  /** How to render a present value in read mode (e.g. a link/badge). */
  renderValue?: (v: string) => React.ReactNode;
  onSaved: (value: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const v = draft.trim();
    if (v && validate) {
      const e = validate(v);
      if (e) { setErr(e); return; }
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: v }), // "" clears it server-side
      });
      if (res.ok) {
        onSaved(v || null);
        setEditing(false);
        showToast(`${label} ${v ? "updated" : "cleared"}`, "success");
      } else {
        const b = (await res.json().catch(() => ({}))) as { error?: unknown };
        setErr(typeof b.error === "string" ? b.error : `Couldn't save (${res.status})`);
      }
    } catch {
      setErr("Couldn't save — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setEditing(false);
    setDraft(value ?? "");
    setErr(null);
  }

  return (
    <div className="py-2 border-b border-separator last:border-0 group">
      <p className="text-2xs text-text-tertiary uppercase tracking-wide mb-1">{label}</p>
      {editing ? (
        <div>
          <div className="flex items-center gap-1">
            <input
              type={type}
              value={draft}
              placeholder={placeholder}
              autoFocus
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void save(); }
                if (e.key === "Escape") cancel();
              }}
              className="flex-1 min-w-0 h-7 px-2 text-sm rounded border border-separator bg-surface-sunken text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
            />
            <button type="button" onClick={() => void save()} disabled={busy} title="Save" aria-label="Save"
              className="h-7 w-7 shrink-0 rounded flex items-center justify-center text-text-tertiary hover:text-success hover:bg-surface-hover disabled:opacity-40">
              <Check className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={cancel} disabled={busy} title="Cancel" aria-label="Cancel"
              className="h-7 w-7 shrink-0 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover disabled:opacity-40">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {err && <p className="text-2xs text-danger mt-1">{err}</p>}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <div className={cn("text-sm min-w-0 break-words", value ? "text-text-primary" : "text-text-tertiary italic")}>
            {value ? (renderValue ? renderValue(value) : value) : emptyLabel}
          </div>
          <button type="button" onClick={() => { setDraft(value ?? ""); setEditing(true); }}
            title={value ? `Edit ${label}` : `Add ${label}`} aria-label={value ? `Edit ${label}` : `Add ${label}`}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity h-6 w-6 shrink-0 rounded flex items-center justify-center text-text-tertiary hover:text-accent hover:bg-surface-hover">
            <Pencil className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}
