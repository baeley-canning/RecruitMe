"use client";

import { useState, useCallback } from "react";
import {
  Github, Search, MapPin, Loader2, ExternalLink,
  Plus, CheckCircle2, AlertCircle, Code2, Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { NZLocationInput } from "@/components/ui/nz-location-input";
import { cn } from "@/lib/utils";
import type { GitHubUser } from "@/lib/github-search";
import { githubUserToProfileText } from "@/lib/github-search";

const LANGUAGE_GROUPS: Array<{ label: string; languages: string[] }> = [
  {
    label: "Web",
    languages: [
      "JavaScript", "TypeScript", "PHP", "Ruby", "Python", "HTML", "CSS",
      "Vue", "Svelte", "Astro", "Hack",
    ],
  },
  {
    label: "Backend",
    languages: [
      "Java", "C#", "Go", "Kotlin", "Scala", "Elixir", "Erlang",
      "Clojure", "F#", "Groovy", "Dart",
    ],
  },
  {
    label: "Systems",
    languages: [
      "C++", "C", "Rust", "Objective-C", "Swift", "Zig", "Nim", "D",
    ],
  },
  {
    label: "Data",
    languages: [
      "SQL", "R", "Julia", "MATLAB", "Jupyter Notebook", "SAS", "Stata",
    ],
  },
  {
    label: "DevOps",
    languages: [
      "Shell", "PowerShell", "HCL", "Dockerfile", "Makefile", "Nix", "Puppet",
    ],
  },
  {
    label: "Enterprise",
    languages: [
      "Apex", "Visual Basic .NET", "VBA", "Delphi", "COBOL", "PLSQL", "TSQL",
    ],
  },
  {
    label: "Mobile/Game",
    languages: [
      "Swift", "Kotlin", "Dart", "C#", "GDScript", "Lua",
    ],
  },
];

const LANGUAGE_OPTIONS = [...new Set(LANGUAGE_GROUPS.flatMap((group) => group.languages))];

interface Job { id: string; title: string; company: string | null; }
interface ImportState { jobId: string; status: "loading" | "done" | "exists" | "error"; warning?: string | null; }

export default function GitHubSearchPage() {
  const [location, setLocation]   = useState("New Zealand");
  const [languages, setLanguages] = useState<string[]>([]);
  const [customLanguage, setCustomLanguage] = useState("");
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

  const addCustomLanguage = () => {
    const lang = customLanguage.trim();
    if (!lang) return;
    setLanguages((prev) => prev.some((l) => l.toLowerCase() === lang.toLowerCase()) ? prev : [...prev, lang]);
    setCustomLanguage("");
  };

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
      const data = await res.json() as { alreadyExists?: boolean; error?: string; lowScoreWarning?: string | null };
      if (res.status === 409) {
        setImports((prev) => ({ ...prev, [key]: { jobId, status: "exists" } }));
      } else if (!res.ok) {
        setImports((prev) => ({ ...prev, [key]: { jobId, status: "error" } }));
      } else {
        setImports((prev) => ({ ...prev, [key]: {
          jobId,
          status: "done",
          warning: data.lowScoreWarning ?? null,
        } }));
      }
    } catch {
      setImports((prev) => ({ ...prev, [key]: { jobId, status: "error" } }));
    }
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="toolbar">
        <Github className="w-3.5 h-3.5 text-text-secondary" />
        <h1 className="text-md font-semibold text-text-primary">GitHub Developer Search</h1>
        <span className="text-xs text-text-tertiary hidden sm:inline">
          Find developers by location and language
        </span>
        {rateRemaining !== null && (
          <span className="ml-auto text-xs text-text-tertiary data-mono">
            {rateRemaining} API reqs remaining
          </span>
        )}
      </div>

      <div className="p-4 max-w-5xl mx-auto">
        {/* Search card */}
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-text-secondary mb-1">Location</label>
                <NZLocationInput
                  value={location}
                  onChange={setLocation}
                  placeholder="e.g. Wellington"
                  allowNationwide
                />
              </div>
              <div className="flex items-end">
                <Button onClick={handleSearch} loading={loading} disabled={loading || !location.trim()} size="lg">
                  <Search className="w-4 h-4" />
                  {loading ? "Searching…" : "Search"}
                </Button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Filter by language (optional — pick one or more)
              </label>
              <div className="space-y-2">
                {LANGUAGE_GROUPS.map((group) => (
                  <div key={group.label} className="flex gap-2">
                    <span className="w-20 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary flex-shrink-0">
                      {group.label}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {group.languages.map((lang) => {
                        const active = languages.includes(lang);
                        return (
                          <button
                            key={`${group.label}:${lang}`}
                            onClick={() => toggleLang(lang)}
                            className={cn(
                              "text-xs px-2 py-0.5 rounded-sm border font-medium transition-colors",
                              active
                                ? "bg-accent-subtle text-accent border-accent/40"
                                : "bg-surface-sunken text-text-secondary border-separator hover:border-separator-strong hover:text-text-primary"
                            )}
                          >
                            {lang}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="flex items-center gap-2 pl-0 sm:pl-20">
                  <input
                    value={customLanguage}
                    onChange={(e) => setCustomLanguage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomLanguage();
                      }
                    }}
                    placeholder="Add any GitHub language"
                    className="h-8 w-full max-w-xs rounded border border-separator bg-surface-raised px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addCustomLanguage}>
                    Add
                  </Button>
                </div>
                {languages.some((lang) => !LANGUAGE_OPTIONS.includes(lang)) && (
                  <div className="flex flex-wrap gap-1.5 pl-0 sm:pl-20">
                    {languages.filter((lang) => !LANGUAGE_OPTIONS.includes(lang)).map((lang) => (
                      <button
                        key={lang}
                        onClick={() => toggleLang(lang)}
                        className="text-xs px-2 py-0.5 rounded-sm border font-medium transition-colors bg-accent-subtle text-accent border-accent/40"
                      >
                        {lang}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Error */}
        {error && (
          <div className="mb-3 px-3 py-2 bg-danger-subtle border border-separator rounded flex items-center gap-2 text-xs text-danger">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
            {error.includes("GITHUB_TOKEN") && (
              <span className="ml-1 font-medium">Add GITHUB_TOKEN to your Railway env vars.</span>
            )}
          </div>
        )}

        {/* Results count */}
        {total !== null && (
          <p className="text-xs text-text-tertiary mb-2 data-mono">
            {total.toLocaleString()} developers found on GitHub · showing top {results.length}
          </p>
        )}

        <div className="space-y-2">
          {results.map((user) => {
            const expanded = expandedLogin === user.login;
            return (
              <div key={user.login} className="bg-surface-raised rounded-md border border-separator overflow-hidden">
                <div className="flex items-start gap-3 p-3">
                  {/* Avatar */}
                  <img
                    src={user.avatarUrl}
                    alt={user.login}
                    className="w-9 h-9 rounded-full border border-separator flex-shrink-0"
                  />

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-text-primary text-base">
                            {user.name ?? user.login}
                          </span>
                          <a
                            href={user.githubUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-text-tertiary hover:text-accent flex items-center gap-0.5 data-mono"
                          >
                            @{user.login} <ExternalLink className="w-3 h-3" />
                          </a>
                          {user.linkedinUrl && (
                            <a
                              href={user.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-accent hover:text-accent-hover flex items-center gap-0.5"
                            >
                              LinkedIn <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                        {user.bio && (
                          <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{user.bio}</p>
                        )}
                        <div className="flex items-center gap-3 mt-1 text-xs text-text-tertiary flex-wrap">
                          {user.company  && <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{user.company}</span>}
                          {user.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{user.location}</span>}
                          <span className="flex items-center gap-1 data-mono"><Code2 className="w-3 h-3" />{user.publicRepos} repos</span>
                          <span className="data-mono">{user.followers} followers</span>
                        </div>
                        {/* Language chips */}
                        {user.languages.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {user.languages.map((l) => (
                              <span
                                key={l}
                                className="text-2xs px-1.5 py-0.5 rounded-sm border border-separator bg-surface-hover text-text-secondary font-medium"
                              >
                                {l}
                              </span>
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
                      <div className="mt-2.5 grid sm:grid-cols-2 gap-2">
                        {user.topRepos.map((r) => (
                          <div key={r.name} className="text-xs bg-surface-sunken border border-separator rounded px-2.5 py-1.5">
                            <span className="font-medium text-text-primary">{r.name}</span>
                            {r.language && <span className="ml-1.5 text-text-tertiary">· {r.language}</span>}
                            {r.stars > 0 && <span className="ml-1.5 text-warning data-mono">★ {r.stars}</span>}
                            {r.description && <p className="text-text-tertiary mt-0.5 line-clamp-1">{r.description}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Job picker panel */}
                {expanded && (
                  <div className="border-t border-separator bg-surface-sunken px-3 py-2.5">
                    <p className="text-xs font-medium text-text-secondary mb-1.5">Add to which job?</p>
                    {jobs.length === 0 ? (
                      <p className="text-xs text-text-tertiary">No active jobs found.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {jobs.map((job) => {
                          const key = `${user.login}:${job.id}`;
                          const imp = imports[key];
                          return (
                            <div key={job.id} className="flex flex-col">
                              <button
                                onClick={() => !imp && handleImport(user, job.id)}
                                disabled={Boolean(imp)}
                                className={cn(
                                  "text-xs h-7 px-2.5 rounded border font-medium transition-colors inline-flex items-center gap-1.5",
                                  imp?.status === "done"    ? "bg-success-subtle text-success border-success/40" :
                                  imp?.status === "exists"  ? "bg-surface-hover text-text-tertiary border-separator" :
                                  imp?.status === "error"   ? "bg-danger-subtle text-danger border-danger/40" :
                                  imp?.status === "loading" ? "bg-surface-hover text-text-secondary border-separator" :
                                  "bg-surface-raised text-text-primary border-separator hover:border-accent hover:text-accent"
                                )}
                              >
                                {imp?.status === "loading" && <Loader2 className="w-3 h-3 animate-spin" />}
                                {imp?.status === "done"    && <CheckCircle2 className="w-3 h-3" />}
                                {imp?.status === "exists"  && <CheckCircle2 className="w-3 h-3" />}
                                {imp?.status === "error"   && <AlertCircle className="w-3 h-3" />}
                                <span className="truncate max-w-[160px]">
                                  {job.title}{job.company ? ` · ${job.company}` : ""}
                                </span>
                                {imp?.status === "done"   && <span className="text-2xs">Added</span>}
                                {imp?.status === "exists" && <span className="text-2xs">Already in</span>}
                              </button>
                              {imp?.status === "done" && imp.warning && (
                                <p className="text-2xs text-warning mt-1 flex items-start gap-1">
                                  <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                                  {imp.warning}
                                </p>
                              )}
                              {imp?.status === "done" && (
                                <a href={`/jobs/${job.id}`} className="text-2xs text-success underline underline-offset-1 mt-0.5">
                                  Open in {job.title} →
                                </a>
                              )}
                            </div>
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
          <div className="text-center py-16 text-text-tertiary">
            <Github className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-base">Enter a location and click Search to find developers.</p>
            <p className="text-xs mt-1">
              {process.env.NEXT_PUBLIC_GITHUB_TOKEN_SET === "1"
                ? "GitHub API authenticated — 5000 requests/hour."
                : "Add GITHUB_TOKEN to Railway for higher rate limits."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
