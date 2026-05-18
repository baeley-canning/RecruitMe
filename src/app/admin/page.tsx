"use client";

import React, { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  Users, Building2, Plus, Trash2, Loader2, Shield, User, X, Eye, EyeOff,
  BarChart3, Search, Sparkles, FileText, Camera, ArrowLeft, AlertTriangle, CheckCircle2, Activity, Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { confirm } from "@/components/ui/confirm-dialog";
import { isOwner as sessionIsOwner } from "@/lib/access";

interface UserRow {
  id: string;
  username: string;
  role: "owner" | "user";
  orgId: string | null;
  orgName: string | null;
  createdAt: string;
}

interface OrgRow {
  id: string;
  name: string;
  createdAt: string;
  _count: { users: number; jobs: number };
}

interface OrgUsage {
  orgId: string | null;
  orgName: string | null;
  search: number;
  score: number;
  score_all: number;
  parse: number;
  capture: number;
  total: number;
}

interface AnalyticsData {
  totals: { search: number; score: number; score_all: number; parse: number; capture: number; total: number };
  byOrg: OrgUsage[];
  recent: { id: string; orgName: string | null; type: string; meta: string | null; createdAt: string }[];
  days: number;
}

interface SearchQualityData {
  days: number;
  totals: {
    total: number;
    fail: number;
    warning: number;
    ok: number;
    failPct: number;
    warningPct: number;
    okPct: number;
    avgScore: number | null;
  };
  byOrg: {
    orgId: string | null;
    orgName: string;
    total: number;
    fail: number;
    warning: number;
    ok: number;
    avgScore: number | null;
  }[];
  problemJobs: {
    jobId: string;
    jobTitle: string;
    orgName: string;
    failedRuns: number;
    lastEvaluation: string | null;
    lastRunAt: string;
  }[];
}

// Shared table-header cell class — kept tight to align with Logic Pro density.
const TH = "text-left text-2xs font-semibold text-text-tertiary uppercase tracking-wider px-4 py-2";
const THR = "text-right text-2xs font-semibold text-text-tertiary uppercase tracking-wider px-4 py-2";

// Standard input recipe re-used across the inline edit and modal forms below.
const INPUT = "w-full h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all";
const SELECT = INPUT;

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [analyticsDays, setAnalyticsDays] = useState(30);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [searchQuality, setSearchQuality] = useState<SearchQualityData | null>(null);
  const [loading, setLoading] = useState(true);

  // User form
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", role: "user" as "user" | "owner", orgId: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Inline edit state
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [editForm, setEditForm]     = useState({ username: "", newPassword: "", role: "user" as "user" | "owner", orgId: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError]   = useState("");

  // Org form
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [orgForm, setOrgForm] = useState({ name: "" });
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgError, setOrgError] = useState("");
  const [deletingOrgId, setDeletingOrgId] = useState<string | null>(null);

  // System stats banner
  const [stats, setStats] = useState<{ candidates: number; jobs: number; searches7d: number } | null>(null);
  useEffect(() => {
    fetch("/api/dashboard").then(r => r.ok ? r.json() : null).then(d => {
      if (d) setStats({ candidates: d.totals.totalCandidates, jobs: d.totals.activeJobs, searches7d: d.recentSearches?.length ?? 0 });
    }).catch(() => {});
  }, []);

  // Danger zone
  const [wiping, setWiping] = useState<string | null>(null);
  const handleWipeCandidates = async (jobId?: string) => {
    const label = jobId ? "all candidates for this job" : "ALL candidates in your organisation";
    if (!await confirm({ title: "Delete candidates?", message: `Delete ${label}? This cannot be undone.`, danger: true, confirmLabel: "Delete" })) return;
    // Second confirmation for the org-wide wipe
    if (!jobId && !await confirm({ title: "Final confirmation", message: "This wipes EVERY candidate in your organisation. There is no undo.", danger: true, confirmLabel: "Wipe everything" })) return;
    setWiping(jobId ?? "all");
    if (jobId) {
      await fetch(`/api/jobs/${jobId}/candidates/wipe`, { method: "DELETE" }).catch(() => {});
    } else {
      await fetch("/api/admin/wipe-candidates", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ALL_CANDIDATES" }),
      }).catch(() => {});
    }
    setWiping(null);
    setStats(s => s ? { ...s, candidates: 0 } : s);
  };

  const isOwner = sessionIsOwner(session);

  useEffect(() => {
    if (status === "loading") return;
    if (!isOwner) { router.replace("/jobs"); return; }
    fetchAll();
  }, [status, isOwner]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchAll = async () => {
    setLoading(true);
    const [usersRes, orgsRes] = await Promise.all([
      fetch("/api/admin/users"),
      fetch("/api/admin/orgs"),
    ]);
    if (usersRes.ok) setUsers(await usersRes.json() as UserRow[]);
    if (orgsRes.ok) setOrgs(await orgsRes.json() as OrgRow[]);
    setLoading(false);
    fetchAnalytics(analyticsDays);
  };

  const fetchAnalytics = async (days: number) => {
    setAnalyticsLoading(true);
    try {
      const [usageRes, qualityRes] = await Promise.all([
        fetch(`/api/admin/analytics?days=${days}`),
        fetch(`/api/admin/search-quality?days=${days}`),
      ]);
      if (usageRes.ok) setAnalytics(await usageRes.json() as AnalyticsData);
      if (qualityRes.ok) setSearchQuality(await qualityRes.json() as SearchQualityData);
    } catch { /* network error — leave analytics at previous state */ }
    finally { setAnalyticsLoading(false); }
  };

  const handlePeriodChange = (days: number) => {
    setAnalyticsDays(days);
    fetchAnalytics(days);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      setCreateError(typeof data.error === "string" ? data.error : "Failed to create user");
    } else {
      setShowCreate(false);
      setForm({ username: "", password: "", role: "user", orgId: "" });
      await fetchAll();
    }
    setCreating(false);
  };

  const startEdit = (user: UserRow) => {
    setEditingId(user.id);
    setEditForm({ username: user.username, newPassword: "", role: user.role, orgId: user.orgId ?? "" });
    setEditError("");
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setEditSaving(true);
    setEditError("");
    const body: Record<string, unknown> = { id: editingId };
    const orig = users.find((u) => u.id === editingId);
    if (editForm.username !== orig?.username) body.username = editForm.username;
    if (editForm.newPassword.trim())          body.password = editForm.newPassword;
    if (editForm.role !== orig?.role)         body.role     = editForm.role;
    if (editForm.orgId !== (orig?.orgId ?? "")) body.orgId  = editForm.orgId || null;
    const res = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { error?: unknown };
    if (!res.ok) {
      const msg = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
      setEditError(msg);
    } else {
      setEditingId(null);
      await fetchAll();
    }
    setEditSaving(false);
  };

  const handleDelete = async (id: string, username: string) => {
    if (!await confirm({ title: "Delete user?", message: `Delete user "${username}"? This cannot be undone.`, danger: true, confirmLabel: "Delete" })) return;
    setDeletingId(id);
    await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setDeletingId(null);
    await fetchAll();
  };

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingOrg(true);
    setOrgError("");
    const res = await fetch("/api/admin/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orgForm),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      setOrgError(typeof data.error === "string" ? data.error : "Failed to create organisation");
    } else {
      setShowCreateOrg(false);
      setOrgForm({ name: "" });
      await fetchAll();
    }
    setCreatingOrg(false);
  };

  const handleDeleteOrg = async (id: string, name: string) => {
    if (!await confirm({ title: "Delete organisation?", message: `Delete organisation "${name}"? Users and jobs will become unassigned.`, danger: true, confirmLabel: "Delete" })) return;
    setDeletingOrgId(id);
    await fetch("/api/admin/orgs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setDeletingOrgId(null);
    await fetchAll();
  };

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-5 h-5 text-accent animate-spin" />
      </div>
    );
  }

  if (!isOwner) return null;

  const currentId = (session?.user as { id?: string })?.id;

  return (
    <div>
      {/* Toolbar */}
      <div className="toolbar">
        <Shield className="w-3.5 h-3.5 text-text-secondary" />
        <h1 className="text-md font-semibold text-text-primary">Admin</h1>
        <span className="text-xs text-text-tertiary">System management and monitoring</span>
        <div className="ml-auto">
          <button
            onClick={() => router.back()}
            className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />Back
          </button>
        </div>
      </div>

      <div className="p-4 max-w-5xl mx-auto space-y-6">
        {/* ── System stats ── */}
        {stats && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Active jobs",   value: stats.jobs },
              { label: "Candidates",    value: stats.candidates },
              { label: "Searches (7d)", value: stats.searches7d },
            ].map(({ label, value }) => (
              <Card key={label}>
                <CardBody>
                  <p className="text-xl font-semibold text-text-primary data-mono">{value}</p>
                  <p className="text-xs text-text-tertiary mt-0.5">{label}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        )}

        {/* ── Users ── */}
        <section>
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-text-secondary" />
                Users
              </h2>
              <p className="text-xs text-text-tertiary mt-0.5">Manage recruiter accounts.</p>
            </div>
            <Button
              onClick={() => { setShowCreate(true); setCreateError(""); setForm({ username: "", password: "", role: "user", orgId: "" }); }}
              variant="primary"
              size="md"
            >
              <Plus className="w-3.5 h-3.5" />
              New User
            </Button>
          </div>

          <Card className="overflow-hidden">
            {users.length === 0 ? (
              <p className="text-text-tertiary text-xs text-center py-8">No users yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-separator">
                      <th className={TH}>User</th>
                      <th className={TH}>Role</th>
                      <th className={TH}>Organisation</th>
                      <th className={TH}>Created</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <React.Fragment key={user.id}>
                        <tr className="border-b border-separator-subtle last:border-0 hover:bg-surface-hover transition-colors">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-full bg-surface-hover flex items-center justify-center flex-shrink-0">
                                {user.role === "owner"
                                  ? <Shield className="w-3 h-3 text-accent" />
                                  : <User className="w-3 h-3 text-text-tertiary" />
                                }
                              </div>
                              <span className="text-base font-medium text-text-primary">{user.username}</span>
                              {user.id === currentId && (
                                <span className="text-2xs px-1.5 py-0.5 bg-accent-subtle text-accent rounded-sm font-medium">you</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`text-2xs px-1.5 py-0.5 rounded-sm font-medium ${
                                user.role === "owner"
                                  ? "bg-accent-subtle text-accent"
                                  : "bg-surface-hover text-text-secondary"
                              }`}
                            >
                              {user.role}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-base text-text-secondary">
                            {user.orgName ?? <span className="text-text-tertiary text-xs italic">none</span>}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-text-tertiary data-mono" suppressHydrationWarning>
                            {new Date(user.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => editingId === user.id ? setEditingId(null) : startEdit(user)}
                                className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                                title="Edit user"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {user.id !== currentId && (
                                <button
                                  onClick={() => handleDelete(user.id, user.username)}
                                  disabled={deletingId === user.id}
                                  className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-danger hover:bg-danger-subtle transition-colors disabled:opacity-50"
                                  title="Delete user"
                                >
                                  {deletingId === user.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Trash2 className="w-3.5 h-3.5" />
                                  }
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {editingId === user.id && (
                          <tr className="bg-surface-sunken border-t border-separator">
                            <td colSpan={6} className="px-4 py-3">
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="text-xs font-medium text-text-secondary mb-1 block">Username</label>
                                  <input
                                    type="text"
                                    value={editForm.username}
                                    onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))}
                                    className={INPUT}
                                  />
                                </div>
                                <div>
                                  <label className="text-xs font-medium text-text-secondary mb-1 block">
                                    New password <span className="font-normal text-text-tertiary">(leave blank to keep current)</span>
                                  </label>
                                  <input
                                    type="password"
                                    value={editForm.newPassword}
                                    onChange={(e) => setEditForm((f) => ({ ...f, newPassword: e.target.value }))}
                                    placeholder="Enter new password…"
                                    className={INPUT}
                                  />
                                </div>
                                <div>
                                  <label className="text-xs font-medium text-text-secondary mb-1 block">Role</label>
                                  <select
                                    value={editForm.role}
                                    onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value as "user" | "owner" }))}
                                    className={SELECT}
                                  >
                                    <option value="user">user</option>
                                    <option value="owner">owner</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="text-xs font-medium text-text-secondary mb-1 block">Organisation</label>
                                  <select
                                    value={editForm.orgId}
                                    onChange={(e) => setEditForm((f) => ({ ...f, orgId: e.target.value }))}
                                    className={SELECT}
                                  >
                                    <option value="">None</option>
                                    {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                                  </select>
                                </div>
                              </div>
                              {editError && <p className="text-xs text-danger mt-2">{editError}</p>}
                              <div className="flex items-center gap-2 mt-3">
                                <Button onClick={handleSaveEdit} disabled={editSaving} loading={editSaving} variant="primary" size="md">
                                  Save changes
                                </Button>
                                <Button onClick={() => setEditingId(null)} variant="secondary" size="md">
                                  Cancel
                                </Button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>

        {/* ── Organisations ── */}
        <section>
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
                <Building2 className="w-3.5 h-3.5 text-text-secondary" />
                Organisations
              </h2>
              <p className="text-xs text-text-tertiary mt-0.5">Users in an org can only see that org&apos;s jobs.</p>
            </div>
            <Button
              onClick={() => { setShowCreateOrg(true); setOrgError(""); setOrgForm({ name: "" }); }}
              variant="primary"
              size="md"
            >
              <Plus className="w-3.5 h-3.5" />
              New Org
            </Button>
          </div>

          <Card className="overflow-hidden">
            {orgs.length === 0 ? (
              <p className="text-text-tertiary text-xs text-center py-8">No organisations yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-separator">
                      <th className={TH}>Name</th>
                      <th className={TH}>Users</th>
                      <th className={TH}>Jobs</th>
                      <th className={TH}>Created</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {orgs.map((org) => (
                      <tr key={org.id} className="border-b border-separator-subtle last:border-0 hover:bg-surface-hover transition-colors">
                        <td className="px-4 py-2.5 text-base font-medium text-text-primary">{org.name}</td>
                        <td className="px-4 py-2.5 text-base text-text-secondary data-mono">{org._count.users}</td>
                        <td className="px-4 py-2.5 text-base text-text-secondary data-mono">{org._count.jobs}</td>
                        <td className="px-4 py-2.5 text-xs text-text-tertiary data-mono" suppressHydrationWarning>
                          {new Date(org.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => handleDeleteOrg(org.id, org.name)}
                            disabled={deletingOrgId === org.id}
                            className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-danger hover:bg-danger-subtle transition-colors disabled:opacity-50"
                            title="Delete organisation"
                          >
                            {deletingOrgId === org.id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Trash2 className="w-3.5 h-3.5" />
                            }
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>

        {/* ── Create User Modal ── */}
        <Modal open={showCreate} onClose={() => setShowCreate(false)} labelledBy="create-user-title" className="bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-sm flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
            <h2 id="create-user-title" className="font-semibold text-text-primary text-md">Create New User</h2>
            <button onClick={() => setShowCreate(false)} className="text-text-tertiary hover:text-text-primary">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <form onSubmit={handleCreate} className="p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Username</label>
              <input
                type="text"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="e.g. sarah"
                autoFocus
                className={INPUT}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Min. 8 characters"
                  className={`${INPUT} pr-8`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-xs text-text-tertiary mt-1">At least 8 characters including one number or special character.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as "user" | "owner", orgId: "" }))}
                className={SELECT}
              >
                <option value="user">User — standard access</option>
                <option value="owner">Owner — can manage users</option>
              </select>
            </div>
            {form.role === "user" && (
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Organisation</label>
                <select
                  value={form.orgId}
                  onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))}
                  className={SELECT}
                >
                  <option value="">— No organisation —</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
            )}
            {createError && (
              <p className="text-xs text-danger bg-danger-subtle border border-separator rounded px-2.5 py-1.5">
                {createError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="lg" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={creating || !form.username.trim() || !form.password}
                loading={creating}
                variant="primary"
                size="lg"
              >
                {creating ? "Creating…" : "Create User"}
              </Button>
            </div>
          </form>
        </Modal>

        {/* ── Create Org Modal ── */}
        <Modal open={showCreateOrg} onClose={() => setShowCreateOrg(false)} labelledBy="create-org-title" className="bg-surface-overlay text-text-primary rounded-xl shadow-overlay w-full max-w-sm flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
            <h2 id="create-org-title" className="font-semibold text-text-primary text-md">Create Organisation</h2>
            <button onClick={() => setShowCreateOrg(false)} className="text-text-tertiary hover:text-text-primary">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <form onSubmit={handleCreateOrg} className="p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Name</label>
              <input
                type="text"
                value={orgForm.name}
                onChange={(e) => setOrgForm({ name: e.target.value })}
                placeholder="e.g. Auckland Office"
                autoFocus
                className={INPUT}
              />
            </div>
            {orgError && (
              <p className="text-xs text-danger bg-danger-subtle border border-separator rounded px-2.5 py-1.5">
                {orgError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="lg" onClick={() => setShowCreateOrg(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={creatingOrg || !orgForm.name.trim()}
                loading={creatingOrg}
                variant="primary"
                size="lg"
              >
                {creatingOrg ? "Creating…" : "Create Organisation"}
              </Button>
            </div>
          </form>
        </Modal>

        {/* ── Analytics ── */}
        <section>
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
                <BarChart3 className="w-3.5 h-3.5 text-text-secondary" />
                Usage Analytics
              </h2>
              <p className="text-xs text-text-tertiary mt-0.5">AI calls, searches, and captures across all orgs.</p>
            </div>
            <div className="flex items-center gap-1 bg-surface-sunken border border-separator rounded p-0.5">
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  onClick={() => handlePeriodChange(d)}
                  className={`h-6 px-2 text-xs font-medium rounded-sm transition-colors ${
                    analyticsDays === d
                      ? "bg-surface-hover text-text-primary"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {analyticsLoading && !analytics ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
            </div>
          ) : analytics ? (
            <div className="space-y-4">
              {/* Stat cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Searches",  value: analytics.totals.search,                                  icon: Search },
                  { label: "Scores",    value: analytics.totals.score + analytics.totals.score_all,     icon: Sparkles },
                  { label: "JD Parses", value: analytics.totals.parse,                                   icon: FileText },
                  { label: "Captures",  value: analytics.totals.capture,                                 icon: Camera },
                ].map(({ label, value, icon: Icon }) => (
                  <Card key={label}>
                    <CardBody>
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="w-7 h-7 rounded bg-surface-hover flex items-center justify-center">
                          <Icon className="w-3.5 h-3.5 text-text-secondary" />
                        </div>
                        <span className="text-xs font-medium text-text-secondary">{label}</span>
                      </div>
                      <p className="text-xl font-semibold text-text-primary data-mono">{value.toLocaleString()}</p>
                      <p className="text-xs text-text-tertiary mt-0.5">last {analyticsDays} days</p>
                    </CardBody>
                  </Card>
                ))}
              </div>

              {/* Per-org breakdown */}
              {analytics.byOrg.length > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader>
                    <h3 className="text-md font-semibold text-text-primary">By Organisation</h3>
                  </CardHeader>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-separator">
                          <th className={TH}>Org</th>
                          <th className={THR}>Searches</th>
                          <th className={THR}>Scores</th>
                          <th className={THR}>Parses</th>
                          <th className={THR}>Captures</th>
                          <th className={THR}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.byOrg.map((row) => (
                          <tr key={row.orgId ?? "__owner__"} className="border-b border-separator-subtle last:border-0 hover:bg-surface-hover">
                            <td className="px-4 py-2.5 text-base font-medium text-text-primary">{row.orgName}</td>
                            <td className="px-4 py-2.5 text-base text-right data-mono text-text-secondary">{row.search || "—"}</td>
                            <td className="px-4 py-2.5 text-base text-right data-mono text-text-secondary">{(row.score + row.score_all) || "—"}</td>
                            <td className="px-4 py-2.5 text-base text-right data-mono text-text-secondary">{row.parse || "—"}</td>
                            <td className="px-4 py-2.5 text-base text-right data-mono text-text-secondary">{row.capture || "—"}</td>
                            <td className="px-4 py-2.5 text-base text-right data-mono font-semibold text-text-primary">{row.total}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              {/* Recent activity */}
              {analytics.recent.length > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader>
                    <h3 className="text-md font-semibold text-text-primary">Recent Activity</h3>
                  </CardHeader>
                  <div className="divide-y divide-separator-subtle">
                    {analytics.recent.slice(0, 20).map((e) => {
                      const meta = e.meta ? (() => { try { return JSON.parse(e.meta); } catch { return null; } })() : null;
                      const label = {
                        search: "Search",
                        score: "Re-score",
                        score_all: "Score all",
                        parse: "JD parse",
                        capture: "Capture",
                      }[e.type] ?? e.type;
                      const detail = meta?.jobId ? ` · job ${meta.jobId.slice(-6)}` : meta?.scored != null ? ` · ${meta.scored} scored` : "";
                      return (
                        <div key={e.id} className="flex items-center justify-between px-4 py-2">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-medium text-text-secondary w-16">{label}</span>
                            <span className="text-xs text-text-tertiary">{e.orgName}{detail}</span>
                          </div>
                          <span className="text-xs text-text-tertiary data-mono" suppressHydrationWarning>
                            {new Date(e.createdAt).toLocaleString()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              {analytics.totals.total === 0 && (
                <p className="text-center text-text-tertiary text-xs py-8">No activity in the last {analyticsDays} days.</p>
              )}
            </div>
          ) : null}
        </section>

        {/* ── Search quality ── */}
        {searchQuality && searchQuality.totals.total > 0 && (
          <section>
            <div className="mb-3">
              <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-success" />
                Search Quality
              </h2>
              <p className="text-xs text-text-tertiary mt-0.5">
                How searches across all orgs are evaluating — helps spot misconfigured roles before recruiters complain.
              </p>
            </div>

            <div className="space-y-4">
              {/* Top-level stat tiles */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Total runs", value: searchQuality.totals.total.toLocaleString(),                              icon: Search,        tone: "text-text-secondary" },
                  { label: "OK",         value: `${searchQuality.totals.ok} (${searchQuality.totals.okPct}%)`,            icon: CheckCircle2,  tone: "text-success" },
                  { label: "Warnings",   value: `${searchQuality.totals.warning} (${searchQuality.totals.warningPct}%)`,  icon: AlertTriangle, tone: "text-warning" },
                  { label: "Failures",   value: `${searchQuality.totals.fail} (${searchQuality.totals.failPct}%)`,        icon: AlertTriangle, tone: "text-danger" },
                ].map(({ label, value, icon: Icon, tone }) => (
                  <Card key={label}>
                    <CardBody>
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="w-7 h-7 rounded bg-surface-hover flex items-center justify-center">
                          <Icon className={`w-3.5 h-3.5 ${tone}`} />
                        </div>
                        <span className="text-xs font-medium text-text-secondary">{label}</span>
                      </div>
                      <p className="text-xl font-semibold text-text-primary data-mono">{value}</p>
                    </CardBody>
                  </Card>
                ))}
              </div>

              {/* Avg score and explanatory text */}
              <Card>
                <CardBody className="flex items-center justify-between">
                  <span className="text-base text-text-secondary">Average match score across all completed search runs</span>
                  <span className="text-xl font-semibold text-text-primary data-mono">
                    {searchQuality.totals.avgScore !== null ? `${searchQuality.totals.avgScore}%` : "—"}
                  </span>
                </CardBody>
              </Card>

              {/* Per-org rollup */}
              {searchQuality.byOrg.length > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader>
                    <h3 className="text-md font-semibold text-text-primary">By Org</h3>
                  </CardHeader>
                  <table className="w-full">
                    <thead className="bg-surface-sunken">
                      <tr>
                        <th className={TH}>Org</th>
                        <th className={THR}>Runs</th>
                        <th className={THR}>OK</th>
                        <th className={THR}>Warn</th>
                        <th className={THR}>Fail</th>
                        <th className={THR}>Avg score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchQuality.byOrg.map((row, i) => (
                        <tr key={`${row.orgId ?? "owner"}-${i}`} className="border-t border-separator-subtle">
                          <td className="px-4 py-2.5 text-base text-text-primary">{row.orgName}</td>
                          <td className="px-4 py-2.5 text-base text-right data-mono text-text-secondary">{row.total}</td>
                          <td className="px-4 py-2.5 text-base text-right data-mono text-success">{row.ok || "—"}</td>
                          <td className="px-4 py-2.5 text-base text-right data-mono text-warning">{row.warning || "—"}</td>
                          <td className="px-4 py-2.5 text-base text-right data-mono text-danger">{row.fail || "—"}</td>
                          <td className="px-4 py-2.5 text-base text-right data-mono text-text-secondary">{row.avgScore !== null ? `${row.avgScore}%` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}

              {/* Problem jobs */}
              {searchQuality.problemJobs.length > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader className="flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-danger" />
                    <h3 className="text-md font-semibold text-text-primary">Jobs with repeated FAIL evaluations</h3>
                  </CardHeader>
                  <div className="divide-y divide-separator-subtle">
                    {searchQuality.problemJobs.map((j) => (
                      <div key={j.jobId} className="px-4 py-2.5 flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-medium text-text-primary truncate">{j.jobTitle}</p>
                          <p className="text-xs text-text-tertiary">
                            {j.orgName} · {j.failedRuns} failed run{j.failedRuns !== 1 ? "s" : ""}
                          </p>
                          {j.lastEvaluation && (
                            <p className="text-xs text-danger mt-0.5 line-clamp-2">{j.lastEvaluation}</p>
                          )}
                        </div>
                        <span className="text-xs text-text-tertiary data-mono whitespace-nowrap" suppressHydrationWarning>
                          {new Date(j.lastRunAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          </section>
        )}

        {/* ── Danger zone ── */}
        <section>
          <h2 className="text-md font-semibold text-text-primary flex items-center gap-2 mb-1">
            <AlertTriangle className="w-3.5 h-3.5 text-danger" />
            Danger zone
          </h2>
          <p className="text-xs text-text-tertiary mb-2">Destructive actions. These cannot be undone.</p>
          <div className="rounded-md border border-danger/30 bg-danger-subtle">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-base font-medium text-text-primary">Delete all candidates</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  Removes every candidate across all jobs. Jobs and parsed roles are kept.
                </p>
              </div>
              <button
                onClick={() => handleWipeCandidates()}
                disabled={wiping === "all"}
                className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-danger hover:bg-danger-hover text-white text-md font-medium transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {wiping === "all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {wiping === "all" ? "Deleting…" : "Delete all candidates"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
