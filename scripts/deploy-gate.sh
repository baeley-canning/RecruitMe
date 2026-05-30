#!/usr/bin/env bash
# Deploy gate — run ON THE BOX (as baeley, with sudo access) after rsync,
# before cutting over to the new build. Sequence:
#   apply schema → build → REAL-DB smoke test → only then restart.
# If the smoke test fails (a raw-SQL statement Postgres rejects, like the
# left(text,bigint) regression), the OLD app keeps running and the deploy
# aborts — the error never reaches a recruiter as "Library · failed".
#
# Usage:  cd /home/baeley/RecruitMe && ./scripts/deploy-gate.sh
#
# /etc/recruitme/app.env is root-readable only, so the steps that need
# DATABASE_URL run via `sudo bash -c '... ; sudo -u baeley --preserve-env'`
# (the same pattern the manual deploys use). build needs no DB; restart
# needs sudo.
set -euo pipefail

APP_DIR=/home/baeley/RecruitMe
ENV_FILE=/etc/recruitme/app.env
cd "$APP_DIR"

run_with_db() {  # run "$@" as baeley with DATABASE_URL from the root env file
  sudo bash -c "set -a; . '$ENV_FILE'; set +a; sudo -u baeley --preserve-env=DATABASE_URL,SMOKE_DB $*"
}

echo "[gate] 1/4 apply schema changes"
run_with_db "node scripts/apply-schema-changes.mjs"

echo "[gate] 2/4 build"
NODE_OPTIONS="--max-old-space-size=6144" npm run build

echo "[gate] 3/4 real-DB smoke test (raw-SQL paths)"
if ! run_with_db "env SMOKE_DB=1 ./node_modules/.bin/vitest run src/lib/__tests__/smoke-db.integration.test.ts"; then
  echo "[gate] SMOKE TEST FAILED — aborting deploy. The running app is untouched." >&2
  exit 1
fi

echo "[gate] 4/4 smoke passed — restarting app"
sudo systemctl restart recruitme-app
echo "[gate] done."
