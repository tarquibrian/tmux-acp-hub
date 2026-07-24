#!/usr/bin/env sh

CURRENT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$CURRENT_DIR/scripts/lib.sh"

set_default() {
  option="$1"
  value="$2"

  # Test whether the option exists, not whether its value is non-empty: an
  # explicit empty @acp_hub_key_* value is a supported way to leave a key
  # unbound.
  tmux show-option -g "$option" >/dev/null 2>&1 && return 0
  tmux set-option -gq "$option" "$value"
}

set_default @acp_hub_popup_width "90%"
set_default @acp_hub_popup_height "85%"
set_default @acp_hub_legacy_keys "on"
set_default @acp_hub_workspace_session "acp-hub"
set_default @acp_hub_workspace_scope "project"
set_default @acp_hub_session_prefix "acp"
set_default @acp_hub_hash_length "8"
set_default @acp_hub_node "node"
set_default @acp_hub_key_toggle "m"
set_default @acp_hub_key_menu "M"
set_default @acp_hub_key_control "y"
set_default @acp_hub_key_switcher "s"
set_default @acp_hub_key_rename ","
set_default @acp_hub_key_close "x"
set_default @acp_hub_key_close_window "&"
set_default @acp_hub_scroll_page_percent "40"
set_default @acp_hub_mouse "on"
set_default @acp_hub_mouse_scroll_rows "4"
set_default @acp_hub_mouse_select_key "F4"
set_default @acp_hub_mouse_native_select "on"
set_default @acp_hub_transcript_padding "3"
set_default @acp_hub_prompt_padding "2"
set_default @acp_hub_history_limit "2000"
set_default @acp_hub_menu_order "recent"
set_default @acp_hub_menu_scope "project"
set_default @acp_hub_menu_list_percent "58"
set_default @acp_hub_status_animation "wave"
set_default @acp_hub_status_animation_interval "120"
set_default @acp_hub_status_animation_pause "900"
set_default @acp_hub_theme "vanzi"
# `prompt` delegates each ACP permission request to the user. `deny` is a
# fail-closed client policy: the Hub automatically rejects every escalation.
set_default @acp_hub_permission_policy "prompt"
set_default @acp_hub_activity_icon_ran "●"
set_default @acp_hub_activity_icon_explored "●"
set_default @acp_hub_activity_icon_edited "●"
set_default @acp_hub_activity_icon_tools "●"
set_default @acp_hub_plan_pin "auto"
set_default @acp_hub_plan_completed "collapse"
set_default @acp_hub_plan_awaiting "auto"
set_default @acp_hub_plan_key "C-p"
set_default @acp_hub_title_policy "agent-first"
set_default @acp_hub_tab_title_max_width "32"
set_default @acp_hub_switcher_title_max_width "30"
set_default @acp_hub_update_channel "stable"
set_default @acp_hub_update_check_interval "24h"
set_default @acp_hub_update_notify "on"
set_default @acp_hub_update_keep_versions "2"

tmux set-option -gq @acp_hub_dir "$CURRENT_DIR"

configured_key() {
  tmux show-option -gqv "$1"
}

key_enabled() {
  [ -n "$1" ] && [ "$1" != "off" ]
}

TOGGLE_KEY="$(configured_key @acp_hub_key_toggle)"
MENU_KEY="$(configured_key @acp_hub_key_menu)"
CONTROL_KEY="$(configured_key @acp_hub_key_control)"
SWITCHER_KEY="$(configured_key @acp_hub_key_switcher)"
RENAME_KEY="$(configured_key @acp_hub_key_rename)"
CLOSE_KEY="$(configured_key @acp_hub_key_close)"
CLOSE_WINDOW_KEY="$(configured_key @acp_hub_key_close_window)"

if key_enabled "$TOGGLE_KEY"; then
  tmux unbind-key -q "$TOGGLE_KEY"
  tmux bind-key "$TOGGLE_KEY" run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" '' '' toggle"
fi
if key_enabled "$CONTROL_KEY"; then
  tmux unbind-key -q "$CONTROL_KEY"
  tmux bind-key "$CONTROL_KEY" run-shell "sh \"$CURRENT_DIR/scripts/tmux-menu.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\""
fi
if key_enabled "$MENU_KEY"; then
  tmux unbind-key -q "$MENU_KEY"
  tmux bind-key "$MENU_KEY" run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" '' '' menu"
fi

if [ "$(tmux show-option -gqv @acp_hub_legacy_keys)" = "on" ]; then
  # 9/0 always create a fresh chat (predictable with many chats around);
  # (/) focus the most recent existing chat for the provider.
  tmux unbind-key -q 9
  tmux unbind-key -q 0
  tmux unbind-key -q '('
  tmux unbind-key -q ')'
  tmux bind-key -r 9 run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" codex '' new"
  tmux bind-key -r 0 run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" claude '' new"
  tmux bind-key -r '(' run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" codex '' open"
  tmux bind-key -r ')' run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" claude '' open"
fi

