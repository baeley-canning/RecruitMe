"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Share2, Trash2, AlertCircle, Loader2 } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { confirm } from "@/components/ui/confirm-dialog";

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
    if (!await confirm({ title: "Revoke access?", message: `Revoke ${viewer}'s access to ${provider}'s library?`, danger: true, confirmLabel: "Revoke" })) return;
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
      <Link href="/admin" className="inline-flex items-center gap-1.5 text-md text-text-tertiary hover:text-text-primary transition-colors mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to admin
      </Link>
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 bg-accent-subtle rounded-md flex items-center justify-center">
            <Share2 className="w-5 h-5 text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-text-primary">Cross-org library access</h1>
        </div>
        <p className="text-text-secondary text-md ml-12 max-w-3xl">
          Grant a viewer org read access to a provider org&apos;s candidate library.
          One-way: the viewer sees the provider&apos;s candidates in their own library
          and search results, marked with a &quot;Shared from&quot; badge. Manual layer —
          billing happens externally.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-danger-subtle border border-separator rounded-md text-md text-danger">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleCreate} className="bg-surface-raised rounded-md border border-separator p-5 mb-5">
        <h2 className="text-md font-semibold text-text-primary mb-4">New grant</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="viewer" className="block text-xs font-medium text-text-secondary mb-1">Viewer org (sees the library)</label>
            <select id="viewer" value={viewerOrgId} onChange={(e) => setViewerOrgId(e.target.value)} className="w-full text-md border border-separator rounded px-3 py-2 bg-surface-sunken text-text-primary focus:outline-none focus:border-accent focus:shadow-focus transition-all">
              <option value="">— select —</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="provider" className="block text-xs font-medium text-text-secondary mb-1">Provider org (shares the library)</label>
            <select id="provider" value={providerOrgId} onChange={(e) => setProviderOrgId(e.target.value)} className="w-full text-md border border-separator rounded px-3 py-2 bg-surface-sunken text-text-primary focus:outline-none focus:border-accent focus:shadow-focus transition-all">
              <option value="">— select —</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="note" className="block text-xs font-medium text-text-secondary mb-1">Note (optional)</label>
            <input id="note" type="text" maxLength={500} placeholder="e.g. Pro tier, paid until end of FY26" value={note} onChange={(e) => setNote(e.target.value)} className="w-full text-md border border-separator rounded px-3 py-2 bg-surface-sunken text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all" />
          </div>
          <div>
            <label htmlFor="expires" className="block text-xs font-medium text-text-secondary mb-1">Expires (optional)</label>
            <input id="expires" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full text-md border border-separator rounded px-3 py-2 bg-surface-sunken text-text-primary focus:outline-none focus:border-accent focus:shadow-focus transition-all" />
          </div>
        </div>
        <button type="submit" disabled={submitting} className="mt-4 h-7 px-3 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-md font-medium rounded transition-colors">
          {submitting ? "Creating…" : "Grant access"}
        </button>
      </form>

      <div className="bg-surface-raised rounded-md border border-separator overflow-hidden">
        <div className="px-5 py-2.5 border-b border-separator bg-surface-sunken">
          <p className="text-md font-medium text-text-primary">
            {grants === null ? "Loading…" : `${grants.length} active grant${grants.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {grants !== null && grants.length === 0 && (
          <p className="text-center py-12 text-md text-text-tertiary">No grants yet. Create one above.</p>
        )}
        {grants !== null && grants.length > 0 && (
          <table className="w-full text-md">
            <thead className="text-xs text-text-secondary bg-surface-sunken">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Viewer</th>
                <th className="text-left px-4 py-2 font-medium">Provider</th>
                <th className="text-left px-4 py-2 font-medium">Note</th>
                <th className="text-left px-4 py-2 font-medium">Granted by</th>
                <th className="text-left px-4 py-2 font-medium">Expires</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {grants.map((g) => {
                const isExpired = g.expiresAt && new Date(g.expiresAt) < new Date();
                return (
                  <tr key={g.id} className={isExpired ? "opacity-50" : ""}>
                    <td className="px-4 py-3 font-medium text-text-primary">{g.viewerOrgName}</td>
                    <td className="px-4 py-3 text-text-primary">{g.providerOrgName}</td>
                    <td className="px-4 py-3 text-text-secondary text-xs">{g.note ?? "—"}</td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      {g.grantedByName} <span className="text-text-tertiary">· {new Date(g.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      {g.expiresAt ? (
                        <span className={isExpired ? "text-danger" : ""}>
                          {new Date(g.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                          {isExpired && " (expired)"}
                        </span>
                      ) : "Never"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(g.id, g.viewerOrgName, g.providerOrgName)}
                        disabled={deletingId === g.id}
                        className="text-text-tertiary hover:text-danger hover:bg-surface-hover p-2 rounded transition-colors"
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
