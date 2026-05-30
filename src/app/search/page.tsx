/**
 * /search — standalone multi-source boolean search landing.
 *
 * Query box (NewSearchPanel) + the caller's recent runs. Submitting creates a
 * durable SearchRun and navigates to /search/[runId]. Recent runs link back
 * to their live/finished result pages — search is resumable across sessions.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuth } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { prisma } from "@/lib/db";
import { NewSearchPanel } from "@/components/search/new-search-panel";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  queued: "bg-warning-subtle text-warning",
  running: "bg-warning-subtle text-warning",
  complete: "bg-success-subtle text-success",
  partial: "bg-warning-subtle text-warning",
  failed: "bg-danger-subtle text-danger",
};

export default async function SearchPage() {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (!auth.isOwner && !auth.orgId) redirect("/login");

  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const where = accessibleOrgIds === null ? {} : { orgId: { in: accessibleOrgIds } };
  const runs = await prisma.searchRun.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      id: true, rawQuery: true, status: true, totalCount: true,
      createdAt: true,
    },
  });

  return (
    <div className="px-4 py-6 sm:px-6 md:p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Search</h1>
        <p className="text-text-secondary text-sm mt-1">
          Boolean search across your library, LinkedIn and SEEK. Runs in the background — leave the
          page and come back; results keep filling in.
        </p>
      </div>

      <NewSearchPanel />

      <div className="mt-8">
        <h2 className="text-xs text-text-tertiary uppercase tracking-wide mb-3">Recent searches</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-text-tertiary">No searches yet.</p>
        ) : (
          <div className="space-y-1.5">
            {runs.map((r) => (
              <Link
                key={r.id}
                href={`/search/${r.id}`}
                className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface-raised border border-separator hover:bg-surface-hover transition-colors"
              >
                <span className="flex-1 min-w-0 truncate text-sm text-text-primary">{r.rawQuery}</span>
                <span className="text-xs text-text-tertiary data-mono flex-shrink-0">{r.totalCount}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-2xs font-medium flex-shrink-0 ${STATUS_TONE[r.status] ?? "bg-surface-hover text-text-tertiary"}`}>
                  {r.status}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
