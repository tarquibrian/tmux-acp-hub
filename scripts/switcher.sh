#!/usr/bin/env sh
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$CURRENT_DIR/scripts/lib.sh"

CURRENT_SESSION="${1:-}"
TARGET_PANE="${2:-}"

if is_acp_session "$CURRENT_SESSION"; then
  provider="#{?#{@acp_hub_provider_short},#{@acp_hub_provider_short},#{?#{@acp_hub_provider_label},#{@acp_hub_provider_label},#{@acp_hub_provider}}}"
  icon="#{?#{@acp_hub_provider_icon},#{@acp_hub_provider_icon},$provider}"
  glyph="#{?#{@acp_hub_status_glyph},#{@acp_hub_status_glyph} ,}"
  title="#{?#{@acp_hub_title},#{@acp_hub_title},#{window_name}}"
  meta="#{?#{@acp_hub_mode},#{@acp_hub_mode}  ,}#{?#{@acp_hub_model},#{@acp_hub_model} ,}#{?#{@acp_hub_effort},#{@acp_hub_effort}  ,}#{?#{@acp_hub_plan},steps #{@acp_hub_plan},}"
  status_style="#{?#{==:#{@acp_hub_status},error},#[fg=red],#{?#{==:#{@acp_hub_status},idle},#[fg=green],#{?#{==:#{@acp_hub_status},responding},#[fg=green],#{?#{==:#{@acp_hub_status},permission},#[fg=yellow],#{?#{==:#{@acp_hub_status},auth},#[fg=yellow],#{?#{==:#{@acp_hub_status},starting},#[fg=cyan],#[fg=colour244]}}}}}}"
  provider_style="#{?#{==:#{@acp_hub_provider},claude},#[fg=colour173],#{?#{==:#{@acp_hub_provider},codex},#[fg=colour39],#[fg=colour39]}}"

  # Window rows: icon · fixed-width title · status · last activity · meta.
  # Titles are clipped with an ellipsis and padded so the columns line up.
  chat_line="$provider_style$icon#[default] #[bold]#{p32:#{=/30/…:$title}}#[default] $status_style$glyph#{p11:#{@acp_hub_status}}#[default] #[fg=colour244]#{t/f/%R:window_activity}  $meta#[default]"
  # Session rows (the tree parents) read as the project instead of the raw
  # acp-<slug> name; the active window's options carry the path.
  session_line="#[bold]▣ #{?#{@acp_hub_project_path},#{b:@acp_hub_project_path},#{session_name}}#[default]  #[fg=colour244]#{@acp_hub_project_path}#[default]"
  format="#{?window_format,$chat_line,$session_line}"
  prefix="$(tmux_option @acp_hub_session_prefix acp)"
  global_session="$(acp_global_session_name)"

  if [ "$(acp_workspace_scope)" = "project" ]; then
    session_filter="#{&&:#{m/r:^$prefix-,#{session_name}},#{!=:#{session_name},$global_session}}"
  else
    session_filter="#{||:#{==:#{session_name},$global_session},#{m/r:^$prefix-,#{session_name}}}"
  fi

  filter="#{&&:$session_filter,#{&&:#{!=:#{window_name},menu},#{&&:#{==:#{pane_dead},0},#{&&:#{!=:#{@acp_hub_project_path},},#{!=:#{@acp_hub_provider},}}}}}"

  chat_count="$(tmux list-windows -a -f "$filter" -F "#{window_id}" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$chat_count" = "0" ]; then
    tmux display-message "acp-hub: no hay chats ACP activos para mostrar"
    exit 0
  fi

  if [ -n "$TARGET_PANE" ]; then
    tmux choose-tree -Zw -O time -t "$TARGET_PANE" -f "$filter" -F "$format" "switch-client -t '%%'"
  else
    tmux choose-tree -Zw -O time -f "$filter" -F "$format" "switch-client -t '%%'"
  fi
  exit 0
fi

prefix="$(tmux_option @acp_hub_session_prefix acp)"
normal_session_filter="#{?#{m/r:^(agents|acp|$prefix)-,#{session_name}},0,1}"
tmux choose-tree -Zs -f "$normal_session_filter"
