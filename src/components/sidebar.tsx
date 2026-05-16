"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus, Users, LayoutDashboard, Trash2, Settings, X, Eye, EyeOff, Bookmark, Shield, LogOut, FileText, Library, ClipboardList, Github, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { Modal } from "./ui/modal";
import { confirm } from "./ui/confirm-dialog";

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
    <Modal
      open
      onClose={onClose}
      labelledBy="settings-modal-title"
      className="bg-surface-overlay border border-separator rounded-xl w-full max-w-md mx-4 shadow-overlay"
    >
        <div className="flex items-center justify-between px-5 py-3 border-b border-separator">
          <h2 id="settings-modal-title" className="text-text-primary font-semibold text-md">API Keys</h2>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            aria-label="Close"
          >
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
                  <label className="text-xs font-medium text-text-secondary">{label}</label>
                  {status?.configured ? (
                    <span className={cn(
                      "inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium",
                      isEnv
                        ? "bg-surface-hover text-text-tertiary"
                        : "bg-success-subtle text-success"
                    )}>
                      {isEnv ? "set via .env" : "configured"}
                    </span>
                  ) : (
                    <span className="text-xs text-text-tertiary">not set</span>
                  )}
                </div>
                <p className="text-xs text-text-tertiary mb-1.5">{hint}</p>
                {isEnv ? (
                  <div className="text-xs text-text-tertiary italic px-1">
                    Configured in .env.local — remove from there to override here
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type={show[key] ? "text" : "password"}
                      placeholder={status?.configured ? "••••••••••••• (saved — enter new to replace)" : "Paste API key…"}
                      value={values[key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                      className="w-full h-7 px-2.5 pr-9 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShow((s) => ({ ...s, [key]: !s[key] }))}
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
                      aria-label={show[key] ? "Hide key" : "Show key"}
                    >
                      {show[key] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-separator flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 px-3 rounded bg-surface-hover hover:bg-[#3a3a3c] text-text-primary text-md border border-separator transition-colors"
          >
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={saving || Object.values(values).every((v) => !v?.trim())}
            className="h-8 px-3 rounded bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-md font-medium transition-colors"
          >
            {saved ? "Saved" : saving ? "Saving…" : "Save Keys"}
          </button>
        </div>
    </Modal>
  );
}

// Centralised list of primary nav items — used for both mobile drawer and desktop rail.
const NAV_ITEMS: ReadonlyArray<{
  href: string;
  icon: typeof LayoutDashboard;
  label: string;
  match: (p: string) => boolean;
}> = [
  { href: "/dashboard",           icon: LayoutDashboard,    label: "Dashboard",          match: (p) => p === "/dashboard" },
  { href: "/jobs/listing-builder",icon: FileText,           label: "Listing Builder",    match: (p) => p === "/jobs/listing-builder" },
  { href: "/candidates",          icon: Library,            label: "Candidates Library", match: (p) => p === "/candidates" || p.startsWith("/candidates/") },
  { href: "/candidate-profiles",  icon: ClipboardList,      label: "Candidate Profiles", match: (p) => p === "/candidate-profiles" },
  { href: "/github-search",       icon: Github,             label: "GitHub Search",      match: (p) => p.startsWith("/github-search") },
  { href: "/linkedin-setup",      icon: Bookmark,           label: "LinkedIn Setup",     match: (p) => p === "/linkedin-setup" },
];

export function Sidebar({ jobs }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const [showSettings, setShowSettings] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const username = session?.user?.name ?? "";
  const isOwner = (session?.user as { role?: string })?.role === "owner";

  // Close mobile drawer whenever the route changes
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const handleDelete = async (e: React.MouseEvent, jobId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!await confirm({ title: "Delete job?", message: "Delete this job and all its candidates? This cannot be undone.", danger: true, confirmLabel: "Delete" })) return;
    await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (pathname.startsWith(`/jobs/${jobId}`)) {
      router.push("/jobs");
    }
    router.refresh();
  };

  return (
    <>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* ── Mobile top bar ── */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-12 items-center justify-between border-b border-separator bg-surface-raised px-3 md:hidden">
        <Link href="/dashboard" className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 bg-accent rounded flex items-center justify-center flex-shrink-0">
            <Users className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-text-primary font-semibold text-base">RecruitMe</div>
            <div className="text-text-tertiary text-2xs uppercase tracking-wider">Talent Manager</div>
          </div>
        </Link>
        <div className="flex items-center gap-1.5">
          <Link
            href="/jobs/new"
            className="h-7 px-3 rounded bg-accent hover:bg-accent-hover text-white text-md font-medium transition-colors inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            New Job
          </Link>
          <button
            onClick={() => setMobileOpen(true)}
            className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Mobile slide-out drawer ── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setMobileOpen(false)}>
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60" />
          {/* Drawer panel */}
          <div
            className="absolute inset-y-0 left-0 w-60 max-w-[85vw] bg-surface-raised border-r border-separator flex flex-col shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 bg-accent rounded flex items-center justify-center">
                  <Users className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="leading-tight">
                  <div className="text-text-primary font-semibold text-base">RecruitMe</div>
                  <div className="text-text-tertiary text-2xs uppercase tracking-wider">Talent Manager</div>
                </div>
              </div>
              <button
                onClick={() => setMobileOpen(false)}
                className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* New Job button */}
            <div className="px-2 pt-2">
              <Link
                href="/jobs/new"
                className="h-7 w-full rounded bg-surface-hover hover:bg-[#3a3a3c] text-text-primary text-md font-medium border border-separator transition-colors inline-flex items-center justify-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                New Job
              </Link>
            </div>

            {/* Drawer nav */}
            <div className="sidebar-section">Navigation</div>
            <nav className="px-2 pb-2 space-y-0.5">
              {NAV_ITEMS.map(({ href, icon: Icon, label, match }) => {
                const active = match(pathname ?? "");
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      "flex items-center gap-2 h-7 px-3 rounded-md text-base transition-colors",
                      active
                        ? "bg-accent-subtle text-accent"
                        : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                    )}
                  >
                    <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                    {label}
                  </Link>
                );
              })}
              {isOwner && (
                <Link
                  href="/admin"
                  className={cn(
                    "flex items-center gap-2 h-7 px-3 rounded-md text-base transition-colors",
                    pathname === "/admin"
                      ? "bg-accent-subtle text-accent"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                  )}
                >
                  <Shield className="w-3.5 h-3.5 flex-shrink-0" />
                  Admin
                </Link>
              )}
            </nav>

            {/* Jobs list */}
            <div className="flex items-center justify-between sidebar-section">
              <span>Jobs</span>
              <Link
                href="/jobs/new"
                className="h-5 w-5 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
                aria-label="New job"
              >
                <Plus className="w-3 h-3" />
              </Link>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
              {jobs.length === 0 && (
                <p className="text-xs text-text-tertiary px-3 py-1.5">No jobs yet</p>
              )}
              {jobs.map((job) => {
                const active = pathname === `/jobs/${job.id}` || pathname?.startsWith(`/jobs/${job.id}/`);
                return (
                  <Link
                    key={job.id}
                    href={`/jobs/${job.id}`}
                    className={cn(
                      "flex flex-col px-3 py-1.5 rounded-md transition-colors",
                      active
                        ? "bg-accent-subtle text-accent"
                        : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base font-medium leading-snug line-clamp-1 flex-1">{job.title}</span>
                      {job._count && job._count.candidates > 0 && (
                        <span className="data-mono text-text-tertiary text-xs ml-auto">
                          {job._count.candidates}
                        </span>
                      )}
                    </div>
                    {job.company && (
                      <span className="text-xs mt-0.5 line-clamp-1 text-text-tertiary">
                        {job.company}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>

            {/* Footer */}
            <div className="px-3 py-2 border-t border-separator flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-6 h-6 rounded-full bg-surface-hover flex items-center justify-center flex-shrink-0">
                  {isOwner ? <Shield className="w-3 h-3 text-accent" /> : <Users className="w-3 h-3 text-text-tertiary" />}
                </div>
                <span className="text-xs text-text-secondary truncate">{username}</span>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => { setMobileOpen(false); setShowSettings(true); }}
                  className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  title="API Keys"
                  aria-label="API Keys"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Desktop sidebar ── */}
      <aside className="hidden md:flex flex-col h-screen sticky top-0 w-60 flex-shrink-0 bg-surface-raised border-r border-separator">
        {/* Logo */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-separator">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 bg-accent rounded flex items-center justify-center flex-shrink-0">
              <Users className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="leading-tight min-w-0">
              <div className="text-text-primary font-semibold text-base">RecruitMe</div>
              <div className="text-text-tertiary text-2xs uppercase tracking-wider">Talent Manager</div>
            </div>
          </div>
          <Link
            href="/jobs/new"
            className="h-7 px-2.5 rounded bg-surface-hover hover:bg-[#3a3a3c] text-text-primary text-xs font-medium border border-separator transition-colors inline-flex items-center gap-1"
            title="New job"
          >
            <Plus className="w-3 h-3" />
            New
          </Link>
        </div>

        {/* Primary nav */}
        <div className="sidebar-section">Workspace</div>
        <nav className="px-2 pb-2 space-y-0.5">
          {NAV_ITEMS.map(({ href, icon: Icon, label, match }) => {
            const active = match(pathname ?? "");
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2 h-7 px-3 rounded-md text-base transition-colors",
                  active
                    ? "bg-accent-subtle text-accent"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                )}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Jobs list */}
        <div className="flex items-center justify-between sidebar-section">
          <span>Jobs</span>
          <Link
            href="/jobs/new"
            className="h-5 w-5 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
            title="New job"
            aria-label="New job"
          >
            <Plus className="w-3 h-3" />
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          {jobs.length === 0 && (
            <p className="text-xs text-text-tertiary px-3 py-1.5">No jobs yet</p>
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
                    "flex flex-col px-3 py-1.5 pr-7 rounded-md transition-colors",
                    active
                      ? "bg-accent-subtle text-accent"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base font-medium leading-snug line-clamp-1 flex-1">
                      {job.title}
                    </span>
                    {job._count && job._count.candidates > 0 && (
                      <span className="data-mono text-text-tertiary text-xs ml-auto flex-shrink-0">
                        {job._count.candidates}
                      </span>
                    )}
                  </div>
                  {job.company && (
                    <span className="text-xs mt-0.5 line-clamp-1 text-text-tertiary">
                      {job.company}
                    </span>
                  )}
                </Link>
                <button
                  onClick={(e) => handleDelete(e, job.id)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 rounded flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-surface-hover opacity-0 group-hover/item:opacity-100 transition-opacity"
                  title="Delete job"
                  aria-label="Delete job"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer: New Job button + user row */}
        <div className="px-2 py-2 border-t border-separator space-y-2">
          <Link
            href="/jobs/new"
            className="h-7 w-full rounded bg-surface-hover hover:bg-[#3a3a3c] text-text-primary text-md font-medium border border-separator transition-colors inline-flex items-center justify-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            New Job
          </Link>

          <div className="flex items-center justify-between gap-1 px-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-full bg-surface-hover flex items-center justify-center flex-shrink-0">
                {isOwner
                  ? <Shield className="w-3 h-3 text-accent" />
                  : <Users className="w-3 h-3 text-text-tertiary" />
                }
              </div>
              <span className="text-xs text-text-secondary truncate">{username}</span>
              {isOwner && (
                <Link
                  href="/admin"
                  className={cn(
                    "inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium uppercase tracking-wider flex-shrink-0 transition-colors",
                    pathname === "/admin"
                      ? "bg-accent text-white"
                      : "bg-accent-subtle text-accent hover:bg-accent/25"
                  )}
                >
                  Admin
                </Link>
              )}
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={() => setShowSettings(true)}
                className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                title="API Keys"
                aria-label="API Keys"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="h-7 w-7 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

export function SidebarWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface-base pt-12 md:pt-0">
      {children}
    </div>
  );
}
