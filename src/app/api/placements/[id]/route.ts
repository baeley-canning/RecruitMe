import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { isCrmEnabled } from "@/lib/feature-flags";

const PatchSchema = z.object({
  startDate:      z.string().datetime().nullable().optional(),
  salaryPlaced:   z.number().int().min(0).optional().nullable(),
  feeType:        z.enum(["fixed", "percentage"]).optional(),
  feePct:         z.number().min(0).max(100).optional().nullable(),
  feeAmount:      z.number().int().min(0).optional().nullable(),
  invoiceRef:     z.string().max(200).optional().nullable(),
  invoicedAt:     z.string().datetime().optional().nullable(),
  paidAt:         z.string().datetime().optional().nullable(),
  guaranteeMonths: z.number().int().min(0).max(24).optional().nullable(),
  notes:          z.string().max(2000).optional().nullable(),
  clientId:       z.string().optional().nullable(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isCrmEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const placement = await prisma.placement.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!placement) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(placement);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isCrmEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const { id } = await params;
  const existing = await prisma.placement.findFirst({
    where: { id, ...(auth.isOwner ? {} : { orgId: auth.orgId ?? "__none__" }) },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 422 });
  }

  const d = result.data;
  const data: Record<string, unknown> = { ...d };
  if (d.startDate !== undefined) data.startDate = d.startDate ? new Date(d.startDate) : null;
  if (d.invoicedAt !== undefined) data.invoicedAt = d.invoicedAt ? new Date(d.invoicedAt) : null;
  if (d.paidAt !== undefined) data.paidAt = d.paidAt ? new Date(d.paidAt) : null;

  if (d.guaranteeMonths !== undefined) {
    data.guaranteeExpiry = d.guaranteeMonths
      ? new Date(existing.placedAt.getTime() + d.guaranteeMonths * 30 * 24 * 60 * 60 * 1000)
      : null;
  }

  const updated = await prisma.placement.update({ where: { id }, data });
  return NextResponse.json(updated);
}
