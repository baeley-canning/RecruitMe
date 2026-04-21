import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth, jobsWhere } from "@/lib/session";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });

  const jobs = await prisma.job.findMany({
    where: { status: "active", ...jobsWhere(auth) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      company: true,
      _count: { select: { candidates: true } },
    },
  });

  return NextResponse.json(
    jobs.map((job) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      candidateCount: job._count.candidates,
    })),
    { headers: CORS }
  );
}
