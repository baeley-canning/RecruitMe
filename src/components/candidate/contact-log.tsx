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
  message: { label: "Messaged",  icon: <MessageSquare className="w-3 h-3" />, colour: "text-blue-600 bg-blue-50 border-blue-200" },
  call:    { label: "Called",    icon: <Phone className="w-3 h-3" />,          colour: "text-emerald-600 bg-emerald-50 border-emerald-200" },
  email:   { label: "Emailed",   icon: <Mail className="w-3 h-3" />,           colour: "text-violet-600 bg-violet-50 border-violet-200" },
  other:   { label: "Contacted", icon: <MoreHorizontal className="w-3 h-3" />, colour: "text-slate-600 bg-slate-50 border-slate-200" },
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
            <span className={cn("inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium", TYPE_CONFIG[latest.type]?.colour)}>
              {TYPE_CONFIG[latest.type]?.icon}
              {TYPE_CONFIG[latest.type]?.label} by {latest.userName}
              <span className="text-[10px] opacity-70 ml-0.5" suppressHydrationWarning>
                · {new Date(latest.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </span>
          ) : (
            <span className="text-[11px] text-slate-400">No contact logged yet</span>
          )}
          {events.length > 1 && (
            <span className="text-[10px] text-slate-400">+{events.length - 1} more</span>
          )}
          {flash && <span className="text-[10px] text-emerald-600 flex items-center gap-1"><Check className="w-3 h-3" />Logged</span>}
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[10px] text-blue-600 hover:text-blue-700 underline underline-offset-2 whitespace-nowrap flex items-center gap-0.5"
        >
          <Plus className="w-3 h-3" />Log contact
        </button>
      </div>

      {/* Log form */}
      {open && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-2">
          <div className="flex gap-1.5">
            {(["message","call","email","other"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  "flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors",
                  type === t ? TYPE_CONFIG[t].colour : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
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
            className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex gap-2">
            <button
              onClick={handleLog}
              disabled={saving}
              className="px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}Save
            </button>
            <button onClick={() => setOpen(false)} className="px-3 py-1 text-xs text-slate-500 border border-slate-200 rounded-md hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      )}

      {/* History list */}
      {loaded && events.length > 1 && (
        <div className="space-y-1 pl-1">
          {events.slice(1).map((e) => {
            const cfg = TYPE_CONFIG[e.type] ?? TYPE_CONFIG.other;
            return (
              <div key={e.id} className="flex items-start gap-2 text-[11px] text-slate-500">
                <span className={cn("mt-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-medium", cfg.colour)}>
                  {cfg.icon}{cfg.label}
                </span>
                <span>{e.userName}</span>
                {e.note && <span className="text-slate-400">— {e.note}</span>}
                <span className="ml-auto text-slate-300 whitespace-nowrap" suppressHydrationWarning>
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
