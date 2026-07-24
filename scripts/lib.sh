#!/usr/bin/env sh

tmux_option() {
  value="$(tmux show-option -gqv "$1" 2>/dev/null || true)"
  [ -n "$value" ] && printf "%s" "$value" || printf "%s" "$2"
}

project_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || printf "%s" "$1"
}

path_hash() {
  hash_length="$(tmux_option @acp_hub_hash_length 8)"

  if command -v md5sum >/dev/null 2>&1; then
    printf "%s" "$1" | md5sum | cut -c1-"$hash_length"
  else
    printf "%s" "$1" | md5 | cut -c1-"$hash_length"
  fi
}

acp_workspace_scope() {
  tmux_option @acp_hub_workspace_scope "project"
}

acp_global_session_name() {
  tmux_option @acp_hub_workspace_session "acp-hub"
}

acp_project_session_name() {
  project_path="$1"
  prefix="$(tmux_option @acp_hub_session_prefix acp)"
  project_slug="$(safe_name "$(basename "$project_path")")"
  project_hash="$(path_hash "$project_path")"

  printf "%s-%s-%s" "$prefix" "$project_slug" "$project_hash"
}

# Friendly session resolution: sessions are named <prefix>-<slug> (acp-<slug>
# by default, with -2/-3 when another project owns the slug) so tree views
# read cleanly. Identity lives in the @acp_hub_project_path session option,
# not the name; the legacy <prefix>-<slug>-<hash> deterministic name is still
# honored so live sessions from older versions keep working until they die.
acp_project_session() {
  project_path="$1"
  prefix="$(tmux_option @acp_hub_session_prefix acp)"
  tab="$(printf '\t')"

  found="$(tmux list-sessions -F "#{session_name}${tab}#{@acp_hub_project_path}" 2>/dev/null |
    awk -F "\t" -v pre="$prefix-" -v path="$project_path" \
      'index($1, pre) == 1 && $2 == path { print $1; exit }')"
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return
  fi

  legacy="$(acp_project_session_name "$project_path")"
  if tmux has-session -t "=$legacy" 2>/dev/null; then
    printf '%s\n' "$legacy"
    return
  fi

  base="$prefix-$(safe_name "$(basename "$project_path")")"
  name="$base"
  n=2
  while tmux has-session -t "=$name" 2>/dev/null; do
    name="$base-$n"
    n=$((n + 1))
  done
  printf '%s\n' "$name"
}

acp_session_name() {
  project_path="${1:-}"

  if [ "$(acp_workspace_scope)" = "global" ] || [ -z "$project_path" ]; then
    acp_global_session_name
    return
  fi

  acp_project_session "$project_path"
}

is_acp_session() {
  prefix="$(tmux_option @acp_hub_session_prefix acp)"
  workspace="$(acp_global_session_name)"

  case "$1" in
    "$workspace") return 0 ;;
    "$prefix"-*) return 0 ;;
    *) return 1 ;;
  esac
}

window_exists() {
  tmux list-windows -t "$1" -F "#{window_name}" 2>/dev/null | grep -Fxq "$2"
}

# Window id for a window matched by exact name in a session. Used to reuse the
# singleton "menu" window; chat windows are matched by @acp_hub_chat_id.
window_id_for() {
  tmux list-windows -t "$1" -F "#{window_id} #{window_name}" 2>/dev/null |
    awk -v name="$2" '$2 == name { print $1; exit }'
}

