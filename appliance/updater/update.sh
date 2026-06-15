#!/usr/bin/env bash
# RecruitMe Box updater.
#
# Pulls the latest signed manifest from the seller's update server,
# verifies the cosign signature against the public key burned into the
# image, downloads the new release tarball, applies it, and rolls back
# on healthcheck failure.
#
# Run by recruitme-update.timer at 03:00 local. Manual trigger via
# `systemctl start recruitme-update.service` (also the target of the
# control-plane `update.now` command).
#
# Channels:
#   - stable  (default for customers)
#   - canary  (10% of fleet, soaked 24h before promote to stable)
#   - frozen  (no automatic updates, customer opts in to manual)
#
# Set CHANNEL in /etc/recruitme/box.env to pick.

set -euo pipefail

CONFIG_FILE=/etc/recruitme/box.env
[ -f "$CONFIG_FILE" ] || { echo "[update] no $CONFIG_FILE — exit"; exit 0; }
set -a; . "$CONFIG_FILE"; set +a

CHANNEL="${CHANNEL:-stable}"
UPDATE_BASE="${UPDATE_BASE:-https://updates.placeme.co}"
COSIGN_PUB=/etc/recruitme/cosign.pub
APP_DIR=/opt/recruitme

CURRENT_VERSION=$(grep -E "^RECRUITME_VERSION=" "$CONFIG_FILE" | cut -d= -f2 | tr -d '"' || echo "0.0.0")
echo "[update] channel=$CHANNEL current=$CURRENT_VERSION"

MANIFEST=$(curl -fsSL "$UPDATE_BASE/channel/$CHANNEL/manifest.json")
SIG=$(curl -fsSL "$UPDATE_BASE/channel/$CHANNEL/manifest.json.sig")

# Verify signature. If cosign isn't installed (older image), skip but
# log loudly so the seller knows their fleet is unverified.
if command -v cosign >/dev/null 2>&1 && [ -f "$COSIGN_PUB" ]; then
  echo "$SIG" | base64 -d > /tmp/manifest.sig
  echo "$MANIFEST" > /tmp/manifest.json
  if ! cosign verify-blob --key "$COSIGN_PUB" --signature /tmp/manifest.sig /tmp/manifest.json; then
    echo "[update] SIGNATURE VERIFICATION FAILED — refusing to apply"
    exit 1
  fi
else
  echo "[update] ERROR: cosign and/or $COSIGN_PUB missing — refusing to apply an UNVERIFIED update."
  echo "[update] Set up signing: generate a cosign keypair, ship cosign.pub to $COSIGN_PUB, and sign the channel manifest."
  exit 1
fi

NEW_VERSION=$(echo "$MANIFEST" | jq -r .version)
TARBALL_URL=$(echo "$MANIFEST" | jq -r .url)
TARBALL_SHA=$(echo "$MANIFEST" | jq -r .sha256)

if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
  echo "[update] already on $NEW_VERSION — nothing to do"
  exit 0
fi

echo "[update] upgrading $CURRENT_VERSION → $NEW_VERSION"

# Snapshot current app dir for rollback. Cheap because the disk is one
# volume and we're just moving directories. /opt/recruitme.prev gets
# blown away on success.
sudo rm -rf "$APP_DIR.prev"
sudo cp -a "$APP_DIR" "$APP_DIR.prev"

# Download + verify + extract
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
curl -fsSL "$TARBALL_URL" -o "$TMP/release.tar.gz"
echo "$TARBALL_SHA  $TMP/release.tar.gz" | sha256sum -c - || { echo "[update] sha256 mismatch — aborting"; exit 1; }
sudo tar -xzf "$TMP/release.tar.gz" -C "$APP_DIR" --overwrite

# Migrations + build
cd "$APP_DIR"
sudo -u recruitme npm install --omit=dev
sudo -u recruitme node scripts/apply-schema-changes.mjs
sudo -u recruitme npm run build

# Stamp version + restart
sudo sed -i -E "s/^RECRUITME_VERSION=.*/RECRUITME_VERSION=$NEW_VERSION/" "$CONFIG_FILE"
sudo systemctl restart recruitme-app

# Health gate: wait up to 120s for /api/health to return 200. If it doesn't,
# roll back to the previous snapshot. Better to ship one missed update than
# a fleet-wide outage.
for i in $(seq 1 24); do
  sleep 5
  if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/dev/null; then
    echo "[update] healthcheck passed after ${i}x5s — promoting"
    sudo rm -rf "$APP_DIR.prev"
    exit 0
  fi
done

echo "[update] healthcheck failed — rolling back to $CURRENT_VERSION"
sudo rm -rf "$APP_DIR"
sudo mv "$APP_DIR.prev" "$APP_DIR"
sudo sed -i -E "s/^RECRUITME_VERSION=.*/RECRUITME_VERSION=$CURRENT_VERSION/" "$CONFIG_FILE"
sudo systemctl restart recruitme-app
exit 1
