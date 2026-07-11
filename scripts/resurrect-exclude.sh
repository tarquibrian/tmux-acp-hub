#!/usr/bin/env sh

# Strip agent-hub sessions from the most recent tmux-resurrect save so a
# restore never brings back hollow, agent-less skeleton sessions: resurrect
# doesn't re-launch the agent (not in @resurrect-processes) and it doesn't save
# the @acp_hub_*/@cli_hub_* metadata, so a restored acp-/vz-/cli-/agents-
# session is just an empty shell that clutters the switchers. The real state
# lives in the acp-hub daemon (or each CLI's own resume), not in resurrect.
#
# Wire it in (only needed if you use tmux-resurrect / continuum auto-save):
#   set -g @resurrect-hook-post-save-all 'sh ~/.config/tmux/plugins/tmux-acp-hub/scripts/resurrect-exclude.sh'

dir="$(tmux show-option -gqv @resurrect-dir 2>/dev/null)"
[ -n "$dir" ] || dir="${XDG_DATA_HOME:-$HOME/.local/share}/tmux/resurrect"
[ -d "$dir" ] || dir="$HOME/.tmux/resurrect"

last="$dir/last"
[ -e "$last" ] || exit 0

# `last` is normally a symlink to the timestamped save; resolve it.
target="$(readlink "$last" 2>/dev/null || true)"
case "$target" in
  "") file="$last" ;;
  /*) file="$target" ;;
  *)  file="$dir/$target" ;;
esac
[ -f "$file" ] || exit 0

# Drop the pane/window records whose session is an agent-hub session — the
# canonical prefixes plus whatever @acp_hub_session_prefix is set to. State and
# other records that reference a removed session are harmless — resurrect skips
# sessions it can't recreate.
prefix="$(tmux show-option -gqv @acp_hub_session_prefix 2>/dev/null)"
[ -n "$prefix" ] || prefix="acp"

tmp="$file.agents.$$"
awk -F'\t' -v p="$prefix" '!(($1 == "pane" || $1 == "window") && $2 ~ ("^(" p "|cli|agents|acp|vz)-"))' "$file" > "$tmp" 2>/dev/null &&
  mv "$tmp" "$file"
