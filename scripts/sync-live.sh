#!/usr/bin/env bash
# Push the author's live memory system into this repo for publishing.
#
# - Skill: live copy -> repo, with a scrub of machine-specific names and a
#   hard gate: if any Adobe-specific string survives, the sync aborts.
# - Plugin: the repo copy is the generalized public version. The live plugin
#   is only synced when it is byte-identical to the repo copy; otherwise the
#   script warns and leaves the repo copy untouched (the live plugin may
#   contain hardcoded paths and must not clobber the generic one).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_SKILL="$HOME/.claude/skills/memory-learnings-review"
LIVE_PLUGIN="$HOME/.config/opencode/plugins/memory-inject"
# The author's publishing GitHub account (the repo's owner).
PUBLISH_ACCOUNT="andrewmkhoury"

cd "$REPO_DIR"

# --- skill -----------------------------------------------------------------
if [ ! -d "$LIVE_SKILL" ]; then
  echo "live skill not found at $LIVE_SKILL — skipping skill sync"
else
  cp "$LIVE_SKILL/SKILL.md" "skills/memory-learnings-review/SKILL.md"
  # Apply the author's local scrub patterns (one sed -E pattern per line in
  # .author-scrub, kept out of the public repo).
  if [ -f "$REPO_DIR/.author-scrub" ]; then
    while IFS= read -r pattern; do
      [ -n "$pattern" ] && sed -i '' -E "$pattern" "skills/memory-learnings-review/SKILL.md"
    done < "$REPO_DIR/.author-scrub"
  fi

  if grep -rinE 'adobe|genstudio|akhoury' --include='*.md' skills/ memory/ | grep -q .; then
    echo "ABORT: Adobe-specific string survived the scrub in skills/ or memory/:"
    grep -rinE 'adobe|genstudio|akhoury' --include='*.md' skills/ memory/
    git checkout -- skills/ memory/
    exit 1
  fi
  echo "✓ skill synced and scrubbed (skills/ + memory/ gates clean)"
fi

# --- plugin ------------------------------------------------------------------
if [ ! -f "$LIVE_PLUGIN/index.ts" ]; then
  echo "live plugin not found — skipping plugin sync"
else
  if diff -q "$LIVE_PLUGIN/index.ts" "plugins/memory-inject/index.ts" >/dev/null; then
    echo "✓ plugin identical to repo copy — nothing to do"
  else
    echo "⚠ live plugin differs from the repo's generalized version."
    echo "  Not syncing (repo copy is public; live copy has hardcoded paths)."
    echo "  Once the live plugin converges on the generic implementation,"
    echo "  they will match and future syncs will be automatic."
  fi
fi

# --- commit ------------------------------------------------------------------
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "nothing to publish"
  exit 0
fi
git add .
git commit -m "sync: update from live install"

# Push as the publishing account (the gh CLI may have several logged in).
# `gh auth switch` alone is not enough: git may still hand the keychain a
# credential for a different account (seen: 403 denied to the other user).
# Push with a one-shot token URL so the publishing account is guaranteed.
REMOTE_URL="$(git remote get-url origin)"
case "$REMOTE_URL" in
  https://github.com/*)
    TOKEN="$(gh auth token -u "$PUBLISH_ACCOUNT")"
    git push "https://x-access-token:${TOKEN}@${REMOTE_URL#https://}" HEAD
    unset TOKEN
    ;;
  *)
    git push
    ;;
esac
