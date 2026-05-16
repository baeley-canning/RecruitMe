import { NextResponse } from "next/server";
import JSZip from "jszip";
import fs from "fs";
import path from "path";
import { getAuth, unauthorized } from "@/lib/session";
import { reportError } from "@/lib/error-reporting";

const EXTENSION_DIR = path.join(process.cwd(), "browser-companion", "recruitme-opera-linkedin-capture");

// Files we deliberately don't ship to end users. Anything else in the extension
// directory is bundled — this prevents the kind of bug where the manifest
// references a file (e.g. options.html) that the hardcoded list forgot to
// include, which then causes Chrome's "Could not load manifest" cascade error.
const EXCLUDED = new Set([
  "README.md",
  "content.test.js", // dev-only test file, not part of the shipping extension
]);

export const dynamic = "force-dynamic";

export async function GET() {
  // Require auth — the extension itself doesn't embed secrets, but reading the
  // zip on every request does an unbounded fs scan + zip build per call.
  // Without a gate, this is a free CPU/IO amplifier for any anonymous caller.
  const auth = await getAuth();
  if (!auth) return unauthorized();
  try {
    const zip = new JSZip();
    const folder = zip.folder("recruitme-extension")!;
    let version = "unknown";

    const entries = fs.readdirSync(EXTENSION_DIR, { withFileTypes: true });
    for (const entry of entries) {
      // Skip directories, dotfiles, and explicitly-excluded files. If a
      // sub-directory is added later (icons, locales) extend this to recurse.
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (EXCLUDED.has(entry.name)) continue;

      const filePath = path.join(EXTENSION_DIR, entry.name);
      const content = fs.readFileSync(filePath);
      if (entry.name === "manifest.json") {
        try {
          version = JSON.parse(content.toString("utf8")).version ?? version;
        } catch {
          version = "unknown";
        }
      }
      folder.file(entry.name, content);
    }

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="recruitme-extension.zip"',
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store, max-age=0",
        "X-RecruitMe-Extension-Version": version,
      },
    });
  } catch (err) {
    reportError(err, { route: "extension/download" });
    return NextResponse.json({ error: "Failed to build extension zip" }, { status: 500 });
  }
}
