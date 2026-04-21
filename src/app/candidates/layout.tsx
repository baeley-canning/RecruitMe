import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { Sidebar, SidebarWrapper } from "@/components/sidebar";
import { getAuth, jobsWhere } from "@/lib/session";

export default async function CandidatesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuth();
  if (!auth) redirect("/login");

  const jobs = await prisma.job.findMany({
    where: jobsWhere(auth),
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
