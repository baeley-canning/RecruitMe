# RecruitMe Scraper Worker — Setup Guide

## What This Is

A standalone Node.js service that runs on a Raspberry Pi (4G carrier IP) to scrape
LinkedIn profiles, SEEK Talent, and JobAdder. It polls the RecruitMe Railway app for
pending jobs and posts results back. The 4G carrier IP avoids the datacenter IP blocks
that flagged previous Railway-based scraping attempts.

---

## Prerequisites

- Raspberry Pi 4 or 5 (2GB+ RAM recommended)
- 4G USB modem (e.g. Huawei E3372, ZTE MF831) with a NZ SIM
  OR a 4G-capable phone USB-tethered to the Pi
- A RecruitMe account with an API key (owner access required)

---

## Step 1 — Raspberry Pi OS setup

```bash
# Install OS (use Raspberry Pi Imager, choose Raspberry Pi OS Lite 64-bit)
# SSH into your Pi, then:

sudo apt update && sudo apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# Chromium (Playwright uses this)
sudo apt install -y chromium-browser

# PM2 (process manager — keeps worker alive on reboot)
sudo npm install -g pm2
```

## Step 2 — 4G Modem setup

```bash
# Install modem tools
sudo apt install -y usb-modeswitch modemmanager network-manager

# Create a 4G connection (replace "internet" with your SIM's APN if different)
# Spark NZ: internet.spark.co.nz | Vodafone NZ: internet | 2degrees: internet
sudo nmcli con add type gsm ifname cdc-wdm0 con-name "4g" apn "internet.spark.co.nz"
sudo nmcli con up "4g"

# Verify you have a carrier IP (not a private range)
curl ifconfig.me
```

If using USB tethering from an Android phone instead:
- Enable USB tethering in phone Settings → Network → Hotspot & Tethering
- Pi will get the phone's 4G IP automatically via RNDIS

## Step 3 — Get a RecruitMe API key

1. Log into RecruitMe as owner
2. Go to the browser console or use curl:
   ```bash
   curl -X POST https://your-app.up.railway.app/api/v1/keys \
     -H "Content-Type: application/json" \
     -H "Cookie: your-session-cookie" \
     -d '{"name": "scraper-worker-pi"}'
   ```
3. Copy the `raw` field from the response — it starts with `rm_` and is shown ONCE.

## Step 4 — Configure the worker

```bash
cd /path/to/RecruitMe/scraper-worker

# Copy config template
cp .env.example .env
nano .env
```

Fill in:
- `RAILWAY_API_URL` — your Railway app URL
- `SCRAPER_API_KEY` — the `rm_...` key from Step 3
- `SESSION_ENCRYPTION_KEY` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` — your LinkedIn credentials
- `SEEK_EMAIL` / `SEEK_PASSWORD` — your SEEK Talent credentials
- `JOBADDER_ACCESS_TOKEN` — if you have JobAdder API access

## Step 5 — Install and build

```bash
npm install
npx playwright install chromium
npm run build
```

## Step 6 — Enable scraping on Railway

In Railway dashboard → your app → Variables:
```
SCRAPER_ENABLED=true
```

This tells the search pipeline to create ScrapeJob rows for snippet-only LinkedIn results.

## Step 7 — Start the worker

```bash
# Run once to test
npm start

# Or with PM2 (persistent, auto-restart on failure/reboot)
pm2 start dist/index.js --name scraper-worker
pm2 startup   # follow the printed command to enable on boot
pm2 save
```

## Step 8 — Verify it works

1. In RecruitMe, run a search on any job
2. The search saves LinkedIn snippet candidates (no profileText)
3. Check Railway logs — you should see `[search] Enqueued N scrape jobs`
4. Check Pi logs — you should see `[worker] Claimed 1 job(s)` and then profile scraping
5. After ~30–60 seconds, refresh the candidate in RecruitMe — it should have a full profile

---

## IP Management

### Getting a fresh IP
The Pi's 4G IP changes automatically when the modem reconnects. To force a refresh:
```bash
# Toggle the modem connection
sudo nmcli con down "4g" && sleep 5 && sudo nmcli con up "4g"
curl ifconfig.me  # confirm new IP
```

### If you're still getting blocked
- The problem is the operator's LinkedIn account, not the IP — the account may be flagged
- Create a new LinkedIn account and update LINKEDIN_EMAIL/LINKEDIN_PASSWORD in .env
- Delete sessions/linkedin.enc to force a fresh login
- Reduce LINKEDIN_HOURLY_CAP to 4 and increase pauses

---

## Fly.io alternative

If you don't have a Pi, deploy the worker to Fly.io with a residential proxy:

```bash
# From scraper-worker/
fly launch --name recruitme-scraper --region syd
fly secrets set RAILWAY_API_URL=... SCRAPER_API_KEY=... SESSION_ENCRYPTION_KEY=... \
  LINKEDIN_EMAIL=... LINKEDIN_PASSWORD=... SEEK_EMAIL=... SEEK_PASSWORD=... \
  HTTP_PROXY=http://user:pass@brd.superproxy.io:22225  # Brightdata example
fly deploy
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `SESSION_ENCRYPTION_KEY must be a 64-char hex string` | Generate a key (see Step 4) |
| `Invalid or revoked API key` | Re-create the API key in RecruitMe settings |
| LinkedIn login fails | Check LINKEDIN_EMAIL/LINKEDIN_PASSWORD, delete sessions/linkedin.enc |
| LinkedIn challenge page | Complete the challenge in a real browser, or wait 24h and try fresh IP |
| Worker claims jobs but scores never appear | Check Railway logs for `applyProfileResult` errors |
| `SCRAPER_ENABLED is not set` | Set `SCRAPER_ENABLED=true` in Railway env vars and redeploy |

---

## How the full system works (for debugging)

```
RecruitMe (Railway)                      Pi (scraper-worker)
─────────────────────────────────────────────────────────────
Search finds LinkedIn URL (snippet only)
  → enqueueScrapeJob() creates ScrapeJob  ←── polls GET /api/scraper/jobs
  → status: "pending"                         ←── claims job, status: "processing"
                                               ←── scrapes LinkedIn profile
                                               ←── PATCH /api/scraper/jobs/{id}
  → completeScrapeJob()                    ──→
  → writes profileText to Candidate
  → triggers AI scoring (background)
  → recruiter sees full scored profile
```
