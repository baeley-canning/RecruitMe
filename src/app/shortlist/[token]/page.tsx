import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ScoreBadge } from "@/components/score-badge";
import { displayableLinkedinUrl } from "@/components/candidate/helpers";
import { MapPin, ExternalLink, Briefcase, CheckCircle2, AlertCircle } from "lucide-react";

interface PublicCandidate {
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  matchScore: number | null;
  summary: string | null;
  strengths: string[];
  gaps: string[];
}

interface PublicShortlist {
  job: {
    title: string;
    company: string | null;
    location: string | null;
    mustHaves: string[];
  };
  candidates: PublicCandidate[];
}

async function fetchShortlist(token: string): Promise<PublicShortlist | null> {
  // Fetch via the same origin — works in dev, on Railway, and behind reverse proxies.
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const url = `${proto}://${host}/api/public/shortlist/${encodeURIComponent(token)}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json() as Promise<PublicShortlist>;
}

export default async function PublicShortlistPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await fetchShortlist(token);
  if (!data) notFound();

  const { job, candidates } = data;

  return (
    <div className="min-h-screen bg-surface-base">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6">
          <p className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider mb-1">Shortlist</p>
          <h1 className="text-xl sm:text-2xl font-semibold text-text-primary leading-tight">{job.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-text-secondary">
            {job.company && (
              <span className="flex items-center gap-1.5">
                <Briefcase className="w-3.5 h-3.5" />
                {job.company}
              </span>
            )}
            {job.location && (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" />
                {job.location}
              </span>
            )}
            <span className="data-mono text-text-tertiary">
              {candidates.length} candidate{candidates.length !== 1 ? "s" : ""}
            </span>
          </div>
          {job.mustHaves.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {job.mustHaves.slice(0, 8).map((m) => (
                <span
                  key={m}
                  className="text-xs bg-surface-hover text-text-secondary border border-separator rounded-sm px-2 py-0.5"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Candidates */}
        {candidates.length === 0 ? (
          <div className="bg-surface-raised rounded-md border border-separator border-dashed p-8 text-center">
            <Briefcase className="w-7 h-7 text-text-tertiary mx-auto mb-2" />
            <p className="text-text-primary font-medium text-base">Candidates are being evaluated</p>
            <p className="text-text-tertiary text-xs mt-1">
              Check back soon — your recruiter is actively reviewing profiles for this role.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {candidates.map((c) => (
              <article
                key={c.id}
                className="bg-surface-raised rounded-md border border-separator p-4"
              >
                <div className="flex items-start justify-between gap-4 mb-2.5">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-md font-semibold text-text-primary truncate">{c.name}</h2>
                    {c.headline && (
                      <p className="text-base text-text-secondary mt-0.5">{c.headline}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary">
                      {c.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {c.location}
                        </span>
                      )}
                      {displayableLinkedinUrl(c.linkedinUrl) && (
                        <a
                          href={displayableLinkedinUrl(c.linkedinUrl)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-accent hover:text-accent-hover"
                        >
                          LinkedIn <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                  <ScoreBadge score={c.matchScore} size="sm" />
                </div>

                {c.summary && (
                  <p className="text-base text-text-secondary leading-relaxed mb-3">{c.summary}</p>
                )}

                {(c.strengths.length > 0 || c.gaps.length > 0) && (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {c.strengths.length > 0 && (
                      <div>
                        <p className="text-2xs uppercase tracking-wider text-success font-semibold mb-1">
                          Strengths
                        </p>
                        <ul className="space-y-1">
                          {c.strengths.slice(0, 4).map((s, i) => (
                            <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
                              <CheckCircle2 className="w-3 h-3 text-success mt-0.5 flex-shrink-0" />
                              <span>{s}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {c.gaps.length > 0 && (
                      <div>
                        <p className="text-2xs uppercase tracking-wider text-warning font-semibold mb-1">
                          Gaps
                        </p>
                        <ul className="space-y-1">
                          {c.gaps.slice(0, 4).map((g, i) => (
                            <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
                              <AlertCircle className="w-3 h-3 text-warning mt-0.5 flex-shrink-0" />
                              <span>{g}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        <p className="mt-10 text-center text-xs text-text-tertiary">
          Read-only shortlist · Generated by RecruitMe
        </p>
      </div>
    </div>
  );
}
