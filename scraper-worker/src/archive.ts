/**
 * JobAdder archive writer. The scraper writes here — NOT through RecruitMe's
 * API — so the archive on the mini-PC is preserved exactly as scraped,
 * independent of any RecruitMe schema changes. RecruitMe imports from this
 * archive separately via `scripts/import-jobadder-archive.mjs`.
 *
 * Storage:
 *   • Structured fields → Postgres `jobadder_archive` DB (separate from
 *     `recruitme`), connected via JOBADDER_ARCHIVE_URL.
 *   • Binary files (CVs / photos) → filesystem at
 *     /home/baeley/jobadder-archive/files/<jobAdderId>/<filename>. The Postgres
 *     `file` row holds the path + dataHash; the bytes live on disk so we don't
 *     bloat the DB or its backups.
 *
 * Idempotency:
 *   • Candidate upserts are ON CONFLICT(job_adder_id) DO UPDATE — re-running
 *     a scrape refreshes the row with the latest data.
 *   • Files dedup via UNIQUE(job_adder_id, data_hash) — identical bytes
 *     written twice = no-op.
 *   • Notes are wiped + re-inserted per candidate per scrape, so the archive
 *     mirrors the current set of notes (JobAdder's DOM has no stable note ids
 *     we can dedup on otherwise).
 */

import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { log } from "./util/log.js";

const FILES_ROOT =
  process.env.JOBADDER_ARCHIVE_FILES_DIR ??
  "/home/baeley/jobadder-archive/files";

// Lazy pool — the worker can boot without JOBADDER_ARCHIVE_URL set (Phase D
// might be off), and only crashes if a job actually tries to write to the
// archive. Phase B (LinkedIn) and existing LinkedIn/SEEK profile scrapes
// don't touch the archive so they're unaffected.
let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (_pool) return _pool;
  const archiveUrl = process.env.JOBADDER_ARCHIVE_URL;
  if (!archiveUrl) {
    throw new Error(
      "JOBADDER_ARCHIVE_URL not set — add it to /home/baeley/scraper-worker/.env",
    );
  }
  _pool = new pg.Pool({ connectionString: archiveUrl, max: 4 });
  return _pool;
}

export type FileCategory = "cv" | "cover" | "other" | "photo";

export interface ArchiveCandidate {
  jobAdderId: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  currentTitle?: string | null;
  currentEmployer?: string | null;
  profileText?: string | null;
  jobAdderUrl: string;
  rawJson?: unknown;
}

export async function upsertArchiveCandidate(c: ArchiveCandidate): Promise<void> {
  await getPool().query(
    `INSERT INTO candidate (
       job_adder_id, name, first_name, last_name, email, phone, location,
       current_title, current_employer, profile_text, job_adder_url,
       scraped_at, raw_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12)
     ON CONFLICT (job_adder_id) DO UPDATE SET
       name              = EXCLUDED.name,
       first_name        = EXCLUDED.first_name,
       last_name         = EXCLUDED.last_name,
       email             = EXCLUDED.email,
       phone             = EXCLUDED.phone,
       location          = EXCLUDED.location,
       current_title     = EXCLUDED.current_title,
       current_employer  = EXCLUDED.current_employer,
       profile_text      = EXCLUDED.profile_text,
       job_adder_url     = EXCLUDED.job_adder_url,
       scraped_at        = EXCLUDED.scraped_at,
       raw_json          = EXCLUDED.raw_json`,
    [
      c.jobAdderId,
      c.name ?? null,
      c.firstName ?? null,
      c.lastName ?? null,
      c.email ?? null,
      c.phone ?? null,
      c.location ?? null,
      c.currentTitle ?? null,
      c.currentEmployer ?? null,
      c.profileText ?? null,
      c.jobAdderUrl,
      c.rawJson != null ? JSON.stringify(c.rawJson) : null,
    ],
  );
}

export async function saveArchiveFile(args: {
  jobAdderId: string;
  category: FileCategory;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<{ saved: boolean; reason?: string }> {
  const { jobAdderId, category, filename, mimeType, bytes } = args;
  if (bytes.length === 0) return { saved: false, reason: "empty" };

  // Same 32-hex-char prefix shape as RecruitMe's CandidateFile.dataHash — makes
  // re-importing into RecruitMe later cheaper to dedup.
  const dataHash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);

  // Fast-path dedup: skip the filesystem write entirely if we already have
  // this exact file for this candidate.
  const existing = await getPool().query(
    `SELECT id FROM file WHERE job_adder_id = $1 AND data_hash = $2 LIMIT 1`,
    [jobAdderId, dataHash],
  );
  if ((existing.rowCount ?? 0) > 0) return { saved: false, reason: "duplicate" };

  const candidateDir = join(FILES_ROOT, jobAdderId);
  await mkdir(candidateDir, { recursive: true });
  // Sanitise filename — JobAdder filenames can contain weird chars + we don't
  // want directory traversal. Keep alnum, dot, dash, underscore.
  const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "file";
  const fsPath = join(candidateDir, safeFilename);
  await writeFile(fsPath, bytes);

  await getPool().query(
    `INSERT INTO file (
       job_adder_id, category, filename, mime_type, size_bytes, fs_path,
       data_hash, scraped_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (job_adder_id, data_hash) DO NOTHING`,
    [jobAdderId, category, filename, mimeType, bytes.length, fsPath, dataHash],
  );
  return { saved: true };
}

export async function deleteArchiveNotesForCandidate(jobAdderId: string): Promise<void> {
  await getPool().query(`DELETE FROM note WHERE job_adder_id = $1`, [jobAdderId]);
}

export async function saveArchiveNote(args: {
  jobAdderId: string;
  author?: string | null;
  body: string;
  createdAtJobAdder?: Date | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO note (job_adder_id, author, body, created_at_jobadder, scraped_at)
     VALUES ($1, $2, $3, $4, now())`,
    [args.jobAdderId, args.author ?? null, args.body, args.createdAtJobAdder ?? null],
  );
}

export async function closeArchive(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  log.info("archive: connection pool closed");
}
