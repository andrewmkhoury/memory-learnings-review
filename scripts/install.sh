#!/usr/bin/env bash
# Installs the memory-learnings-review skill and the memory-inject OpenCode
# plugin from a checkout of this repo. Idempotent.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SRC="$REPO_DIR/skills/memory-learnings-review"
SKILL_DST="$HOME/.claude/skills/memory-learnings-review"
PLUGIN_SRC="$REPO_DIR/plugins/memory-inject"
PLUGIN_DST="$HOME/.config/opencode/plugins/memory-inject"
OC_JSON="$HOME/.config/opencode/opencode.json"

mkdir -p "$HOME/.claude/skills" "$HOME/.config/opencode/plugins"

rsync -a --delete "$SKILL_SRC/" "$SKILL_DST/"
echo "✓ skill -> $SKILL_DST"

rsync -a --delete "$PLUGIN_SRC/" "$PLUGIN_DST/"
echo "✓ plugin -> $PLUGIN_DST"

# Register the plugin in opencode.json (creates the file if missing).
python3 - "$OC_JSON" "$PLUGIN_DST" <<'PY'
import json, sys, os
path, plugin = sys.argv[1], sys.argv[2]
cfg = {}
if os.path.exists(path):
    with open(path) as f: cfg = json.load(f)
plugins = cfg.setdefault("plugins", [])
if plugin not in plugins:
    plugins.append(plugin)
    with open(path, "w") as f: json.dump(cfg, f, indent=2)
    print(f"✓ registered plugin in {path}")
else:
    print(f"✓ plugin already registered in {path}")
PY

echo "Optional: copy plugins/memory-inject/config.example.json to"
echo "$PLUGIN_DST/config.json for explicit project -> memory-dir mappings."
