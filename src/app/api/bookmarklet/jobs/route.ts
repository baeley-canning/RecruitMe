import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

  const result = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company,
    candidateCount: j._count.candidates,
  }));

  return NextResponse.json(result, { headers: CORS });
}
