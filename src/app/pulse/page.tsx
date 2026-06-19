/**
 * /updates — the profile-update alerts feed (Stage D).
 *
 * Server component: gates on isProfileWatchEnabled() and notFound()s when off,
 * so the whole feature ships dark (the route 404s, the client bundle for the
 * feed/form never reaches the browser). When on, renders the terminal-style
 * live feed client, which consumes /api/watches/feed/stream over SSE.
 */

import { notFound } from "next/navigation";
import { isProfileWatchEnabled } from "@/lib/feature-flags";
import { UpdatesFeed } from "./updates-feed";
import { PulseCursor } from "@/components/pulse/pulse-cursor";

export const dynamic = "force-dynamic";

export default function UpdatesPage() {
  if (!isProfileWatchEnabled()) notFound();
  return (
    <>
      <PulseCursor />
      <UpdatesFeed />
    </>
  );
}