window_is_dead() {
  [ "$(tmux display-message -p -t "$1" "#{pane_dead}" 2>/dev/null || true)" = "1" ]
}

# The window already hosting a given chat id, regardless of its name. A chat
# created as "<provider>-new" keeps that window name but stores the real chat
# id in @acp_hub_chat_id; reopening it by canonical name would miss this
# window and spawn a duplicate, so match on the id.
window_id_for_chat() {
  window_chat_session="$1"
  window_chat_id="$2"
  [ -n "$window_chat_id" ] || return 1

  tmux has-session -t "$window_chat_session" 2>/dev/null || return 1
  tmux list-windows -t "$window_chat_session" -F "#{@acp_hub_chat_id}|#{window_id}" 2>/dev/null |
    awk -F "|" -v chat="$window_chat_id" '$1 == chat { print $2; exit }'
}

current_acp_window_for() {
  current_session="$1"
  current_project_path="$2"
  current_provider="$3"

  tmux has-session -t "$current_session" 2>/dev/null || return 1
  tmux list-windows -t "$current_session" -F "#{@acp_hub_project_path}|#{@acp_hub_provider}|#{@acp_hub_action}|#{@acp_hub_status}|#{@acp_hub_updated_at}|#{window_activity}|#{window_id}" 2>/dev/null |
    awk -F "|" -v project="$current_project_path" -v provider="$current_provider" '
      $1 == project && $2 == provider && $3 != "menu" && $4 != "closed" && $4 != "stopped" && $4 != "error" {
        score = $5 != "" ? $5 : sprintf("%020d", $6)
        if (best == "" || score > best_score) {
          best = $7
          best_score = score
        }
      }
      END {
        if (best != "") print best
      }
    '
}

last_acp_window_for_project() {
  current_session="$1"
  current_project_path="$2"

  tmux has-session -t "$current_session" 2>/dev/null || return 1
  tmux list-windows -t "$current_session" -F "#{window_active}|#{@acp_hub_project_path}|#{@acp_hub_action}|#{pane_dead}|#{@acp_hub_updated_at}|#{window_activity}|#{window_id}" 2>/dev/null |
    awk -F "|" -v project="$current_project_path" '
      $2 == project && $3 != "menu" && $4 != "1" {
        if ($1 == "1") {
          print $7
          selected = 1
          exit
        }

        score = $5 != "" ? $5 : sprintf("%020d", $6)
        if (best == "" || score > best_score) {
          best = $7
          best_score = score
        }
      }
      END {
        if (!selected && best != "") print best
      }
    '
}

safe_name() {
  value="$(printf "%s" "$1" | tr -cs '[:alnum:]_.-' '-' | sed 's/^[^[:alnum:]]*//;s/[^[:alnum:]]*$//')"
  [ -n "$value" ] && printf "%.24s" "$value" || printf "project"
}

# Chat windows are named by their title (managed by the UI) and identified by
# @acp_hub_chat_id, so there is no canonical name to heal here anymore. The
# one thing worth reclaiming: the singleton "menu" name if that window ended up
# hosting a chat, so the next prefix+M can create a fresh menu window.
cleanup_workspace_windows() {
  cleanup_session="$1"
  cleanup_separator="|"

  tmux has-session -t "$cleanup_session" 2>/dev/null || return 0

  tmux list-windows -t "$cleanup_session" -F "#{window_id}|#{window_name}|#{@acp_hub_provider}|#{@acp_hub_action}" 2>/dev/null |
    while IFS="$cleanup_separator" read -r cleanup_window_id cleanup_window_name cleanup_provider cleanup_action; do
      [ -n "$cleanup_window_id" ] || continue
      if [ "$cleanup_window_name" = "menu" ] && [ -n "$cleanup_action" ] && [ "$cleanup_action" != "menu" ]; then
        tmux rename-window -t "$cleanup_window_id" "$(clean_provider_label "$cleanup_provider")" 2>/dev/null || true
      fi
    done
}

set_window_metadata() {
  target="$1"
  provider="$2"
  chat_id="$3"
  action="$4"
  project_path="$5"
  project_name="$(basename "$project_path")"
  provider_short="$(clean_provider_label "$provider")"
  status_detail="Starting ACP"
  if [ "$action" = "new" ]; then
    status_detail="Creating new ACP session"
  elif [ -n "$chat_id" ]; then
    status_detail="Restoring ACP session"
  elif [ "$action" = "menu" ]; then
    status_detail="Opening ACP menu"
  fi

  case "$provider" in
    claude) provider_icon="❋" ;;
    codex) provider_icon="⬡" ;;
    *) provider_icon="◆" ;;
  esac

  # Never fight the name we set: automatic-rename would relabel the window to
  # the running process ("node"). The tab title is the window name (kept in
  # sync with the chat title by the UI) or, until then, the clean creation name.
  tmux set-window-option -t "$target" -q automatic-rename off
  tmux set-window-option -t "$target" -q @acp_hub_provider "$provider"
  tmux set-window-option -t "$target" -q @acp_hub_provider_short "$provider_short"
  tmux set-window-option -t "$target" -q @acp_hub_provider_icon "$provider_icon"
  tmux set-window-option -t "$target" -q @acp_hub_chat_id "$chat_id"
  tmux set-window-option -t "$target" -q @acp_hub_action "$action"
  tmux set-window-option -t "$target" -q @acp_hub_project_path "$project_path"
  tmux set-window-option -t "$target" -q @acp_hub_project_name "$project_name"
  tmux set-window-option -t "$target" -q @acp_hub_project_hash "$(path_hash "$project_path")"
  tmux set-window-option -t "$target" -q @acp_hub_status "starting"
  tmux set-window-option -t "$target" -q @acp_hub_status_glyph "◌"
  tmux set-window-option -t "$target" -q @acp_hub_status_detail "$status_detail"
  tmux set-window-option -t "$target" -q @acp_hub_mode ""
  tmux set-window-option -t "$target" -q @acp_hub_model ""
  tmux set-window-option -t "$target" -q @acp_hub_effort ""
  # Empty title → the tab falls back to the clean window name (#W) instead of a
  # placeholder; the UI fills in the real title and renames the window.
  tmux set-window-option -t "$target" -q @acp_hub_title ""
  tmux set-window-option -t "$target" -q @acp_hub_tab_title ""
  tmux set-window-option -t "$target" -q @acp_hub_title_source ""
  refresh_status_line
}

