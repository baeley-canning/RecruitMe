import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "./db";

/**
 * CV-at-rest encryption (audit P2 HIGH).
 *
 * CVs live as base64 in `CandidateFile.data`. Without this layer every Railway
 * backup contains every CV in plaintext-equivalent form (a base64 string a
 * grade-schooler can decode), which is a NZ Privacy Act exposure.
 *
 * Scope of this module:
 *   - AES-256-GCM with a 12-byte IV per row.
 *   - Storage format:  v1:<base64-iv>:<base64-tag>:<base64-ciphertext>
 *   - The leading "v1:" sentinel lets the decrypt path tell encrypted blobs
 *     from legacy plain-base64 rows so we can keep reading old data while we
 *     lazily migrate it.
 *   - Key source order:
 *       1. `process.env.CV_ENCRYPTION_KEY` — 32 bytes, base64-encoded.
 *       2. `Setting` row with `key = "cv.encryption.v1"`. Created on demand
 *          on the first encrypt call.
 *   - Letting the key live in Postgres makes self-hosters' "it just works"
 *     deployment story easier. If a deployer can keep a stable env var they
 *     should — env wins.
 *
 *   FAILURE MODE: if the Setting row is wiped (DB restore from a backup that
 *   pre-dates the key's creation, manual deletion, accidental truncate) every
 *   `v1:`-encrypted row becomes unreadable. The plaintext base64 is gone too,
 *   because we re-encrypt on read. Operationally: back up the Setting table
 *   alongside CandidateFile, or set `CV_ENCRYPTION_KEY` in Railway so the
 *   key is reproducible from outside the DB. To stop a silent-corruption
 *   compounding, `loadKey` now FAILS CLOSED — it refuses to mint a fresh key
 *   when encrypted rows already exist, so a missing key surfaces as a loud
 *   error rather than a new divergent key written over lost data.
 */

const SETTING_KEY = "cv.encryption.v1";
const VERSION_PREFIX = "v1:";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12;  // GCM standard
const TAG_BYTES = 16; // GCM auth tag

/** Module-level cache so the per-request hot path doesn't hit Postgres. */
let cachedKey: Buffer | null = null;

/** Throttle for the lazy re-encrypt background job. */
const lastMigrationAt = new Map<string, number>();
const MIGRATION_THROTTLE_MS = 1_000;

function parseKey(b64: string): Buffer {
  const buf = Buffer.from(b64.trim(), "base64");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `CV encryption key must decode to ${KEY_BYTES} bytes; got ${buf.length}`,
    );
  }
  return buf;
}

async function loadKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.CV_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    cachedKey = parseKey(fromEnv);
    return cachedKey;
  }

  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (row?.value) {
    cachedKey = parseKey(row.value);
    return cachedKey;
  }

  // FAIL-CLOSED (audit Phase 0.3): no env key and no Setting row. Before we
  // mint a brand-new key, make sure we're not about to ORPHAN existing
  // encrypted CVs. If any `v1:`-encrypted row already exists, the real key was
  // lost (DB restored from a pre-key backup, env wiped, Setting truncated) — a
  // fresh key could never decrypt those rows, and minting one would also start
  // writing NEW rows under a divergent key, compounding the corruption. Refuse
  // loudly instead so the operator restores the key rather than silently losing
  // every CV.
  const existingEncrypted = await prisma.candidateFile.findFirst({
    where: { data: { startsWith: VERSION_PREFIX } },
    select: { id: true },
  });
  if (existingEncrypted) {
    throw new Error(
      "CV encryption key is missing but encrypted CVs already exist. Refusing " +
      "to generate a new key (it could never decrypt them). Restore " +
      "CV_ENCRYPTION_KEY (or the cv.encryption.v1 Setting row) before serving CVs.",
    );
  }

  // Genuinely fresh install (no key anywhere, no encrypted data) — safe to
  // bootstrap. The `create` may race with another worker; if so the second
  // insert collides on the primary key and we just re-read.
  const generated = randomBytes(KEY_BYTES);
  try {
    await prisma.setting.create({
      data: { key: SETTING_KEY, value: generated.toString("base64") },
    });
    cachedKey = generated;
    return cachedKey;
  } catch {
    const winner = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    if (!winner?.value) {
      throw new Error("Failed to bootstrap CV encryption key");
    }
    cachedKey = parseKey(winner.value);
    return cachedKey;
  }
}

/**
 * Test-only: drop the in-memory key cache so a test can swap env vars.
 * @internal
 */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
  lastMigrationAt.clear();
}

/**
 * Encrypt a base64-encoded CV blob. Output is itself a string (the
 * `v1:iv:tag:ciphertext` envelope) so it slots straight into the existing
 * `CandidateFile.data` TEXT column with no schema change.
 */
export async function encryptCv(plainBase64: string): Promise<string> {
  const key = await loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainBase64, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a stored CV blob. Returns the original base64 string.
 *
 * Legacy passthrough: a row without the `v1:` prefix is a pre-encryption
 * upload — return it unchanged so old files keep working.
 *
 * Throws on tampered / wrong-key ciphertext (GCM auth tag mismatch).
 */
export async function decryptCv(stored: string): Promise<string> {
  if (!stored.startsWith(VERSION_PREFIX)) return stored;

  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Malformed CV ciphertext envelope");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("CV ciphertext header has wrong IV/tag length");
  }

  const key = await loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Returns true if the stored blob is already in the encrypted format.
 * Useful for the lazy-migration path so callers don't need to know the
 * envelope shape.
 */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(VERSION_PREFIX);
}

/**
 * Fire-and-forget lazy migration. When a legacy plain-base64 row is read,
 * encrypt it and write back so subsequent reads are encrypted. Throttled to
 * one migration per second per file ID per process so a hot CV doesn't spam
 * the DB if multiple recruiters refresh the same candidate page.
 *
 * Callers must `void` the returned promise — errors are intentionally
 * swallowed because failing to migrate is not a user-facing failure.
 */
export async function maybeMigrateLegacy(
  fileId: string,
  plainBase64: string,
): Promise<void> {
  const now = Date.now();
  const last = lastMigrationAt.get(fileId) ?? 0;
  if (now - last < MIGRATION_THROTTLE_MS) return;
  lastMigrationAt.set(fileId, now);

  try {
    const envelope = await encryptCv(plainBase64);
    await prisma.candidateFile.update({
      where: { id: fileId },
      data: { data: envelope },
    });
  } catch {
    // Best-effort. The next read will retry once the throttle window clears.
  }
}
