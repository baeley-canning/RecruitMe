import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";
import { safeParseJson } from "@/lib/utils";

const PersonSchema = z.object({
  name: z.string().max(200).default(""),
  email: z.string().max(300).default(""),
  phone: z.string().max(80).default(""),
});

const CandidateProfileSettingsSchema = z.object({
  consultant: PersonSchema.default({ name: "", email: "", phone: "" }),
  manager: PersonSchema.default({ name: "", email: "", phone: "" }),
});

type CandidateProfileSettings = z.infer<typeof CandidateProfileSettingsSchema>;

function settingKey(auth: { orgId?: string | null; userId: string }) {
  return `candidate-profile-settings:${auth.orgId ?? auth.userId}`;
}

const EMPTY_SETTINGS: CandidateProfileSettings = {
  consultant: { name: "", email: "", phone: "" },
  manager: { name: "", email: "", phone: "" },
};

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const row = await prisma.setting.findUnique({ where: { key: settingKey(auth) } });
  const parsed = CandidateProfileSettingsSchema.safeParse(
    safeParseJson<unknown>(row?.value, EMPTY_SETTINGS)
  );

  return NextResponse.json({ settings: parsed.success ? parsed.data : EMPTY_SETTINGS });
}

export async function PUT(req: Request) {
  const auth = await getAuth();
  if (!auth) return unauthorized();

  const parsed = CandidateProfileSettingsSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
  }

  await prisma.setting.upsert({
    where: { key: settingKey(auth) },
    update: { value: JSON.stringify(parsed.data) },
    create: { key: settingKey(auth), value: JSON.stringify(parsed.data) },
  });

  return NextResponse.json({ settings: parsed.data });
}
