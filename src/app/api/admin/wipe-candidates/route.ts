import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

type AnySession = { user?: { role?: string } } | null;

export async function DELETE() {
  const session = await getServerSession(authOptions) as AnySession;
  if (session?.user?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }

  const { count } = await prisma.candidate.deleteMany({});
  return NextResponse.json({ deleted: count });
}