# Human window/tab name for a provider: "Codex", "Claude", capitalized default.
clean_provider_label() {
  case "$1" in
    codex) printf "Codex" ;;
    claude) printf "Claude" ;;
    "") printf "Chat" ;;
    *) printf '%s' "$1" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }' ;;
  esac
}

# Window-status labels are not re-rendered on option changes; force it. A bare
# refresh-client -S fails inside run-shell (no current client), so refresh
# every attached client explicitly.
refresh_status_line() {
  for _client in $(tmux list-clients -F '#{client_name}' 2>/dev/null); do
    tmux refresh-client -S -t "$_client" 2>/dev/null || true
  done
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

popup_width() {
  tmux_option @acp_hub_popup_width "90%"
}

popup_height() {
  tmux_option @acp_hub_popup_height "85%"
}

node_bin() {
  tmux_option @acp_hub_node "node"
}

default_agent() {
  tmux_option @acp_hub_default_agent "codex"
}

hub_state_dir() {
  if [ -n "${ACP_HUB_HOME:-}" ]; then
    printf "%s" "$ACP_HUB_HOME"
  else
    printf "%s/tmux-acp-hub" "${XDG_CACHE_HOME:-$HOME/.cache}"
  fi
}

# `/restart` is detached from the popup that requested it. Without a marker,
# prefix+m can create a replacement workspace just before the restart process
# kills every old workspace, making the new popup flash and disappear too.
wait_for_hub_restart() {
  restart_lock="$(hub_state_dir)/restart.lock"
  restart_waits=0
  if [ -f "$restart_lock" ]; then
    tmux display-message "acp-hub: finishing restart…" 2>/dev/null || true
  fi
  while [ -f "$restart_lock" ]; do
    restart_now="$(date +%s)"
    restart_mtime="$(stat -f %m "$restart_lock" 2>/dev/null || stat -c %Y "$restart_lock" 2>/dev/null || printf 0)"
    case "$restart_mtime" in ''|*[!0-9]*) restart_mtime=0 ;; esac
    if [ "$restart_mtime" -eq 0 ] || [ $((restart_now - restart_mtime)) -gt 60 ]; then
      rm -f "$restart_lock"
      break
    fi
    restart_waits=$((restart_waits + 1))
    if [ "$restart_waits" -ge 300 ]; then
      tmux display-message "acp-hub: restart still in progress; try again shortly" 2>/dev/null || true
      return 1
    fi
    sleep 0.1
  done
}

set_workspace_metadata() {
  session="$1"
  project_path="$2"
  parent_client="$3"
  parent_pane="$4"

  tmux set-option -t "$session" -q @acp_hub_project_path "$project_path"
  tmux set-option -t "$session" -q @acp_hub_project_name "$(basename "$project_path")"
  tmux set-option -t "$session" -q @acp_hub_project_hash "$(path_hash "$project_path")"
  tmux set-option -t "$session" -q @acp_hub_parent_client "$parent_client"
  tmux set-option -t "$session" -q @acp_hub_parent_pane "$parent_pane"

  apply_acp_status_format "$session"
}

