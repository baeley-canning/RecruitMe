"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, Building2, ExternalLink, Pencil, Trash2, ChevronRight } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { confirm } from "@/components/ui/confirm-dialog";

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
  _count: { jobs: number };
}

function ClientForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Partial<Client>;
  onSave: (data: Omit<Client, "id" | "createdAt" | "_count">) => Promise<void>;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    industry: initial?.industry ?? "",
    website: initial?.website ?? "",
    primaryContact: initial?.primaryContact ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
    notes: initial?.notes ?? "",
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        name: form.name,
        industry: form.industry || null,
        website: form.website || null,
        primaryContact: form.primaryContact || null,
        email: form.email || null,
        phone: form.phone || null,
        notes: form.notes || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-500 mb-1">Company name *</label>
          <input
            required
            value={form.name}
            onChange={e => set("name", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Industry</label>
          <input
            value={form.industry}
            onChange={e => set("industry", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Website</label>
          <input
            value={form.website}
            onChange={e => set("website", e.target.value)}
            placeholder="https://"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Primary contact</label>
          <input
            value={form.primaryContact}
            onChange={e => set("primaryContact", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Email</label>
          <input
            type="email"
            value={form.email}
            onChange={e => set("email", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Phone</label>
          <input
            value={form.phone}
            onChange={e => set("phone", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
          <textarea
            rows={3}
            value={form.notes}
            onChange={e => set("notes", e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export default function ClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/clients");
    if (res.ok) setClients(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(data: Omit<Client, "id" | "createdAt" | "_count">) {
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      showToast("Client added", "success");
      setCreating(false);
      await load();
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(body.error?.message ?? "Failed to create client", "error");
    }
  }

  async function handleEdit(id: string, data: Omit<Client, "id" | "createdAt" | "_count">) {
    const res = await fetch(`/api/clients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      showToast("Client saved", "success");
      setEditingId(null);
      await load();
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(body.error?.message ?? "Failed to save client", "error");
    }
  }

  async function handleDelete(id: string, name: string) {
    const ok = await confirm({
      title: "Delete client?",
      message: `Delete "${name}"? Jobs linked to this client will be unlinked but not deleted.`,
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;

    const res = await fetch(`/api/clients/${id}`, { method: "DELETE" });
    if (res.ok) {
      showToast("Client deleted", "success");
      setClients(c => c.filter(x => x.id !== id));
    } else {
      showToast("Failed to delete client", "error");
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500 mt-1">{clients.length} client{clients.length !== 1 ? "s" : ""}</p>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            Add client
          </button>
        )}
      </div>

      {creating && (
        <div className="border border-blue-200 rounded-xl p-5 mb-4 bg-blue-50/40">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">New client</h2>
          <ClientForm onSave={handleCreate} onCancel={() => setCreating(false)} />
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
      ) : clients.length === 0 && !creating ? (
        <div className="text-center py-16 text-gray-400">
          <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No clients yet — add your first one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {clients.map(client => (
            <div key={client.id} className="border border-gray-200 rounded-xl bg-white overflow-hidden">
              {editingId === client.id ? (
                <div className="p-5">
                  <h2 className="text-sm font-semibold text-gray-800 mb-4">Edit client</h2>
                  <ClientForm
                    initial={client}
                    onSave={data => handleEdit(client.id, data)}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <button
                      onClick={() => router.push(`/clients/${client.id}`)}
                      className="text-sm font-semibold text-gray-900 hover:text-blue-600 text-left"
                    >
                      {client.name}
                    </button>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
                      {client.industry && <span>{client.industry}</span>}
                      {client.primaryContact && <span>{client.primaryContact}</span>}
                      {client.email && <span>{client.email}</span>}
                      {client.phone && <span>{client.phone}</span>}
                      {client.website && (
                        <a
                          href={client.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-0.5 hover:text-blue-600"
                          onClick={e => e.stopPropagation()}
                        >
                          <ExternalLink className="w-3 h-3" />
                          Website
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-gray-400">{client._count.jobs} job{client._count.jobs !== 1 ? "s" : ""}</span>
                    <button onClick={() => setEditingId(client.id)} className="text-gray-400 hover:text-gray-700">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(client.id, client.name)} className="text-gray-400 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => router.push(`/clients/${client.id}`)} className="text-gray-400 hover:text-gray-700">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
