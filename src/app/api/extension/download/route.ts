import { NextResponse } from "next/server";
import JSZip from "jszip";
import fs from "fs";
import path from "path";

const EXTENSION_DIR = path.join(process.cwd(), "browser-companion", "recruitme-opera-linkedin-capture");
const FILES = ["manifest.json", "background.js", "content.js", "popup.html", "popup.js"];

export async function GET() {
  try {
    const zip = new JSZip();
    const folder = zip.folder("recruitme-extension")!;

    for (const file of FILES) {
      const filePath = path.join(EXTENSION_DIR, file);
      if (fs.existsSync(filePath)) {
        folder.file(file, fs.readFileSync(filePath));
      }
    }

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="recruitme-extension.zip"',
        "Content-Length": String(buffer.length),
      },
    });
  } catch (err) {
    console.error("Extension download error:", err);
    return NextResponse.json({ error: "Failed to build extension zip" }, { status: 500 });
  }
}
