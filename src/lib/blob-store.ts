/**
 * Object-store backend for candidate file blobs (CVs, cover letters, photos).
 *
 * WHY THIS EXISTS
 * ---------------
 * Today every CandidateFile blob lives base64-in-Postgres (`CandidateFile.data`).
 * At scale that bloats the DB (~1.33x the raw bytes) and, once the app + DB move
 * to managed Postgres, it makes storage and query latency expensive. This module
 * lets the file routes write the (already AES-256-GCM encrypted) envelope to an
 * S3-compatible bucket — Cloudflare R2 in our case — and keep only a pointer in
 * the row.
 *
 * ENCRYPTION BOUNDARY
 * -------------------
 * This module is encryption-agnostic. Callers hand it the `v1:iv:tag:ciphertext`
 * envelope produced by `cv-encryption.ts` and that exact string is what lands in
 * the bucket. R2 therefore never holds plaintext — the at-rest guarantee is
 * identical to the Postgres path. Decryption still happens in the app with the
 * CV_ENCRYPTION_KEY, which never leaves the app tier.
 *
 * INERT UNTIL CONFIGURED
 * ----------------------
 * With no `BLOB_S3_*` env set, `isBlobStoreConfigured()` is false and the file
 * routes behave byte-for-byte as they do today (blob in `CandidateFile.data`,
 * `storageKey` null). Flip the env on (and apply the `storageKey` column) and
 * new uploads start landing in the bucket; existing rows keep working until the
 * one-off migration script moves them.
 *
 * NO SDK
 * ------
 * We sign requests with SigV4 by hand against the S3 REST API (PUT/GET/DELETE on
 * a single object) rather than pulling in `@aws-sdk/client-s3` (~3MB of deps).
 * That matches the rest of this codebase's roll-your-own-crypto posture
 * (cv-encryption, the age-encrypted backups) and keeps cold-start small.
 */

import { createHash, createHmac, randomBytes } from "crypto";

interface BlobConfig {
  endpoint: string; // e.g. https://<acct>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string; // "auto" for R2
}

let cached: BlobConfig | null | undefined;
// One-shot guard so the key-durability warning (below) logs once per process,
// not on every upload.
let warnedNoExplicitKey = false;

function readConfig(): BlobConfig | null {
  if (cached !== undefined) return cached;
  const endpoint = process.env.BLOB_S3_ENDPOINT?.trim();
  const bucket = process.env.BLOB_S3_BUCKET?.trim();
  const accessKeyId = process.env.BLOB_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.BLOB_S3_SECRET_ACCESS_KEY?.trim();
  const region = process.env.BLOB_S3_REGION?.trim() || "auto";
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    cached = null;
    return cached;
  }
  cached = {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
  };
  return cached;
}

/** Test-only: drop the cached config so a test can swap env vars. @internal */
export function _resetBlobConfigForTests(): void {
  cached = undefined;
  warnedNoExplicitKey = false;
}

/** True when an S3/R2 bucket is configured. When false, callers must fall back
 *  to storing the blob in Postgres (`CandidateFile.data`). */
export function isBlobStoreConfigured(): boolean {
  return readConfig() !== null;
}

// --- SigV4 ------------------------------------------------------------------

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC-3986 encode a single path segment. S3 requires the canonical URI to be
 *  percent-encoded, with `/` left literal between segments. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** ISO8601 basic format (YYYYMMDDTHHMMSSZ) without separators, as SigV4 wants. */
