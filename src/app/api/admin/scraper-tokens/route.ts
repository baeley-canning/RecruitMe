/**
 * GET  /api/admin/scraper-tokens — list scraper API tokens (owner-only).
 * POST /api/admin/scraper-tokens — mint a token; returns the plaintext ONCE.
 *
 * These bearer tokens let a headless scraper box authenticate and are LOCKED
 * to their org server-side (resolveScraperOrgId) — the BYO-box customer model.
 * The plaintext is shown once and never stored (only its sha256 hash).
 * Owner-only: a token grants ingest access, so only the platform owner mints
 * or lists them.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isOwner } from "@/lib/access";
import { generateScraperToken, scraperTokenStatus } from "@/lib/scraper-tokens";

type AnySession = { user?: { role?: string } } | null;

export async function GET() {
  const session = (await getServerSession(authOptions)) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await prisma.scraperApiToken.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      orgId: true,
      org: { select: { name: true } },
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
      createdAt: true,
      // tokenHash is deliberately NOT selected — never leaves the server.
    },
  });
  return NextResponse.json(
    rows.map(({ org, ...t }) => ({
      ...t,
      orgName: org?.name ?? null,
      status: scraperTokenStatus(t),
    })),
  );
}

const CreateSchema = z.object({
  label: z.string().min(1).max(120).trim(),
  orgId: z.string().optional().nullable(),
  expiresInDays: z.number().int().min(1).max(3650).optional().nullable(),
});

export async function POST(req: Request) {
  const session = (await getServerSession(authOptions)) as AnySession;
  if (!isOwner(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });

  const orgId = parsed.data.orgId || null;
  if (orgId) {
    const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }

  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const { raw, tokenHash } = generateScraperToken();
  const row = await prisma.scraperApiToken.create({
    data: { label: parsed.data.label, orgId, tokenHash, expiresAt },
    select: { id: true, label: true, orgId: true, expiresAt: true, createdAt: true },
  });

  // The plaintext is returned ONCE here and never again (only its hash was stored).
  return NextResponse.json({ ...row, token: raw }, { status: 201 });
}
