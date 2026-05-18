/**
 * API key management for Score-as-a-Service (P6-2).
 *
 * Keys are stored as SHA-256 hashes. The raw key is only returned once at
 * creation and is never stored. The prefix (first 8 chars) is stored for UI.
 *
 * Format: rm_<random 32-char hex>   e.g. rm_a3f9c2d14e8b7a...
 */

import { createHash, randomBytes } from "crypto";
import { prisma } from "./db";

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `rm_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 8);
  return { raw, hash, prefix };
}

export async function createApiKey(
  orgId: string,
  name: string,
): Promise<{ id: string; raw: string; prefix: string; createdAt: Date }> {
  const { raw, hash, prefix } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: { orgId, name, keyHash: hash, prefix },
  });
  return { id: key.id, raw, prefix, createdAt: key.createdAt };
}

export async function listApiKeys(orgId: string) {
  return prisma.apiKey.findMany({
    where: { orgId, revokedAt: null },
    select: { id: true, name: true, prefix: true, lastUsed: true, rateLimit: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeApiKey(id: string, orgId: string): Promise<boolean> {
  const result = await prisma.apiKey.updateMany({
    where: { id, orgId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/** Resolve a raw key from the Authorization header. Returns orgId if valid. */
export async function resolveApiKey(raw: string): Promise<string | null> {
  if (!raw.startsWith("rm_")) return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hash },
    select: { orgId: true, revokedAt: true, id: true },
  });
  if (!key || key.revokedAt) return null;

  // Update lastUsed asynchronously — fire and forget
  prisma.apiKey.update({ where: { id: key.id }, data: { lastUsed: new Date() } }).catch(() => {});
  return key.orgId;
}
