#!/usr/bin/env bash
# Build + (re)start the English Buddy stack on the HK VPS.
# Run from the repo root on the server:  bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.production ]]; then
  echo "✗ .env.production not found. Copy .env.example to .env.production and fill it in."
  exit 1
fi

# Required keys (fail fast with a clear message).
required=(SITE_DOMAIN ACME_EMAIL DATABASE_URL DASHSCOPE_API_KEY DEEPSEEK_API_KEY
          VOLCENGINE_TTS_ACCESS_TOKEN NEXT_PUBLIC_DID_CLIENT_KEY NEXT_PUBLIC_DID_AGENT_ID)
for k in "${required[@]}"; do
  if ! grep -q "^${k}=." .env.production; then
    echo "✗ .env.production is missing $k"
    exit 1
  fi
done

# Make NEXT_PUBLIC_* available to compose's build-arg substitution.
set -a
# shellcheck disable=SC1091
source .env.production
set +a

echo "→ Building image for ${SITE_DOMAIN}…"
docker compose build

echo "→ Starting stack…"
docker compose up -d

echo "→ Removing old image…"
docker image prune -f >/dev/null || true

echo "→ Waiting for health…"
for i in $(seq 1 30); do
  status=$(docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q web)" 2>/dev/null || echo "starting")
  if [[ "$status" == "healthy" ]]; then
    echo "✓ healthy"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo "! container not healthy yet — check: docker compose logs web"
  fi
done

echo
echo "Done. Local check:  curl -I http://127.0.0.1/login"
echo "Public:  https://${SITE_DOMAIN}/login"
echo "Logs:    docker compose logs -f web"
