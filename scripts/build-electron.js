#!/usr/bin/env node
/**
 * Prepares the Next.js standalone build for Electron packaging.
 * Copies static assets and public folder into the standalone directory
 * so the bundled server can serve them correctly.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const nextDir = path.join(root, ".next");
const standalone = path.join(nextDir, "standalone");

function run(cmd) {
  console.log("▶", cmd);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) { console.warn("  skip (not found):", src); return; }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log("  copied:", path.relative(root, src), "→", path.relative(root, dest));
}

// 1. Build Next.js
run("npx next build");

// 2. Verify standalone was produced
if (!fs.existsSync(standalone)) {
  console.error("ERROR: .next/standalone not found — ensure next.config has output: 'standalone'");
  process.exit(1);
}

// 3. Copy static assets into standalone (required for the standalone server to serve them)
copyDir(path.join(nextDir, "static"), path.join(standalone, ".next", "static"));
copyDir(path.join(root, "public"), path.join(standalone, "public"));

// 4. Create seed.db if one doesn't already exist
const seedDb = path.join(root, "prisma", "seed.db");
const devDb = path.join(root, "prisma", "dev.db");
if (!fs.existsSync(seedDb) && fs.existsSync(devDb)) {
  fs.copyFileSync(devDb, seedDb);
  console.log("  created prisma/seed.db from dev.db");
}

console.log("\n✅  Build complete — run electron-builder to package.\n");
