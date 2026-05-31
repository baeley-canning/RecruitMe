/**
 * One-off: move existing CandidateFile blobs out of Postgres into the S3/R2
 * blob store.
 *
 *   DRY-RUN (default):  node scripts/migrate-files-to-r2.mjs
 *   APPLY:              node scripts/migrate-files-to-r2.mjs --apply
 *   APPLY a batch:      node scripts/migrate-files-to-r2.mjs --apply --limit 500
 *
 * For each row where `storageKey IS NULL` and the inline `data` holds an
 * ENCRYPTED envelope (`v1:` prefix), it uploads that exact envelope to the
 * bucket and rewrites the row to `{ storageKey: <key>, data: "" }`. The blob in
 * the bucket is byte-identical to what was in Postgres, so the at-rest
 * encryption guarantee is preserved and the read path is unchanged.
 *
 * SAFETY:
 *   • Dry-run by default — prints what it WOULD do and touches nothing.
 *   • Idempotent — already-migrated rows (storageKey set) are skipped, so a
 *     re-run after an interruption resumes cleanly.
 *   • Verifies each upload with a read-back before nulling the inline `data`,
 *     so a failed/partial PUT can never lose the only copy of a CV.
 *   • LEGACY PLAINTEXT rows (no `v1:` prefix — pre-encryption uploads) are
 *     SKIPPED and counted, never uploaded: we will not put plaintext in the
 *     bucket. They heal to `v1:` on next download (the lazy re-encrypt in
 *     cv-encryption.ts), after which a later run of this script picks them up.
 *
 * This script is self-contained (its own SigV4 signer, plain `node`, no deps)
 * so it can be scp'd to the box and run directly. The canonical signer lives in
 * src/lib/blob-store.ts — keep the two in sync if the signing ever changes.
 */

import { PrismaClient } from "@prisma/client";
import { createHash, createHmac, randomBytes } from "crypto";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : null;

const prisma = new PrismaClient();

// --- config -----------------------------------------------------------------

function loadConfig() {
  const endpoint = process.env.BLOB_S3_ENDPOINT?.trim();
  const bucket = process.env.BLOB_S3_BUCKET?.trim();
  const accessKeyId = process.env.BLOB_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.BLOB_S3_SECRET_ACCESS_KEY?.trim();
  const region = process.env.BLOB_S3_REGION?.trim() || "auto";
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Set BLOB_S3_ENDPOINT / BLOB_S3_BUCKET / BLOB_S3_ACCESS_KEY_ID / BLOB_S3_SECRET_ACCESS_KEY",
    );
  }
  return { endpoint: endpoint.replace(/\/+$/, ""), bucket, accessKeyId, secretAccessKey, region };
}

// --- SigV4 (mirror of src/lib/blob-store.ts) --------------------------------

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d, "utf8").digest();
const encodeSegment = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function sign(cfg, method, key, body) {
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = `/${encodeSegment(cfg.bucket)}/${key.split("/").map(encodeSegment).join("/")}`;
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const datestamp = iso.slice(0, 8);
  const canonicalHeaders =
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${iso}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${datestamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", iso, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, datestamp), cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    url: `${cfg.endpoint}${canonicalUri}`,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": iso,
    },
  };
}

async function putBlob(cfg, key, bodyStr) {
  const buf = Buffer.from(bodyStr, "utf8");
  const { url, headers } = sign(cfg, "PUT", key, buf);
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "text/plain", "Content-Length": String(buf.length) },
    body: buf,
  });
  if (!res.ok) throw new Error(`PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function getBlob(cfg, key) {
  const { url, headers } = sign(cfg, "GET", key, null);
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return res.text();
}

// --- migration ---------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  console.log(`[migrate-files-to-r2] mode=${APPLY ? "APPLY" : "DRY-RUN"} bucket=${cfg.bucket}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  // Page through in bounded batches with a keyset cursor on id, rather than one
  // findMany that pulls every row's `data` into memory at once (a 14k-CV table
  // would OOM the 2-core box). Migrated rows (storageKey set) and skipped
  // legacy rows both fall behind the cursor, so the scan always advances and
  // terminates — no offset bookkeeping, resumable after an interruption.
  const BATCH = 200;
  let migrated = 0;
  let skippedLegacy = 0;
  let bytes = 0;
  let failed = 0;
  let examined = 0;
  let cursorId = null;
  let stop = false;

  while (!stop) {
    const batch = await prisma.candidateFile.findMany({
      where: {
        storageKey: null,
        NOT: { data: "" },
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      select: { id: true, data: true, size: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      cursorId = row.id;
      if (LIMIT !== null && Number.isFinite(LIMIT) && examined >= LIMIT) {
        stop = true;
        break;
      }
      examined++;

      if (!row.data.startsWith("v1:")) {
        skippedLegacy++;
        continue;
      }
      if (!APPLY) {
        migrated++;
        bytes += row.size ?? 0;
        continue;
      }
      const key = `candidate-files/${randomBytes(16).toString("hex")}`;
      try {
        await putBlob(cfg, key, row.data);
        // Read-back verification before we drop the only inline copy.
        const readBack = await getBlob(cfg, key);
        if (readBack !== row.data) throw new Error("read-back mismatch");
        await prisma.candidateFile.update({
          where: { id: row.id },
          data: { storageKey: key, data: "" },
        });
        migrated++;
        bytes += row.size ?? 0;
        if (migrated % 100 === 0) console.log(`  …${migrated} migrated`);
      } catch (err) {
        failed++;
        console.error(`  ✗ ${row.id}: ${err.message}`);
      }
    }
  }

  console.log(
    `[migrate-files-to-r2] ${APPLY ? "migrated" : "would migrate"} ${migrated} file(s) (~${(bytes / 1e6).toFixed(1)} MB), ` +
      `skipped ${skippedLegacy} legacy-plaintext row(s)${failed ? `, ${failed} FAILED` : ""}.`,
  );
  if (skippedLegacy > 0) {
    console.log(
      "  Legacy rows heal to encrypted on next download; re-run this script afterwards to move them.",
    );
  }
  if (!APPLY) console.log("  Dry run — nothing changed. Re-run with --apply to migrate.");

  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
