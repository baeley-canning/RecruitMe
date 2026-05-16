"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MapPin, Search, Users, FileText, Briefcase, Star, UserPlus } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { AddLibraryCandidateModal } from "@/components/add-library-candidate-modal";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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
  orgName: string | null;
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

function scoreTier(score: number) {
  if (score >= 80) return "bg-success-subtle text-success";
  if (score >= 60) return "bg-accent-subtle text-accent";
  if (score >= 40) return "bg-warning-subtle text-warning";
  return "bg-surface-hover text-text-secondary";
}

function CandidateCard({ c }: { c: LibraryCandidate }) {
  const hasCV = c.files.some((f) => f.type === "cv");
  const hasCoverLetter = c.files.some((f) => f.type === "cover_letter");
  const initials = c.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <Link
      href={`/candidates/${c.id}`}
      className="block bg-surface-raised rounded-md border border-separator p-4 hover:bg-surface-hover transition-colors group"
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="w-10 h-10 rounded-full bg-accent-subtle text-accent flex items-center justify-center flex-shrink-0 text-sm font-semibold">
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-text-primary text-md group-hover:text-accent transition-colors line-clamp-1">
                {c.name}
              </p>
              {c.headline && (
                <p className="text-xs text-text-secondary line-clamp-1 mt-0.5">{c.headline}</p>
              )}
            </div>
            {c.matchScore !== null && (
              <span
                className={cn(
                  "text-xs font-medium px-1.5 py-0.5 rounded-sm flex-shrink-0 data-mono",
                  scoreTier(c.matchScore)
                )}
              >
                {c.matchScore}%
              </span>
            )}
          </div>

          {c.location && (
            <div className="flex items-center gap-1 mt-1.5 text-xs text-text-tertiary">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="line-clamp-1">{c.location}</span>
            </div>
          )}

          {/* Badges */}
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {/* Org name — only shown to owner, identifies cross-org candidates */}
            {c.orgName && (
              <Badge className="bg-accent-subtle text-accent" >
                <span title={`Organisation: ${c.orgName}`}>{c.orgName}</span>
              </Badge>
            )}
            {/* Job context */}
            <Badge>
              <Briefcase className="w-2.5 h-2.5" />
              <span className="line-clamp-1 max-w-[100px] ml-1">
                {c.job?.title ?? c.archivedJobTitle ?? (c.source === "manual" || c.source === "jobadder_import" ? "Library" : "Archived role")}
              </span>
            </Badge>

            {/* Profile captured */}
            <Badge className="bg-success-subtle text-success">
              <span className="w-1.5 h-1.5 rounded-full bg-success inline-block mr-1" />
              Profile
            </Badge>

            {/* CV */}
            {hasCV && (
              <Badge className="bg-accent-subtle text-accent">
                <FileText className="w-2.5 h-2.5 mr-1" />
                CV
              </Badge>
            )}

            {/* No LinkedIn URL — may be duplicate */}
            {!c.linkedinUrl && (
              <span
                title="No LinkedIn URL — if this person appears twice, they may be a duplicate. Add their LinkedIn URL to enable deduplication."
                className="inline-flex items-center h-5 px-1.5 py-0.5 rounded-sm text-xs font-medium leading-none bg-warning-subtle text-warning cursor-help"
              >
                No LinkedIn
              </span>
            )}

            {/* Cover letter */}
            {hasCoverLetter && (
              <Badge className="bg-warning-subtle text-warning">
                <FileText className="w-2.5 h-2.5 mr-1" />
                Cover
              </Badge>
            )}

            {/* Source */}
            <Badge className="ml-auto">
              {sourceLabel(c.source)}
            </Badge>
          </div>
        </div>
      </div>

      <p className="text-xs text-text-tertiary mt-2.5 text-right" suppressHydrationWarning>
        {c.profileCapturedAt
          ? `Captured ${timeAgo(new Date(c.profileCapturedAt))}`
          : `Added ${timeAgo(new Date(c.createdAt))}`}
      </p>
    </Link>
  );
}

export function CandidatesLibraryClient({ candidates }: { candidates: LibraryCandidate[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [showAddModal, setShowAddModal] = useState(false);

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
  const strongMatches = candidates.filter((c) => c.matchScore !== null && c.matchScore >= 70).length;

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Candidates Library</h1>
          <p className="text-text-secondary text-sm mt-1">
            All captured profiles — reused automatically in future job searches
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)} variant="primary" size="md">
          <UserPlus className="w-3.5 h-3.5" />
          Add Candidate
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <Card className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-accent-subtle rounded-md flex items-center justify-center">
            <Users className="w-4 h-4 text-accent" />
          </div>
          <div>
            <p className="text-lg font-semibold text-text-primary data-mono">{withProfile}</p>
            <p className="text-xs text-text-secondary">People</p>
          </div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-success-subtle rounded-md flex items-center justify-center">
            <Star className="w-4 h-4 text-success" />
          </div>
          <div>
            <p className="text-lg font-semibold text-text-primary data-mono">{strongMatches}</p>
            <p className="text-xs text-text-secondary">Strong matches (70%+)</p>
          </div>
        </Card>
        <Card className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-warning-subtle rounded-md flex items-center justify-center">
            <FileText className="w-4 h-4 text-warning" />
          </div>
          <div>
            <p className="text-lg font-semibold text-text-primary data-mono">{withCV}</p>
            <p className="text-xs text-text-secondary">With CV</p>
          </div>
        </Card>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, headline, location, or job…"
          className="w-full h-8 pl-8 pr-3 rounded bg-surface-sunken border border-separator text-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:shadow-focus transition-all"
        />
      </div>

      {/* Results count */}
      {search && (
        <p className="text-xs text-text-tertiary mb-3 data-mono">
          {filtered.length} of {candidates.length} people
        </p>
      )}

      {/* Grid */}
      {candidates.length === 0 ? (
        <Card className="text-center py-16 border-dashed">
          <div className="w-14 h-14 bg-accent-subtle rounded-full flex items-center justify-center mx-auto mb-4">
            <Users className="w-7 h-7 text-accent" />
          </div>
          <h3 className="text-md font-semibold text-text-primary mb-2">No profiles yet</h3>
          <p className="text-text-secondary text-sm max-w-xs mx-auto mb-4">
            Candidates appear here once their LinkedIn profile has been captured via the browser extension or a search.
          </p>
          <div className="flex justify-center">
            <Button onClick={() => setShowAddModal(true)} variant="primary" size="md">
              <UserPlus className="w-3.5 h-3.5" />
              Add Candidate via CV
            </Button>
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-text-tertiary text-sm">
          No candidates match &ldquo;{search}&rdquo;
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <CandidateCard key={c.id} c={c} />
          ))}
        </div>
      )}

      {showAddModal && (
        <AddLibraryCandidateModal
          onComplete={() => {
            setShowAddModal(false);
            router.refresh();
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
