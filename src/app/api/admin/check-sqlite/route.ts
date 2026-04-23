import { existsSync, statSync } from "fs";
import { NextResponse } from "next/server";
import { getAuth, unauthorized } from "@/lib/session";

export async function GET() {
  const auth = await getAuth();
  if (!auth?.isOwner) return unauthorized();

  const paths = ["/data/dev.db", "/data/prisma/dev.db", "/app/prisma/dev.db", "/app/dev.db"];
  const results: Record<string, { exists: boolean; size?: number; modified?: Date }> = {};
  for (const p of paths) {
    if (existsSync(p)) {
      const s = statSync(p);
      results[p] = { exists: true, size: s.size, modified: s.mtime };
    } else {
      results[p] = { exists: false };
    }
  }
  return NextResponse.json(results);
}
