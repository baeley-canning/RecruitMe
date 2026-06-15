"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Users, GitMerge, Undo2, Loader2 } from "lucide-react";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { showToast } from "@/components/ui/toast";
import { confirm } from "@/components/ui/confirm-dialog";
import {
  IDENTITY_MATCH_REASON_LABEL,
  type IdentityRelatedResponse,
  type IdentitySummary,
  type MergeSuggestion,
  type MergedFromEntry,
} from "@/lib/identity-merge-dto";

/**
 * Recruiter merge-review panel for the candidate detail page. Self-gating:
 * fetches GET /api/candidates/[id]/identity/related (404 when the feature flag
 * is off) and renders NOTHING unless there's something actionable — a possible
 * duplicate, a prior merge to split, or an identity that spans >1 record. Calls
 * the existing POST .../identity/merge and .../identity/unmerge routes.
 */
export function IdentityMergePanel({ candidateId }: { candidateId: string }) {
  const [data, setData] = useState<IdentityRelatedResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/candidates/${candidateId}/identity/related`, { cache: "no-store" });
    if (res.ok) setData(await res.json());
    else setData(null); // 404 (flag off) / error → stay invisible
  }, [candidateId]);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/identity/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(typeof json.error === "string" ? json.error : "Couldn't complete that", "error");
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }, [candidateId, load]);

  const doMerge = async (s: MergeSuggestion, currentCount: number) => {
    const ok = await confirm({
      title: "Merge identities?",
      message: `Merge this candidate's identity into "${s.canonicalName}". ${currentCount} record${currentCount === 1 ? "" : "s"} will move onto it. You can split it back out afterwards.`,
      confirmLabel: "Merge",
    });
    if (!ok) return;
    if (await post("merge", { survivorIdentityId: s.identityId })) showToast("Identities merged", "success");
  };

  const doUnmerge = async (m: MergedFromEntry) => {
    const ok = await confirm({
      title: "Split identity back out?",
      message: `Detach "${m.canonicalName}" from this person. This candidate returns to its own identity; the split is durable and won't auto-re-merge.`,
      danger: true,
      confirmLabel: "Unmerge",
    });
    if (!ok) return;
    if (await post("unmerge", { originalIdentityId: m.originalIdentityId })) showToast("Identity split out", "success");
  };

  if (!data || !data.hasIdentity || !data.current) return null;

  const { current, suggestions, mergedFrom } = data;
  const spansMultiple = current.candidateCount > 1;
  // Nothing to show or act on → stay out of the way.
  if (!spansMultiple && suggestions.length === 0 && mergedFrom.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-text-secondary" />
          <h2 className="text-md font-semibold text-text-primary">Identity &amp; duplicates</h2>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Current identity reach */}
        {spansMultiple && (
          <div>
            <p className="text-base text-text-secondary">
              This person is linked across <span className="font-semibold text-text-primary">{current.candidateCount}</span> records.
            </p>
            <SampleList summary={current} />
          </div>
        )}

        {/* Possible duplicates */}
        {suggestions.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-text-primary">Possible duplicates</p>
            {suggestions.map((s) => (
              <div key={s.identityId} className="border border-separator rounded-lg p-3 bg-surface-raised">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-medium text-text-primary truncate">{s.canonicalName}</span>
                      {s.matchReasons.map((r) => (
                        <Badge key={r} className="bg-warning-subtle text-warning">{IDENTITY_MATCH_REASON_LABEL[r]}</Badge>
                      ))}
                    </div>
                    <div className="text-xs text-text-tertiary mt-0.5 space-x-2">
                      {s.primaryEmail && <span className="break-all">{s.primaryEmail}</span>}
                      {s.primaryPhone && <span>{s.primaryPhone}</span>}
                      <span>{s.candidateCount} record{s.candidateCount === 1 ? "" : "s"}</span>
                    </div>
                    <SampleList summary={s} />
                  </div>
                  <button
                    onClick={() => void doMerge(s, current.candidateCount)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 h-8 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 flex-shrink-0"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitMerge className="w-3.5 h-3.5" />} Merge
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Merged-in identities — splittable */}
        {mergedFrom.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-text-primary">Merged in</p>
            {mergedFrom.map((m) => (
              <div key={m.originalIdentityId} className="flex items-center justify-between gap-3 border border-separator rounded-lg px-3 py-2 bg-surface-raised">
                <div className="min-w-0">
                  <span className="text-base text-text-primary truncate">{m.canonicalName}</span>
                  <span className="text-xs text-text-tertiary ml-2">merged {new Date(m.mergedAt).toLocaleDateString()}</span>
                </div>
                <button
                  onClick={() => void doUnmerge(m)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2.5 h-8 text-sm border border-separator text-text-secondary rounded-lg hover:text-text-primary hover:border-accent disabled:opacity-50 flex-shrink-0"
                >
                  <Undo2 className="w-3.5 h-3.5" /> Unmerge
                </button>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function SampleList({ summary }: { summary: IdentitySummary }) {
  if (summary.sampleCandidates.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {summary.sampleCandidates.map((c) => (
        <li key={c.id} className="text-xs text-text-tertiary truncate">
          <Link href={`/candidates/${c.id}`} className="text-accent hover:text-accent-hover">{c.name}</Link>
          {c.jobTitle && <span> · {c.jobTitle}</span>}
        </li>
      ))}
    </ul>
  );
}
