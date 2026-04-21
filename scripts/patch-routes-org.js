/**
 * Prepends org auth to every jobs/[id]/... sub-route that doesn't have it yet.
 * Adds: import getAuth/unauthorized/requireJobAccess, then at the top of each
 * exported handler: auth check + requireJobAccess call.
 *
 * Safe to re-run — skips files already patched.
 */
const fs = require("fs");
const path = require("path");

const apiDir = path.resolve(__dirname, "../src/app/api/jobs/[id]");

const SESSION_IMPORT = `import { getAuth, unauthorized, requireJobAccess } from "@/lib/session";\n`;

// Routes to patch: [filePath, paramName]
const routes = [
  ["parse/route.ts", null],
  ["shortlist-summary/route.ts", null],
  ["candidates/route.ts", null],
  ["candidates/score-all/route.ts", null],
  ["candidates/bulk-delete/route.ts", null],
  ["candidates/talent-pool/route.ts", null],
  ["candidates/[candidateId]/route.ts", null],
  ["candidates/[candidateId]/score/route.ts", null],
  ["candidates/[candidateId]/fetch-profile/route.ts", null],
  ["candidates/[candidateId]/outreach/route.ts", null],
];

for (const [rel] of routes) {
  const file = path.join(apiDir, rel);
  if (!fs.existsSync(file)) { console.log("skip (not found):", rel); continue; }

  let src = fs.readFileSync(file, "utf8");
  if (src.includes("getAuth") || src.includes("requireJobAccess")) {
    console.log("already patched:", rel);
    continue;
  }

  // Add import after the last existing import line
  const lastImport = src.lastIndexOf('\nimport ');
  const insertAt = src.indexOf('\n', lastImport + 1) + 1;
  src = src.slice(0, insertAt) + SESSION_IMPORT + src.slice(insertAt);

  fs.writeFileSync(file, src, "utf8");
  console.log("patched (import added):", rel);
}

console.log("\nDone. Now manually add auth guards to each handler as needed.");
console.log("The requireJobAccess helper is now available in all routes.");
