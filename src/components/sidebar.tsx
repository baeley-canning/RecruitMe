"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus, Users, LayoutDashboard, Trash2, Settings, X, Eye, EyeOff, Bookmark, Shield, LogOut, FileText, Library } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";

interface Job {
  id: string;
  title: string;
  company: string | null;
  status: string;
  _count?: { candidates: number };
}

interface SidebarProps {
  jobs: Job[];
}

interface KeyStatus {
  configured: boolean;
  source: "env" | "db" | "none";
}

const KEY_LABELS: Record<string, { label: string; hint: string }> = {
  PDL_API_KEY:     { label: "People Data Labs Key", hint: "Candidate search & enrichment — 100 free calls/month" },
  SERPAPI_API_KEY: { label: "SerpAPI Key", hint: "Google LinkedIn search — 100 searches/month free" },
  BING_API_KEY:    { label: "Bing Search Key", hint: "Bing LinkedIn search" },
};

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [statuses, setStatuses] = useState<Record<string, KeyStatus>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setStatuses)
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    const payload: Record<string, string> = {};
    for (const key of Object.keys(KEY_LABELS)) {
      if (values[key]?.trim()) payload[key] = values[key].trim();
    }
    if (Object.keys(payload).length === 0) return;
    setSaving(true);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    setSaved(true);
    // Refresh statuses
    const fresh = await fetch("/api/settings").then((r) => r.json());
    setStatuses(fresh);
    setValues({});
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-white font-semibold text-sm">API Keys</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {Object.entries(KEY_LABELS).map(([key, { label, hint }]) => {
            const status = statuses[key];
            const isEnv = status?.source === "env";
            return (
              <div key={key}>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-300">{label}</label>
                  {status?.configured ? (
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded",
                      isEnv ? "bg-slate-700 text-slate-400" : "bg-green-900/50 text-green-400"
                    )}>
                      {isEnv ? "set via .env" : "configured"}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-600">not set</span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mb-1.5">{hint}</p>
                {isEnv ? (
                  <div className="text-xs text-slate-600 italic px-1">
                    Configured in .env.local — remove from there to override here
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type={show[key] ? "text" : "password"}
                      placeholder={status?.configured ? "••••••••••••• (saved — enter new to replace)" : "Paste API key…"}
                      value={values[key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 pr-9 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShow((s) => ({ ...s, [key]: !s[key] }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      {show[key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="text-sm text-slate-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || Object.values(values).every((v) => !v?.trim())}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
          >
            {saved ? "Saved" : saving ? "Saving…" : "Save Keys"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ jobs }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const [showSettings, setShowSettings] = useState(false);
  const username = session?.user?.name ?? "";
  const isOwner = (session?.user as { role?: string })?.role === "owner";

  const handleDelete = async (e: React.MouseEvent, jobId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this job and all its candidates? This cannot be undone.")) return;
    await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (pathname.startsWith(`/jobs/${jobId}`)) {
      router.push("/jobs");
    }
    router.refresh();
  };

  return (
    <>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <aside className="w-64 flex-shrink-0 bg-slate-900 flex flex-col h-screen sticky top-0">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
              <Users className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-white font-semibold text-sm leading-tight">RecruitMe</div>
              <div className="text-slate-400 text-xs">Talent Manager</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="px-3 py-3 border-b border-slate-800">
          <Link
            href="/jobs"
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              pathname === "/jobs"
                ? "bg-slate-800 text-white"
                : "text-slate-400 hover:text-white hover:bg-slate-800"
            )}
          >
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </Link>
          <Link
            href="/jobs/listing-builder"
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              pathname === "/jobs/listing-builder"
                ? "bg-slate-800 text-white"
                : "text-slate-400 hover:text-white hover:bg-slate-800"
            )}
          >
            <FileText className="w-4 h-4" />
            Listing Builder
          </Link>
          <Link
            href="/candidates"
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              pathname === "/candidates" || pathname.startsWith("/candidates/")
                ? "bg-slate-800 text-white"
                : "text-slate-400 hover:text-white hover:bg-slate-800"
            )}
          >
            <Library className="w-4 h-4" />
            Candidates Library
          </Link>
          <Link
            href="/linkedin-setup"
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              pathname === "/linkedin-setup"
                ? "bg-slate-800 text-white"
                : "text-slate-400 hover:text-white hover:bg-slate-800"
            )}
          >
            <Bookmark className="w-4 h-4" />
            LinkedIn Setup
          </Link>
        </nav>

        {/* Jobs list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Jobs
            </span>
            <Link
              href="/jobs/new"
              className="text-slate-400 hover:text-white transition-colors rounded p-0.5 hover:bg-slate-800"
              title="New job"
            >
              <Plus className="w-4 h-4" />
            </Link>
          </div>

          <div className="space-y-0.5">
            {jobs.length === 0 && (
              <p className="text-xs text-slate-500 px-3 py-2">No jobs yet</p>
            )}
            {jobs.map((job) => {
              const active =
                pathname === `/jobs/${job.id}` ||
                pathname.startsWith(`/jobs/${job.id}/`);
              return (
                <div key={job.id} className="relative group/item">
                  <Link
                    href={`/jobs/${job.id}`}
                    className={cn(
                      "flex flex-col px-3 py-2.5 pr-8 rounded-lg transition-colors group",
                      active
                        ? "bg-blue-600 text-white"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white"
                    )}
                  >
                    <span className="text-sm font-medium leading-snug line-clamp-1">
                      {job.title}
                    </span>
                    <div className="flex items-center gap-2 mt-0.5">
                      {job.company && (
                        <span
                          className={cn(
                            "text-xs line-clamp-1",
                            active ? "text-blue-100" : "text-slate-500 group-hover:text-slate-400"
                          )}
                        >
                          {job.company}
                        </span>
                      )}
                      {job._count && job._count.candidates > 0 && (
                        <span
                          className={cn(
                            "text-xs ml-auto flex-shrink-0",
                            active ? "text-blue-200" : "text-slate-600 group-hover:text-slate-400"
                          )}
                        >
                          {job._count.candidates}
                        </span>
                      )}
                    </div>
                  </Link>
                  <button
                    onClick={(e) => handleDelete(e, job.id)}
                    className={cn(
                      "absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover/item:opacity-100 transition-opacity",
                      active
                        ? "text-blue-200 hover:text-white hover:bg-blue-500"
                        : "text-slate-500 hover:text-red-400 hover:bg-slate-700"
                    )}
                    title="Delete job"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-slate-800 space-y-2">
          <div className="flex items-center gap-2">
            <Link
              href="/jobs/new"
              className="flex items-center gap-2 flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors justify-center"
            >
              <Plus className="w-4 h-4" />
              New Job
            </Link>
            <button
              onClick={() => setShowSettings(true)}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
              title="API Keys"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>

          {/* Signed-in user */}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0">
                {isOwner
                  ? <Shield className="w-3 h-3 text-blue-400" />
                  : <Users className="w-3 h-3 text-slate-400" />
                }
              </div>
              <span className="text-xs text-slate-400 truncate">{username}</span>
              {isOwner && (
                <Link
                  href="/admin"
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded font-medium transition-colors flex-shrink-0",
                    pathname === "/admin"
                      ? "bg-blue-500 text-white"
                      : "bg-slate-700 text-blue-400 hover:bg-slate-600"
                  )}
                >
                  Admin
                </Link>
              )}
            </div>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="p-1.5 text-slate-500 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors flex-shrink-0"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

export function SidebarWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      {children}
    </div>
  );
}
