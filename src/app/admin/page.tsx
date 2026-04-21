"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  Users, Building2, Plus, Trash2, Loader2, Shield, User, X, Eye, EyeOff,
} from "lucide-react";

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

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);

  // User form
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", role: "user" as "user" | "owner", orgId: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Org form
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [orgForm, setOrgForm] = useState({ name: "" });
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgError, setOrgError] = useState("");
  const [deletingOrgId, setDeletingOrgId] = useState<string | null>(null);

  const isOwner = (session?.user as { role?: string })?.role === "owner";

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

  const handleDelete = async (id: string, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
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
    if (!confirm(`Delete organisation "${name}"? Users and jobs will become unassigned.`)) return;
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
        <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (!isOwner) return null;

  const currentId = (session?.user as { id?: string })?.id;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-10">

      {/* ── Users ── */}
      <div>
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-600" />
              Users
            </h1>
            <p className="text-slate-500 text-sm mt-0.5">Manage recruiter accounts.</p>
          </div>
          <button
            onClick={() => { setShowCreate(true); setCreateError(""); setForm({ username: "", password: "", role: "user", orgId: "" }); }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New User
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {users.length === 0 ? (
            <p className="text-slate-500 text-sm text-center py-10">No users yet.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">User</th>
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">Role</th>
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">Organisation</th>
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">Created</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                          {user.role === "owner"
                            ? <Shield className="w-3.5 h-3.5 text-blue-600" />
                            : <User className="w-3.5 h-3.5 text-slate-400" />
                          }
                        </div>
                        <span className="text-sm font-medium text-slate-900">{user.username}</span>
                        {user.id === currentId && (
                          <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded font-medium">you</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        user.role === "owner"
                          ? "bg-blue-50 text-blue-700 border border-blue-100"
                          : "bg-slate-100 text-slate-600"
                      }`}>
                        {user.role}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-slate-500">
                      {user.orgName ?? <span className="text-slate-300 text-xs italic">none</span>}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-400">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {user.id !== currentId && (
                        <button
                          onClick={() => handleDelete(user.id, user.username)}
                          disabled={deletingId === user.id}
                          className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                          title="Delete user"
                        >
                          {deletingId === user.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />
                          }
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Organisations ── */}
      <div>
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Building2 className="w-5 h-5 text-blue-600" />
              Organisations
            </h2>
            <p className="text-slate-500 text-sm mt-0.5">Users in an org can only see that org&apos;s jobs.</p>
          </div>
          <button
            onClick={() => { setShowCreateOrg(true); setOrgError(""); setOrgForm({ name: "" }); }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Org
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {orgs.length === 0 ? (
            <p className="text-slate-500 text-sm text-center py-10">No organisations yet.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">Name</th>
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">Users</th>
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">Jobs</th>
                  <th className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide px-5 py-3">Created</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3.5 text-sm font-medium text-slate-900">{org.name}</td>
                    <td className="px-5 py-3.5 text-sm text-slate-500">{org._count.users}</td>
                    <td className="px-5 py-3.5 text-sm text-slate-500">{org._count.jobs}</td>
                    <td className="px-5 py-3.5 text-xs text-slate-400">{new Date(org.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={() => handleDeleteOrg(org.id, org.name)}
                        disabled={deletingOrgId === org.id}
                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
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
          )}
        </div>
      </div>

      {/* ── Create User Modal ── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-sm mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900 text-sm">Create New User</h2>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Username</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="e.g. sarah"
                  autoFocus
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="Min. 6 characters"
                    className="w-full px-3.5 py-2.5 pr-10 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as "user" | "owner", orgId: "" }))}
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="user">User — standard access</option>
                  <option value="owner">Owner — can manage users</option>
                </select>
              </div>
              {form.role === "user" && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Organisation</label>
                  <select
                    value={form.orgId}
                    onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))}
                    className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="">— No organisation —</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {createError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {createError}
                </p>
              )}
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setShowCreate(false)} className="text-sm text-slate-500 hover:text-slate-700">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !form.username.trim() || !form.password}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {creating ? "Creating…" : "Create User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Create Org Modal ── */}
      {showCreateOrg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-sm mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900 text-sm">Create Organisation</h2>
              <button onClick={() => setShowCreateOrg(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateOrg} className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Name</label>
                <input
                  type="text"
                  value={orgForm.name}
                  onChange={(e) => setOrgForm({ name: e.target.value })}
                  placeholder="e.g. Auckland Office"
                  autoFocus
                  className="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              {orgError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {orgError}
                </p>
              )}
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setShowCreateOrg(false)} className="text-sm text-slate-500 hover:text-slate-700">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingOrg || !orgForm.name.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {creatingOrg && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {creatingOrg ? "Creating…" : "Create Organisation"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
