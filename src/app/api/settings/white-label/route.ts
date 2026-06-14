import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, unauthorized } from "@/lib/session";
import { getWhiteLabelConfig, saveWhiteLabelConfig } from "@/lib/white-label";
import { isWhiteLabelEnabled } from "@/lib/feature-flags";

const UpdateSchema = z.object({
  // logoUrl is rendered as <img src>. Require an https:// URL — reject
  // data:/javascript:/http: so an org-controlled value can't become a DoS
  // (huge data: URI), a mixed-content/privacy beacon, or anything non-image.
  logoUrl:       z.string().url().refine((u) => /^https:\/\//i.test(u), "Logo URL must start with https://").optional().or(z.literal("")),
  brandName:     z.string().max(60).optional(),
  primaryColour: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex colour e.g. #1D4ED8").optional().or(z.literal("")),
  customDomain:  z.string().max(120).optional().or(z.literal("")),
  footerText:    z.string().max(200).optional().or(z.literal("")),
});

export async function GET() {
  if (!isWhiteLabelEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const config = await getWhiteLabelConfig(auth.orgId);
  return NextResponse.json(config);
}

export async function PATCH(req: Request) {
  if (!isWhiteLabelEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await getAuth();
  if (!auth) return unauthorized();
  if (!auth.isOwner) return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  if (!auth.orgId) return NextResponse.json({ error: "No organisation" }, { status: 400 });

  const parsed = UpdateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  await saveWhiteLabelConfig(auth.orgId, parsed.data);
  const updated = await getWhiteLabelConfig(auth.orgId);
  return NextResponse.json(updated);
}
