"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { MapPin, Search, Users, FileText, Briefcase, Star } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";

interface CandidateFile {
  id: string;
  type: string;
  filename: string;
  size: number;
  createdAt: string;
}

interface LibraryCandidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  matchScore: number | null;
  source: string;
  status: string;
  notes: string | null;
  profileCapturedAt: string | null;
  createdAt: string;
  job: { id: string; title: string; company: string | null } | null;
  archivedJobTitle: string | null;
  archivedJobCompany: string | null;
  files: CandidateFile[];
}

function sourceLabel(s: string) {
  const map: Record<string, string> = {
    manual: "Manual",
    serpapi: "Search",
    pdl: "PDL",
    extension: "LinkedIn",
    talent_pool: "Talent Pool",
  };
  return map[s] ?? s;
}

function scoreColor(score: number) {
  if (score >= 80) return "text-emerald-600 bg-emerald-50";
  if (score >= 60) return "text-blue-600 bg-blue-50";
  if (score >= 40) return "text-amber-600 bg-amber-50";
  return "text-slate-500 bg-slate-100";
}

function CandidateCard({ c }: { c: LibraryCandidate }) {
  const hasCV = c.files.some((f) => f.type === "cv");
  const hasCoverLetter = c.files.some((f) => f.type === "cover_letter");
  const initials = c.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <Link
      href={`/candidates/${c.id}`}
      className="block bg-white rounded-xl border border-slate-200 p-4 hover:border-blue-300 hover:shadow-sm transition-all group"
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 text-white text-sm font-semibold">
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-slate-900 text-sm group-hover:text-blue-600 transition-colors line-clamp-1">
                {c.name}
              </p>
              {c.headline && (
                <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">{c.headline}</p>
              )}
            </div>
            {c.matchScore !== null && (
              <span className={cn("text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0", scoreColor(c.matchScore))}>
                {c.matchScore}%
              </span>
            )}
          </div>

          {c.location && (
            <div className="flex items-center gap-1 mt-1.5 text-xs text-slate-400">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="line-clamp-1">{c.location}</span>
            </div>
          )}

          {/* Badges */}
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {/* Job context */}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-500">
              <Briefcase className="w-2.5 h-2.5" />
              <span className="line-clamp-1 max-w-[100px]">{c.job?.title ?? c.archivedJobTitle ?? "Archived role"}</span>
            </span>

            {/* Profile captured */}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-green-50 text-green-600">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              Profile
            </span>

            {/* CV */}
            {hasCV && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-600">
                <FileText className="w-2.5 h-2.5" />
                CV
              </span>
            )}

            {/* Cover letter */}
            {hasCoverLetter && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-purple-50 text-purple-600">
                <FileText className="w-2.5 h-2.5" />
                Cover
              </span>
            )}

            {/* Source */}
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-slate-50 text-slate-400 ml-auto">
              {sourceLabel(c.source)}
            </span>
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-400 mt-2.5 text-right">
        {c.profileCapturedAt
          ? `Captured ${timeAgo(new Date(c.profileCapturedAt))}`
          : `Added ${timeAgo(new Date(c.createdAt))}`}
      </p>
    </Link>
  );
}

export function CandidatesLibraryClient({ candidates }: { candidates: LibraryCandidate[] }) {
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);

  const filtered = useMemo(() => {
    const q = deferred.toLowerCase().trim();
    if (!q) return candidates;
    return candidates.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.headline?.toLowerCase().includes(q) ||
      c.location?.toLowerCase().includes(q) ||
      (c.job?.title ?? c.archivedJobTitle ?? "").toLowerCase().includes(q) ||
      (c.job?.company ?? c.archivedJobCompany ?? "").toLowerCase().includes(q)
    );
  }, [candidates, deferred]);

  const withCV = candidates.filter((c) => c.files.some((f) => f.type === "cv")).length;
  const withProfile = candidates.length;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-7">
        <h1 className="text-2xl font-bold text-slate-900">Candidates Library</h1>
        <p className="text-slate-500 text-sm mt-1">
          All captured profiles — reused automatically in future job searches
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center">
            <Users className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <p className="text-xl font-bold text-slate-900">{withProfile}</p>
            <p className="text-xs text-slate-500">People</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center">
            <Star className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <p className="text-xl font-bold text-slate-900">
              {candidates.filter((c) => c.matchScore !== null && c.matchScore >= 70).length}
            </p>
            <p className="text-xs text-slate-500">Strong matches (70%+)</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-purple-50 rounded-lg flex items-center justify-center">
            <FileText className="w-4 h-4 text-purple-600" />
          </div>
          <div>
            <p className="text-xl font-bold text-slate-900">{withCV}</p>
            <p className="text-xs text-slate-500">With CV</p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, headline, location, or job…"
          className="w-full pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
        />
      </div>

      {/* Results count */}
      {search && (
        <p className="text-xs text-slate-400 mb-4">
          {filtered.length} of {candidates.length} people
        </p>
      )}

      {/* Grid */}
      {candidates.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200 border-dashed">
          <div className="w-14 h-14 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Users className="w-7 h-7 text-blue-500" />
          </div>
          <h3 className="text-lg font-semibold text-slate-900 mb-2">No profiles yet</h3>
          <p className="text-slate-500 text-sm max-w-xs mx-auto">
            Candidates appear here once their LinkedIn profile has been captured via the browser extension or a search.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">
          No candidates match &ldquo;{search}&rdquo;
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <CandidateCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}
