import { redirect } from "next/navigation";
import { Sidebar, SidebarWrapper } from "@/components/sidebar";
import { getAuth, getSidebarJobs } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ClientsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const jobs = await getSidebarJobs(auth);

  return (
    <SidebarWrapper>
      <Sidebar jobs={jobs} />
      <main className="flex-1 min-w-0">{children}</main>
    </SidebarWrapper>
  );
}
