/**
 * API key management — P6-2
 *
 * GET  /api/v1/keys  — list active API keys for the org
 * POST /api/v1/keys  — create a new API key (raw key shown once)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { checkFeatureAccess } from "@/lib/subscriptions";
import { createApiKey, listApiKeys } from "@/lib/api-keys";

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
});

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const access = await checkFeatureAccess(auth.orgId, "hasApiAccess");
  if (!access.allowed) {
    return NextResponse.json({ error: access.reason }, { status: 403 });
  }

  const keys = await listApiKeys(auth.orgId);
  return NextResponse.json(keys);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const access = await checkFeatureAccess(auth.orgId, "hasApiAccess");
  if (!access.allowed) {
    return NextResponse.json({ error: access.reason }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const key = await createApiKey(auth.orgId, parsed.data.name);
  return NextResponse.json(key, { status: 201 });
}
