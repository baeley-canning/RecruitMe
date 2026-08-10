# Session Handoff — 2026-08-10

## Shipped

| Area | Change | Commit |
|------|--------|--------|
| Ops alerting | Tested state machine over /api/health that pages via webhook, falls back to Sentry when no webhook is set. Alerts on `degraded` and hard failure, holds 15-minute grace, de-dupes to one alert per outage, sends recovery notice. | a63e1f6 |
| Backups | Production Postgres volume had zero Railway backup schedules and zero snapshots. Built backup/verify/restore scripts plus automated daily backup to S3. | f759b03, 8e2e73c |
| Smoke gate | Real-Postgres coverage for PDL raw SQL, wired into `npm run smoke:db`. | e38a1a1 |
| Box security | Shared secret on root-privileged control actions. | 8cda4b4 |
| AI provider | Site now runs on DeepSeek through its Anthropic-compatible endpoint. | 2491838, 7a430db, bf46a58, 47dd086 |
| Candidate scoring | Over-qualified candidates no longer rank highest. | d848c24 |

## The vulnerability found and fixed

The box dashboard's IP gate trusted a client-supplied `X-Real-IP` header. Caddy never set that header, so it forwarded whatever the client sent. Port 3000 was open to the whole LAN in ufw. Any device on the customer's network could send `X-Real-IP: 127.0.0.1` and reach root-privileged actions (reboot, restart, wifi, logs, launching a login browser).

Fixed by making Caddy set `X-Real-IP` from the real peer on every proxy block.

```
before: X-Real-IP: 8.8.8.8 -> 404   (the gate believed the forged header)
after:  X-Real-IP: 8.8.8.8 -> 200   (header now has no influence)
```

## Open items for the owner

| Item | Why it matters | Action |
|------|----------------|--------|
| Railway native volume backups are still OFF | API returns "Not Authorized" for this account/plan; custom backup script is vendor-independent cover in the meantime | Enable via Railway dashboard |
| 13,465 CVs in object-storage bucket have no backup | Irreplaceable candidate data | Set up bucket replication or export |
| `CV_ENCRYPTION_KEY` is in no backup by design | Losing it makes every CV unreadable even after a perfect database restore | Put it in a password manager |
| Port 3000 is open to the LAN | `ufw` marks it "backwards-compat, drop in Phase J"; closing it removes LAN exposure, tailnet access keeps working | Close port in Phase J |
| Three empty Postgres services still cost money | Wasted spend | Delete them |

## Known risks

The box at /home/baeley/RecruitMe is NOT a git checkout, so there is no clean update path to it. Its app code predates today's changes, which means BOX_CONTROL_SECRET is written to its env but inert until the code is updated.

Search is inclusion-only, so "Technical Lead, Full Stack Developer" still matches a search for "Full Stack Developer". The scoring fix demotes such a candidate, but they are still surfaced.

Cost tracking now bills the serving model. DeepSeek has signalled a price rise, so the rate card in ai-pricing.ts should be re-checked.

## Verification

1396 tests passing, 28 skipped; typecheck and production build clean; every change deployed to Railway and confirmed serving.
