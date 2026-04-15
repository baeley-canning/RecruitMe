import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJobDescription } from "@/lib/ai";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  try {
    const parsedRole = await parseJobDescription(job.rawJd);

    // Save parsed role back to job
    await prisma.job.update({
      where: { id },
      data: { parsedRole: JSON.stringify(parsedRole) },
    });

    return NextResponse.json({ parsedRole });
  } catch (err) {
    console.error("JD parse error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI parsing failed" },
      { status: 500 }
    );
  }
}
