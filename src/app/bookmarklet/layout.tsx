import { prisma } from "@/lib/db";
import { Sidebar, SidebarWrapper } from "@/components/sidebar";

export default async function BookmarkletLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const jobs = await prisma.job.findMany({
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
      <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
    </SidebarWrapper>
  );
}
