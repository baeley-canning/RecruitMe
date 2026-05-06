import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ScoreBadge } from "@/components/score-badge";
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
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1">Shortlist</p>
          <h1 className="text-3xl font-bold text-slate-900">{job.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-slate-500">
            {job.company && (
              <span className="flex items-center gap-1.5"><Briefcase className="w-4 h-4" />{job.company}</span>
            )}
            {job.location && (
              <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4" />{job.location}</span>
            )}
            <span>{candidates.length} candidate{candidates.length !== 1 ? "s" : ""}</span>
          </div>
          {job.mustHaves.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {job.mustHaves.slice(0, 8).map((m) => (
                <span key={m} className="text-[11px] bg-slate-100 text-slate-600 border border-slate-200 rounded-md px-2 py-0.5">
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Candidates */}
        {candidates.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 border-dashed p-10 text-center">
            <p className="text-slate-500 text-sm">No candidates have been shortlisted yet.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {candidates.map((c) => (
              <article key={c.id} className="bg-white rounded-xl border border-slate-200 p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold text-slate-900 truncate">{c.name}</h2>
                    {c.headline && (
                      <p className="text-sm text-slate-600 mt-0.5">{c.headline}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                      {c.location && (
                        <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{c.location}</span>
                      )}
                      {c.linkedinUrl && (
                        <a
                          href={c.linkedinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-blue-600 hover:text-blue-700"
                        >
                          LinkedIn <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                  <ScoreBadge score={c.matchScore} size="sm" />
                </div>

                {c.summary && (
                  <p className="text-sm text-slate-700 leading-relaxed mb-3">{c.summary}</p>
                )}

                {(c.strengths.length > 0 || c.gaps.length > 0) && (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {c.strengths.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1.5">Strengths</p>
                        <ul className="space-y-1">
                          {c.strengths.slice(0, 4).map((s, i) => (
                            <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                              <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-0.5 flex-shrink-0" />
                              <span>{s}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {c.gaps.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-amber-700 font-semibold mb-1.5">Gaps</p>
                        <ul className="space-y-1">
                          {c.gaps.slice(0, 4).map((g, i) => (
                            <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                              <AlertCircle className="w-3 h-3 text-amber-500 mt-0.5 flex-shrink-0" />
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

        <p className="mt-10 text-center text-[11px] text-slate-400">
          Read-only shortlist · Generated by RecruitMe
        </p>
      </div>
    </div>
  );
}
