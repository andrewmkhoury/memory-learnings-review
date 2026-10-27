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

# Fork-store mode: if the user has no config, point every project's memory at
# <repo>/memory/<slug> so this repo checkout becomes their version-controlled
# memory store, and point globalDir at the pre-seeded general rules when the
# repo ships them. Never overwrites an existing config.
mkdir -p "$REPO_DIR/memory"
if [ ! -f "$PLUGIN_DST/config.json" ]; then
  if [ -d "$REPO_DIR/memory/global" ]; then
    printf '{\n  "baseDir": "%s/memory",\n  "globalDir": "%s/memory/global"\n}\n' \
      "$REPO_DIR" "$REPO_DIR" > "$PLUGIN_DST/config.json"
  else
    printf '{\n  "baseDir": "%s/memory"\n}\n' "$REPO_DIR" > "$PLUGIN_DST/config.json"
  fi
  echo "✓ created $PLUGIN_DST/config.json (fork-store mode: $REPO_DIR/memory is your memory store)"
else
  echo "✓ existing config.json left untouched"
fi

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

# Cursor: install the recall rule and register the MCP server, if Cursor is
# present. Never touches other entries in mcp.json.
if [ -d "$HOME/.cursor" ]; then
  if [ -d "$HOME/.cursor/rules" ]; then
    cp "$PLUGIN_DST/cursor-rule.mdc" "$HOME/.cursor/rules/memory-inject.mdc"
    echo "✓ cursor rule -> $HOME/.cursor/rules/memory-inject.mdc"
  fi
  python3 - "$HOME/.cursor/mcp.json" "$PLUGIN_DST/memory-mcp.mjs" <<'PY'
import json, sys, os
path, server = sys.argv[1], sys.argv[2]
cfg = {}
if os.path.exists(path):
    with open(path) as f: cfg = json.load(f)
servers = cfg.setdefault("mcpServers", {})
entry = {"command": "node", "args": [server]}
if servers.get("memory-inject") != entry:
    servers["memory-inject"] = entry
    with open(path, "w") as f: json.dump(cfg, f, indent=2)
    print(f"✓ registered memory-inject MCP server in {path}")
else:
    print(f"✓ memory-inject MCP server already registered in {path}")
PY
fi

echo "Optional: copy plugins/memory-inject/config.example.json to"
echo "$PLUGIN_DST/config.json for explicit project -> memory-dir mappings."
