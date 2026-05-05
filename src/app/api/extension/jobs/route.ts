import { EXTENSION_CORS, extensionCorsHeaders } from "@/lib/extension-cors";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyExtensionAuth, jobsWhere } from "@/lib/session";

// EXTENSION_CORS headers are computed per-request to restrict to extension origins

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

export async function GET(req: Request) {
  const auth = await verifyExtensionAuth(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: extensionCorsHeaders(req) });

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
    { headers: EXTENSION_CORS }
  );
}
