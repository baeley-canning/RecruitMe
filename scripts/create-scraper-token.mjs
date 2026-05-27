/**
 * Mint a ScraperApiToken for the headless-scraper ingest path.
 *
 * There's no UI for this (it's for the user's OWN mini-PC scraper pulling
 * their OWN candidate data) so this CLI is the way to issue a token. It:
 *   1. Generates a random bearer token (base64url, 32 random bytes).
 *   2. Stores ONLY its sha256 hex hash — the plaintext is never persisted.
 *   3. Prints the plaintext ONCE so you can paste it into the scraper config.
 *
 * Usage (locally or via Railway):
 *   node scripts/create-scraper-token.mjs <label> [orgId]
 *   railway run node scripts/create-scraper-token.mjs <label> [orgId]
 *
 *   <label>  required, human label e.g. "thinkcentre-scraper"
 *   [orgId]  optional; omit for owner-scope (token may ingest into any org)
 *
 * The token is shown ONCE and cannot be recovered — store it now.
 */

import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const label = process.argv[2];
const orgId = process.argv[3] ?? null;

if (!label) {
  console.error("Usage: node scripts/create-scraper-token.mjs <label> [orgId]");
  await prisma.$disconnect();
  process.exit(1);
}

// 32 random bytes → ~43-char base64url string. Plenty of entropy for a
// bearer token; base64url so it's header-safe (no +, /, or padding).
const token = crypto.randomBytes(32).toString("base64url");
const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

const row = await prisma.scraperApiToken.create({
  data: { label, orgId, tokenHash },
});

console.log("");
console.log("Scraper API token created.");
console.log(`  id:     ${row.id}`);
console.log(`  label:  ${row.label}`);
console.log(`  orgId:  ${row.orgId ?? "(owner-scope — any org)"}`);
console.log("");
console.log("  TOKEN (store this now — it will NOT be shown again):");
console.log("");
console.log(`    ${token}`);
console.log("");
console.log("  Send it as:  Authorization: Bearer <token>");
console.log("");

await prisma.$disconnect();
