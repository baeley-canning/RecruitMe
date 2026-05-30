/**
 * /search/[runId] — a specific durable search run's live results.
 *
 * Server-renders the current snapshot (so a cold reload mid-run paints
 * instantly), then SearchRunClient subscribes via SSE for deltas. Access is
 * org-scoped; a run outside the caller's accessible orgs 404s.
 */

import { notFound, redirect } from "next/navigation";
import { getAuth } from "@/lib/session";
import { getAccessibleOrgIds } from "@/lib/org-access";
import { assertRunAccess, loadRunSnapshot } from "@/lib/search-run";
import { SearchRunClient } from "@/components/search/search-run-client";

export const dynamic = "force-dynamic";

export default async function SearchRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  const { runId } = await params;

  const accessibleOrgIds = await getAccessibleOrgIds(auth);
  const ok = await assertRunAccess(runId, { isOwner: auth.isOwner, accessibleOrgIds });
  if (!ok) notFound();

  const snapshot = await loadRunSnapshot(runId);
  if (!snapshot) notFound();

  // loadRunSnapshot without sinceUpdatedAt always includes results.
  return <SearchRunClient initial={{ run: snapshot.run, results: snapshot.results ?? [] }} />;
}
