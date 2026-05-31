"use client";

import { useEffect, useState } from "react";
import { Search, Loader2, Key, AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";
import { NZLocationInput } from "@/components/ui/nz-location-input";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ProviderBadgeRow, type ProviderHealth } from "@/components/provider-badge";
import { getSearchResultDisplay, type SearchResultSummary } from "@/lib/search-result-display";
import { extractRoleAwareDistinctiveAnchors } from "@/lib/requirement-signals";
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
  // Live per-provider health (Claude / Llama / SerpAPI / PDL / GitHub)
  // for the green/amber/red badges. Polled every 30s so a failed
  // call flips the badge before the recruiter notices via output quality.
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [searchHistory, setSearchHistory] = useState<Array<{
    id: string; status: string; collected: number; location: string;
    message: string | null; createdAt: string;
    evaluation: string | null; avgScore: number | null;
    candidatesRejected: number | null; totalExamined: number | null;
  }>>([]);
  const [maxResults, setMaxResults] = useState(50);
  const [locationOverride, setLocationOverride] = useState<string | null>(null);
  const [relaxClearance, setRelaxClearance] = useState(false);
  // Library-only mode — when ON, the main button searches only the talent
  // pool and never falls through to SERP/LinkedIn. Persisted in localStorage
  // so the recruiter's preference survives navigation between job pages.
  const [libraryOnly, setLibraryOnly] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { setLibraryOnly(localStorage.getItem("recruitme:libraryOnlySearch") === "1"); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem("recruitme:libraryOnlySearch", libraryOnly ? "1" : "0"); } catch { /* ignore */ }
  }, [libraryOnly]);

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
      .then((d: { available: boolean; ai?: { provider: string; claude: "ok" | "invalid" | "error" | "unconfigured" } }) => {
        setHasSerpApi(d.available);
      })
      .catch(() => setHasSerpApi(false));
  }, []);

  // Poll /api/ai/status for the full per-provider health snapshot. 30s
  // cadence — slow enough not to spam the endpoint, fast enough that a
  // failed scoring run flips the Claude badge to red before the recruiter
  // wonders why their results look weird. The status endpoint reads
  // in-memory state, so polling is cheap.
  useEffect(() => {
    let cancelled = false;
    const loadHealth = () => {
      fetch("/api/ai/status")
        .then((r) => r.json())
        .then((d: { providers?: ProviderHealth[] }) => {
          if (!cancelled && Array.isArray(d.providers)) setProviderHealth(d.providers);
        })
        .catch(() => {/* keep last known state on transient errors */});
    };
    loadHealth();
    const id = setInterval(loadHealth, 30_000);
    return () => { cancelled = true; clearInterval(id); };
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
  }): Promise<{ count: number; ok: boolean; aborted?: boolean; message?: string }> => {
    setSearchingPool(true);
    setPoolError("");
    setPoolResult(null);
    // 50s client-side abort. The route declares maxDuration = 300, but if
    // we waited that long for the pool we'd starve the LinkedIn fallback;
    // aborting at 50s frees the UI to proceed to LinkedIn while the
    // server-side worker continues in the background.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 50_000);
    try {
      const res = await fetch(`/api/jobs/${jobId}/candidates/talent-pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults: limit }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({})) as { count?: number; error?: string; message?: string };
      if (!res.ok || data.error) {
        setPoolError(data.error ?? "Talent pool search failed");
        return { count: 0, ok: false };
      }

      const count = data.count ?? 0;
      setPoolResult({ count, message: data.message });
      if (count > 0 || !refreshOnlyWhenAdded) onComplete();

      // Fire-and-forget score-all with onlyUnscored=1 so the freshly imported
      // candidates pick up AI scores without re-rescoring the LinkedIn cohort.
      // We don't block the response on this — recruiter sees the imports land
      // immediately and scores trickle in via the existing candidate-list
      // polling/refresh path. If the daily AI spend cap is hit the score-all
      // returns 429; the imports already exist so the recruiter can manually
      // re-score later.
      if (count > 0) {
        void fetch(`/api/jobs/${jobId}/candidates/score-all?onlyUnscored=1`, { method: "POST" })
          .then(() => onComplete())
          .catch(() => { /* surfaced via candidate row "Score" buttons if needed */ });
      }
      return { count, ok: true, message: data.message };
    } catch (err) {
      // AbortError: budget exceeded — treat as "skipped, not failed" so the
      // main search flow proceeds straight to LinkedIn instead of bailing
      // with a generic error banner.
      if ((err as { name?: string })?.name === "AbortError") {
        setPoolResult({ count: 0, message: "Library search took too long — continuing with LinkedIn search." });
        return { count: 0, ok: true, aborted: true, message: "Library search took too long — try a smaller max candidate count or search again." };
      }
      setPoolError("Talent pool search failed. Check your connection.");
      return { count: 0, ok: false };
    } finally {
      clearTimeout(abortTimer);
      setSearchingPool(false);
    }
  };

  const handleSearch = async () => {
    setSearching(true);
    setSearchError("");
    setSearchResult(null);
    setSearchTimedOut(false);

    // Library-only mode: short-circuit to the talent-pool path and skip
    // LinkedIn/SERP entirely. The recruiter explicitly opted out of paid
    // sources via the toggle; respect it.
    if (libraryOnly) {
      const pool = await runTalentPoolSearch({ limit: maxResults, refreshOnlyWhenAdded: false });
      setSearchResult({
        status: pool.ok ? "complete" : "rate_limited",
        count: pool.count,
        fromPool: pool.count,
        // Library import is hard-match (instant); AI scoring auto-fires in the
        // background via score-all?onlyUnscored=1. If the AI spend cap is hit
        // the recruiter can still manually re-score with the existing button.
        message: pool.count > 0
          ? `Imported ${pool.count} from your library — scoring in the background…`
          : pool.message ?? "No library matches for this role. Switch off library-only to search LinkedIn.",
      });
      setSearching(false);
      return;
    }

    // Pool-first only when the role has distinctive technical anchors
    // (SCADA, C++, Sybase, ISMS, etc). For non-specialist roles like a
    // Project Manager, the talent-pool match logic has no anchor to gate
    // on, so it ships every Wellington dev to Claude for batch scoring —
    // which is slow AND surfaces the wrong-role-type candidates that
    // dominated the PM job's results. Skipping pool for these roles sends
    // the recruiter straight to LinkedIn, which is the right primary
    // sourcing channel for a generic role. The recruiter can still hit
    // "Pool only" explicitly when they want to browse the library.
    const distinctiveAnchors = extractRoleAwareDistinctiveAnchors({
      title: parsedRole.title,
      requirements: [
        ...(parsedRole.must_haves ?? []),
        ...(parsedRole.knockout_criteria ?? []),
      ],
    });
    const shouldRunPool = distinctiveAnchors.length > 0;

    let pool: { count: number; ok: boolean; aborted?: boolean } = { count: 0, ok: true };
    if (shouldRunPool) {
      pool = await runTalentPoolSearch({ limit: maxResults, refreshOnlyWhenAdded: true });
    } else {
      setPoolResult({ count: 0, message: "Library skipped — no distinctive anchors for this role, going straight to LinkedIn." });
    }
    const remainingResults = Math.max(0, maxResults - pool.count);
    if (pool.ok && remainingResults === 0 && pool.count > 0) {
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
          // "crashed" is returned when the server detects a session stuck in
          // "running" beyond the 10-min worker lifetime (Railway restart,
          // unhandled crash, etc). We map it to "rate_limited" before
          // handing it to the display layer so the recruiter gets the
          // standard warning treatment + retry affordance.
          const pollData = await pollRes.json() as { status?: "running" | "complete" | "rate_limited" | "crashed"; count?: number; message?: string; fromPool?: number };
          if (pollData.status === "running") { setTimeout(poll, 3000); }
          else {
            const displayStatus = pollData.status === "crashed" ? "rate_limited" : pollData.status;
            setSearchResult({ status: displayStatus, count: pollData.count ?? 0, message: pollData.message, fromPool: pollData.fromPool });
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
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 bg-surface-hover rounded flex items-center justify-center flex-shrink-0">
              <Key className="w-3.5 h-3.5 text-text-secondary" />
            </div>
            <div className="flex-1">
              <p className="text-md font-semibold text-text-primary">Enable Candidate Search</p>
              <p className="text-base text-text-secondary mt-1 mb-3">
                Add one or more of the keys below to <code className="bg-surface-sunken text-text-primary px-1 rounded-xs font-mono">.env.local</code>, then restart the server.
              </p>
              <div className="space-y-2">
                {[
                  { label: "People Data Labs", required: false, env: "PDL_API_KEY", desc: "Candidate search + enrichment. 100 free calls/month. LinkedIn/SEEK discovery uses the local scraper — no key needed.", url: "https://peopledatalabs.com" },
                ].map(({ label, required, env, desc, url }) => (
                  <div key={env} className="flex items-start gap-3 p-3 bg-surface-sunken rounded border border-separator">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-base font-semibold text-text-primary">{label}</p>
                        {required
                          ? <span className="text-xs px-1.5 py-0.5 bg-accent-subtle text-accent rounded-sm font-medium">Required</span>
                          : <span className="text-xs px-1.5 py-0.5 bg-surface-hover text-text-tertiary rounded-sm">Optional</span>
                        }
                      </div>
                      <p className="text-xs text-text-secondary mb-1">{desc}</p>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-surface-sunken text-success px-2 py-0.5 rounded-sm font-mono">{env}=your-key</code>
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:text-accent-hover inline-flex items-center gap-0.5">
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
              <div className={cn("w-8 h-8 rounded flex items-center justify-center flex-shrink-0", searching ? "bg-accent-subtle" : "bg-success-subtle")}>
                {searching ? <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" /> : <Search className="w-3.5 h-3.5 text-success" />}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <p className="text-md font-semibold text-text-primary">
                    {searching ? "Searching..." : "Step 2 — Find Candidates"}
                  </p>
                  {providerHealth.length > 0 && (
                    <ProviderBadgeRow providers={providerHealth} />
                  )}
                </div>
                <p className="text-base text-text-secondary">
                  {searching
                    ? searchingPool
                      ? "Checking your candidate library first. LinkedIn search only runs for the remaining gap."
                      : "Searching LinkedIn for remaining candidates after the library pass."
                    : "Searches configured sources, imports likely LinkedIn profiles, and uses full scoring for captured profiles."
                  }
                </p>
                {searchResultDisplay && (
                  <p className={`text-xs mt-1 flex items-center gap-1 ${searchResultDisplay.tone === "warning" ? "text-warning" : "text-success"}`}>
                    {searchResultDisplay.tone === "warning" ? <AlertCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                    {searchResultDisplay.message}
                  </p>
                )}
                {searchError && (
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <p className="text-xs text-danger flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />{searchError}
                    </p>
                    {searchTimedOut && (
                      <button
                        onClick={handleSearch}
                        className="text-xs text-accent hover:text-accent-hover font-medium underline"
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
                        <p className="text-xs text-text-tertiary flex items-center gap-1.5 tabular-nums" suppressHydrationWarning>
                          {s.status === "complete"
                            ? <CheckCircle2 className="w-3 h-3 text-success flex-shrink-0" />
                            : <AlertCircle className="w-3 h-3 text-warning flex-shrink-0" />}
                          {new Date(s.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          {" · "}
                          {s.status === "complete"
                            ? s.collected === 0
                              ? `0 found in ${s.location || "search area"}`
                              : `${s.collected} found`
                            : s.status === "rate_limited" ? "Rate limited — wait a few minutes and search again"
                            : s.status === "crashed" ? "Search worker died — try again"
                            : s.status}
                          {s.collected > 0 && s.location ? ` in ${s.location}` : ""}
                          {s.message && s.message.includes("broadening") ? ` · ${s.message}` : ""}
                        </p>
                        {s.evaluation && (
                          <p className={cn(
                            "text-2xs px-1.5 py-0.5 rounded-sm inline-flex items-center gap-1 font-medium",
                            s.evaluation.startsWith("FAIL")    ? "bg-danger-subtle text-danger" :
                            s.evaluation.startsWith("WARNING") ? "bg-warning-subtle text-warning" :
                                                                 "bg-success-subtle text-success"
                          )}>
                            {s.evaluation}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {poolResult && (
                  <p className="text-xs text-success mt-1 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    {poolResult.count > 0
                      ? `Added ${poolResult.count} candidate${poolResult.count !== 1 ? "s" : ""} from talent pool — scroll down to see them`
                      : (poolResult.message ?? "No talent pool candidates matched this role.")}
                  </p>
                )}
                {poolError && (
                  <p className="text-xs text-danger mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />{poolError}
                  </p>
                )}
                {searchingPool && (
                  <p className="text-xs text-accent mt-1 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />Searching candidate library…
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 flex-shrink-0 items-end">
              <Button onClick={handleSearch} loading={searching} disabled={searching || searchingPool || jobStatus === "closed"} size="lg">
                <Search className="w-3.5 h-3.5" />
                {searching
                  ? "Searching..."
                  : libraryOnly
                    ? (searchResult ? "Search Library Again" : "Search Library")
                    : (searchResult ? "Search Again" : "Find Candidates")}
              </Button>
              <p className="text-2xs text-text-tertiary max-w-[180px] text-right">
                {libraryOnly
                  ? "Library-only mode is on — LinkedIn / SERP fetch is skipped."
                  : <>
                      Searches LinkedIn and your talent pool together.
                      <button
                        onClick={handleSearchPool}
                        disabled={searching || searchingPool || jobStatus === "closed"}
                        className="ml-1 underline underline-offset-2 hover:text-text-secondary disabled:opacity-50 disabled:no-underline"
                      >
                        {searchingPool ? "Searching pool…" : "Pool only"}
                      </button>
                    </>}
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-1 border-t border-separator">
            <div className="flex flex-wrap gap-x-4 gap-y-2 items-center">
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-secondary whitespace-nowrap">Max candidates</label>
                <select value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value))} disabled={searching}
                  className="h-7 px-2.5 rounded bg-surface-sunken border border-separator text-md text-text-primary focus:outline-none focus:border-accent focus:shadow-focus disabled:opacity-50 tabular-nums">
                  {[10, 20, 30, 50, 75, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              {defaultSearchLocation && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary whitespace-nowrap">Location</span>
                  <NZLocationInput
                    value={locationOverride ?? defaultSearchLocation}
                    onChange={(v) => setLocationOverride(v || null)}
                    allowNationwide={false}
                    disabled={searching}
                    className="w-full sm:w-44"
                  />
                  {locationOverride?.trim() && (
                    <button onClick={() => setLocationOverride(null)} className="text-2xs text-text-tertiary hover:text-text-secondary underline">reset</button>
                  )}
                </div>
              )}
              {hasClearanceRequirement && (
                <label className="flex items-center gap-2 cursor-pointer select-none" title="Exclude clearance and work-rights requirements from scoring — find technically qualified candidates and handle eligibility checks separately">
                  <div
                    onClick={() => !searching && setRelaxClearance((v) => !v)}
                    className={cn(
                      "relative w-8 h-4 rounded-full transition-colors flex-shrink-0",
                      relaxClearance ? "bg-accent" : "bg-surface-hover",
                      searching ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                    )}
                  >
                    <span className={cn(
                      "absolute top-0.5 w-3 h-3 bg-text-primary rounded-full shadow transition-transform",
                      relaxClearance ? "translate-x-4" : "translate-x-0.5"
                    )} />
                  </div>
                  <span className="text-xs text-text-secondary">Ignore clearance for this search</span>
                </label>
              )}
              {/* Library-only toggle — when ON, "Find Candidates" only searches
                  the local talent pool and never falls through to LinkedIn /
                  SERP. Matches the sibling "Ignore clearance" toggle's exact
                  div-based pattern so the OFF state reads clearly as grey
                  (a <button> kept its focus ring after click, blending with
                  the grey track and making both states look blue). */}
              <label
                className="flex items-center gap-2 cursor-pointer select-none"
                title="Search only your candidate library — no LinkedIn or external sources, $0 cost"
              >
                <div
                  role="switch"
                  aria-checked={libraryOnly}
                  aria-label="Toggle library-only search"
                  onClick={() => !searching && setLibraryOnly((v) => !v)}
                  className={cn(
                    "relative w-8 h-4 rounded-full transition-colors flex-shrink-0",
                    libraryOnly ? "bg-accent" : "bg-surface-hover",
                    searching ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  )}
                >
                  <span className={cn(
                    "absolute top-0.5 w-3 h-3 bg-text-primary rounded-full shadow transition-transform",
                    libraryOnly ? "translate-x-4" : "translate-x-0.5"
                  )} />
                </div>
                <span className="text-xs text-text-secondary">Library only (skip LinkedIn)</span>
              </label>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
