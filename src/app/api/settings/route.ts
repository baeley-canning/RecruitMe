import { NextResponse } from "next/server";
import { getServerSetting, setServerSetting } from "@/lib/settings";
import { getAuth, unauthorized } from "@/lib/session";

const MANAGED_KEYS = ["PDL_API_KEY", "SERPAPI_API_KEY", "BING_API_KEY"];

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
  const body = await req.json() as Record<string, string>;

  for (const key of MANAGED_KEYS) {
    if (key in body) {
      const val = body[key]?.trim() ?? "";
      if (val) {
        await setServerSetting(key, val);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
