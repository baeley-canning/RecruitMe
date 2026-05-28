import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(raw: string): Buffer {
  // Accept either a 32-byte hex string or an arbitrary passphrase.
  if (/^[0-9a-f]{64}$/i.test(raw.trim())) {
    return Buffer.from(raw.trim(), "hex");
  }
  return createHash("sha256").update(raw).digest();
}

export function encrypt(data: string, keyRaw: string): string {
  const key = deriveKey(keyRaw);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(blob: string, keyRaw: string): string {
  const key = deriveKey(keyRaw);
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
