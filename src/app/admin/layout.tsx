import { redirect } from "next/navigation";
import { Sidebar, SidebarWrapper } from "@/components/sidebar";
import { getAuth, getSidebarJobs } from "@/lib/session";
import { isCrmEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (!auth.isOwner) redirect("/jobs");

  const jobs = await getSidebarJobs(auth);

  return (
    <SidebarWrapper>
      <Sidebar jobs={jobs} crmEnabled={isCrmEnabled()} />
      <main className="flex-1 min-w-0">{children}</main>
    </SidebarWrapper>
  );
}
