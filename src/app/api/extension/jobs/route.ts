import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET() {
  const jobs = await prisma.job.findMany({
    where: { status: "active" },
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
