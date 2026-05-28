import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

export interface DuplicateGroup {
  key: string;
  reason: "linkedin" | "name";
  candidates: {
    id: string;
    name: string;
    headline: string | null;
    location: string | null;
    linkedinUrl: string | null;
    jobId: string | null;
    source: string;
    matchScore: number | null;
    createdAt: string;
  }[];
}

function normLinkedin(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const where = auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" };

  const candidates = await prisma.candidate.findMany({
    where,
    select: {
      id: true,
      name: true,
      headline: true,
      location: true,
      linkedinUrl: true,
      jobId: true,
      source: true,
      matchScore: true,
      createdAt: true,
      orgId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const groups: DuplicateGroup[] = [];

  // Group by normalised LinkedIn URL first
  const byLinkedin = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = normLinkedin(c.linkedinUrl);
    if (!key) continue;
    const arr = byLinkedin.get(key) ?? [];
    arr.push(c);
    byLinkedin.set(key, arr);
  }
  for (const [key, group] of byLinkedin) {
    if (group.length < 2) continue;
    groups.push({
      key,
      reason: "linkedin",
      candidates: group.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
    });
  }

  // Then group by normalised name among candidates without LinkedIn URLs
  const noLinkedin = candidates.filter(c => !c.linkedinUrl);
  const byName = new Map<string, typeof candidates>();
  for (const c of noLinkedin) {
    const key = normName(c.name);
    if (key.length < 4) continue;
    const arr = byName.get(key) ?? [];
    arr.push(c);
    byName.set(key, arr);
  }
  for (const [key, group] of byName) {
    if (group.length < 2) continue;
    // Don't report name groups already covered by LinkedIn matching
    const linkedinKeys = new Set(group.map(c => normLinkedin(c.linkedinUrl)).filter(Boolean));
    if (linkedinKeys.size > 0) continue;
    groups.push({
      key,
      reason: "name",
      candidates: group.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
    });
  }

  return NextResponse.json(groups);
}
