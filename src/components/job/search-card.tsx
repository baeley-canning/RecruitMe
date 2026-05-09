"use client";

import { useEffect, useState } from "react";
import { Search, Loader2, Key, AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";
import { NZLocationInput } from "@/components/ui/nz-location-input";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSearchResultDisplay, type SearchResultSummary } from "@/lib/search-result-display";
import type { ParsedRole } from "@/lib/ai";

interface SearchCardProps {
  jobId: string;
  parsedRole: ParsedRole;
  jobLocation?: string | null;
  jobStatus: string;
  onComplete: () => void;
}

export function SearchCard({ jobId, parsedRole, jobLocation, jobStatus, onComplete }: SearchCardProps) {
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResultSummary | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searchTimedOut, setSearchTimedOut] = useState(false);
  const [searchingPool, setSearchingPool] = useState(false);
  const [poolResult, setPoolResult] = useState<{ count: number; message?: string } | null>(null);
  const [poolError, setPoolError] = useState("");
  const [hasSerpApi, setHasSerpApi] = useState<boolean | null>(null);
  const [sources, setSources] = useState<{ serpapi: boolean | "configured"; bing: boolean | "configured"; pdl: boolean | "configured" } | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<"ok" | "invalid" | "error" | "unconfigured" | null>(null);
  const [searchHistory, setSearchHistory] = useState<Array<{
    id: string; status: string; collected: number; location: string;
    message: string | null; createdAt: string;
    evaluation: string | null; avgScore: number | null;
    candidatesRejected: number | null; totalExamined: number | null;
  }>>([]);
  const [maxResults, setMaxResults] = useState(20);
  const [locationOverride, setLocationOverride] = useState<string | null>(null);
  const [relaxClearance, setRelaxClearance] = useState(false);

  const searchResultDisplay = searchResult ? getSearchResultDisplay(searchResult) : null;

  // Show the clearance toggle when the role has clearance/work-rights in its requirements
  const CLEARANCE_RE = /security clearance|secret vetting|nz citizen|nz resident|work rights|right to work|\bvisa\b/i;
  const hasClearanceRequirement = [
    ...(parsedRole.must_haves ?? []),
    ...(parsedRole.knockout_criteria ?? []),
    ...(parsedRole.skills_required ?? []),
  ].some((r) => CLEARANCE_RE.test(r));
  const defaultSearchLocation =
    parsedRole.location?.trim() ||
    jobLocation?.trim() ||
    searchHistory.find((session) => session.location?.trim())?.location.trim() ||
    "New Zealand";
  const activeSearchLocation = locationOverride?.trim() || defaultSearchLocation;

  useEffect(() => {
    fetch("/api/search/status")
      .then((r) => r.json())
      .then((d: { available: boolean; sources: { serpapi: boolean | "configured"; bing: boolean | "configured"; pdl: boolean | "configured" }; ai?: { provider: string; claude: "ok" | "invalid" | "error" | "unconfigured" } }) => {
        setHasSerpApi(d.available);
        setSources(d.sources ?? null);
        if (d.ai?.provider === "claude") setClaudeStatus(d.ai.claude);
      })
      .catch(() => setHasSerpApi(false));
  }, []);

  useEffect(() => {
    fetch(`/api/jobs/${jobId}/search-sessions`)
      .then((r) => r.ok ? r.json() : [])
      .then(setSearchHistory)
      .catch(() => {});
  }, [jobId, searchResult]);

  const runTalentPoolSearch = async ({
    limit = maxResults,
    refreshOnlyWhenAdded,
  }: {
    limit?: number;
    refreshOnlyWhenAdded: boolean;
  }): Promise<{ count: number; ok: boolean }> => {
    setSearchingPool(true);
    setPoolError("");
    setPoolResult(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/talent-pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults: limit }),
      });
      const data = await res.json() as { count?: number; error?: string; message?: string };
      if (!res.ok || data.error) {
        setPoolError(data.error ?? "Talent pool search failed");
        return { count: 0, ok: false };
      }

      const count = data.count ?? 0;
      setPoolResult({ count, message: data.message });
      if (count > 0 || !refreshOnlyWhenAdded) onComplete();
      return { count, ok: true };
    } catch {
      setPoolError("Talent pool search failed. Check your connection.");
      return { count: 0, ok: false };
    } finally {
      setSearchingPool(false);
    }
  };

  const handleSearch = async () => {
    setSearching(true);
    setSearchError("");
    setSearchResult(null);
    setSearchTimedOut(false);

    // Pool first: full profiles we already own should be used before spending
    // fresh search/fetch effort. The search API only reuses pool profiles whose
    // URL appears in new LinkedIn results; this route is the independent pass.
    const pool = await runTalentPoolSearch({ limit: maxResults, refreshOnlyWhenAdded: true });
    const remainingResults = Math.max(0, maxResults - pool.count);
    if (pool.ok && remainingResults === 0) {
      setSearchResult({
        status: "complete",
        count: pool.count,
        fromPool: pool.count,
        message: "Candidate library filled this search, so LinkedIn search was skipped.",
      });
      setSearching(false);
      return;
    }

    try {
      const res = await fetch(`/api/jobs/${jobId}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults: remainingResults || maxResults, locationOverride: activeSearchLocation, relaxClearance }),
      });
      const data = await res.json() as { sessionId?: string; error?: string };
      if (!res.ok || data.error) { setSearchError(data.error ?? "Search failed"); setSearching(false); return; }

      const sessionId = data.sessionId!;
      const deadline = Date.now() + 8 * 60 * 1000;
      const poll = async () => {
        if (Date.now() > deadline) {
          setSearchTimedOut(true);
          setSearchError("Search is taking longer than expected. It may still be running in the background.");
          setSearching(false);
          return;
        }
        try {
          const pollRes = await fetch(`/api/jobs/${jobId}/search?sessionId=${sessionId}`);
          const pollData = await pollRes.json() as { status?: "running" | "complete" | "rate_limited"; count?: number; message?: string; fromPool?: number };
          if (pollData.status === "running") { setTimeout(poll, 3000); }
          else {
            setSearchResult({ status: pollData.status, count: pollData.count ?? 0, message: pollData.message, fromPool: pollData.fromPool });
            onComplete();
            setSearching(false);
          }
        } catch { setSearchError("Search failed. Check your connection."); setSearching(false); }
      };
      setTimeout(poll, 3000);
    } catch { setSearchError("Search failed. Check your connection."); setSearching(false); }
  };

  const handleSearchPool = async () => {
    await runTalentPoolSearch({ refreshOnlyWhenAdded: false });
  };

  if (hasSerpApi === false) {
    return (
      <Card className="mb-6">
        <CardBody>
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0">
              <Key className="w-5 h-5 text-slate-500" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-slate-900 text-sm">Enable Candidate Search</p>
              <p className="text-xs text-slate-500 mt-1 mb-3">
                Add one or more of the keys below to <code className="bg-slate-100 px-1 rounded">.env.local</code>, then restart the server.
              </p>
              <div className="space-y-3">
                {[
                  { label: "SerpAPI", required: true, env: "SERPAPI_API_KEY", desc: "Searches Google for LinkedIn profiles. 100 searches/month free.", url: "https://serpapi.com" },
                  { label: "Bing Web Search", required: false, env: "BING_API_KEY", desc: "Second search index — finds different profiles. $5/1000 searches via Azure.", url: "https://portal.azure.com" },
                ].map(({ label, required, env, desc, url }) => (
                  <div key={env} className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-xs font-semibold text-slate-800">{label}</p>
                        {required
                          ? <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">Required</span>
                          : <span className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">Optional</span>
                        }
                      </div>
                      <p className="text-xs text-slate-500 mb-1">{desc}</p>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-slate-900 text-emerald-400 px-2 py-0.5 rounded font-mono">{env}=your-key</code>
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5">
                          Get key <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="mb-6">
      <CardBody>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0", searching ? "bg-blue-50" : "bg-emerald-50")}>
                {searching ? <Loader2 className="w-5 h-5 text-blue-500 animate-spin" /> : <Search className="w-5 h-5 text-emerald-600" />}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <p className="font-semibold text-slate-900 text-sm">
                    {searching ? "Searching..." : "Step 2 — Find Candidates"}
                  </p>
                  {sources && (
                    <div className="flex items-center gap-1">
                      {[{ key: "serpapi", label: "SerpAPI" }, { key: "claude", label: "Claude" }].map(({ key, label }) => {
                        const rawVal = key === "claude" ? claudeStatus : (sources as Record<string, boolean | "configured">)[key];
                        const isOk        = rawVal === "ok" || rawVal === true;
                        const isConfigured = rawVal === "configured"; // key present but not verified
                        const isError     = rawVal === "invalid" || rawVal === "error";
                        return (
                          <span
                            key={key}
                            title={isConfigured ? `${label} key is set but not yet verified — will confirm on first search` : undefined}
                            className={cn("text-xs px-1.5 py-0.5 rounded font-medium border",
                              isOk        ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                              isConfigured? "bg-amber-50 text-amber-600 border-amber-200" :
                              isError     ? "bg-red-50 text-red-600 border-red-200" :
                                            "bg-slate-50 text-slate-400 border-slate-200"
                            )}>
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  {searching
                    ? searchingPool
                      ? "Checking your candidate library first. LinkedIn search only runs for the remaining gap."
                      : "Searching LinkedIn for remaining candidates after the library pass."
                    : "Searches configured sources, imports likely LinkedIn profiles, and uses full scoring for captured profiles."
                  }
                </p>
                {searchResultDisplay && (
                  <p className={`text-xs mt-1 flex items-center gap-1 ${searchResultDisplay.tone === "warning" ? "text-amber-600" : "text-emerald-600"}`}>
                    {searchResultDisplay.tone === "warning" ? <AlertCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                    {searchResultDisplay.message}
                  </p>
                )}
                {searchError && (
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <p className="text-xs text-red-600 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />{searchError}
                    </p>
                    {searchTimedOut && (
                      <button
                        onClick={handleSearch}
                        className="text-xs text-blue-600 hover:text-blue-700 font-medium underline"
                      >
                        Retry search
                      </button>
                    )}
                  </div>
                )}
                {!searching && searchHistory.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {searchHistory.map((s) => (
                      <div key={s.id} className="space-y-0.5">
                        <p className="text-[11px] text-slate-400 flex items-center gap-1.5" suppressHydrationWarning>
                          {s.status === "complete"
                            ? <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                            : <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0" />}
                          {new Date(s.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          {" · "}
                          {s.status === "complete"
                            ? s.collected === 0
                              ? `0 found in ${s.location || "search area"}`
                              : `${s.collected} found`
                            : s.status === "rate_limited" ? "Rate limited — wait a few minutes and search again" : s.status}
                          {s.collected > 0 && s.location ? ` in ${s.location}` : ""}
                          {s.message && s.message.includes("broadening") ? ` · ${s.message}` : ""}
                        </p>
                        {s.evaluation && (
                          <p className={cn(
                            "text-[10px] px-2 py-0.5 rounded-full border inline-flex items-center gap-1 font-medium",
                            s.evaluation.startsWith("FAIL")    ? "bg-red-50 text-red-600 border-red-200" :
                            s.evaluation.startsWith("WARNING") ? "bg-amber-50 text-amber-700 border-amber-200" :
                                                                 "bg-emerald-50 text-emerald-700 border-emerald-200"
                          )}>
                            {s.evaluation}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {poolResult && (
                  <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    {poolResult.count > 0
                      ? `Added ${poolResult.count} candidate${poolResult.count !== 1 ? "s" : ""} from talent pool — scroll down to see them`
                      : (poolResult.message ?? "No talent pool candidates matched this role.")}
                  </p>
                )}
                {poolError && (
                  <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />{poolError}
                  </p>
                )}
                {searchingPool && (
                  <p className="text-xs text-blue-600 mt-1 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />Searching candidate library…
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 flex-shrink-0 items-end">
              <Button onClick={handleSearch} loading={searching} disabled={searching || searchingPool || jobStatus === "closed"} size="lg">
                <Search className="w-4 h-4" />
                {searching ? "Searching..." : searchResult ? "Search Again" : "Find Candidates"}
              </Button>
              <p className="text-[10px] text-slate-400 max-w-[180px] text-right">
                Searches LinkedIn and your talent pool together.
                <button
                  onClick={handleSearchPool}
                  disabled={searching || searchingPool || jobStatus === "closed"}
                  className="ml-1 underline underline-offset-2 hover:text-slate-600 disabled:opacity-50 disabled:no-underline"
                >
                  {searchingPool ? "Searching pool…" : "Pool only"}
                </button>
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-1 border-t border-slate-100">
            <div className="flex flex-wrap gap-x-4 gap-y-2 items-center">
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500 whitespace-nowrap">Max candidates</label>
                <select value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value))} disabled={searching}
                  className="text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50">
                  {[10, 20, 30, 50, 75, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              {defaultSearchLocation && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 whitespace-nowrap">Location</span>
                  <NZLocationInput
                    value={locationOverride ?? defaultSearchLocation}
                    onChange={(v) => setLocationOverride(v || null)}
                    allowNationwide={false}
                    disabled={searching}
                    className="w-full sm:w-44"
                  />
                  {locationOverride?.trim() && (
                    <button onClick={() => setLocationOverride(null)} className="text-[10px] text-slate-400 hover:text-slate-600 underline">reset</button>
                  )}
                </div>
              )}
              {hasClearanceRequirement && (
                <label className="flex items-center gap-2 cursor-pointer select-none" title="Exclude clearance and work-rights requirements from scoring — find technically qualified candidates and handle eligibility checks separately">
                  <div
                    onClick={() => !searching && setRelaxClearance((v) => !v)}
                    className={cn(
                      "relative w-8 h-4 rounded-full transition-colors flex-shrink-0",
                      relaxClearance ? "bg-blue-500" : "bg-slate-300",
                      searching ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                    )}
                  >
                    <span className={cn(
                      "absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform",
                      relaxClearance ? "translate-x-4" : "translate-x-0.5"
                    )} />
                  </div>
                  <span className="text-xs text-slate-500">Ignore clearance for this search</span>
                </label>
              )}
            </div>
          </div>
        </div>

        {/* GitHub sourcing link — for technical roles, GitHub developer search
            is a high-yield complement to LinkedIn. Wiring it into the main
            search would mix two pipelines (LinkedIn-URL keyed vs GitHub-user
            keyed); a separate page keeps the UX clean. */}
        {(parsedRole.must_haves ?? []).length + (parsedRole.skills_required ?? []).length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <a
              href={`/github-search?role=${encodeURIComponent(parsedRole.title ?? "")}&languages=${encodeURIComponent([...(parsedRole.must_haves ?? []), ...(parsedRole.skills_required ?? [])].join(","))}&jobId=${encodeURIComponent(jobId)}`}
              className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 transition-colors"
            >
              <span>Also search GitHub for developers in {jobLocation || "NZ"}</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
