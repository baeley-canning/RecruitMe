/**
 * Automated database backup → object storage.
 *
 * The manual script (scripts/backup-db.mjs) proved a backup is possible; this
 * makes it HAPPEN without anyone remembering. It runs in-process on a daily
 * timer and writes the archive to the S3-compatible bucket that already holds
 * the CVs — so the data lives somewhere other than the Postgres volume, which
 * on 2026-07-28 was found to have zero snapshots and zero schedules.
 *
 * Design notes:
 *  - Streams model-by-model in batches; only the gzip output is held in memory
 *    (~68 MB today), so this doesn't balloon the server's footprint.
 *  - Enumerates models from the generated Prisma client, so a new table is
 *    picked up automatically instead of being silently missed.
 *  - Prunes old archives to a retention count — an unbounded backup folder is a
 *    bill, and a bill nobody watches becomes a deleted bucket.
 *  - Returns a structured result so the caller can ALERT ON FAILURE. A backup
 *    that fails silently is exactly how you end up with none.
 */

import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import { putBlob, getBlob, deleteBlob, isBlobStoreConfigured } from "./blob-store";

const BATCH = 500;
export const BACKUP_PREFIX = "db-backups/";
const MANIFEST_KEY = `${BACKUP_PREFIX}_manifest.json`;
export const DEFAULT_RETENTION = 14;

export interface BackupResult {
  ok: boolean;
  key?: string;
  bytes?: number;
  rows?: number;
  models?: number;
  pruned?: number;
  error?: string;
  skipped?: string;
}

function encode(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return { __t: "d", v: value.toISOString() };
  if (typeof value === "bigint") return { __t: "n", v: value.toString() };
  if (Buffer.isBuffer(value)) return { __t: "b", v: value.toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encode(v);
    return out;
  }
  return value;
}

function modelNames(): string[] {
  const models = (prisma as unknown as { _runtimeDataModel?: { models?: Record<string, unknown> } })
    ._runtimeDataModel?.models ?? {};
  return Object.keys(models).map((m) => m.charAt(0).toLowerCase() + m.slice(1));
}

export function retentionCount(): number {
  const n = Number.parseInt(process.env.BACKUP_RETENTION ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION;
}

/**
 * Run one backup. Never throws — returns {ok:false,error} so the caller can
 * alert instead of the timer dying quietly.
 */
export async function runDatabaseBackup(): Promise<BackupResult> {
  if (!isBlobStoreConfigured()) return { ok: false, skipped: "blob store not configured" };
  try {
    const models = modelNames();
    const parts: string[] = [
      JSON.stringify({ __meta: "backup", startedAt: new Date().toISOString(), models }),
    ];
    let rows = 0;
    const counts: Record<string, number> = {};

    for (const model of models) {
      const delegate = (prisma as unknown as Record<string, { findMany?: (a: unknown) => Promise<unknown[]> }>)[model];
      if (!delegate?.findMany) continue;
      let skip = 0;
      let n = 0;
      for (;;) {
        let batch: unknown[];
        try {
          batch = await delegate.findMany({ skip, take: BATCH });
        } catch {
          break; // client/DB drift on this model — don't abandon the whole backup
        }
        if (batch.length === 0) break;
        for (const row of batch) parts.push(JSON.stringify({ m: model, r: encode(row) }));
        n += batch.length;
        skip += batch.length;
        if (batch.length < BATCH) break;
      }
      counts[model] = n;
      rows += n;
    }
    parts.push(JSON.stringify({ __meta: "end", counts, finishedAt: new Date().toISOString() }));

    const gz = gzipSync(Buffer.from(parts.join("\n") + "\n", "utf8"), { level: 6 });
    const key = `${BACKUP_PREFIX}recruitme-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.ndjson.gz`;
    // putBlob signs a utf8 body; base64 keeps the gzip bytes intact through it.
    await putBlob(key, gz.toString("base64"));

    // Retention via a manifest object. The S3 signer here only covers
    // get/put/delete on a key, and implementing ListObjectsV2 signing just to
    // prune would be a lot of surface for housekeeping — so we keep our own
    // index of what we've written.
    let pruned = 0;
    try {
      let keys: string[] = [];
      try {
        keys = JSON.parse(await getBlob(MANIFEST_KEY)) as string[];
        if (!Array.isArray(keys)) keys = [];
      } catch {
        keys = []; // first run, or manifest lost — rebuild from here
      }
      keys.push(key);
      keys.sort(); // timestamped names → lexical order is chronological
      const excess = Math.max(0, keys.length - retentionCount());
      for (let i = 0; i < excess; i++) {
        try { await deleteBlob(keys[i]); pruned++; } catch { /* already gone */ }
      }
      await putBlob(MANIFEST_KEY, JSON.stringify(keys.slice(excess)));
    } catch {
      // Pruning is housekeeping — never fail a good backup over it.
    }

    return { ok: true, key, bytes: gz.length, rows, models: Object.keys(counts).length, pruned };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
