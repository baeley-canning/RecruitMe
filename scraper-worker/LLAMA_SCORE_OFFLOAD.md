# Llama scoring offload — activation & verification

**What it is.** A backup scoring path so candidate scoring **survives hours
without Claude tokens**. When Claude is out *and* the OpenAI-compatible Ollama
endpoint Railway tries is unreachable (it always is on Railway — that's the
latent failover-to-nowhere bug this fixes), the score routes enqueue a
`kind="score"` `ScrapeJob` carrying the prompt Railway already built. The
mini-PC box — which already polls Railway *outbound* for scrape jobs — claims
it, runs it against its **local Ollama**, and POSTs the raw text back. Railway
finalises that text into a `ScoreBreakdown` with the exact same math Claude
scores go through (`finalizeScoreFromText`), tagged `scoredBy: "ollama"`.

**Why poll-based.** Railway cannot reach the box (no public IP, no Tailscale
Funnel). The box reaching Railway already works. So scoring rides the same
proven, lock-free `claimScrapeJobs` queue as scraping — **no inbound path, no
Tailscale change** required.

**Architecture:** box is a *dumb LLM proxy*. Zero scoring logic on the box —
Railway builds the prompt and does all pre/post-processing. The box only runs
the raw completion.

---

## Activation — do these IN ORDER

The order matters. `claimScrapeJobs` is kind-agnostic: an **old** worker would
claim a `kind="score"` job and mishandle it. So update the box **first**, then
arm Railway.

1. **Deploy the updated worker to the box** (this commit) and restart it:
   ```bash
   # on the box, in scraper-worker/
   git pull   # (or your rsync deploy)
   npm install && npm run build
   # restart the worker service (systemd / pm2 / however it runs)
   ```
2. **Ensure Ollama is up on the box with the model pulled:**
   ```bash
   ollama pull qwen2.5:1.5b      # or a 3B — see "Quality" below
   curl -s http://127.0.0.1:11434/v1/models | head    # sanity check
   ```
3. **Set the box's Ollama env** (defaults already correct if Ollama is local):
   ```
   OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
   OLLAMA_SCORE_MODEL=qwen2.5:1.5b
   OLLAMA_SCORE_TIMEOUT_MS=120000
   ```
4. **Only now arm Railway** — set the master switch:
   ```bash
   railway variables set LLAMA_SCORE_OFFLOAD=1   # (or via the dashboard)
   ```
   With this **unset / not "1"** the entire offload is inert: scoring behaves
   exactly as before (Claude-out → the prior 500 / per-candidate flag).

---

## Verification (the joint smoke test — REQUIRED)

This path's Railway side is unit-tested (enqueue dedup, ingest finalize +
guards, flag on/off, sweep TTL — 33 tests). The **end-to-end box leg was NOT
verifiable from the build environment** (no box access). Verify it live once:

1. Make Claude fail on purpose (temporarily blank `ANTHROPIC_API_KEY` on
   Railway, or wait for a real exhaustion) **with `LLAMA_SCORE_OFFLOAD=1`**.
2. Open a job, click **Score** on one candidate. Expect the API to return
   `{ queued: true }` and the UI to say "queued for the local model".
3. On the box, watch the log for:
   ```
   processing job <id> — linkedin — score — (no target)
   score job <id> → local model returned <N> chars
   ```
4. Within a poll cycle the candidate should show a real score with the
   **"Llama"** provider badge (`scoredBy: "ollama"`). If it does — the full
   loop (enqueue → claim → local model → POST back → finalise → write) works.
5. Restore `ANTHROPIC_API_KEY`.

**If a score job never drains** (box behind or not updated), the 20-minute
`failStaleScoreJobs` sweep marks it failed so the candidate's "queued" state
resolves instead of hanging forever.

---

## Rollback

Set `LLAMA_SCORE_OFFLOAD` to anything other than `1` (or unset it) on Railway.
Instantly inert — no redeploy needed. The box-side code is dormant with no
score jobs to claim.

---

## Quality & limits (be realistic)

- **1.5B is weak.** `qwen2.5:1.5b` produces lower-quality judgement and more
  malformed JSON than Claude. It's a *resilience* backup, not a Claude
  replacement — scores are visibly tagged `scoredBy: "ollama"` so recruiters
  know. The server-side JSON-repair + stub fallback handle bad output
  gracefully. **If the box has RAM headroom, set `OLLAMA_SCORE_MODEL=qwen2.5:3b`**
  for materially better JSON adherence.
- **Latency.** 1.5B on a 2-core box (~6–10 tok/s) + the 15s poll interval means
  a queued score lands in tens of seconds to a couple of minutes, not instantly.
- **Big batches.** A `Score all` over many candidates enqueues one job each; the
  box drains them sequentially (priority 0, so live scrapes still win). The tail
  of a very large batch can hit the 20-min TTL before the box reaches it — those
  resolve as "scoring unavailable, retry". Raise `STALE_SCORE_MS` in
  `src/lib/search-run.ts` if you routinely score large batches while Claude is
  out.
- **Single browser.** A score job blocks the worker's single loop for the
  duration of the inference (its own 120s hard timeout caps a wedge). Scraping
  resumes immediately after.
