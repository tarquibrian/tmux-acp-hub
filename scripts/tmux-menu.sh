#!/usr/bin/env sh
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CWD="${1:-$(pwd)}"
CURRENT_SESSION="${2:-}"
TARGET_CLIENT="${3:-}"
TARGET_PANE="${4:-}"

tmux_option() {
  value="$(tmux show-option -gqv "$1" 2>/dev/null || true)"
  [ -n "$value" ] && printf "%s" "$value" || printf "%s" "$2"
}

NODE_BIN="$(tmux_option @vanzi_hub_node "node")"
DEFAULT_AGENT="$(tmux_option @vanzi_hub_default_agent "")"

if [ -n "$DEFAULT_AGENT" ]; then
  exec "$NODE_BIN" "$CURRENT_DIR/bin/vanzi-hub.mjs" tmux-menu --cwd "$CWD" --session "$CURRENT_SESSION" --client "$TARGET_CLIENT" --pane "$TARGET_PANE" --default-agent "$DEFAULT_AGENT"
fi

exec "$NODE_BIN" "$CURRENT_DIR/bin/vanzi-hub.mjs" tmux-menu --cwd "$CWD" --session "$CURRENT_SESSION" --client "$TARGET_CLIENT" --pane "$TARGET_PANE"
