import fs from "fs/promises";
import path from "path";
import { redirect } from "next/navigation";
import { Sidebar, SidebarWrapper } from "@/components/sidebar";
import { getAuth, getSidebarJobs } from "@/lib/session";
import { PlaceMeLogoMissingBanner } from "@/components/placeme-logo-missing-banner";

export const dynamic = "force-dynamic";

// Session-level cache: we only need to discover this once per server process.
// `force-dynamic` re-renders the layout per request, but checking two paths
// with fs.access is cheap (~µs) so we memoise just to avoid re-stat'ing on
// every navigation between candidate-profiles sub-routes.
let cachedLogoMissing: boolean | null = null;

async function logoIsMissing(): Promise<boolean> {
  if (cachedLogoMissing !== null) return cachedLogoMissing;
  const pub = path.join(process.cwd(), "public");
  const candidates = ["placeme-logo.png", "placeme-logo.jpg"];
  for (const name of candidates) {
    try {
      await fs.access(path.join(pub, name));
      cachedLogoMissing = false;
      return false;
    } catch { /* try next */ }
  }
  cachedLogoMissing = true;
  return true;
}

export default async function CandidateProfilesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const [jobs, logoMissing] = await Promise.all([
    getSidebarJobs(auth),
    auth.isOwner ? logoIsMissing() : Promise.resolve(false),
  ]);

  return (
    <SidebarWrapper>
      <Sidebar jobs={jobs} />
      <main className="flex-1 min-w-0">
        {auth.isOwner && logoMissing && (
          <div className="px-4 pt-4 max-w-4xl mx-auto">
            <PlaceMeLogoMissingBanner />
          </div>
        )}
        {children}
      </main>
    </SidebarWrapper>
  );
}
