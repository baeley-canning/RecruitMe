#!/usr/bin/env bash
# Fire the SearchRun safety-net sweep from the APP host on a timer, so stuck
# runs get reclaimed/settled even when the scraper worker is wedged or down
# (the worker normally drives the sweep from its poll loop — which dies exactly
# when the worker does). Idempotent + cheap. Runs as root (reads app.env).
set -euo pipefail
set -a; . /etc/recruitme/app.env; set +a
curl -fsS -X POST "http://localhost:3000/api/admin/search-runs/sweep" \
  -H "x-scraper-secret: ${SCRAPER_SECRET}" \
  --max-time 20 >/dev/null 2>&1 || true
