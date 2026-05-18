"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Copy, Merge, ArrowLeft, RefreshCw, ExternalLink } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import { confirm } from "@/components/ui/confirm-dialog";
import type { DuplicateGroup } from "@/app/api/candidates/duplicates/route";

const REASON_LABEL: Record<string, string> = {
  linkedin: "Same LinkedIn URL",
  name: "Same name (no LinkedIn)",
};

export default function DuplicatesPage() {
  const router = useRouter();
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/candidates/duplicates");
    if (res.ok) setGroups(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleMerge(group: DuplicateGroup, primaryId: string) {
    const duplicateIds = group.candidates.map(c => c.id).filter(id => id !== primaryId);
    const ok = await confirm({
      title: "Merge duplicates?",
      message: `Keep candidate #${primaryId.slice(-6)} as primary, transfer their files and submissions from ${duplicateIds.length} duplicate${duplicateIds.length !== 1 ? "s" : ""}, then delete the duplicates. This cannot be undone.`,
      danger: true,
      confirmLabel: "Merge",
    });
    if (!ok) return;

    setMerging(group.key);
    try {
      const res = await fetch("/api/candidates/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryId, duplicateIds }),
      });
      if (res.ok) {
        showToast(`Merged ${duplicateIds.length} duplicate${duplicateIds.length !== 1 ? "s" : ""} into primary`, "success");
        setGroups(g => g.filter(x => x.key !== group.key));
      } else {
        const body = await res.json().catch(() => ({}));
        showToast(body.error ?? "Merge failed", "error");
      }
    } finally {
      setMerging(null);
    }
  }

  const visible = groups.filter(g => !dismissed.has(g.key));

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.push("/candidates")}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4" />
          Candidates
        </button>
        <span className="text-gray-300">/</span>
        <h1 className="text-xl font-semibold text-gray-900">Duplicate Candidates</h1>
        <button onClick={load} className="ml-auto text-gray-400 hover:text-gray-700" title="Refresh">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Scanning for duplicates…</div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Copy className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No duplicates found.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">{visible.length} duplicate group{visible.length !== 1 ? "s" : ""} found</p>
          {visible.map(group => (
            <div key={group.key} className="border border-gray-200 rounded-xl bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-medium text-gray-500">{REASON_LABEL[group.reason] ?? group.reason}</span>
                <button
                  onClick={() => setDismissed(d => new Set([...d, group.key]))}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  Dismiss
                </button>
              </div>
              <div className="divide-y divide-gray-100">
                {group.candidates.map(c => (
                  <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">{c.name}</span>
                        {c.linkedinUrl && (
                          <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer"
                            className="text-gray-400 hover:text-blue-600">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <span className="text-xs font-mono text-gray-400">#{c.id.slice(-6)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                        {c.headline && <span className="truncate max-w-xs">{c.headline}</span>}
                        {c.location && <span>{c.location}</span>}
                        <span className="capitalize">{c.source}</span>
                        {c.matchScore != null && <span>{c.matchScore}%</span>}
                        <span>{new Date(c.createdAt).toLocaleDateString("en-NZ")}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleMerge(group, c.id)}
                      disabled={merging === group.key}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Merge className="w-3.5 h-3.5" />
                      Keep as primary
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
