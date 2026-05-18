import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const extensionDir = __dirname;
const repoRoot = path.resolve(extensionDir, "..", "..");

describe("desktop extension setup contract", () => {
  it("keeps manifest-referenced extension entrypoints present", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
    const referencedFiles = new Set<string>();

    referencedFiles.add(manifest.background.service_worker);
    referencedFiles.add(manifest.action.default_popup);
    referencedFiles.add(manifest.options_ui.page);

    for (const script of manifest.content_scripts ?? []) {
      for (const file of script.js ?? []) referencedFiles.add(file);
    }

    for (const file of referencedFiles) {
      expect(fs.existsSync(path.join(extensionDir, file)), `${file} should exist`).toBe(true);
    }
  });

  it("copies the extension options page when the desktop app prepares an unpacked folder", () => {
    const electronMain = fs.readFileSync(path.join(repoRoot, "electron", "main.js"), "utf8");

    expect(electronMain).toContain("\"options.html\"");
    expect(electronMain).toContain("\"options.js\"");
  });

  it("allows desktop RecruitMe to run on a non-3000 localhost port", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

    expect(manifest.host_permissions).toContain("http://localhost/*");
    expect(manifest.host_permissions).toContain("http://127.0.0.1/*");
    expect(manifest.host_permissions).not.toContain("http://localhost:3000/*");
  });
});
