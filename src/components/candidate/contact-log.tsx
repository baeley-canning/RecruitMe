"use client";

import { useCallback, useEffect, useState } from "react";
import { Phone, Mail, MessageSquare, MoreHorizontal, Plus, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContactEvent {
  id: string;
  type: string;
  note: string | null;
  userName: string;
  userId: string;
  createdAt: string;
}

const TYPE_CONFIG: Record<string, { label: string; icon: React.ReactNode; colour: string }> = {
  message: { label: "Messaged",  icon: <MessageSquare className="w-3 h-3" />, colour: "text-accent bg-accent-subtle border-separator" },
  call:    { label: "Called",    icon: <Phone className="w-3 h-3" />,          colour: "text-success bg-success-subtle border-separator" },
  email:   { label: "Emailed",   icon: <Mail className="w-3 h-3" />,           colour: "text-warning bg-warning-subtle border-separator" },
  other:   { label: "Contacted", icon: <MoreHorizontal className="w-3 h-3" />, colour: "text-text-secondary bg-surface-hover border-separator" },
};

export function ContactLog({ candidateId }: { candidateId: string }) {
  const [events, setEvents]   = useState<ContactEvent[]>([]);
  const [loaded, setLoaded]   = useState(false);
  const [open, setOpen]       = useState(false);
  const [type, setType]       = useState<"message" | "call" | "email" | "other">("message");
  const [note, setNote]       = useState("");
  const [saving, setSaving]   = useState(false);
  const [flash, setFlash]     = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/candidates/${candidateId}/contacts`);
    if (res.ok) setEvents(await res.json());
    setLoaded(true);
  }, [candidateId]);

  useEffect(() => { load(); }, [load]);

  const handleLog = async () => {
    setSaving(true);
    const res = await fetch(`/api/candidates/${candidateId}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, note: note.trim() || undefined }),
    });
    if (res.ok) {
      setNote(""); setOpen(false); setFlash(true);
      setTimeout(() => setFlash(false), 2500);
      await load();
    }
    setSaving(false);
  };

  const latest = events[0];

  return (
    <div className="space-y-2">
      {/* Summary row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {latest ? (
            <span className={cn("inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded-sm border font-medium", TYPE_CONFIG[latest.type]?.colour)}>
              {TYPE_CONFIG[latest.type]?.icon}
              {TYPE_CONFIG[latest.type]?.label} by {latest.userName}
              <span className="text-2xs opacity-70 ml-0.5" suppressHydrationWarning>
                · {new Date(latest.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </span>
          ) : (
            <span className="text-xs text-text-tertiary">No contact logged yet</span>
          )}
          {events.length > 1 && (
            <span className="text-2xs text-text-tertiary">+{events.length - 1} more</span>
          )}
          {flash && <span className="text-2xs text-success flex items-center gap-1"><Check className="w-3 h-3" />Logged</span>}
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-2xs text-accent hover:text-accent-hover underline underline-offset-2 whitespace-nowrap flex items-center gap-0.5"
        >
          <Plus className="w-3 h-3" />Log contact
        </button>
      </div>

      {/* Log form */}
      {open && (
        <div className="rounded-md border border-separator bg-surface-overlay p-3 space-y-2">
          <div className="flex gap-1.5">
            {(["message","call","email","other"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  "flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-sm border transition-colors",
                  type === t ? TYPE_CONFIG[t].colour : "bg-surface-raised text-text-secondary border-separator hover:bg-surface-hover"
                )}
              >
                {TYPE_CONFIG[t].icon}{TYPE_CONFIG[t].label}
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note — e.g. left voicemail, call back Friday"
            rows={2}
            maxLength={500}
            className="w-full text-xs border border-separator rounded px-2 py-1.5 bg-surface-sunken text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus"
          />
          <div className="flex gap-2">
            <button
              onClick={handleLog}
              disabled={saving}
              className="px-3 py-1 text-xs font-medium bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 inline-flex items-center gap-1 transition-colors"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}Save
            </button>
            <button onClick={() => setOpen(false)} className="px-3 py-1 text-xs text-text-secondary border border-separator rounded hover:bg-surface-hover transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* History list */}
      {loaded && events.length > 1 && (
        <div className="space-y-1 pl-1">
          {events.slice(1).map((e) => {
            const cfg = TYPE_CONFIG[e.type] ?? TYPE_CONFIG.other;
            return (
              <div key={e.id} className="flex items-start gap-2 text-xs text-text-secondary">
                <span className={cn("mt-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm border text-2xs font-medium", cfg.colour)}>
                  {cfg.icon}{cfg.label}
                </span>
                <span>{e.userName}</span>
                {e.note && <span className="text-text-tertiary">— {e.note}</span>}
                <span className="ml-auto text-text-tertiary whitespace-nowrap" suppressHydrationWarning>
                  {new Date(e.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
