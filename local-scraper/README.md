# local-scraper

LinkedIn profile scraper that runs **on your laptop**, not on Railway.

## Why local

LinkedIn HTTP-999s any request from datacenter IPs (Railway, AWS, GCP, every
proxy provider's free tier). Your home IP is residential and trusted, so the
same scraper logic that fails on Railway works fine here.

The trade-off: your laptop has to be on while RecruitMe is fetching profiles.

## How it fits in

The RecruitMe app already knows how to call an external scraper service via
`SCRAPER_URL` + `SCRAPER_API_KEY`. This service exposes the same
`POST /scrape-async` and `GET /health` endpoints, so flipping over is just
pointing `SCRAPER_URL` at this service's ngrok URL.

```
[ Railway: RecruitMe ]
        │
        │  POST /scrape-async {linkedinUrl, sessionId, callbackUrl}
        ▼
[ ngrok tunnel ]
        │
        ▼
[ this service on your laptop ]   ◄── runs joeyism/linkedin_scraper
        │
        │  POST /api/extension/fetch-session/complete {sessionId, profileText}
        ▼
[ Railway: RecruitMe ]
```

The `/complete` callback uses the unguessable sessionId for auth — no API key
needed on that hop.

## One-time setup

1. **Install Python deps**
   ```bash
   cd local-scraper
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Install Chrome + chromedriver**

   If you have Homebrew:
   ```bash
   brew install --cask google-chrome    # if not installed
   brew install chromedriver
   xattr -d com.apple.quarantine "$(which chromedriver)"   # macOS Gatekeeper
   ```

   No Homebrew (manual download):
   ```bash
   # Find your Chrome version
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version

   # Download matching chromedriver to ~/bin (mac arm64 example)
   mkdir -p ~/bin
   VER=147.0.7727.139      # ← replace with your Chrome version
   curl -L "https://storage.googleapis.com/chrome-for-testing-public/$VER/mac-arm64/chromedriver-mac-arm64.zip" -o /tmp/cd.zip
   unzip -o /tmp/cd.zip -d /tmp
   mv /tmp/chromedriver-mac-arm64/chromedriver ~/bin/chromedriver
   chmod +x ~/bin/chromedriver
   xattr -d com.apple.quarantine ~/bin/chromedriver   # macOS Gatekeeper
   ```

   `start.sh` adds `~/bin` to PATH automatically, so no shell config needed.

3. **Install ngrok**

   Homebrew:
   ```bash
   brew install ngrok
   ```

   Manual (mac arm64):
   ```bash
   curl -L https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-arm64.zip -o /tmp/ngrok.zip
   unzip -o /tmp/ngrok.zip -d ~/bin
   chmod +x ~/bin/ngrok
   ```

   Either way, authenticate once:
   ```bash
   ngrok config add-authtoken <your-token-from-dashboard.ngrok.com>
   ```

4. **Get your LinkedIn `li_at` cookie**
   - Open Chrome → linkedin.com → log in
   - DevTools → Application → Cookies → `https://www.linkedin.com`
   - Find `li_at`, copy the **Value** column

5. **Configure `.env`**
   ```bash
   cp .env.example .env
   ```
   Fill in:
   - `SCRAPER_API_KEY` — make up a strong random string. Will also go in Railway.
   - `LINKEDIN_LI_AT` — the cookie value from step 4.

## Running it

```bash
./start.sh
```

You'll see two URLs in the ngrok output:
```
Forwarding   https://abcd-1234-5678.ngrok-free.app -> http://localhost:8080
```

Copy the `https://abcd-…ngrok-free.app` URL — that's your `SCRAPER_URL`.

Verify it's healthy:
```bash
curl https://abcd-1234-5678.ngrok-free.app/health
# → {"ok": true, "version": "0.1.0", "queue_size": 0}
```

## Wiring up Railway

In Railway → RecruitMe service → **Variables**:

| Variable          | Value                                                   |
|-------------------|---------------------------------------------------------|
| `SCRAPER_URL`     | `https://abcd-1234-5678.ngrok-free.app` (your tunnel)   |
| `SCRAPER_API_KEY` | the same value you put in your local `.env`             |

Save → Railway redeploys → click Fetch on a candidate.

You should see in this terminal:
```
[scraper-py] starting <uuid> for https://www.linkedin.com/in/...
[scraper-py] <uuid> done in 12s — 4823 chars
```

And in the RecruitMe UI the candidate's profile fills in within ~30 seconds.

## When it stops working

| Symptom                              | Fix                                                  |
|--------------------------------------|------------------------------------------------------|
| `LI_AT cookie rejected`              | Cookie expired — refresh from DevTools, update .env  |
| `Profile text too short`             | LinkedIn served an authwall — refresh cookie         |
| `chromedriver` version mismatch      | `brew upgrade chromedriver`                          |
| ngrok URL changed after restart      | Update `SCRAPER_URL` in Railway with the new URL     |
| The tunnel disconnects every 8h      | Free ngrok limit; pay $8/mo or use Cloudflare Tunnel |

## Limits of the free tier

- ngrok's free URL is randomised on each restart. Each time you bounce
  `start.sh`, update `SCRAPER_URL` in Railway. To pin a stable URL, either pay
  ngrok $8/mo or switch to Cloudflare Tunnel (free, fixed URL, more setup).
- Your laptop has to be awake. Throw it on a charger and disable sleep, or
  expect captures to queue silently until you're back.
- If you hammer it (>20 profiles/hour from one account), LinkedIn may flag
  your account. The library has no rate-limiting built in — be human about
  pacing.
