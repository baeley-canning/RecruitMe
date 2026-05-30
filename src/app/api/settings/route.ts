import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSetting, setServerSetting } from "@/lib/settings";
import { getAuth, unauthorized } from "@/lib/session";

const MANAGED_KEYS = ["PDL_API_KEY"] as const;

// Body is an object whose keys may be any of MANAGED_KEYS, each carrying a
// string value. Unknown keys are stripped (we only iterate MANAGED_KEYS below).
const SettingsBodySchema = z.object({
  PDL_API_KEY: z.string().optional(),
});

export async function GET() {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const result: Record<string, { configured: boolean; source: "env" | "db" | "none" }> = {};

  for (const key of MANAGED_KEYS) {
    const fromEnv = process.env[key]?.trim();
    if (fromEnv) {
      result[key] = { configured: true, source: "env" };
    } else {
      const fromDb = await getServerSetting(key);
      result[key] = { configured: Boolean(fromDb), source: fromDb ? "db" : "none" };
    }
  }

  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth?.isOwner) return unauthorized();

  const parsed = SettingsBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const body = parsed.data;

  for (const key of MANAGED_KEYS) {
    if (key in body) {
      const val = body[key]?.trim() ?? "";
      if (val) {
        if (/\s/.test(val)) {
          return NextResponse.json(
            { error: `${key}: API keys cannot contain spaces — check for accidental whitespace` },
            { status: 422 }
          );
        }
        if (val.length < 8) {
          return NextResponse.json(
            { error: `${key}: API key is too short — check you pasted the full key` },
            { status: 422 }
          );
        }
        await setServerSetting(key, val);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
