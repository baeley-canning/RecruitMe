"use client";

import { useState, useCallback } from "react";
import {
  Github, Search, MapPin, Loader2, ExternalLink, Star,
  Plus, CheckCircle2, AlertCircle, Code2, Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GitHubUser } from "@/lib/github-search";
import { githubUserToProfileText } from "@/lib/github-search";

const LANGUAGE_OPTIONS = [
  "C++", "C", "Rust", "Python", "JavaScript", "TypeScript", "Go",
  "Java", "C#", "Ruby", "PHP", "Kotlin", "Swift", "Scala",
  "SQL", "Shell", "PowerShell",
];

const LANG_COLOURS: Record<string, string> = {
  "C++":        "bg-pink-100 text-pink-700 border-pink-200",
  "C":          "bg-slate-100 text-slate-700 border-slate-200",
  "Rust":       "bg-orange-100 text-orange-700 border-orange-200",
  "Python":     "bg-blue-100 text-blue-700 border-blue-200",
  "JavaScript": "bg-yellow-100 text-yellow-800 border-yellow-200",
  "TypeScript": "bg-blue-100 text-blue-700 border-blue-200",
  "Go":         "bg-cyan-100 text-cyan-700 border-cyan-200",
  "Java":       "bg-red-100 text-red-700 border-red-200",
  "C#":         "bg-violet-100 text-violet-700 border-violet-200",
};

function langClass(lang: string) {
  return LANG_COLOURS[lang] ?? "bg-slate-100 text-slate-600 border-slate-200";
}

interface Job { id: string; title: string; company: string | null; }
interface ImportState { jobId: string; status: "loading" | "done" | "exists" | "error"; }

