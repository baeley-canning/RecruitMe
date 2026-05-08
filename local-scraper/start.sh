#!/usr/bin/env bash
# Boot the local scraper + an ngrok tunnel in two parallel processes.
# Ctrl-C kills both.
#
# Prereqs: ./.venv exists (see README), ngrok is installed and authenticated,
# .env has SCRAPER_API_KEY and LINKEDIN_LI_AT set.

set -euo pipefail
cd "$(dirname "$0")"

# Pick up chromedriver/ngrok from ~/bin (where we install them when there's
# no Homebrew). Harmless when they're already on PATH from /opt/homebrew.
export PATH="$HOME/bin:$PATH"

if [[ ! -d .venv ]]; then
  echo "✗ no .venv — run: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "✗ no .env — copy .env.example to .env and fill it in"
  exit 1
fi

PORT="${PORT:-8080}"

echo "→ starting Flask on port $PORT"
./.venv/bin/python app.py &
APP_PID=$!

# Wait until the port is actually accepting connections — otherwise ngrok
# prints "tunnel session failed" before app.py finishes booting Chrome.
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "→ starting ngrok tunnel"
ngrok http "$PORT" &
NGROK_PID=$!

trap 'echo "→ shutting down"; kill $APP_PID $NGROK_PID 2>/dev/null || true; wait 2>/dev/null || true' INT TERM EXIT
wait