# The ACP window-status-format is a session option, and something in the tmux
# session lifecycle (client attach/switch races during a fresh popup + daemon
# boot) intermittently reverts it to the theme default, so a chat tab shows the
# raw canonical window name instead of its title. Split out so the daemon/UI
# can re-assert it on every metadata sync and self-heal that transient.
resolve_acp_theme_styles() {
  acp_theme="$(tmux show-option -gqv @acp_hub_theme)"
  [ "$acp_theme" = "agent" ] || acp_theme="vanzi"
  acp_accent="$(tmux show-option -gqv @acp_hub_accent)"
  case "$acp_accent" in
    \#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F])
      acp_vanzi_style="#[fg=$acp_accent]"
      acp_vanzi_current_style="#[fg=black]#[bg=$acp_accent]"
      ;;
    [0-9]|[0-9][0-9]|[0-9][0-9][0-9])
      acp_vanzi_style="#[fg=colour$acp_accent]"
      acp_vanzi_current_style="#[fg=black]#[bg=colour$acp_accent]"
      ;;
    *)
      acp_vanzi_style="#[fg=colour168]"
      acp_vanzi_current_style="#[fg=black]#[bg=colour168]"
      ;;
  esac
  acp_agent_style="#{?#{==:#{@acp_hub_provider},claude},#[fg=colour173],#{?#{==:#{@acp_hub_provider},codex},#[fg=colour39],$acp_vanzi_style}}"
  # Composite styles inside `#{?...,...,...}` cannot contain raw commas: tmux
  # treats them as branch separators and truncates the active tab. Independent
  # directives are parser-safe in both direct and nested formats.
  acp_agent_current_style="#{?#{==:#{@acp_hub_provider},claude},#[fg=black]#[bg=colour173],#{?#{==:#{@acp_hub_provider},codex},#[fg=black]#[bg=colour39],$acp_vanzi_current_style}}"
  if [ "$acp_theme" = "agent" ]; then
    ACP_THEME_PROVIDER_STYLE="$acp_agent_style"
    ACP_THEME_PROVIDER_CURRENT_STYLE="$acp_agent_current_style"
  else
    ACP_THEME_PROVIDER_STYLE="$acp_vanzi_style"
    ACP_THEME_PROVIDER_CURRENT_STYLE="$acp_vanzi_current_style"
  fi
}

apply_acp_status_format() {
  session="$1"
  # Inside the ACP workspace, show minimal chat labels in the status bar:
  # provider icon (accent-colored), renameable title, and a status glyph only
  # when the chat needs attention (busy/permission/auth/error) — idle is quiet.
  resolve_acp_theme_styles
  acp_provider_style="$ACP_THEME_PROVIDER_STYLE"
  acp_provider_current_style="$ACP_THEME_PROVIDER_CURRENT_STYLE"
  acp_icon="#{?#{@acp_hub_provider_icon},#{@acp_hub_provider_icon},#{@acp_hub_provider_short}}"
  acp_attention_states="responding|thinking|working|planning|starting|cancelling|permission|auth|error"
  # Inactive tabs: semantic hue for the attention glyph (dark bg reads it fine).
  # The right pad belongs to the attention suffix itself. Keeping it before
  # #[default] prevents the busy glyph from visually consuming the last cell
  # of an inactive tab; the idle branch still contributes the same one cell.
  acp_attention="#{?#{m/r:^($acp_attention_states)$,#{@acp_hub_status}}, #{?#{==:#{@acp_hub_status},error},#[fg=colour168],#{?#{m/r:^(permission|auth)$,#{@acp_hub_status}},#[fg=yellow],#[fg=cyan]}}#{@acp_hub_status_glyph} #[default], }"
  # Active tab: the glyph inherits the current-style (black on the accent bar)
  # like the icon and title; its shape (◐ ⏸ ⊘ ✗) already carries the state, so
  # a semantic tint would only cost contrast on the punk background.
  acp_attention_active="#{?#{m/r:^($acp_attention_states)$,#{@acp_hub_status}}, #{@acp_hub_status_glyph} , }"
  acp_title="#{?#{@acp_hub_tab_title},#{@acp_hub_tab_title},#{?#{@acp_hub_title},#{@acp_hub_title},#W}}"
  # Inactive: theme-accented icon. Active: the resolved accent owns the tab
  # background and the icon/title use dark text for contrast.
  acp_window_status_format=" $acp_provider_style$acp_icon#[default] $acp_title$acp_attention"
  acp_window_status_current_format="$acp_provider_current_style $acp_icon $acp_title$acp_attention_active#[default]"
  tmux set-option -t "$session" -q window-status-format "$acp_window_status_format"
  tmux set-option -t "$session" -q window-status-current-format "$acp_window_status_current_format"
  tmux set-option -t "$session" -q window-status-separator ""
}