function amzDate(now: Date): { amzdate: string; datestamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  // iso is now like 20260531T091500Z
  return { amzdate: iso, datestamp: iso.slice(0, 8) };
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

function signRequest(
  cfg: BlobConfig,
  method: "PUT" | "GET" | "DELETE",
  key: string,
  body: Buffer | null,
  now: Date,
): SignedRequest {
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = `/${encodeSegment(cfg.bucket)}/${key
    .split("/")
    .map(encodeSegment)
    .join("/")}`;
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const { amzdate, datestamp } = amzDate(now);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzdate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${datestamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzdate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, datestamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${cfg.endpoint}${canonicalUri}`,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzdate,
    },
  };
}

// --- Public API -------------------------------------------------------------

function requireConfig(): BlobConfig {
  const cfg = readConfig();
  if (!cfg) {
    throw new Error(
      "Blob store not configured (set BLOB_S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY)",
    );
  }
  return cfg;
}

/**
 * Build the deterministic key under which a blob is stored. Keyed on a random
 * id rather than the CandidateFile id so the upload path can compute it before
 * the DB row exists (and so the key carries no PII).
 */
export function makeBlobKey(randomId: string): string {
  return `candidate-files/${randomId}`;
}

/** Upload an (already-encrypted) blob envelope. Throws on non-2xx. */
export async function putBlob(key: string, body: string): Promise<void> {
  const cfg = requireConfig();
  const buf = Buffer.from(body, "utf8");
  const { url, headers } = signRequest(cfg, "PUT", key, buf, new Date());
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "text/plain", "Content-Length": String(buf.length) },
    body: buf,
  });
  if (!res.ok) {
    throw new Error(`blob put failed: ${res.status} ${await safeText(res)}`);
  }
}

/** Fetch a blob envelope. Throws on non-2xx (including 404). */
export async function getBlob(key: string): Promise<string> {
  const cfg = requireConfig();
  const { url, headers } = signRequest(cfg, "GET", key, null, new Date());
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`blob get failed: ${res.status} ${await safeText(res)}`);
  }
  return res.text();
}

/** Delete a blob. Best-effort: a non-2xx (e.g. already gone) is swallowed. */
export async function deleteBlob(key: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) return;
  try {
    const { url, headers } = signRequest(cfg, "DELETE", key, null, new Date());
    await fetch(url, { method: "DELETE", headers });
  } catch {
    // Orphaned object is a minor storage cost, never a correctness problem.
  }
}

// --- Policy layer: where does this row's blob live? -------------------------
//
// These two helpers are the only thing the file routes need. They keep the
// DB-vs-bucket decision in one place so the routes stay readable.

/**
 * Decide where a freshly-encrypted envelope is stored and return the values to
 * write onto the CandidateFile row. When a bucket is configured the envelope is
 * uploaded and `data` is left empty (the row just carries the `storageKey`
 * pointer); otherwise the envelope goes inline in `data` exactly as before.
 */
export async function persistFileEnvelope(
  envelope: string,
): Promise<{ data: string; storageKey: string | null }> {
  if (!isBlobStoreConfigured()) return { data: envelope, storageKey: null };
  // Key-durability footgun: with blobs in the bucket and CV_ENCRYPTION_KEY
  // unset, the only copy of the decryption key lives in the Postgres `Setting`
  // table (cv-encryption.ts). Losing that DB — or restoring a backup predating
  // the key row — would make every bucket blob permanently unreadable. Warn
  // loudly (once) so this surfaces in logs before it bites. See .env.example.
  if (!warnedNoExplicitKey && !process.env.CV_ENCRYPTION_KEY?.trim()) {
    warnedNoExplicitKey = true;
    console.warn(
      "[blob-store] Offloading encrypted CVs to the bucket while CV_ENCRYPTION_KEY " +
        "is unset — the decryption key exists only in the Postgres `Setting` table. " +
        "If that DB is lost/restored-old, the bucket blobs become unreadable. " +
        "Set CV_ENCRYPTION_KEY explicitly (openssl rand -base64 32) — see .env.example.",
    );
  }
  const key = makeBlobKey(randomBytes(16).toString("hex"));
  await putBlob(key, envelope);
  return { data: "", storageKey: key };
}

/**
 * Return the stored (still-encrypted) envelope for a row, from the bucket when
 * `storageKey` is set, else from the inline `data` column. The caller decrypts.
 */
export async function loadFileEnvelope(file: {
  data: string;
  storageKey: string | null;
}): Promise<string> {
  if (file.storageKey) return getBlob(file.storageKey);
  return file.data;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
