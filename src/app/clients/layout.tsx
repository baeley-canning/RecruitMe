import { redirect, notFound } from "next/navigation";
import { Sidebar, SidebarWrapper } from "@/components/sidebar";
import { getAuth, getSidebarJobs, getSidebarBrand } from "@/lib/session";
import { isCrmEnabled, isRemindersEnabled, isProfileWatchEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function ClientsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (!isCrmEnabled()) notFound();

  const jobs = await getSidebarJobs(auth);
  const brand = await getSidebarBrand(auth);

  return (
    <SidebarWrapper>
      <Sidebar jobs={jobs} crmEnabled={isCrmEnabled()} remindersEnabled={isRemindersEnabled()} profileWatchEnabled={isProfileWatchEnabled()} brandName={brand.brandName} logoUrl={brand.logoUrl} />
      <main className="flex-1 min-w-0">{children}</main>
    </SidebarWrapper>
  );
}
