import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { extensionCorsHeaders } from "@/lib/extension-cors";

const EXTENSION_DIR = path.join(process.cwd(), "browser-companion", "recruitme-chrome-extension");

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: extensionCorsHeaders(req) });
}

/**
 * Returns the current extension version so the browser extension can compare
 * against its own version and prompt users to re-download when behind.
 */
export async function GET(req: Request) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")
    ) as { version?: string };
    return NextResponse.json(
      { version: manifest.version ?? "unknown", updateUrl: "/linkedin-setup" },
      { headers: extensionCorsHeaders(req) }
    );
  } catch {
    return NextResponse.json({ version: "unknown" }, { headers: extensionCorsHeaders(req) });
  }
}
