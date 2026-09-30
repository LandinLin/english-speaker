#!/bin/bash
# Push all app env vars to Vercel (production), with the Neon DATABASE_URL.
# Reads values from .env.local so secrets never appear in shell history.
set -euo pipefail
cd "$(dirname "$0")/.."

NEON_URL='postgresql://neondb_owner:npg_aZB9GizMD5YC@ep-solitary-water-b5p9jak9-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'

push_env() {
  local name="$1" value="$2"
  printf '%s' "$value" | npx --yes vercel@latest env add "$name" production --force > /dev/null
  echo "  ✓ $name"
}

echo "Pushing env vars to Vercel production…"
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  case "$key" in
    DATABASE_URL) push_env DATABASE_URL "$NEON_URL" ;;
    VERCEL_OIDC_TOKEN) ;; # local-only, managed by vercel link
    *) push_env "$key" "$value" ;;
  esac
done < .env.local
echo "Done."
