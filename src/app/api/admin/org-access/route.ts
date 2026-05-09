import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized, forbidden } from "@/lib/session";
import { invalidateAccessCache } from "@/lib/org-access";

// Owner-only endpoints for managing cross-org library access grants.
// Used by the admin panel at /admin/org-access. No Stripe wiring — this is
// the manual-toggle layer on top of whatever billing happens externally.

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) return forbidden();

  const grants = await prisma.orgAccessGrant.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  // Resolve org names + grantor names so the admin UI can render them
  // without N+1. Two batched lookups.
  const orgIds = new Set<string>();
  const userIds = new Set<string>();
  for (const g of grants) {
    orgIds.add(g.viewerOrgId);
    orgIds.add(g.providerOrgId);
    userIds.add(g.grantedByUserId);
  }
  const [orgs, users] = await Promise.all([
    prisma.org.findMany({ where: { id: { in: [...orgIds] } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, username: true } }),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const userName = new Map(users.map((u) => [u.id, u.username]));

  return NextResponse.json(grants.map((g) => ({
    ...g,
    viewerOrgName:    orgName.get(g.viewerOrgId)    ?? "(unknown)",
    providerOrgName:  orgName.get(g.providerOrgId)  ?? "(unknown)",
    grantedByName:    userName.get(g.grantedByUserId) ?? "(unknown)",
  })));
}

const PostSchema = z.object({
  viewerOrgId:   z.string().min(1),
  providerOrgId: z.string().min(1),
  scope:         z.enum(["library_read"]).default("library_read"),
  note:          z.string().max(500).optional(),
  expiresAt:     z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) return forbidden();

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }
  const { viewerOrgId, providerOrgId, scope, note, expiresAt } = parsed.data;

  if (viewerOrgId === providerOrgId) {
    return NextResponse.json({ error: "Viewer and provider must be different orgs" }, { status: 400 });
  }

  // Verify both orgs exist before creating the grant — otherwise the unique
  // constraint will succeed against ghost rows.
  const orgs = await prisma.org.findMany({
    where: { id: { in: [viewerOrgId, providerOrgId] } },
    select: { id: true },
  });
  if (orgs.length < 2) {
    return NextResponse.json({ error: "One or both orgs not found" }, { status: 404 });
  }

  try {
    const grant = await prisma.orgAccessGrant.create({
      data: {
        viewerOrgId,
        providerOrgId,
        scope,
        grantedByUserId: auth.userId,
        note: note?.trim() || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });
    invalidateAccessCache(viewerOrgId);
    return NextResponse.json(grant, { status: 201 });
  } catch (err) {
    // Unique constraint — same (viewer, provider, scope) already exists.
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "This grant already exists" }, { status: 409 });
    }
    throw err;
  }
}
