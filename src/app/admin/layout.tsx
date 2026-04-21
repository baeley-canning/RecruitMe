import { prisma } from "@/lib/db";
import { Sidebar, SidebarWrapper } from "@/components/sidebar";
import { getAuth, jobsWhere } from "@/lib/session";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuth();
  const where = auth ? jobsWhere(auth) : {};
  const jobs = await prisma.job.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      company: true,
      status: true,
      _count: { select: { candidates: true } },
    },
  });

  return (
    <SidebarWrapper>
      <Sidebar jobs={jobs} />
      <main className="flex-1 min-w-0">{children}</main>
    </SidebarWrapper>
  );
}
