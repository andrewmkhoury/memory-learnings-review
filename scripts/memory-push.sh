#!/usr/bin/env bash
# Commit and push memory/ changes in this repo checkout (your memory store).
# Run it after a session that recorded learnings, or wire it to a cron/launchd
# job if you want the push to happen on its own.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
mkdir -p memory
git add memory/

if git diff --cached --quiet; then
  echo "no memory changes to push"
  exit 0
fi

git commit -m "memory: update $(date +%Y-%m-%d)"
git push
echo "✓ memory pushed"
