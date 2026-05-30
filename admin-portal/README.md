# RecruitMe Admin Portal

Fleet monitor for deployed RecruitMe boxes. Each box POSTs a 5-minute
heartbeat here (no PII — counts and system gauges only); seller logs in
to see fleet health, queue commands (restart services, force re-auth),
and revoke a box.

## Deploy to Fly.io

```bash
brew install flyctl
cd admin-portal
fly auth login
fly launch --name recruitme-admin   # accept defaults; pick syd or your nearest region
fly volumes create portal_data --region syd --size 1
fly secrets set ADMIN_PASSWORD="$(openssl rand -base64 24)"
fly secrets set ADMIN_USERNAME="cassius"
fly deploy
fly open
```

Costs roughly $US 2-3/month at one shared-1x VM + 1 GB volume.

## Register a box

```bash
# Replace ADMIN_PASSWORD with what you set above.
curl -u cassius:ADMIN_PASSWORD -H "Content-Type: application/json" \
  -d '{"customer_name":"Acme Recruiting"}' \
  https://recruitme-admin.fly.dev/api/admin/boxes
# → { "id": "abc-...", "customer_name": "Acme Recruiting", "token": "longstring..." }
```

The `token` is shown ONCE. Burn it into the box at provisioning (Phase J)
into `/etc/recruitme/box.env` as `BOX_TOKEN=...`, `BOX_ID=...`,
`ADMIN_PORTAL_URL=https://recruitme-admin.fly.dev`.

## Queue a remote command

```bash
curl -u cassius:PASS -H "Content-Type: application/json" \
  -d '{"command":"services.restart","args":{"target":"recruitme-app"}}' \
  https://recruitme-admin.fly.dev/api/admin/boxes/abc-.../cmd
```

The box's control-agent (see `appliance/control-agent/`) long-polls
`/api/control/<box_id>` and runs the command locally. Supported commands:

- `services.restart` — `{target: "recruitme-app" | "recruitme-scraper" | "ollama" | "all"}`
- `scraper.reauth` — `{platform: "linkedin" | "seek"}` (opens an embedded browser session — coordinated separately)
- `logs.tail` — `{service: string, lines: 200}`
- `health.deep` — runs the full health probe and returns the result
- `update.now` — pulls the latest signed manifest immediately

## Local dev

```bash
cd admin-portal
npm install
ADMIN_PASSWORD=devpass DB_PATH=./portal.sqlite npm run dev
open http://localhost:3000
```
