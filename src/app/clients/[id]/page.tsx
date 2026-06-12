"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Briefcase, Users, Pencil, Check, X } from "lucide-react";
import { showToast } from "@/components/ui/toast";

interface Job {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  _count: { candidates: number };
}

interface Client {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  primaryContact: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: string;
  jobs: Job[];
}

function InlineField({
  label,
  value,
  onSave,
  type = "text",
  multiline = false,
}: {
  label: string;
  value: string | null;
  onSave: (v: string | null) => Promise<void>;
  type?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onSave(draft.trim() || null);
    setSaving(false);
    setEditing(false);
  }

  function cancel() {
    setDraft(value ?? "");
    setEditing(false);
  }

  return (
    <div className="group">
      <div className="text-xs font-medium text-text-tertiary mb-1">{label}</div>
      {editing ? (
        <div className="flex items-start gap-2">
          {multiline ? (
            <textarea
              autoFocus
              rows={4}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="flex-1 border border-accent rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-surface-sunken text-text-primary placeholder:text-text-tertiary resize-none"
            />
          ) : (
            <input
              autoFocus
              type={type}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
              className="flex-1 border border-accent rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent bg-surface-sunken text-text-primary placeholder:text-text-tertiary"
            />
          )}
          <button onClick={save} disabled={saving} className="mt-0.5 text-success hover:text-success disabled:opacity-50">
            <Check className="w-4 h-4" />
          </button>
          <button onClick={cancel} className="mt-0.5 text-text-tertiary hover:text-text-secondary">
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className={`text-sm ${value ? "text-text-primary" : "text-text-tertiary italic"}`}>
            {value || "—"}
          </span>
          <button
            onClick={() => { setDraft(value ?? ""); setEditing(true); }}
            className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text-secondary"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active:   "bg-success-subtle text-success",
  closed:   "bg-surface-hover text-text-secondary",
  "on-hold": "bg-amber-100 text-amber-700",
};

export default function ClientDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clients/${params.id}`);
    if (res.ok) {
      setClient(await res.json());
    } else {
      showToast("Client not found", "error");
      router.push("/clients");
    }
    setLoading(false);
  }, [params.id, router]);

  useEffect(() => { load(); }, [load]);

  async function patch(field: string, value: string | null) {
    const res = await fetch(`/api/clients/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    if (res.ok) {
      const updated = await res.json();
      setClient(c => c ? { ...c, ...updated } : c);
    } else {
      showToast(`Failed to save ${field}`, "error");
      throw new Error("save failed");
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-tertiary text-sm">Loading…</div>;
  }

  if (!client) return null;

  const totalCandidates = client.jobs.reduce((s, j) => s + j._count.candidates, 0);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button
        onClick={() => router.push("/clients")}
        className="flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Clients
      </button>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: client details */}
        <div className="col-span-2 space-y-6">
          <div className="border border-separator rounded-xl p-5 bg-surface-raised space-y-4">
            <InlineField label="Company name" value={client.name} onSave={v => patch("name", v ?? "")} />
            <div className="grid grid-cols-2 gap-4">
              <InlineField label="Industry" value={client.industry} onSave={v => patch("industry", v)} />
              <InlineField label="Website" value={client.website} onSave={v => patch("website", v)} />
              <InlineField label="Primary contact" value={client.primaryContact} onSave={v => patch("primaryContact", v)} />
              <InlineField label="Email" value={client.email} onSave={v => patch("email", v)} type="email" />
              <InlineField label="Phone" value={client.phone} onSave={v => patch("phone", v)} />
            </div>
            <InlineField label="Notes" value={client.notes} onSave={v => patch("notes", v)} multiline />
          </div>

          {/* Jobs list */}
          <div>
            <h2 className="text-sm font-semibold text-text-secondary mb-3">Jobs</h2>
            {client.jobs.length === 0 ? (
              <p className="text-sm text-text-tertiary italic">No jobs linked to this client yet.</p>
            ) : (
              <div className="space-y-2">
                {client.jobs.map(job => (
                  <button
                    key={job.id}
                    onClick={() => router.push(`/jobs/${job.id}`)}
                    className="w-full flex items-center gap-3 border border-separator rounded-xl px-4 py-3 bg-surface-raised hover:border-accent text-left"
                  >
                    <Briefcase className="w-4 h-4 text-text-tertiary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">{job.title}</div>
                      <div className="text-xs text-text-tertiary mt-0.5">
                        {new Date(job.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="flex items-center gap-1 text-xs text-text-tertiary">
                        <Users className="w-3.5 h-3.5" />
                        {job._count.candidates}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLES[job.status] ?? "bg-surface-hover text-text-secondary"}`}>
                        {job.status}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: stats */}
        <div className="space-y-3">
          <div className="border border-separator rounded-xl p-4 bg-surface-raised">
            <div className="text-xs text-text-tertiary mb-1">Total jobs</div>
            <div className="text-2xl font-semibold text-text-primary">{client.jobs.length}</div>
          </div>
          <div className="border border-separator rounded-xl p-4 bg-surface-raised">
            <div className="text-xs text-text-tertiary mb-1">Total candidates</div>
            <div className="text-2xl font-semibold text-text-primary">{totalCandidates}</div>
          </div>
          <div className="border border-separator rounded-xl p-4 bg-surface-raised">
            <div className="text-xs text-text-tertiary mb-1">Active jobs</div>
            <div className="text-2xl font-semibold text-text-primary">{client.jobs.filter(j => j.status === "active").length}</div>
          </div>
          {client.website && (
            <a
              href={client.website}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-accent hover:underline"
            >
              <ExternalLink className="w-4 h-4" />
              Visit website
            </a>
          )}
          <div className="text-xs text-text-tertiary">
            Added {new Date(client.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
          </div>
        </div>
      </div>
    </div>
  );
}
