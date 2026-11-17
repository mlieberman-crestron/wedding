#!/bin/sh
# Build and (re)start the app with docker compose, then wait until healthy.
# Run on the NAS over SSH:   sh scripts/deploy.sh
# POSIX sh only (works with busybox sh). If docker needs root on your NAS,
# run it as:  sudo sh scripts/deploy.sh

set -eu

# Run from the project folder (the parent of scripts/), wherever we're called from.
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Note: no .env file; using defaults (copy .env.example to .env to change them)."
fi

mkdir -p data

echo "==> Building image and starting container"
docker compose up -d --build

CID=$(docker compose ps -q web)
if [ -z "$CID" ]; then
  echo "ERROR: container for service 'web' not found."
  exit 1
fi

echo "==> Waiting for health check (up to 90 s)"
i=0
STATUS=unknown
while [ "$i" -lt 45 ]; do
  STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CID")
  case "$STATUS" in
    healthy) break ;;
    unhealthy) break ;;
  esac
  i=$((i + 1))
  sleep 2
done

echo
docker compose ps
echo
echo "Health status: $STATUS"

if [ "$STATUS" != "healthy" ]; then
  echo "==> Last 30 log lines:"
  docker compose logs --tail 30 web
  exit 1
fi

PORT=$(docker compose port web 3000 | sed 's/.*://')
echo "OK - open http://<nas-ip>:${PORT}/"
