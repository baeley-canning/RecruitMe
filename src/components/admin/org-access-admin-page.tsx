"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Share2, Trash2, AlertCircle, Loader2 } from "lucide-react";
import { showToast } from "@/components/ui/toast";

interface Grant {
  id: string;
  viewerOrgId: string;
  viewerOrgName: string;
  providerOrgId: string;
  providerOrgName: string;
  scope: string;
  note: string | null;
  grantedByName: string;
  createdAt: string;
  expiresAt: string | null;
}

interface Org {
  id: string;
  name: string;
}

export function OrgAccessAdminPage() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Form state
  const [viewerOrgId, setViewerOrgId] = useState("");
  const [providerOrgId, setProviderOrgId] = useState("");
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const load = useCallback(async () => {
    try {
      const [grantsRes, orgsRes] = await Promise.all([
        fetch("/api/admin/org-access", { credentials: "include" }),
        fetch("/api/admin/orgs", { credentials: "include" }),
      ]);
      if (!grantsRes.ok) throw new Error(`Grants HTTP ${grantsRes.status}`);
      if (!orgsRes.ok)   throw new Error(`Orgs HTTP ${orgsRes.status}`);
      setGrants(await grantsRes.json());
      setOrgs(await orgsRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!viewerOrgId || !providerOrgId) {
      showToast("Pick both a viewer and a provider org", "error");
      return;
    }
    if (viewerOrgId === providerOrgId) {
      showToast("Viewer and provider must be different orgs", "error");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/org-access", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          viewerOrgId, providerOrgId,
          note: note.trim() || undefined,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        showToast(body.error || `Create failed (${res.status})`, "error");
        return;
      }
      showToast("Grant created");
      setViewerOrgId(""); setProviderOrgId(""); setNote(""); setExpiresAt("");
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string, viewer: string, provider: string) => {
    if (!confirm(`Revoke ${viewer}'s access to ${provider}'s library?`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/org-access/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        showToast(`Revoke failed (${res.status})`, "error");
        return;
      }
      setGrants((prev) => prev?.filter((g) => g.id !== id) ?? null);
      showToast("Grant revoked");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link href="/admin" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-700 transition-colors mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to admin
      </Link>
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 bg-violet-50 rounded-lg flex items-center justify-center">
            <Share2 className="w-5 h-5 text-violet-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Cross-org library access</h1>
        </div>
        <p className="text-slate-500 text-sm ml-12 max-w-3xl">
          Grant a viewer org read access to a provider org&apos;s candidate library.
          One-way: the viewer sees the provider&apos;s candidates in their own library
          and search results, marked with a &quot;Shared from&quot; badge. Manual layer —
          billing happens externally.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleCreate} className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="text-sm font-semibold text-slate-900 mb-4">New grant</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="viewer" className="block text-xs font-medium text-slate-600 mb-1">Viewer org (sees the library)</label>
            <select id="viewer" value={viewerOrgId} onChange={(e) => setViewerOrgId(e.target.value)} className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2">
              <option value="">— select —</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="provider" className="block text-xs font-medium text-slate-600 mb-1">Provider org (shares the library)</label>
            <select id="provider" value={providerOrgId} onChange={(e) => setProviderOrgId(e.target.value)} className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2">
              <option value="">— select —</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="note" className="block text-xs font-medium text-slate-600 mb-1">Note (optional)</label>
            <input id="note" type="text" maxLength={500} placeholder="e.g. Pro tier, paid until end of FY26" value={note} onChange={(e) => setNote(e.target.value)} className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label htmlFor="expires" className="block text-xs font-medium text-slate-600 mb-1">Expires (optional)</label>
            <input id="expires" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2" />
          </div>
        </div>
        <button type="submit" disabled={submitting} className="mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
          {submitting ? "Creating…" : "Grant access"}
        </button>
      </form>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
          <p className="text-sm font-medium text-slate-700">
            {grants === null ? "Loading…" : `${grants.length} active grant${grants.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {grants !== null && grants.length === 0 && (
          <p className="text-center py-12 text-sm text-slate-400">No grants yet. Create one above.</p>
        )}
        {grants !== null && grants.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 bg-slate-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Viewer</th>
                <th className="text-left px-4 py-2 font-medium">Provider</th>
                <th className="text-left px-4 py-2 font-medium">Note</th>
                <th className="text-left px-4 py-2 font-medium">Granted by</th>
                <th className="text-left px-4 py-2 font-medium">Expires</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {grants.map((g) => {
                const isExpired = g.expiresAt && new Date(g.expiresAt) < new Date();
                return (
                  <tr key={g.id} className={isExpired ? "opacity-50" : ""}>
                    <td className="px-4 py-3 font-medium text-slate-800">{g.viewerOrgName}</td>
                    <td className="px-4 py-3 text-slate-700">{g.providerOrgName}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{g.note ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {g.grantedByName} <span className="text-slate-400">· {new Date(g.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {g.expiresAt ? (
                        <span className={isExpired ? "text-red-600" : ""}>
                          {new Date(g.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                          {isExpired && " (expired)"}
                        </span>
                      ) : "Never"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(g.id, g.viewerOrgName, g.providerOrgName)}
                        disabled={deletingId === g.id}
                        className="text-slate-300 hover:text-red-600 hover:bg-red-50 p-2 rounded-md transition-colors"
                        aria-label={`Revoke grant from ${g.viewerOrgName} to ${g.providerOrgName}`}
                      >
                        {deletingId === g.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
