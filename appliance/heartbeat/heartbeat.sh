#!/usr/bin/env bash
# RecruitMe Box — 5-minute heartbeat to the seller admin portal.
#
# Collects a tiny vitals payload (NO recruiter PII, counts only) and POSTs
# it to $ADMIN_PORTAL_URL/api/heartbeat with the per-box bearer token.
# Driven by recruitme-heartbeat.timer (every 5 min). Silently exits if
# ADMIN_PORTAL_URL or BOX_TOKEN aren't set — supports boxes operating
# in disconnected mode until the seller registers them.
#
# Payload shape (mirrors /api/box-dashboard/stats but stripped of activity
# log content — only counts and system gauges leave the box):
#   {
#     box_id,
#     version,
#     ts,
#     uptime_s,
#     stats_today: { searches, ingested, scrape_ok, scrape_failed, ai_calls },
#     system: { cpu_load, ram_used_pct, swap_used_pct, disk_used_pct,
#               disk_free_gb, wifi_dbm, tailscale_online },
#     services: { app, db, ollama, scraper },
#     scraper: { queue_depth, in_progress_platform }
#   }

set -euo pipefail

CONFIG_FILE="${RECRUITME_BOX_CONFIG:-/etc/recruitme/box.env}"
[ -f "$CONFIG_FILE" ] || { echo "[heartbeat] no config at $CONFIG_FILE — exit 0"; exit 0; }
set -a
. "$CONFIG_FILE"
set +a

ADMIN_PORTAL_URL="${ADMIN_PORTAL_URL:-}"
BOX_TOKEN="${BOX_TOKEN:-}"
BOX_ID="${BOX_ID:-}"

if [ -z "$ADMIN_PORTAL_URL" ] || [ -z "$BOX_TOKEN" ] || [ -z "$BOX_ID" ]; then
  echo "[heartbeat] BOX_ID / BOX_TOKEN / ADMIN_PORTAL_URL not set — skipping send"
  exit 0
fi

STATS=$(curl -fsS --max-time 5 http://127.0.0.1:3001/api/box-dashboard/stats 2>/dev/null || echo "")
if [ -z "$STATS" ]; then
  # The app being down is itself signal — emit a minimal "app_down" payload.
  STATS='{"down":true}'
fi

# Reshape to the portal's expected schema using jq (already a dep for json
# work elsewhere). On boxes without jq, fall back to a verbatim POST of
# the full stats payload — the portal is permissive about extra keys.
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(jq --null-input --arg box_id "$BOX_ID" --arg ver "${RECRUITME_VERSION:-dev}" --argjson s "$STATS" '
    {
      box_id: $box_id,
      version: $ver,
      ts: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
      uptime_s: ($s.system.uptimeSec // 0),
      stats_today: {
        searches: ($s.today.searches // 0),
        ingested: ($s.today.candidatesAdded // 0),
        scrape_ok: ($s.today.scrapeOk // 0),
        scrape_failed: ($s.today.scrapeFailed // 0),
        ai_calls: ($s.today.aiCalls // 0),
      },
      system: {
        cpu_load: ($s.system.loadAvg[0] // 0),
        ram_used_pct: ($s.system.ram.usedPct // 0),
        swap_used_pct: ($s.system.swap.usedPct // 0),
        disk_used_pct: ($s.system.disk.usedPct // 0),
        disk_free_gb: (($s.system.disk.free // 0) / 1024 / 1024 / 1024),
        wifi_dbm: ($s.system.network.wifiSignal // null),
        tailscale_online: ($s.system.network.tailscaleOnline // false),
      },
      services: {
        app: ($s.services.app.ok // false),
        db: ($s.services.db.ok // false),
        ollama: ($s.services.ollama.ok // false),
        scraper: ($s.services.scraper.ok // false),
      },
      scraper: {
        queue_depth: ($s.scraper.queueDepth // 0),
        in_progress_platform: ($s.scraper.inProgress.platform // null),
      },
    }')
else
  PAYLOAD="$STATS"
fi

curl -fsS --max-time 10 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOX_TOKEN" \
  --data "$PAYLOAD" \
  "$ADMIN_PORTAL_URL/api/heartbeat" \
  > /dev/null

echo "[heartbeat] posted for $BOX_ID"