# Outside the ACP popup this is the normal tmux session chooser. Inside a
# acp-* popup workspace it becomes the ACP chat/window chooser with live status.
if key_enabled "$SWITCHER_KEY"; then
  tmux unbind-key -q "$SWITCHER_KEY"
  tmux bind-key "$SWITCHER_KEY" run-shell "sh \"$CURRENT_DIR/scripts/switcher.sh\" \"#{session_name}\" \"#{pane_id}\""
fi

SESSION_PREFIX="$(tmux show-option -gqv @acp_hub_session_prefix)"
[ -n "$SESSION_PREFIX" ] || SESSION_PREFIX="acp"
WORKSPACE_SESSION="$(tmux show-option -gqv @acp_hub_workspace_session)"
[ -n "$WORKSPACE_SESSION" ] || WORKSPACE_SESSION="acp-hub"
ACP_MATCH="#{||:#{m/r:^${SESSION_PREFIX}-,#{session_name}},#{==:#{session_name},$WORKSPACE_SESSION}}"

# tmux normally forwards a drag to applications that requested mouse events.
# ACP Hub needs those events for hover/click/wheel, but a real drag is better
# handled by copy-mode: the user's MouseDragEnd1Pane policy then owns copying
# (pbcopy, OSC52, tmux buffer, etc.). Only wrap tmux's stock root binding; a
# customized or deliberately unbound binding is never replaced unless the user
# explicitly selects `force`.
NATIVE_MOUSE_SELECT="$(tmux show-option -gqv @acp_hub_mouse_native_select)"
CURRENT_MOUSE_DRAG="$(tmux list-keys -T root MouseDrag1Pane 2>/dev/null || true)"
MOUSE_DRAG_KIND="custom"
case "$CURRENT_MOUSE_DRAG" in
  *"@acp_hub_chat_id"*"copy-mode -M"*) MOUSE_DRAG_KIND="acp" ;;
  *"mouse_any_flag"*"send-keys -M"*"copy-mode -M"*) MOUSE_DRAG_KIND="standard" ;;
esac

bind_standard_mouse_drag() {
  tmux bind-key -T root MouseDrag1Pane if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' \
    'send-keys -M' 'copy-mode -M'
}

bind_acp_mouse_drag() {
  tmux bind-key -T root MouseDrag1Pane if-shell -F '#{!=:#{@acp_hub_chat_id},}' \
    'copy-mode -M' \
    'if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'
}

case "$NATIVE_MOUSE_SELECT" in
  off|none|disabled)
    if [ "$MOUSE_DRAG_KIND" = "acp" ]; then bind_standard_mouse_drag; fi
    tmux set-option -gq @acp_hub_mouse_native_select_status "disabled"
    ;;
  force)
    bind_acp_mouse_drag
    tmux set-option -gq @acp_hub_mouse_native_select_status "enabled"
    ;;
  *)
    if [ "$MOUSE_DRAG_KIND" = "standard" ] || [ "$MOUSE_DRAG_KIND" = "acp" ]; then
      bind_acp_mouse_drag
      tmux set-option -gq @acp_hub_mouse_native_select_status "enabled"
    else
      tmux set-option -gq @acp_hub_mouse_native_select_status "custom-binding"
    fi
    ;;
esac

# Inside ACP workspaces prefix+, renames the CHAT (daemon title + status-bar
# label); window names stay canonical since they carry chat identity. It routes
# to the composer's in-process rename prompt (Ctrl+G) so the title never passes
# through a shell/tmux command string. Outside it is the normal window rename.
if key_enabled "$RENAME_KEY"; then
  tmux unbind-key -q "$RENAME_KEY"
  tmux bind-key "$RENAME_KEY" if-shell -F "$ACP_MATCH" \
    "send-keys C-g" \
    "command-prompt -I \"#{window_name}\" \"rename-window -- '%%'\""
fi

# Inside ACP workspaces prefix+x / prefix+& open a close menu that states what
# actually dies: killing the window only closes the view — the chat keeps
# running in the daemon unless explicitly stopped or deleted.
CLOSE_MENU_COMMAND="sh $(shell_quote "$CURRENT_DIR/scripts/close-menu.sh") $(shell_quote '#{pane_id}')"
if key_enabled "$CLOSE_KEY"; then
  tmux unbind-key -q "$CLOSE_KEY"
  tmux bind-key "$CLOSE_KEY" if-shell -F "$ACP_MATCH" \
    "run-shell \"$CLOSE_MENU_COMMAND\"" \
    "confirm-before -p \"kill-pane #P? (y/n)\" kill-pane"
fi
if key_enabled "$CLOSE_WINDOW_KEY"; then
  tmux unbind-key -q "$CLOSE_WINDOW_KEY"
  tmux bind-key "$CLOSE_WINDOW_KEY" if-shell -F "$ACP_MATCH" \
    "run-shell \"$CLOSE_MENU_COMMAND\"" \
    "confirm-before -p \"kill-window #W? (y/n)\" kill-window"
fi
