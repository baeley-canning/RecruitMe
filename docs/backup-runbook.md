# Backup & Restore Runbook

_Created 2026-07-28 after an audit found the production volume had **zero**
Railway backup schedules and **zero** backups — 16,772 candidates, 2,493
identities and 13,520 CV records on a single volume with nothing to restore from._

---

## What's protected, and what isn't

| | |
|---|---|
| **Postgres (420 MB)** | Covered by `scripts/backup-db.mjs` — all 35 models, ~183k rows |
| **CVs in the R2 bucket** | **NOT covered here.** 13,465 CVs live in `recruitme-cvs-*`; only 55 are inline in the DB. The bucket needs its own backup story. |
| **`CV_ENCRYPTION_KEY`** | **NOT in any backup, by design.** Lose it and every CV is unreadable *even with* a perfect DB restore. Keep it in a password manager. |

The biggest table is `Candidate` (283 MB) — the profile text is the moat.
`SearchRunResult` (86 MB) is regenerable and matters least.

---

## Take a backup

```bash
railway run --service Postgres node scripts/backup-db.mjs
# → ~/recruitme-backups/recruitme-<timestamp>.ndjson.gz   (~68 MB compressed)
```

Gzipped NDJSON, one row per line, types encoded losslessly (Date/BigInt/Buffer).
Models are enumerated from the generated Prisma client, so a **new table cannot
be silently missed**.

## Verify it (do this every time — untested backups are decoration)

```bash
railway run --service Postgres node scripts/verify-backup.mjs ~/recruitme-backups/<file>.ndjson.gz
```

Checks: decompresses, every line parses, per-model counts match **live**, and the
largest profile is compared **byte-for-byte** against the live row.

Last verified run (2026-07-28): 182,913 lines, 0 malformed, all 12 largest models
matched exactly, a 200,000-char profile byte-identical. ✅

## Restore

```bash
# 1. ALWAYS dry-run first — writes nothing, prints the plan
DATABASE_URL=<TARGET> node scripts/restore-db.mjs <file>.ndjson.gz

# 2. Apply (only into an EMPTY target; --force to override)
DATABASE_URL=<TARGET> node scripts/restore-db.mjs <file>.ndjson.gz --apply
```

Safety rails, both verified live:
- **Dry run by default** — nothing is written without `--apply`.
- **Refuses a non-empty target** without `--force`, so a mistyped URL can't
  overwrite production. (Confirmed: running `--apply` against prod refused.)
- Restores parents before children; `skipDuplicates` makes a re-run a top-up
  rather than a crash; a bad chunk falls back to row-by-row instead of aborting.

---

## Still outstanding

1. **Railway-native volume backups are OFF.** The API mutation
   (`volumeInstanceBackupScheduleUpdate`, kinds `DAILY|WEEKLY|MONTHLY`) returns
   **"Not Authorized"** for the current token/plan — so it needs doing in the
   Railway dashboard (Postgres service → volume → Backups), or a plan that
   includes it. Volume `postgres-volume`, id `0385e15a-967c-468d-a042-743f08e164fc`.
2. **Automate this script.** Today it is manual. Options: a Railway cron service,
   or a systemd timer on the box (always-on, unlike a laptop). Until then, run it
   before every risky change — schema migrations especially.
3. **Off-site copy.** The archive currently sits on one Mac. One machine is not a
   backup strategy.
4. **Bucket backup** for the 13,465 CVs.
5. **Delete the three empty `Postgres-*` shells** (155/134/157 MB) — they cost
   money and add restore-time confusion.

## Before any risky change

```bash
railway run --service Postgres node scripts/backup-db.mjs \
  && railway run --service Postgres node scripts/verify-backup.mjs ~/recruitme-backups/$(ls -t ~/recruitme-backups | head -1)
```
