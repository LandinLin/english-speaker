#!/usr/bin/env bash
# Ship the current source to the HK VPS and rebuild/restart there.
# Usage: SERVER_HOST=root@203.0.113.10 bash scripts/deploy-remote.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${SERVER_HOST:?usage: SERVER_HOST=root@<ip> bash scripts/deploy-remote.sh}"
REMOTE_DIR="${REMOTE_DIR:-/opt/english-buddy}"

echo "→ Syncing source to ${SERVER}:${REMOTE_DIR}"
# Excluded paths on the server (incl. .env.production) are never deleted.
rsync -az --delete \
  --exclude node_modules \
  --exclude .next \
  --exclude .git \
  --exclude .env.local \
  --exclude .env.production \
  --exclude data \
  --exclude .vercel \
  --exclude "*.log" \
  -e ssh ./ "$SERVER:$REMOTE_DIR/"

echo "→ Remote build + restart"
ssh "$SERVER" "cd $REMOTE_DIR && bash scripts/deploy.sh"
