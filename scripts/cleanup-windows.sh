#!/usr/bin/env sh
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$CURRENT_DIR/scripts/lib.sh"

SESSION="${1:-$(acp_session_name)}"

cleanup_workspace_windows "$SESSION"