export default function GitHubSearchPage() {
  const [location, setLocation]   = useState("New Zealand");
  const [languages, setLanguages] = useState<string[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [results, setResults]     = useState<GitHubUser[]>([]);
  const [total, setTotal]         = useState<number | null>(null);
  const [rateRemaining, setRateRemaining] = useState<number | null>(null);

  const [jobs, setJobs]           = useState<Job[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [imports, setImports]     = useState<Record<string, ImportState>>({}); // key = login+jobId
  const [expandedLogin, setExpandedLogin] = useState<string | null>(null);

  const toggleLang = (lang: string) =>
    setLanguages((prev) => prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang]);

  const handleSearch = async () => {
    setLoading(true);
    setError("");
    setResults([]);
    setTotal(null);
    try {
      const params = new URLSearchParams({ location, max: "25" });
      if (languages.length) params.set("languages", languages.join(","));
      const res = await fetch(`/api/github/search?${params}`);
      const data = await res.json() as { users?: GitHubUser[]; total?: number; rateLimitRemaining?: number | null; error?: string };
      if (!res.ok) { setError(data.error ?? "Search failed"); return; }
      setResults(data.users ?? []);
      setTotal(data.total ?? null);
      setRateRemaining(data.rateLimitRemaining ?? null);
    } catch {
      setError("Network error — check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const loadJobs = useCallback(async () => {
    if (jobsLoaded) return;
    const res = await fetch("/api/jobs?status=active");
    if (res.ok) {
      const data = await res.json() as Job[];
      setJobs(data);
      setJobsLoaded(true);
    }
  }, [jobsLoaded]);

  const handleImport = async (user: GitHubUser, jobId: string) => {
    const key = `${user.login}:${jobId}`;
    setImports((prev) => ({ ...prev, [key]: { jobId, status: "loading" } }));
    try {
      const profileText = githubUserToProfileText(user);
      const res = await fetch("/api/github/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          login:       user.login,
          name:        user.name ?? user.login,
          headline:    user.bio?.slice(0, 200) ?? null,
          location:    user.location,
          githubUrl:   user.githubUrl,
          linkedinUrl: user.linkedinUrl ?? null,
          profileText,
        }),
      });
      const data = await res.json() as { alreadyExists?: boolean; error?: string };
      if (res.status === 409) {
        setImports((prev) => ({ ...prev, [key]: { jobId, status: "exists" } }));
      } else if (!res.ok) {
        setImports((prev) => ({ ...prev, [key]: { jobId, status: "error" } }));
      } else {
        setImports((prev) => ({ ...prev, [key]: { jobId, status: "done" } }));
      }
    } catch {
      setImports((prev) => ({ ...prev, [key]: { jobId, status: "error" } }));
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Github className="w-5 h-5 text-slate-700" />
          <h1 className="text-xl font-bold text-slate-900">GitHub Developer Search</h1>
        </div>
        <p className="text-sm text-slate-500">
          Find developers by location and language. GitHub profiles prove what they actually build — higher signal than LinkedIn snippets for technical roles.
          <span className="ml-1 text-slate-400">
            {rateRemaining !== null && `· ${rateRemaining} API requests remaining`}
          </span>
        </p>
      </div>

      {/* Search bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-5 space-y-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Location</label>
            <div className="relative">
              <MapPin className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="e.g. Wellington, New Zealand"
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex items-end">
            <Button onClick={handleSearch} loading={loading} disabled={loading || !location.trim()} size="lg">
              <Search className="w-4 h-4" />
              {loading ? "Searching…" : "Search"}
            </Button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-2">Filter by language (optional — pick one or more)</label>
          <div className="flex flex-wrap gap-1.5">
            {LANGUAGE_OPTIONS.map((lang) => (
              <button
                key={lang}
                onClick={() => toggleLang(lang)}
                className={cn(
                  "text-xs px-2.5 py-1 rounded-md border font-medium transition-colors",
                  languages.includes(lang)
                    ? langClass(lang) + " ring-1 ring-current"
                    : "bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300"
                )}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          {error.includes("GITHUB_TOKEN") && (
            <span className="ml-1 font-medium">Add GITHUB_TOKEN to your Railway env vars.</span>
          )}
        </div>
      )}

      {/* Results */}
      {total !== null && (
        <p className="text-xs text-slate-400 mb-3">
          {total.toLocaleString()} developers found on GitHub · showing top {results.length}
        </p>
      )}

      <div className="space-y-3">
        {results.map((user) => {
          const expanded = expandedLogin === user.login;
          return (
            <div key={user.login} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="flex items-start gap-4 p-4">
                {/* Avatar */}
                <img
                  src={user.avatarUrl}
                  alt={user.login}
                  className="w-10 h-10 rounded-full border border-slate-200 flex-shrink-0"
                />

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900 text-sm">{user.name ?? user.login}</span>
                        <a
                          href={user.githubUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-slate-400 hover:text-blue-600 flex items-center gap-0.5"
                        >
                          @{user.login} <ExternalLink className="w-3 h-3" />
                        </a>
                        {user.linkedinUrl && (
                          <a
                            href={user.linkedinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-blue-600 hover:text-blue-700 flex items-center gap-0.5"
                          >
                            LinkedIn <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      {user.bio && <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{user.bio}</p>}
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400 flex-wrap">
                        {user.company  && <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{user.company}</span>}
                        {user.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{user.location}</span>}
                        <span className="flex items-center gap-1"><Code2 className="w-3 h-3" />{user.publicRepos} repos</span>
                        <span>{user.followers} followers</span>
                      </div>
                      {/* Language chips */}
                      {user.languages.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {user.languages.map((l) => (
                            <span key={l} className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", langClass(l))}>{l}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Add to job */}
                    <div className="flex-shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setExpandedLogin(expanded ? null : user.login); loadJobs(); }}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add to job
                      </Button>
                    </div>
                  </div>

                  {/* Repos when expanded */}
                  {expanded && user.topRepos.length > 0 && (
                    <div className="mt-3 grid sm:grid-cols-2 gap-2">
                      {user.topRepos.map((r) => (
                        <div key={r.name} className="text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5">
                          <span className="font-medium text-slate-700">{r.name}</span>
                          {r.language && <span className="ml-1.5 text-slate-400">· {r.language}</span>}
                          {r.stars > 0 && <span className="ml-1.5 text-amber-600">★ {r.stars}</span>}
                          {r.description && <p className="text-slate-500 mt-0.5 line-clamp-1">{r.description}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Job picker panel */}
              {expanded && (
                <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3">
                  <p className="text-xs font-medium text-slate-600 mb-2">Add to which job?</p>
                  {jobs.length === 0 ? (
                    <p className="text-xs text-slate-400">No active jobs found.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {jobs.map((job) => {
                        const key = `${user.login}:${job.id}`;
                        const imp = imports[key];
                        return (
                          <button
                            key={job.id}
                            onClick={() => !imp && handleImport(user, job.id)}
                            disabled={Boolean(imp)}
                            className={cn(
                              "text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors inline-flex items-center gap-1.5",
                              imp?.status === "done"   ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                              imp?.status === "exists" ? "bg-slate-100 text-slate-500 border-slate-200" :
                              imp?.status === "error"  ? "bg-red-50 text-red-600 border-red-200" :
                              imp?.status === "loading"? "bg-slate-100 text-slate-500 border-slate-200" :
                              "bg-white text-slate-700 border-slate-300 hover:border-blue-400 hover:text-blue-700"
                            )}
                          >
                            {imp?.status === "loading" && <Loader2 className="w-3 h-3 animate-spin" />}
                            {imp?.status === "done"    && <CheckCircle2 className="w-3 h-3" />}
                            {imp?.status === "exists"  && <CheckCircle2 className="w-3 h-3" />}
                            {imp?.status === "error"   && <AlertCircle className="w-3 h-3" />}
                            <span className="truncate max-w-[160px]">{job.title}{job.company ? ` · ${job.company}` : ""}</span>
                            {imp?.status === "done"    && <span className="text-[10px]">Added</span>}
                            {imp?.status === "exists"  && <span className="text-[10px]">Already in</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!loading && results.length === 0 && total === null && (
        <div className="text-center py-16 text-slate-400">
          <Github className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Enter a location and click Search to find developers.</p>
          <p className="text-xs mt-1">
            {process.env.NEXT_PUBLIC_GITHUB_TOKEN_SET === "1"
              ? "GitHub API authenticated — 5000 requests/hour."
              : "Add GITHUB_TOKEN to Railway for higher rate limits."}
          </p>
        </div>
      )}
    </div>
  );
}
