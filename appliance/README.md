# RecruitMe Box — appliance build artifacts

Everything needed to turn the RecruitMe app into a sellable mini-PC
appliance. The pieces below are arranged in the order they fire on a
shipped box.

## Build a box

```
appliance/luks/             # Step 0: enable full-disk encryption on the fresh SSD
appliance/packer/           # Step 1: Packer template that produces the base image
appliance/firstboot/        # Step 2: wizard that runs ONCE on first boot to collect
                            #         customer creds + drive LinkedIn/SEEK logins
appliance/heartbeat/        # Step 3: 5-min vitals POST to the admin portal
appliance/control-agent/    # Step 4: long-poll command channel for remote ops
appliance/updater/          # Step 5: nightly self-update via signed manifest
appliance/pool-sync/        # Step 6: opt-in candidate pool upload (dormant by default)
admin-portal/               # Seller-side fleet monitor (Fly.io deployable)
```

## Lifecycle

```
                ┌─────────────────┐
                │ appliance/luks  │  ← physical setup on bare SSD (one-off, per box)
                └────────┬────────┘
                         │
                ┌────────▼────────┐
                │ packer build    │  ← reproducible image build (per release)
                └────────┬────────┘
                         │ flash to SSD with dd / Etcher
                         │ plug into mini-PC, power on
                ┌────────▼────────┐
                │ firstboot.mjs   │  ← runs ONCE: collect creds, gen secrets,
                │ port :80 LAN    │     join tailnet, write box.env, disable self
                └────────┬────────┘
                         │ recruitme-firstboot.service exits
                         │
                ┌────────▼─────────────────────────────────────┐
                │ Steady-state services (all enabled on boot)   │
                │ ┌────────────────┐ ┌──────────────────────┐   │
                │ │ recruitme-app  │ │ recruitme-scraper    │   │
                │ │ (Caddy → :3001)│ │ (Patchright + xvfb)  │   │
                │ └────────────────┘ └──────────────────────┘   │
                │ ┌────────────────┐ ┌──────────────────────┐   │
                │ │ ollama         │ │ postgresql           │   │
                │ │ Qwen 1.5B 11434│ │ 5432 (loopback)      │   │
                │ └────────────────┘ └──────────────────────┘   │
                │ ┌────────────────┐ ┌──────────────────────┐   │
                │ │ heartbeat      │ │ control-agent        │   │
                │ │ (5-min POST)   │ │ (long-poll commands) │   │
                │ └────────────────┘ └──────────────────────┘   │
                │ ┌────────────────┐ ┌──────────────────────┐   │
                │ │ backup         │ │ update               │   │
                │ │ (02:15 nightly)│ │ (03:00 nightly)      │   │
                │ └────────────────┘ └──────────────────────┘   │
                │ ┌────────────────┐                            │
                │ │ pool-sync      │  ← dormant until customer  │
                │ │ (04:30 opt-in) │     signs T&Cs             │
                │ └────────────────┘                            │
                └────────────────────────────────────────────────┘
                         │
                         │ Tailscale outbound
                ┌────────▼────────┐
                │  admin-portal   │  ← Fly.io, seller logs in to monitor + control
                └─────────────────┘
```

## Register a new box with the seller portal

After flashing + firstboot completes, register the box's auto-generated
UUID with the admin portal to get a `BOX_TOKEN`:

```bash
# Read BOX_ID off the box
ssh customer-box "cat /etc/recruitme/box.env | grep BOX_ID"
# → BOX_ID=abc12345-...

# Register against the portal (seller side)
curl -u cassius:$ADMIN_PASS https://recruitme-admin.fly.dev/api/admin/boxes \
  -H "Content-Type: application/json" \
  -d '{"customer_name":"Acme Recruiting","box_id":"abc12345-..."}'
# → { "id": "...", "token": "longstring" }

# Burn the token onto the box
ssh customer-box "sudo tee -a /etc/recruitme/box.env <<EOF
ADMIN_PORTAL_URL=https://recruitme-admin.fly.dev
BOX_TOKEN=longstring
EOF
sudo systemctl restart recruitme-heartbeat.timer recruitme-control-agent"
```

Heartbeats start flowing within 5 min; remote commands work immediately.

## What's not yet done (deferred)

- **Customer-facing T&Cs flow** for the candidate pool opt-in. The schema
  + sync script ship dormant; flipping `OPT_IN_CANDIDATE_POOL=true`
  activates them — but the legal page that captures consent is on you to
  draft and host.
- **`scraper.reauth` command** is wired but returns "not implemented" —
  needs a noVNC bridge to a visible Chromium so the seller can drive a
  LinkedIn/SEEK login remotely.
- **Per-customer update channels** (`canary` vs `stable`) — the env var
  is read by the updater but the admin portal has no UI to assign boxes
  to channels yet; v2.
- **TPM2 key rotation script** for after BIOS updates — see `luks/README.md`.
