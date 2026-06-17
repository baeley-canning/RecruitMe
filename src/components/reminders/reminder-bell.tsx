"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Bell, Plus, Check, Clock, Trash2 } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { confirm } from "@/components/ui/confirm-dialog";
import { REMINDER_TYPE_LABEL, type ReminderDto, type ReminderType } from "@/lib/tags";

function dueLabel(due: string): { text: string; overdue: boolean } {
  const ms = new Date(due).getTime() - Date.now();
  const overdue = ms < 0;
  const days = Math.round(Math.abs(ms) / 86400000);
  if (overdue) return { text: days === 0 ? "due today" : `${days}d overdue`, overdue: true };
  return { text: days === 0 ? "due today" : `in ${days}d`, overdue: false };
}

/**
 * Reminders bell + popover. Shows reminders that are due/overdue (badge count),
 * lists them with complete/snooze/delete, and an inline create form. Mounted in
 * the sidebar, gated on the reminders flag by the caller. 60s poll.
 */
export function ReminderBell() {
  const [items, setItems] = useState<ReminderDto[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [type, setType] = useState<ReminderType>("follow_up");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  // Profile-Update Alerts (Stage D): a separate COUNT of unseen profile updates,
  // shown as an extra line. Fed by /api/watches/feed?count=1 — NOT Reminder rows.
  // That endpoint 404s when FEATURES_PROFILE_WATCH_ENABLED is off, so the line
  // stays inert (count 0, no link) when the feature ships dark.
  const [profileUpdates, setProfileUpdates] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/reminders", { cache: "no-store" });
    if (res.ok) setItems(await res.json());
  }, []);

  const loadProfileUpdates = useCallback(async () => {
    // 404 (flag off) or any error → treat as zero; the line stays hidden.
    const res = await fetch("/api/watches/feed?count=1", { cache: "no-store" }).catch(() => null);
    if (res && res.ok) {
      const b = (await res.json().catch(() => ({}))) as { unseen?: number };
      setProfileUpdates(typeof b.unseen === "number" ? b.unseen : 0);
    } else {
      setProfileUpdates(0);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadProfileUpdates();
    const t = setInterval(() => { void load(); void loadProfileUpdates(); }, 60_000);
    return () => clearInterval(t);
  }, [load, loadProfileUpdates]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const dueCount = items.filter((r) => new Date(r.dueAt).getTime() <= Date.now()).length;
  // Badge folds in unseen profile updates so a recruiter notices them without
  // opening the popover; the popover separates the two (reminders vs updates).
  const badgeCount = dueCount + profileUpdates;

  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/reminders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) void load(); else showToast("Couldn't update reminder", "error");
  };
  const complete = (id: string) => void patch(id, { dismissed: true });
  const snooze = (r: ReminderDto) => void patch(r.id, { dueAt: new Date(Date.now() + 86400000).toISOString() });
  const del = async (id: string) => {
    if (!(await confirm({ title: "Delete reminder?", message: "This can't be undone.", danger: true, confirmLabel: "Delete" }))) return;
    const res = await fetch(`/api/reminders/${id}`, { method: "DELETE" });
    if (res.ok) void load(); else showToast("Couldn't delete", "error");
  };

  async function create() {
    if (!dueAt) { showToast("Pick a due date", "info"); return; }
    const res = await fetch("/api/reminders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, dueAt: new Date(dueAt).toISOString(), note: note.trim() || null }),
    });
    if (res.ok) { setCreating(false); setNote(""); setDueAt(""); showToast("Reminder set", "success"); void load(); }
    else { const b = await res.json().catch(() => ({})); showToast(typeof b.error === "string" ? b.error : "Couldn't create", "error"); }
  }

  const sorted = [...items].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="relative h-7 w-7 rounded flex items-center justify-center hover:bg-surface-hover text-text-secondary" aria-label="Reminders" title="Reminders">
        <Bell className="w-4 h-4" />
        {badgeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-danger text-white text-[9px] leading-[14px] text-center font-semibold">{badgeCount}</span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-9 left-0 z-50 w-80 max-w-[calc(100vw-1.5rem)] max-h-[28rem] overflow-auto rounded-lg border border-separator bg-surface-overlay shadow-2xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-separator sticky top-0 bg-surface-overlay">
            <span className="text-sm font-semibold text-text-primary">Reminders</span>
            <button onClick={() => setCreating((v) => !v)} className="text-xs text-accent inline-flex items-center gap-0.5"><Plus className="w-3 h-3" /> New</button>
          </div>

          {profileUpdates > 0 && (
            <a href="/pulse" className="block px-3 py-2 border-b border-separator text-xs text-accent hover:bg-surface-hover">
              {profileUpdates} new profile {profileUpdates === 1 ? "update" : "updates"} →
            </a>
          )}

          {creating && (
            <div className="p-3 space-y-2 border-b border-separator">
              <select value={type} onChange={(e) => setType(e.target.value as ReminderType)} className="w-full h-8 px-2 text-xs rounded border border-separator bg-surface-sunken text-text-primary">
                {(Object.keys(REMINDER_TYPE_LABEL) as ReminderType[]).map((t) => <option key={t} value={t}>{REMINDER_TYPE_LABEL[t]}</option>)}
              </select>
              <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="w-full h-8 px-2 text-xs rounded border border-separator bg-surface-sunken text-text-primary" />
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} placeholder="Note (optional)" className="w-full px-2 py-1 text-xs rounded border border-separator bg-surface-sunken text-text-primary placeholder:text-text-tertiary resize-none" />
              <button onClick={() => void create()} className="w-full h-7 text-xs bg-accent text-white rounded hover:bg-accent-hover">Set reminder</button>
            </div>
          )}

          {sorted.length === 0 ? (
            <p className="text-xs text-text-tertiary text-center py-6">Nothing due. You&apos;re clear.</p>
          ) : (
            <div className="divide-y divide-separator">
              {sorted.map((r) => {
                const d = dueLabel(r.dueAt);
                return (
                  <div key={r.id} className="px-3 py-2 flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-text-primary">{REMINDER_TYPE_LABEL[r.type]}</div>
                      {r.note && <div className="text-2xs text-text-secondary mt-0.5 break-words">{r.note}</div>}
                      <div className={`text-2xs mt-0.5 ${d.overdue ? "text-danger" : "text-text-tertiary"}`}>{d.text}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => complete(r.id)} className="text-text-tertiary hover:text-success" title="Complete" aria-label="Complete"><Check className="w-3.5 h-3.5" /></button>
                      <button onClick={() => snooze(r)} className="text-text-tertiary hover:text-accent" title="Snooze 1 day" aria-label="Snooze"><Clock className="w-3.5 h-3.5" /></button>
                      <button onClick={() => del(r.id)} className="text-text-tertiary hover:text-danger" title="Delete" aria-label="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
