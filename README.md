# tmux-acp-hub

ACP Hub — a persistent multi-agent hub for tmux. Run Codex, Claude Code, and
any [Agent Client Protocol](https://agentclientprotocol.com) agent in tmux
popups: chats live in a background daemon, survive popup and daemon restarts,
and every list shows live status with a transcript preview.

- **Persistent** — a background daemon keeps agents alive; close the popup, the
  chat keeps working.
- **Multi-agent** — Codex and Claude Code out of the box, plus any ACP adapter.
- **No lock-in to a plan** — a provider API key works too (no subscription
  required).
- **Zero dependencies** — pure Node + tmux; adapters are fetched on demand.

![ACP Hub chat showing a rendered table, completed plan, composer, and model
metadata in a neutral sample project.](assets/screenshot.svg)

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
  - [Updating](#updating)
  - [Uninstalling](#uninstalling)
- [Authentication](#authentication)
- [Keybindings](#keybindings)
- [Popup commands](#popup-commands)
- [How it works](#how-it-works)
  - [Chats, windows, and the daemon](#chats-windows-and-the-daemon)
  - [The composer](#the-composer)
  - [Markdown and tool rendering](#markdown-and-tool-rendering)
- [Configuration](#configuration)
  - [Adapters and model updates](#adapters-and-model-updates)
  - [Provider config defaults](#provider-config-defaults)
  - [MCP servers](#mcp-servers)
  - [tmux options](#tmux-options)
  - [Environment variables](#environment-variables)
- [Privacy and state](#privacy-and-state)
- [tmux-resurrect / continuum](#tmux-resurrect--continuum)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [Maintainer workflow](#maintainer-workflow)
- [Changelog](#changelog)
- [License](#license)

## Requirements

| Need | Version / note |
|------|----------------|
| tmux | >= 3.4 |
| Node.js | >= 18 for the dependency-free Hub; **>= 22 recommended and required by the default ACP adapters** |
| ACP adapters | exact `npx` pins initially; optionally verified into the Hub's private version store |

Each provider authenticates through its own CLI/account the first time
(`/auth` inside a chat). Check your environment:

```sh
plugin_dir="$(tmux show-option -gqv @acp_hub_dir)"
node "$plugin_dir/bin/acp-hub.mjs" health
```

## Installation

GitHub is the canonical distribution source; the Hub is not published as an
npm package. TPM and a manual Git clone execute the same self-contained files.

With [TPM](https://github.com/tmux-plugins/tpm), add to `~/.tmux.conf`:

```tmux
set -g @plugin 'tarquibrian/tmux-acp-hub'
```

Then `prefix + I` to install. Manual install:

```sh
plugin_dir="${XDG_CONFIG_HOME:-$HOME/.config}/tmux/plugins/tmux-acp-hub"
git clone https://github.com/tarquibrian/tmux-acp-hub "$plugin_dir"
```

```tmux
run-shell '${XDG_CONFIG_HOME:-$HOME/.config}/tmux/plugins/tmux-acp-hub/acp-hub.tmux'
```

The entrypoint records its real location in `@acp_hub_dir`, so runtime scripts
work whether TPM uses `~/.tmux/plugins`, an XDG plugin directory, or a custom
`TMUX_PLUGIN_MANAGER_PATH`.

### Updating

With TPM, press `prefix + U`. For a manual install:

```sh
plugin_dir="$(tmux show-option -gqv @acp_hub_dir)"
git -C "$plugin_dir" pull --ff-only
```

Then reload the tmux configuration and restart the daemon so both the bindings
and the long-running Node process use the new files:

```sh
tmux source-file ~/.tmux.conf
plugin_dir="$(tmux show-option -gqv @acp_hub_dir)"
node "$plugin_dir/bin/acp-hub.mjs" restart
```

You may use `/restart` from a chat for the second command. Updates never require
deleting `~/.cache/tmux-acp-hub`; saved chats, drafts, titles, and plans migrate
in place. Check the release notes before updating across minor versions.

Plugin updates and adapter updates are separate. Use `/hub updates` in a chat,
or run `bin/acp-hub.mjs updates` from the resolved `@acp_hub_dir`, to inspect
Codex/Claude adapter releases without updating the plugin itself.

### Uninstalling

Stop the daemon first while the plugin files are still present:

```sh
plugin_dir="$(tmux show-option -gqv @acp_hub_dir)"
node "$plugin_dir/bin/acp-hub.mjs" stop
```

For TPM, remove `set -g @plugin 'tarquibrian/tmux-acp-hub'` from `tmux.conf`,
then press `prefix + Alt + u`. For a manual installation, remove the cloned
directory and the corresponding `run` line, then reload tmux.

Uninstalling the plugin intentionally preserves user data. To erase chats,
drafts and verified adapter copies too, remove
`${XDG_CACHE_HOME:-$HOME/.cache}/tmux-acp-hub`; managed configuration under
`${XDG_CONFIG_HOME:-$HOME/.config}/tmux-acp-hub` remains independent and should
only be deleted when the user explicitly wants to discard it.

## Authentication

The hub speaks [ACP](https://agentclientprotocol.com) to adapter processes;
authentication belongs to the agent CLI behind each adapter, so **you do not
need a paid plan** — an API key works too:

| Provider | Plan login | API key |
|----------|-----------|---------|
| Codex (`codex-acp`) | `codex login` | `OPENAI_API_KEY` |
| Claude Code (`claude-agent-acp`) | `claude /login` | `ANTHROPIC_API_KEY` |

Adapters inherit the daemon's environment, so exporting a key from your shell
or secret manager is preferred. To scope a key to one agent, you may instead
add an `env` block in `~/.config/tmux-acp-hub/agents.json`:

```json
{
  "agents": {
    "codex": {
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

That file is plaintext. Protect it before adding credentials:

```sh
chmod 600 ~/.config/tmux-acp-hub/agents.json
```

The `bin/acp-hub.mjs health` check warns when it finds credential-like values in a user config
that is readable by group or other users; it never prints their values.

If an adapter starts unauthenticated, the chat drops into an auth state (yellow
composer rail): `/auth` lists the login methods the adapter advertises and
`/auth <id|n>` runs one (browser OAuth flows open externally). Credentials are
normally stored by the agent CLIs themselves (`~/.codex`, `~/.claude`). Values
explicitly placed in `agents.json` remain in that file and are passed only to
the configured adapter process; they are not copied into transcripts or the
Hub registry.

## Keybindings

All bindings are under your tmux `prefix`.

| Key | Action |
|-----|--------|
| `prefix + m` | Minimize the open popup, or restore the most recent chat for the project. With no chats, opens a menu (or creates one when the hub is empty). |
| `prefix + M` | Open the full menu. Inside a chat it opens **as an overlay in the same pane** (see below); from a normal pane it opens the popup. |
| `prefix + y` | Open the native tmux Command Center for the active chat. |
| `prefix + 9` / `prefix + 0` | Create a new Codex / Claude chat for the project. |
| `prefix + (` / `prefix + )` | Focus the most recent Codex / Claude chat for the project. |
| `prefix + s` | Outside the popup: normal tmux sessions. Inside `acp-*`: the tree-style ACP chat selector (icon, title, status, last activity, model/effort) with a live preview pane. |
| `prefix + ,` | Inside a chat: rename the **chat** (title + status-bar label). Outside: normal tmux window rename. |
| `prefix + x` / `prefix + &` | Inside a chat: a close menu (close window / stop chat / delete / kill-pane). Outside: normal tmux kill confirmations. |

The primary bindings are configurable. For example, this moves the popup
toggle to `prefix + a`, disables the standalone menu binding, and keeps the
normal tmux `prefix + x` behavior:

```tmux
set -g @acp_hub_key_toggle 'a'
set -g @acp_hub_key_menu 'off'
set -g @acp_hub_key_close 'off'
```

Set any `@acp_hub_key_*` option to `off` (or an empty value) before loading the
plugin to leave that key untouched. The legacy provider shortcuts `9`, `0`,
`(`, and `)` can be disabled together with
`set -g @acp_hub_legacy_keys 'off'`.

Inside a `acp-*` workspace, `prefix + s` opens a tree-style selector of every ACP
chat across projects, with aligned columns (icon, title, status, last activity,
mode, model) and a live preview:

![The prefix+s tree selector listing chats across projects with status, time,
mode and model columns.](assets/switcher.svg)

### The `prefix + M` menu

An interactive list of every chat, with New-chat rows per provider. It opens
with the chat you were just in preselected (not the top of the list), and
navigation comes first — typing doesn't filter until you ask for it:

| In the menu | Does |
|-------------|------|
| `j`/`k`, `↑`/`↓`, `Ctrl+N`/`Ctrl+P` | move (`g`/`G` first/last) |
| `Enter` / `l` | open the chat, or create one from a `New … chat` row |
| `/` | filter mode — type to narrow fzf-style, `Esc` back to the list (query kept) |
| `h` | back out (clear filter first, then close) |
| `Tab` | cycle `Recent` → `Oldest` → `Projects` ordering |
| `s` | toggle current-project / all-projects scope (types normally while filtering) |
| `Ctrl+O` | close the menu immediately and restore the suspended composer |
| `Ctrl+S` | send a one-line reply to a live chat without leaving the list (idle → starts a turn, busy → queues; preview refreshes) |
| `Ctrl+E` | rename the highlighted chat inline |
| `Ctrl+D` (twice) | delete permanently; closes its tab if open |
| `Ctrl+R` | re-import provider sessions |
| `Esc` | leave filter mode, then clear the filter, then close the overlay |

The three order modes are rendered as one-cell-separated family-style tabs: the active
tab uses the resolved `@acp_hub_theme` accent with dark text, while inactive tabs use the same dark
surface language as inactive tmux windows. Labels compact automatically on very
narrow terminals, and plain/non-TTY output falls back to bracketed text.
Chat and New-chat rows follow the compact model/effort picker hierarchy:
unselected titles use Vanzi's readable `#b9b9b9`, secondary metadata and
section labels stay softer, the selected title becomes bold, provider icons use
the resolved theme accent, and semantic status colors remain visible without
making every row compete for attention.

![The menu overlay: a filterable chat list on the left with per-chat status,
age, mode and model, and a live transcript preview of the highlighted chat on
the right.](assets/menu.svg)

Picking a chat focuses its window (or creates one); from a cold-start menu it
loads the chat into that pane. When the popup is ≥ 96 columns wide, a preview
pane on the right shows the highlighted chat's transcript tail — live and saved
alike. The left list receives 58% by default while the preview retains at least
38 columns. Chat titles consume the remaining row width responsively instead of
stopping at a fixed character cap, while project, age and live status retain
semantic priority. `Recent` is the default and mixes every provider by last activity;
`Oldest` reverses the daemon-side chronology before pagination, while `Projects`
groups only by project and ranks attention inside each group. Set
`ACP_HUB_INTERACTIVE_UI=0` for the old text menu.

Inside a chat you can also reach the menu overlay with `←` on an empty composer
at the latest transcript position or `Ctrl+O` at any time, including while
viewing scrollback. The menu temporarily owns the complete popup: composer,
Plan, queue, metadata and shortcut hint are hidden while its filterable list and
preview use the full height. The live draft session is only suspended, so `Esc`
restores its exact text, cursor, editing state, latest Plan and queue in one
frame; `Ctrl+O` closes the scene directly from any menu layer. Selecting another
chat switches its tmux window before the previous pane is repainted.

## Popup commands

Slash commands typed in the chat composer. Most config commands have a tmux
menu / interactive picker equivalent under `prefix + y`.

### Navigation and chats

| Command | Action |
|---------|--------|
| `/menu` | Menu overlay in this pane (same as `←` / `Ctrl+O`). |
| `/chats` | Interactive chat switcher (filter, `Enter` switches, `Ctrl+E` rename, `Ctrl+D`×2 delete; the open chat is protected — use `/delete`). |
| `/control`, `/cmd`, `/panel` | Open the tmux Command Center. |
| `/new <agent>` | Create another ACP session for the project. |
| `/refresh` | Ask providers for saved ACP sessions (`session/list`). |

### Session config

| Command | Action |
|---------|--------|
| `/model [value]` | Show a picker, or set the model when the adapter reports it. |
| `/effort [value]` | Show a picker, or set effort/reasoning. |
| `/modes`, `/mode <value>` | Show / set the provider's canonical mode (`configOptions(category=mode)`, with legacy `modes` fallback). |
| `/access [value]` | Show mode plus live permission/grant state; with a value, compatibility alias for `/mode`. |
| `/config [id value]` | Show adapter config options, or set one. |
| `/commands` | Search one palette containing Hub commands, current ACP commands, and skills. |
| `/plan` | Expand the current execution plan above the composer (`Ctrl+P` toggles it too). |
| `/plan pin auto\|on\|off` | Control the smart-header Plan summary; `/plan close` collapses its non-modal phase list. |
| `/plan awaiting auto\|on\|off` | Control the pre-snapshot `Awaiting agent plan` summary for active turns. |
| `/details [toggle\|open\|close]` | Expand or collapse the latest turn's preserved activity (`F3` toggles it too). |
| `/details auto\|expanded\|hidden` | Set the default turn presentation; `/details all` and `collapse-all` affect every loaded turn. |
| `/roots`, `/roots add\|remove\|clear <path>` | Show / edit extra workspace directories (applied on reopen). |
| `/changes` (`/diff`) | Picker of the files edited in this chat (path + `+/-` counts); Enter expands the chosen file's git-style diff into the transcript. |

`/model`, `/effort`, `/mode(s)`, and `/access` open a compact numbered picker
inline **above the input card** (the same upper panel as command autocomplete), with
the current value marked `●` and the composer and transcript still on screen.
While it's open the picker owns the keyboard: `j`/`k`/`↑`/`↓` move (`g`/`G`
ends), `1-9` picks directly, `Enter`/`l` applies, and `Esc`/`h` backs out. The
underlying composer remains intact and resumes when the picker closes. Every picker that appears while the composer
is live (permission prompts included) uses the same inline list. A pending
permission has priority over model/effort menus, autocomplete, Plan and queue;
it replaces that shelf in one frame without submitting, clearing or recreating
the current draft. The request remains in persisted history for recovery and
audit, but is not duplicated inside the normal agent transcript. The
full-screen variant remains for the flat small-popup layout
(`ACP_HUB_INTERACTIVE_UI=0` forces text menus).

Slash/subcommand and `@file` autocomplete share that upper panel. Its exclusive
priority is quickselect, autocomplete, expanded Plan, then queue; covering a
Plan or queued prompts never changes their state. Lists grow only toward the
transcript, so the
input card, internal metadata, and external hint keep exactly the same rows
while suggestions open, filter, and close. One blank row separates every list
from the smart header, and titles, markers, and options use the same three-cell
left inset as the header content. The hint becomes a navigation guide instead
of repeating command or file results below the card. Moving the selection
repaints only this panel; when it closes, the unchanged complete Plan list
returns immediately.

`/hub` uses that same inline surface with nested action, provider, and
confirmation steps; it falls back to structured text help when an interactive
picker is unavailable.

### Prompt input

| Command | Action |
|---------|--------|
| `/compose` | Multiline prompt; finish with a single `.` line. |
| `/edit` | Write a prompt in `$VISUAL` / `$EDITOR`. |
| `@file` | Mention and attach a project file inline (opens autocomplete). |
| `/attach <path>…` | Attach files to the next prompt (image / resource / link by capability). |
| `/attachments`, `/files` | Show pending attachments. |
| `/detach <n>\|last\|all` | Remove pending attachments. |
| `/command [args]` | Run a command advertised by the current ACP agent when it does not collide with the Hub. |
| `//command [args]` | Force the ACP command when the Hub owns the same `/command` name. |
| `/agent <text>` | Send literal text straight to the provider, including slash text that was not advertised. |

Provider commands are discovered dynamically from ACP `available_commands_update`;
the Hub does not maintain a hard-coded Codex/Claude command list. Descriptions,
argument hints, aliases, skills, and safe command metadata feed the same
autocomplete and `/commands` palette. For example, Codex commonly advertises
`/status` and `/compact`; `/usage` is shown only when the active adapter actually
reports it. Context-window and cost data remain provider-independent through ACP
`usage_update` and appear in the composer footer.

The palette updates in place when ACP changes the available command set. Aliases
are searchable and completable, while the palette keeps one row for the canonical
command. Hub ownership is case-insensitive and Hub spellings are lowercase, so a
casing variation cannot bypass a collision; `//command` is the explicit provider
escape. Without the interactive picker, `/commands` prints the complete unified
catalog into the scrollable transcript. The auxiliary tmux menu is intentionally
limited to 24 provider commands and points back to `/commands` for the full list.

Command invocations are stored as command events rather than ordinary prompts.
Informational and state commands therefore cannot rename the chat or retire the
pinned Plan; commands that start real work still receive the normal Activity,
cancel, queue, history, and final-answer lifecycle. Known `setConfigOption`
metadata is applied through ACP when the matching config option exists. Unknown
extensions safely fall back to the provider's normal `session/prompt` handling.

### Permissions

Permission requests (including the plan-mode "ready to code?" approval): press
`Enter` on an empty line — or `/allow` with no number — to open a compact
numbered menu. Press the number (`1`–`9`) to pick instantly, or
`Ctrl+N`/`Ctrl+P` (arrows, `j`/`k`) + `Enter` or `l`; `Esc` or `h` keeps it
pending.
`/allow <n>` picks option `n` directly and `/deny` rejects. Options are whatever
the adapter sends — ACP has no per-option preview or free-text channel.

### Auth, MCP, filters, lifecycle

| Command | Action |
|---------|--------|
| `/auth [id\|n]` | List auth methods / run one, then retry session creation. |
| `/mcp` | Open the MCP manager: inspect scopes/status, test, enable/disable, remove, and apply. |
| `/q <text>` or `?<text>` | Filter chats by title/project/path/provider/session. |
| `/p <provider>`, `/s <scope>`, `/o <order>`, `/clear` | Filter provider, select scope (`project`/`all`), select order (`recent`/`oldest`/`projects`), or reset. |
| `/cancel` | Cancel the current turn and pending permission requests. |
| `/rename <title>`, `/title <title>` | Name the current chat for menus/search. |
| `/close` | Stop the ACP adapter, keep saved session metadata. |
| `/delete` | Permanently delete the current chat (confirms; removes the provider session when `sessionCapabilities.delete` is advertised). |
| `/activity <mode>` | Tool activity rendering: `compact`, `hidden`, or `debug`. |
| `/debug` | Toggle internal hub events in the chat pane. |
| `/hub` | Open the inline adapter manager: inspect, check, update, or roll back. |
| `/hub versions` | Show configured, active, pending, bundled-runtime, and global CLI versions. |
| `/hub updates` | Check the configured npm channel without installing anything. |
| `/hub update <agent\|all>` | Prepare the current pin, or download, verify, ACP-handshake, and stage a newer adapter. |
| `/hub rollback <agent>` | Stage the previous verified adapter. |
| `/exit` | Close the popup client only (the agent keeps running). |

`/hub` is a Hub-owned namespace, so it cannot collide silently with a provider
command. If an adapter ever advertises `/hub`, invoke that provider command as
`//hub`. Updates are never activated during a live daemon: the candidate stays
pending until `/restart`, and the previous verified version remains available
for rollback. The bare `/hub` command uses a nested picker (action → provider →
safe confirmation); fully typed update/rollback commands use that same visible
confirmation instead of a hidden `y/N` prompt. After confirmation the daemon
owns the operation: the composer's upper panel shows registry, download,
verification, and ACP-handshake phases while the input remains usable. Closing
and reopening the popup recovers the same progress or final result. A staged
result offers `Restart now` / `Restart later` with empty `Enter`; failures offer
`Retry` / `Dismiss`. Composer completion continues contextually through
`/hub update <provider>`.

Version output uses user-facing states: `npx fallback` means the exact configured
pin works through `npx` but has not yet been copied into the Hub's verified
private store; `restart required` means a verified candidate is staged. Every
actionable state includes a concrete next command. `/hub updates` compares the
effective current and new versions in a compact table before showing those
instructions.

## How it works

The popup is only a client. A background daemon keeps ACP agent processes alive
through `~/.cache/tmux-acp-hub/hub.sock`, so closing the popup does not kill
the chat. The daemon also owns tmux window metadata (`@acp_hub_status` and
friends) and re-syncs the matching window on every chat change, so status
glyphs in the status bar and the `prefix + s` switcher stay fresh even when no
popup is attached.

A permission request raised while the popup is closed stays pending (status
`permission`, visible in tmux badges) and re-surfaces when you reopen the popup;
unanswered requests cancel after a five-minute timeout. Requests and their final
decisions are persisted together by `toolCallId`. The request itself is shown
only as an interactive list in the composer's upper panel (raw protocol details
remain available through `/debug`), while its final decision provides the
compact transcript audit that distinguishes `Allow Once`, a remembered session
grant, rejection, timeout, and cancellation.
The footer keeps the provider's base mode visible and adds a separate temporary
grant label: approving one edit while Codex is `read-only` does not silently
rename the base mode. Set `@acp_hub_permission_policy 'deny'` for a fail-closed
client policy that rejects every ACP escalation without showing a picker; the
default `prompt` asks the user. This policy controls ACP requests, while the
adapter/provider remains responsible for enforcing its sandbox.

When an adapter reports
`auth_required` (ACP error `-32000`), the chat enters an `auth` state instead of
failing: the adapter keeps running and `/auth <id>` runs the ACP `authenticate`
method. Environment-variable methods aren't run through `authenticate` — the hub
tells you which variables to set before reopening.

### Chats, windows, and the daemon

A chat is **not** a pane or a window: it lives in the background daemon (the ACP
adapter process plus the transcript) and is persisted in the registry. Each
tmux window inside the hidden `acp-*` workspace is only a **view** onto one chat,
and the pane inside it runs a disposable UI client.

- Killing a pane or window closes the view; the chat keeps running and stays in
  every menu. Reopen it and the transcript replays.
- The transcript (last 2000 events by default, configurable) is persisted with the session metadata, so
  it survives daemon restarts — restored chats replay even when the adapter
  can't reload history.
- A chat keeps a canonical title for menus/search and a separately bounded tab
  label for tmux. **Identity is the `@acp_hub_chat_id` window option, not the
  name** — `prefix + ,` renames the chat, never the internal id.
- Splitting panes inside a chat window is plain tmux; extra panes are not chats.

Workspaces are named `acp-<project>` (with a `-2`/`-3` suffix when two projects
share a basename; the owning project is tracked in `@acp_hub_project_path`,
and legacy `acp-project-hash` sessions are reused while they live). They are
hidden from the normal `prefix + s` chooser. Set `@acp_hub_workspace_scope` to
`global` to restore the single `acp-hub` workspace mode.

In the status bar each window renders as a minimal label from chat metadata —
the provider icon in the resolved theme accent (`❋` Claude, `⬡` Codex, `◆` others;
override per agent with `icon` in `agents.json`), the chat title, and a status
glyph only while the chat needs attention (e.g. `❋ Refactor auth ⠹`). Chat
titles default to `New chat`, `New chat 2`, … (restored → `Saved chat`); project
and provider are their own columns, so titles stay short. With the default
`agent-first` policy, the first meaningful prompt is only an immediate fallback:
an ACP `session_info_update` title from Codex, Claude, or another adapter may
replace and evolve it. Later prompts never replace a stable title, and a manual
rename always wins and survives daemon restarts. Attachment markers such as
`[Image 1]` are omitted from prompt fallbacks.

### The composer

The chat input uses a pinned raw terminal composer when TTY support is
available.

**Layout.** The transcript scrolls above an editable prompt card. A continuous
full-width shaded surface and `┃` rail mirror the visual language of submitted
prompts while remaining an independent live variant. A responsive smart header
shows `icon + Codex/Claude` while idle and replaces that complete identity with
an animated active state during agent activity. By default the Braille loader
keeps rotating while a restrained gold shimmer travels quickly through
`thinking`/`working`/`responding`, then rests before the next pass. Only the
detached header row is repainted, so the transcript, Plan, input card and cursor
do not move. Set `@acp_hub_status_animation` to `breathe` for a whole-word pulse,
`spinner` to keep only the rotating loader, or `off` for a motionless semantic
glyph. Permission, auth, error and idle states are always static.
When ACP
publishes a plan, its compact progress follows that primary label immediately
instead of being right-aligned. On narrower popups the Plan summary drops
glyphs and state text before the primary label is truncated. A composer-owned
blank row separates the transcript from the smart header, and another separates
the header (or its dynamic shelf) from the card. The
rail uses the resolved theme accent, yellow for permission/auth, and Vanzi pink for
errors. Its single cell keeps the terminal/default background while the shaded
surface starts immediately after it. Editable rows and pending attachments stay inside the card with one
shaded padding row above and deliberate separators between sections. Session
metadata is the card's final shaded row, with no additional internal blank row
below it. One continuous left-to-right flow presents human-readable model, effort, and
access values as one-cell-separated theme-aware mini-cards—for example `GPT-5.6 SOL`, `XHigh`, and
`Full access`—without changing the raw ids sent to ACP. Clicking model or effort
expands every adapter-advertised value horizontally inside that same metadata
row; the current model uses the resolved accent over neutral alternatives,
while effort uses a stronger/darker neutral pair and borrows the accent only
for hover or a pending selection. Values inside the
expanded group touch edge to edge; only category boundaries retain spacing.
Hover previews a selectable value with its group's bright accent and dark text,
without adding an underline. The group always has exactly one bright chip: hover
temporarily transfers the accent from the current value to the candidate, and
leaving restores the canonical selection. A choice is applied
through ACP `session/set_config_option` and the group collapses only after the
adapter confirms it. Clicking the current value or pressing `Esc` closes the
group without changing configuration. `/model` and `/effort` remain the
keyboard-oriented upper-panel alternatives, while access continues to open
`/access`. The draft and cursor remain active throughout. The first visible card permanently owns the
pink accent; every other card keeps its dark surface and hover decorates only
the target without transferring selection. Volatile diagnostics continue
immediately after the cards, separated by middots rather than pushed to the
right edge: context, queue, attachments, draft estimate, MCP, roots, and project path
(context-window and cost values appear on ACP `usage_update`). Outside the card, the shortcut
hint has one plain blank row above and another below so it touches neither the
card nor tmux. The header reserves compact badges for transient interaction
state such as `[PERMISSION]`, `[SEARCH]`, `[PASTE]`, selection and scroll.
Canonical access (`read-only`, `full-access`, etc.) and temporary grants live in
the metadata footer, whose semantic responsive layout discards path, roots, MCP
and draft diagnostics before hiding access or permission state. Permission
requests retain priority over clicks on configuration cards. Extra roots show
`+N roots` and MCP servers `+N mcp`. On popups
too narrow for every expanded value, `‹`/`›` page the group horizontally;
diagnostics yield first and the input card never gains or loses rows.
On popups
shorter than 15 rows — or with `ACP_HUB_COMPOSER_ENHANCED=0` — the same card
and requested gaps remain, while the shortcut hint is omitted and completion
uses its classic flow instead of embedded pickers. The former
`ACP_HUB_COMPOSER_BOX=0` name remains supported as a compatibility alias.

**Pinned plan.** Structured ACP plans use the smart header for their compact
summary and therefore reserve no additional rows while collapsed. `Ctrl+P`
opens a non-modal phase drawer immediately below that header and above the
card; the header itself is not duplicated. The card remains bottom-anchored as
the drawer grows upward into otherwise-unused transcript space. It requests
enough rows for the complete wrapped phase list and has no independently
configured viewport or selected phase. Only the physical popup height can clip
an exceptionally large Plan. When a new turn follows an
unfinished plan, the existing summary stays visible as `Awaiting update` until
the agent emits its next complete ACP plan
snapshot; that snapshot replaces the panel atomically, including added, removed,
or reordered steps. If the turn emits no plan update, the carried panel retires
when the turn ends. With `@acp_hub_plan_awaiting auto`, an `Awaiting agent plan`
summary appears only when the ACP session is explicitly in `plan` or `planning`
mode. Previously observed plan support is retained as diagnostic
metadata but does not imply that every future prompt intends to create a plan.
The drawer contains every phase with full word/grapheme-aware wrapping whenever
the terminal can physically contain it. It has no phase navigation, controls
footer, or private scroll position. It never takes keyboard focus: typing,
editing, history, Vim motions, commands, attachments, and submission continue
in the input; `PgUp`/`PgDn` retain their normal transcript behavior. Only
`Ctrl+P` or `Esc` collapse it; while open the external guide explicitly shows
`Ctrl+P/Esc close plan · input active`. In Vim mode that same `Esc` also performs the normal editor-mode
transition. Autocomplete and pickers keep priority over the chord, where
`Ctrl+P` retains its existing "previous item" meaning while such a panel is
visible. Small popups keep the summary compact in the smart header. Only an
absolute height constraint removes the shelf gap, and a tall draft may
temporarily show fewer input viewport rows without losing text. Plans come only
from ACP `plan` updates — prose/Markdown is never guessed
into a plan — so Codex, Claude, and future conforming adapters share the same UI.

**Editing.** Everything advertised is a `Ctrl` chord — it sits in the same
place on every keyboard, unlike Alt/Option. Left/right, Home/End
(`Ctrl+A`/`Ctrl+E`), `Ctrl+U`, `Ctrl+K`, `Ctrl+W`, `Ctrl+Y`, Up/Down history,
and `Ctrl+R` reverse search. Multiline with `Ctrl+J`; plain `Enter` sends.
Soft wrapping moves complete words to the next visual row; only indivisible
tokens wider than a whole row are hard-wrapped. The editable layout keeps
source offsets, display-column cursor movement, selections, and Vim motions in
sync across those soft boundaries. The composer grows to six rows (`↑ N more`
/ `↓ N more` counters beyond that).
While an agent is active, the first `Esc` shows a short confirmation and a
second `Esc` within 1.5 seconds cancels it. The draft is kept — and if the
composer is empty, the just-sent prompt is restored into it, so "wait, one more
thing" remains cancel → tweak → Enter. If queued work would also be discarded,
the confirmation says how many items are affected. `Ctrl+C` only clears the
composer into the kill ring (`Ctrl+Y`); with an empty composer it is inert.
`Ctrl+D` or `/exit` closes the popup. `Ctrl+L` repaints the whole screen. `Ctrl+X`
(or `/edit`) opens the draft in `$VISUAL`/`$EDITOR` (blocking, in this pane)
and reloads the buffer into the composer on exit — the natural way to write
long prompts. `Ctrl+G` (or `/rename`) renames the chat. For terminals
configured with Option/Alt as Meta, `Alt+E`, `Alt+Enter`/`Alt+J` (newline),
and `Alt+B`/`Alt+F` (word jumps) also work as quiet aliases.
Prompts that start immediately enter the semantic transcript optimistically and
are reconciled with the daemon by a stable submission id, so a fast
cancel/repaint cannot hide the input and two identical prompts remain two
distinct turns. Queued prompts stay outside the transcript until their turn
actually begins.

**Draft cost.** While you type, the footer shows an estimated token count for
the draft (`~1.5k tok`): composer text at ~4 chars/token, pending attachments
by size (images at a flat estimate), and `@file` mentions resolved via
`fs.stat` — file *sizes* are read, never contents. It's a local
order-of-magnitude signal, not an API count; it turns yellow past 32k.

**Vim mode.** `/vim` toggles modal editing (persisted; `ACP_HUB_VIM=1` also
enables it). `Esc` switches insert → normal and visual → normal; in clean NORMAL
mode, two further `Esc` presses use the guarded cancellation above (a pending
count/operator is cleared first). `Ctrl+C` with text only clears the draft; with
an empty Vim composer, press `Ctrl+C` twice to confirm cancellation. Normal mode supports
counts (`3w`, `2dd`, `5x`), motions `h j k l`, `w b e`, `0 ^ $`, `gg G`,
`f F t T <char>`, `%` (bracket match), operators `d c y` with those motions
(`dd cc yy` linewise; `cw` = `ce` like vim), edits `x X r s S D C ~`, `p P`
from the kill ring (shared with `Ctrl+Y`), stacked undo `u` and redo `U`,
`.` repeats the last change (including the text typed by a `cw`/`C`/`s`),
and `i a I A o O` re-enter insert. `v`/`V` open charwise/linewise visual mode
(selection shown in reverse video): motions extend it, `o` swaps ends, and
`d x c s y ~ p` act on it. Enter still submits from any mode; the footer
shows `NORMAL`/`INSERT`/`VISUAL`/`V-LINE` plus pending keys (`NORMAL 2d`).
Vim only applies to the main composer — nested prompts stay plain.

**Modes and menu (empty composer).** `Tab`/`Shift+Tab` cycle the adapter's
session modes (e.g. Claude `plan → default → acceptEdits`) — the hint shows the
current provider mode and the footer keeps temporary permission grants separate from it. `←` backs out to the menu
overlay in the same pane (the agent-view "detach" gesture); `Esc` returns to the
chat.

**Autocomplete.** Typing `/` or `@` opens a dropdown above the input card:
`Ctrl+N`/`Ctrl+P` (or arrows) travel, `Tab`/`Enter`/`→` accept (`Enter` still
submits an exact command), `Esc` dismisses. On the flat layout, `Tab` keeps the
classic unique-match completion.

**Paste and attachments.** Bracketed paste is on, so pasted code/logs insert as
one operation and internal newlines don't submit. Pasting file paths attaches
those files; very large text blocks are stored as temporary file attachments.
Each attachment drops an inline `[Image #N]` / `[File #N]` / `[Pasted #N +L
lines]` token at the cursor so the prompt records where it belongs, and the
pending set is listed in a grouped section under the input (`Images (2)` /
`Attachments (3)` + chips), separated from the draft by one blank row. Tokens
and chips use the configured Hub accent, and
submitted attachment references preserve that color plus a blank row after the
prompt text. Inline tokens are atomic:
Left/Right and Vim motions jump across them, while Backspace/Delete or an edit
that intersects one removes the complete token and detaches the file. On an
empty composer, Backspace removes the last attachment.
`Enter` on an empty composer with pending attachments sends them.

**Scrolling.** The internal scroll is the primary way to review the transcript
— it re-renders lazily from the configured retained event history, so wrapping
and colors stay correct at any position. `PgUp`/`PgDn` move 40% of a viewport by default, keeping
visual context between jumps. The mouse wheel uses the same internal buffer and
moves four rows per event; wheel up enters scroll mode and wheel down returns
toward the live tail. `Home` jumps to the top, while `End`/`Esc`/submitting
return to the live tail. A `[SCROLL]` badge (with `+N new`) shows when output
arrives while scrolled, and the hint row lists the keys. `Ctrl+L` redraws from
the buffer. tmux copy-mode (`prefix+[`) remains available but reads tmux's own
scrollback, which can hold stale frames from earlier repaints — prefer the
internal scroll. Drafts and input history persist per chat; browsing history
with `↑`/`↓` stashes your in-progress draft and restores it when you come back
down. Turn headers are the primary mouse target for their activity drawer;
Activity group headers with summaries or diffs are secondary targets for those
nested details. Hover gives either header a subtle highlight and a left click
toggles it. A bare drag in an ACP chat enters tmux copy-mode; releasing uses the
user's existing `MouseDragEnd1Pane` policy (tmux buffer, OSC52, `pbcopy`, etc.)
and normally copies automatically. `F4` remains a terminal-selection fallback:
the Hub suspends SGR tracking until `Esc`/`F4`, showing `[SELECT]`. Click and
hover can also be disabled independently.

Native drag routing wraps only tmux's stock `MouseDrag1Pane` root binding. If
the Hub detects a custom or deliberately unbound root binding it leaves it
untouched and reports `@acp_hub_mouse_native_select_status=custom-binding`;
use `force` only when replacing that customization is intentional. `off`
restores the stock binding when the Hub currently owns it.

The transcript uses two inner cells on both sides by default. Wrapping is
computed against that content width. Submitted prompts use a shaded full-width
band with their text inset by those two cells plus one shaded row above and
below; hovered turn headers and diff rows can remain full-bleed too. Fenced code
is a compact semantic rectangle whose background follows its longest visual row
instead of filling the viewport, with two internal cells on every side. The
same outer inset is used by the expanded Plan phases without moving the card.

Queueing: sending while a turn is active keeps the prompt out of the transcript
and opens the shared shelf below the smart header. Each queued request gets one
contiguous row (`Queue 2 · Next: review the wrapper…`, then `· 2: run tests…`),
with one blank row above the list and the ordinary card gap below. Opening a
model/mode/effort/hub/permission picker or autocomplete temporarily replaces
the queue in that same shelf; adapter-maintenance progress and an expanded Plan
do likewise. Closing the temporary section restores the unchanged queue. A row disappears in the same
transition that publishes its prompt as the next real turn. `N queued` remains
in the footer as a compact secondary counter; `/cancel` drops the queue. Env kill-switches:
`ACP_HUB_PINNED_INPUT=0` (inline raw prompt), `ACP_HUB_RAW_INPUT=0` (Node
readline), `ACP_HUB_BRACKETED_PASTE=0`.

### Markdown and tool rendering

Agent responses use a small terminal Markdown renderer: headings, inline code,
bold/italic, links, images, blockquotes, lists, checklists, fenced code blocks
(syntax-highlighted), horizontal rules, and streamed tables. A declared fence
language selects a lightweight grammar; aliases such as `ts`/`typescript` and
`tmux`/`tmuxconf` are normalized, while an unlabeled fence remains headerless
and neutral. The tmux grammar distinguishes commands, flags, user options and
`#{formats}` without adding an external highlighter dependency. Tables render
without pipes, with aligned width-aware columns; while the pinned composer is
active they render progressively (header on separator, each row as it completes,
re-painted when a wider row changes widths). Width math is display-aware (CJK,
emoji stay aligned). It is not a full CommonMark parser; unsupported Markdown
falls back to readable plain text. Prose wraps at word boundaries; lists keep a
hanging indent and blockquotes repeat their rail. Code/diffs retain hard column
semantics, while fenced blocks and tables retain their source rows for
width-aware reflow. These semantic entries are shared by live output, replay,
resize, and internal scroll.

Tool lifecycle events use `compact` rendering by default: read/search tools
group as `Explored`, edit/write as `Edited`, and command-like tools as `Ran`.
A call and all later updates with the same ACP `toolCallId` remain one semantic
action. Consecutive actions share a counted group, while a later return to the
same category creates a new chronological group. Group icons default to `●`
and are yellow while active, green when complete, red on failure, and dim when
cancelled. Each category icon may be overridden from tmux; the renderer reserves
a shared one-or-two-column slot so custom glyphs do not disturb alignment. These
groups branch directly from the turn-detail rail: intermediate groups use
`├─`, while a group that is also the final visible detail block closes the tree
with `└─`. The rail and intersections use a dedicated low-contrast structural
gray, keeping action icons and labels visually dominant. Its child rows use
indentation instead of continuing the parent rail.
Free commentary never gains a branch or marker; it keeps the rail and aligns
with the action label/content column. If prose follows a group, that group remains
intermediate so chronological content is never detached from the tree. The
parent layout inserts exactly one rail-only spacer between visible semantic
blocks and none after the final block, so prose, plans, and action groups keep a
stable vertical rhythm. Action titles remain visible;
summaries and file diffs are open while the turn is active, then collapse under
the clickable group header when the turn settles. Expanded file edits render a
git-style diff — a `path (+added -removed)` header followed by syntax-highlighted
payload inferred from the file path. Only the diff sign stays green or red;
unknown file types fall back to plain text. Hunks remain compact (`⋮` marks
skipped lines).
`/activity hidden` gives a conversation-only transcript;
`/activity debug` or `/debug` renders the full ACP/tool event stream.
Reasoning/thought chunks are hidden in normal mode. ACP `plan` updates render a
`Plan (done/total)` block with per-step markers (`✓` done, `▸` in progress, `·`
pending), update the smart-header summary and optional drawer, and skip
identical transcript repeats.
ACP v1 plan entries define `pending`, `in_progress`, and `completed`; turn-level
permission, cancellation, or failure decorates the panel without inventing a
failed step status.

Every ACP prompt is also projected as a semantic turn card. In the default
`auto` policy a newly submitted prompt leaves the composer's live phase
(`thinking`, `responding`, or `working`) as the only status. Once provisional
content exists, an expanded `In progress · N actions · N files` drawer shows it
without an elapsed-time counter; zero-valued metrics are omitted. When an
adapter classifies message phases, the hub normalizes that
provider metadata into internal `commentary`, `final`, or `unknown` roles.
Codex's `commentary` stays in `Activity`, while `final_answer` streams directly
in the definitive response container; it is never moved or rewrapped when the
turn finishes. `turn_done` closes the drawer automatically and leaves the
`Worked for…` duration and tool/file totals followed by that same final
response when Activity exists. Direct answers without Activity omit that inert
summary row. Exceptional outcomes remain visible, and reported work whose
details are unavailable says so explicitly. The header, F3, and `/details` can reopen the preserved earlier
messages, action titles, thoughts, permission decisions, and plan updates; nested group
headers reveal their summaries and diffs. ACP `messageId` gives exact
message boundaries when present; legacy id-less streams fall back to contiguous
agent blocks separated by activity. Adapters without an equivalent phase signal
(including current Claude ACP releases) remain live inside `Activity`; after
`turn_done`, the last unknown agent message is inferred as the final response.
The provider classifier is isolated from the renderer so another adapter can
add an exact phase mapping later without changing the turn-card layout.
Collapsing a drawer never discards retained raw events; the configured
turn-aware history budget is the only retention
boundary. Cancelled, partial, and failed turns keep explicit outcomes.

## Configuration

Override providers in `~/.config/tmux-acp-hub/agents.json`, using the same
shape as `agents.json` in this plugin.

### Adapters and model updates

The hub has **no hardcoded model list**: models, modes, and reasoning efforts
come from the adapter at session start. ACP wire compatibility is negotiated
separately and currently remains protocol v1; an ACP SDK package version such
as `1.2.x` is not a wire-protocol version.

Default adapters use exact pins from the canonical
[compatibility manifest](compatibility/adapters.json). The generated
`agents.json` fallback and the built-in defaults are release-tested against
that same source, so a maintainer update cannot leave one copy stale.

> **Migrating from `@zed-industries/codex-acp`?** That package is deprecated
> and frozen at 0.16.0 — if your `~/.config/tmux-acp-hub/agents.json` still
> references it, switch to `@agentclientprotocol/codex-acp` to keep receiving
> updates.

The exact pins remain the offline/fallback launch path. The version manager can
install adapters into `~/.cache/tmux-acp-hub/adapters`, including their
compatible Codex runtime or Claude Agent SDK:

```sh
hub_bin="$(tmux show-option -gqv @acp_hub_dir)/bin/acp-hub.mjs"
"$hub_bin" versions
"$hub_bin" updates
"$hub_bin" update codex
"$hub_bin" update claude
"$hub_bin" rollback codex
```

An update is downloaded into staging, checked against the requested package
and version, launched for an ACP v1 `initialize` handshake, and only then
recorded as pending. `/restart` (or `bin/acp-hub.mjs restart`) atomically
promotes it. A failed install
or handshake leaves the active version untouched; concurrent updaters share a
lock, and stale cached registry data is labelled when the network is down.
In-popup operations return an id immediately and continue in the daemon, so a
slow npm install does not freeze the composer. Their latest phase and terminal
result remain available to every reopened popup until explicitly dismissed.

The `stable` channel follows the package's npm `latest` tag. `edge` opts into
`next`/`beta` when published and otherwise falls back to `latest`. Execution
always uses an exact installed version — never a mutable tag. Automatic checks
may notify, but installation is always explicit.

`codex-acp` carries a compatible `@openai/codex` dependency, and
`claude-agent-acp` carries the Claude Agent SDK. Standalone `codex` and `claude`
executables are reported for diagnosis but are never modified by this plugin.
`bin/acp-hub.mjs health` also reports the effective private runtime, pending activation,
incomplete stores, deprecated packages, and user overrides that intentionally
own a command/pin.

### Provider config defaults

Provider defaults can include ACP config values, applied after `session/new`,
`session/load`, or `session/resume` when the adapter reports matching options:

```json
{
  "agents": {
    "claude": {
      "configDefaults": { "model": "sonnet", "effort": "high", "mode": "plan" }
    }
  }
}
```

The hub also remembers the last selected config per project/provider, so a new
chat inherits the model/effort you used most recently there.

### MCP servers

The Hub administers MCP descriptors; the ACP adapter/agent owns the actual MCP
connections and tools. Open `/mcp` from the composer, click the `+N mcp` footer
diagnostic, or choose **MCP servers** in the Command Center. The inline manager
shows whether every entry is applied, pending, invalid, unsupported, disabled,
out of scope, or shadowed by a more specific entry.

Managed entries are stored atomically in
`$XDG_CONFIG_HOME/tmux-acp-hub/mcp.json` with mode `0600`; the containing
directory is `0700`. A malformed registry is moved to a timestamped
`.corrupt-*` backup, also forced to `0600`, so it cannot prevent the daemon
from starting. Existing managed registries and directories are tightened to
`0600`/`0700` when loaded.

Common commands:

```text
/mcp
/mcp list
/mcp diagnostics
/mcp test [name|id]
/mcp add <name> <stdio|http|sse> <target> [args...]
         [--scope global|agent|project|agent-project]
         [--env NAME=value] [--header NAME=value]
/mcp edit <name|id> <new-name> <transport> <target> [...]
/mcp enable|disable|remove <name|id>
/mcp apply
```

The default scope for `/mcp add` is the current project. Precedence is
`agent+project` → `project` → `agent` → `global`; a managed entry wins over a
static entry at the same scope and name. `test` is a local preflight for schema,
environment references, executable resolution, and adapter transport
capabilities—not a remote MCP protocol handshake.

`/mcp apply` reconnects only an idle session and rolls back to its previous
descriptor set if restoration fails. During a turn or permission decision it
stays pending and applies when the chat becomes idle. If the adapter advertises
neither `session/resume` nor `session/load`, the existing chat is left untouched
and a new chat is required to activate the change.

Static configuration remains supported with a top-level `mcpServers` array (all
agents) and/or a per-agent one. These entries are read-only in `/mcp` and are
passed to `session/new`, `session/load`, and `session/resume`. `stdio` works
without an advertised transport capability; `http`/`sse` are passed only when
the adapter advertises the corresponding `mcpCapabilities`. SSE is retained for
compatibility but is deprecated in favor of HTTP.

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": {}
    },
    {
      "name": "context7",
      "type": "http",
      "url": "https://mcp.example.com",
      "headers": { "Authorization": "${MCP_AUTHORIZATION}" }
    }
  ]
}
```

`env`/`headers` accept an ACP `[{name,value}]` list or a plain object. Prefer
`${ENV_VAR}` references for secrets. The canonical descriptor remains private
and is materialized only for the ACP adapter; public RPC responses, persisted
chat summaries, events, the transcript, and the UI use a separate projection.
That projection exposes only environment/header names and redacts recognized
credential flags (`--token`, `--api-key=…`), authorization arguments, URL
userinfo, and credential-like query parameters. Do not pass an unlabelled
positional secret in `args`, because no client can reliably infer its meaning;
use `env`, headers backed by `${ENV_VAR}`, or a named credential flag.

Validation rejects malformed environment/header names, URL credentials,
header injection, and control characters in commands/arguments before an
adapter receives the descriptor. Run `/mcp diagnostics` or
`bin/acp-hub.mjs health` to validate the managed registry, file permissions,
and static definitions.

### tmux options

Set with `set -g @option value` in `~/.tmux.conf`.

| Option | Default | Purpose |
|--------|---------|---------|
| `@acp_hub_session_prefix` | `acp` | Workspace session prefix. |
| `@acp_hub_workspace_session` | `acp-hub` | Name of the shared/global workspace session. |
| `@acp_hub_hash_length` | `8` | Project hash length used in per-project workspace names. |
| `@acp_hub_popup_width` / `@acp_hub_popup_height` | `90%` / `85%` | Popup size. |
| `@acp_hub_menu_order` | `recent` | Initial chat-menu order: `recent`, `oldest`, or `projects`; `Tab` cycles it at runtime. |
| `@acp_hub_menu_scope` | `project` | Initial chat-menu scope: current `project` or `all`; `s` toggles it at runtime. |
| `@acp_hub_menu_list_percent` | `58` | Chat-list share when the transcript preview is visible (45–75%; preview keeps at least 38 columns). |
| `@acp_hub_status_animation` | `wave` | Active composer status effect: `wave`, `breathe`, `spinner`, or `off`. |
| `@acp_hub_status_animation_interval` | `120` | Animation frame interval in milliseconds (80–600); lower values move the loader and wave faster. |
| `@acp_hub_status_animation_pause` | `900` | Quiet pause between `wave` passes in milliseconds (0–3000); the loader keeps rotating. |
| `@acp_hub_theme` | `vanzi` | Structural accent policy: `vanzi` keeps one family-wide pink; `agent` follows Codex blue / Claude orange and falls back to Vanzi for unknown adapters. |
| `@acp_hub_accent` | `colour168` fallback | Vanzi accent (`#rrggbb` or a 256-color number); also the fallback for unknown providers in `agent`. |
| `@acp_hub_default_agent` | `codex` | Provider for `prefix + m` cold starts. |
| `@acp_hub_workspace_scope` | per-project | Set `global` for one shared workspace. |
| `@acp_hub_node` | `node` | Node binary to launch the daemon/UI. |
| `@acp_hub_key_toggle` | `m` | Minimize/restore key; `off` leaves it unbound. |
| `@acp_hub_key_menu` | `M` | Full menu key; `off` leaves it unbound. |
| `@acp_hub_key_control` | `y` | Command Center key; `off` leaves it unbound. |
| `@acp_hub_key_switcher` | `s` | Context-aware session/chat switcher key; `off` leaves it unbound. |
| `@acp_hub_key_rename` | `,` | Context-aware chat/window rename key; `off` leaves it unbound. |
| `@acp_hub_key_close` | `x` | Context-aware pane/chat close key; `off` leaves it unbound. |
| `@acp_hub_key_close_window` | `&` | Context-aware window/chat close key; `off` leaves it unbound. |
| `@acp_hub_legacy_keys` | `on` | Bind `9`/`0` to create and `(`/`)` to focus provider chats. |
| `@acp_hub_scroll_page_percent` | `40` | Percentage of the transcript viewport moved by `PgUp`/`PgDn` (10–100). |
| `@acp_hub_mouse` | `on` | Master switch for transcript wheel, click, and hover tracking. |
| `@acp_hub_mouse_scroll_rows` | `4` | Transcript rows moved by one wheel event (1–20). |
| `@acp_hub_mouse_select_key` | `F4` | Temporarily hand drag selection to tmux/the terminal (`C-a`–`C-z`, `F1`–`F12`, or `off`). |
| `@acp_hub_mouse_native_select` | `on` | Bare drag enters native tmux copy-mode in ACP chats; `off` disables it and `force` replaces a custom root drag binding. |
| `@acp_hub_mouse_click` | `on` | Let left-click toggle interactive turn headers. |
| `@acp_hub_mouse_hover` | `on` | Track motion and highlight the current expand/collapse target. |
| `@acp_hub_transcript_padding` | `3` | General transcript/plan padding per side (0–4); full-bleed backgrounds keep the complete row. |
| `@acp_hub_prompt_padding` | `2` | Independent submitted-prompt padding per side (0–4), measured inside its full-bleed rail/background. |
| `@acp_hub_history_limit` | `2000` | Soft event budget per chat in memory, on disk, and after reopening (200–20000); oldest turns are removed whole. |
| `@acp_hub_permission_policy` | `prompt` | ACP escalation policy: ask with `prompt`, or automatically reject with fail-closed `deny` (applied after daemon restart). |
| `@acp_hub_activity_icon_ran` | `●` | Icon for command/execution groups (`Ran`). |
| `@acp_hub_activity_icon_explored` | `●` | Icon for read/search groups (`Explored`). |
| `@acp_hub_activity_icon_edited` | `●` | Icon for edit/write groups (`Edited`). |
| `@acp_hub_activity_icon_tools` | `●` | Fallback icon for other tool groups. |
| `@acp_hub_turn_details` | `auto` | Turn policy: `auto` (`Activity` expanded, completed summary collapsed), `expanded`, or `hidden`; explicit toggles still work. |
| `@acp_hub_turn_details_key` | `F3` | Toggle the latest turn drawer (`C-a`–`C-z`, `F1`–`F12`, or `off`). |
| `@acp_hub_plan_pin` | `auto` | Smart-header Plan visibility: active plans only (`auto`), always (`on`), or never (`off`). |
| `@acp_hub_plan_completed` | `collapse` | Completed plan behavior: `hide`, `collapse`, or `keep`. |
| `@acp_hub_plan_awaiting` | `auto` | Empty pre-snapshot state: explicit `plan`/`planning` mode (`auto`), every active turn (`on`), or disabled (`off`). An unfinished prior plan uses `Awaiting update` independently. |
| `@acp_hub_plan_key` | `C-p` | Expanded-plan shortcut (`C-a`–`C-z`, `F1`–`F12`, or `off`). |
| `@acp_hub_title_policy` | `agent-first` | Automatic title policy: `agent-first`, `first-prompt`, `latest-prompt`, or `manual-only`. |
| `@acp_hub_tab_title_max_width` | `32` | Maximum tab-label width in terminal columns (12–80). |
| `@acp_hub_switcher_title_max_width` | `30` | Title column width in `prefix + s` (12–80). |
| `@acp_hub_update_channel` | `stable` | Registry channel: npm `latest` (`stable`) or opt-in `next`/`beta` (`edge`). |
| `@acp_hub_update_check_interval` | `24h` | Cached background registry-check interval (`m`, `h`, or `d`; minimum 5m). |
| `@acp_hub_update_notify` | `on` | Show a non-blocking popup notice when an adapter update is available. |
| `@acp_hub_update_keep_versions` | `2` | Recent verified installs retained per adapter (1–5; active/pending/rollback are always protected). |

Title policies:

- `agent-first` — recommended: first prompt fallback, then ACP titles; manual wins.
- `first-prompt` — keep the first meaningful prompt as the automatic title.
- `latest-prompt` — compatibility mode matching the older per-prompt behavior.
- `manual-only` — keep `New chat` until the user renames it.

The daemon reads title policy and tab width at startup. After changing them,
source the tmux configuration and run `/restart`. The
canonical metadata is published as `@acp_hub_title`; the bounded status label
is `@acp_hub_tab_title`, and `@acp_hub_title_source` reports its provenance.

#### Status-bar integration

The daemon publishes theme-agnostic global counters whenever an active chat
changes state. It resets them to zero on shutdown:

| Published option | Meaning |
|------------------|---------|
| `@acp_hub_active_count` | All live chats, including idle and attention states. |
| `@acp_hub_busy_count` | Starting, thinking, responding, working, planning, or cancelling. |
| `@acp_hub_idle_count` | Live chats ready for another prompt. |
| `@acp_hub_waiting_count` | Chats waiting for permission or authentication. |
| `@acp_hub_error_count` | Chats currently in an error state. |
| `@acp_hub_update_count` | Managed adapters with an available/deprecated release. |
| `@acp_hub_updates` | Compact `provider:version` update list. |

Themes do not need an ACP-specific dependency: compose these options in the
user's tmux configuration. For example:

```tmux
set -g @acp_hub_status_enabled 'on'
set -g @acp_hub_status_format ' #{@acp_hub_active_count}#{?#{>:#{@acp_hub_busy_count},0}, ◐#{@acp_hub_busy_count},}#{?#{>:#{@acp_hub_waiting_count},0}, ⏸#{@acp_hub_waiting_count},}#{?#{>:#{@acp_hub_error_count},0}, ✗#{@acp_hub_error_count},}'
```

Use `#{E:@acp_hub_status_format}` in `status-left` or `status-right` to expand
the nested counters. The enable flag and the presentation format belong to the
user configuration; ACP only owns the raw counts.

### Environment variables

| Variable | Effect |
|----------|--------|
| `ACP_HUB_HOME=<path>` | Override the state/cache directory (default: `~/.cache/tmux-acp-hub`). |
| `ACP_HUB_CONFIG=<path>` | Override the user agent configuration file. |
| `ACP_HUB_SOCKET=<path>` | Override the daemon Unix socket path. |
| `ACP_HUB_RESTART_TOKEN=<token>` | Internal `/restart` transaction handoff; set by the popup child process, not by users. |
| `ACP_HUB_INTERACTIVE_UI=0` | Use the old text menus instead of the pickers. |
| `ACP_HUB_THEME=vanzi\|agent` | Override `@acp_hub_theme` for one UI process (primarily useful for tests and integrations). |
| `ACP_HUB_MENU_ORDER=recent\|oldest\|projects` | Headless override for the initial chat-menu order. |
| `ACP_HUB_MENU_SCOPE=project\|all` | Headless override for the initial chat-menu scope. |
| `ACP_HUB_MENU_LIST_PERCENT=<n>` | Headless override for the chat-list share (45–75%). |
| `ACP_HUB_STATUS_ANIMATION=wave\|breathe\|spinner\|off` | Headless override for active composer motion. |
| `ACP_HUB_STATUS_ANIMATION_INTERVAL=<n>` | Headless animation interval override (80–600 ms). |
| `ACP_HUB_STATUS_ANIMATION_PAUSE=<n>` | Headless quiet-pause override between wave passes (0–3000 ms). |
| `ACP_HUB_COMPOSER_ENHANCED=0` | Keep the prompt card but disable its embedded pickers. |
| `ACP_HUB_COMPOSER_BOX=0` | Compatibility alias for `ACP_HUB_COMPOSER_ENHANCED=0`. |
| `ACP_HUB_PINNED_INPUT=0` | Inline raw prompt instead of the pinned composer. |
| `ACP_HUB_RAW_INPUT=0` | Fall back to Node readline. |
| `ACP_HUB_BRACKETED_PASTE=0` | Disable bracketed paste. |
| `ACP_HUB_VIM=1` | Enable Vim composer mode initially. |
| `ACP_HUB_ACTIVITY=compact\|hidden\|debug` | Set the initial Activity rendering mode. |
| `ACP_HUB_DEBUG_UI=1` | Show internal hub events (same as `/debug`). |
| `ACP_HUB_MOUSE=on\|off` | Master switch for transcript mouse tracking. |
| `ACP_HUB_MOUSE_SCROLL_ROWS=<n>` | Headless override for wheel scrolling (1–20 rows). |
| `ACP_HUB_MOUSE_SELECT_KEY=F4\|C-b\|off` | Headless override for temporary mouse-selection mode. |
| `ACP_HUB_SCROLL_PAGE_PERCENT=<n>` | Headless override for `PgUp`/`PgDn` (10–100%). |
| `ACP_HUB_MOUSE_CLICK=on\|off` | Headless override for interactive turn clicks. |
| `ACP_HUB_MOUSE_HOVER=on\|off` | Headless override for motion tracking and hover. |
| `ACP_HUB_TRANSCRIPT_PADDING=<n>` | Headless override for transcript/plan side padding (0–4). |
| `ACP_HUB_PROMPT_PADDING=<n>` | Headless override for submitted-prompt side padding (0–4). |
| `ACP_HUB_HISTORY_LIMIT=<n>` | Headless override for retained chat events (200–20000). |
| `ACP_HUB_PERMISSION_POLICY=prompt\|deny` | Headless override for the ACP escalation policy. |
| `ACP_HUB_ACTIVITY_ICON_RAN=<glyph>` | Headless override for the `Ran` icon. |
| `ACP_HUB_ACTIVITY_ICON_EXPLORED=<glyph>` | Headless override for the `Explored` icon. |
| `ACP_HUB_ACTIVITY_ICON_EDITED=<glyph>` | Headless override for the `Edited` icon. |
| `ACP_HUB_ACTIVITY_ICON_TOOLS=<glyph>` | Headless override for the fallback tool icon. |
| `ACP_HUB_TURN_DETAILS=auto\|expanded\|hidden` | Headless override for the turn presentation policy. |
| `ACP_HUB_TURN_DETAILS_KEY=F3\|C-b\|off` | Headless override for the turn-details shortcut. |
| `ACP_HUB_PLAN_PIN=auto\|on\|off` | Headless override for smart-header Plan visibility. |
| `ACP_HUB_PLAN_COMPLETED=hide\|collapse\|keep` | Headless override for completed-plan behavior. |
| `ACP_HUB_PLAN_AWAITING=auto\|on\|off` | Headless override for the pre-snapshot plan state. |
| `ACP_HUB_PLAN_KEY=C-p\|F2\|off` | Headless override for the expanded-plan shortcut. |
| `ACP_HUB_TITLE_POLICY=<policy>` | Headless override for `@acp_hub_title_policy`. |
| `ACP_HUB_TAB_TITLE_MAX_WIDTH=<n>` | Headless override for the tab width. |
| `ACP_HUB_UPDATE_CHANNEL=stable\|edge` | Headless override for the adapter registry channel. |
| `ACP_HUB_UPDATE_CHECK_INTERVAL=24h` | Headless override for the cached registry-check interval. |
| `ACP_HUB_UPDATE_NOTIFY=on\|off` | Headless override for update notices. |
| `ACP_HUB_UPDATE_KEEP_VERSIONS=<n>` | Headless override for retained verified installs (1–5). |

## Privacy and state

Chat transcripts (a soft budget of 2000 events per chat by default) and the
latest canonical plan are persisted in plain text in
`~/.cache/tmux-acp-hub/registry.json` so chats and plan progress survive
restarts. Retention removes whole oldest turns; an oversized newest turn keeps
its user prompt, latest plan, final response, and closing event. A visible
history-boundary notice marks both intentional retention and legacy records
that were already cut in the middle of a turn. `@acp_hub_history_limit` is one
shared budget for live memory, persistence, reopening, and the popup buffer;
events discarded by an older version cannot be reconstructed from the
registry. Registry and live-state JSON are replaced atomically, so concurrent
readers never observe an in-progress truncated write. Prompt drafts
and input history live in `drafts.json` and `input-history.json` in the same
directory; corrupt JSON is backed up as `.bad-*` and recreated.

Verified adapters live under `adapters/packages`; `adapters/manifest.json`
selects the active, pending, and rollback versions atomically. Adapter cleanup
never deletes the protected active/pending/previous versions.

Delete a chat (`Ctrl+D` in any picker, or `/delete`) to remove its transcript,
or wipe everything: `rm -rf ~/.cache/tmux-acp-hub`.

## tmux-resurrect / continuum

Your chats live in the daemon's registry (above), not in tmux, so they survive
restarts on their own — [resurrect](https://github.com/tmux-plugins/tmux-resurrect)
has nothing to add. But resurrect saves *every* session, and the hidden
`acp-*` workspace sessions are only **views** onto daemon-owned chats. On
restore they'd come back as hollow shells that duplicate what the daemon
re-creates. If you use resurrect/continuum auto-save, exclude them with the
bundled hook:

```tmux
set -g @resurrect-hook-post-save-all 'sh ~/.config/tmux/plugins/tmux-acp-hub/scripts/resurrect-exclude.sh'
```

It strips `acp-*` / `vz-*` (and a sibling cli-hub's `cli-*` / `agents-*`) from
each save. Your chats are untouched — they were never in resurrect.
Replace that path with `tmux show-option -gqv @acp_hub_dir` when TPM or
`XDG_CONFIG_HOME` places the plugin elsewhere.

## Troubleshooting

**Restart (keeps every chat).** If the popup misbehaves, the daemon hangs, or
state looks stale — type `/restart` in any chat, or from a terminal:

```sh
plugin_dir="$(tmux show-option -gqv @acp_hub_dir)"
node "$plugin_dir/bin/acp-hub.mjs" restart
```

It stops the daemon (gracefully if it answers, `SIGTERM`/`SIGKILL` via the pid
file if it's hung), closes the hidden workspace tmux sessions — with the
daemon down they're just dead views — and cleans up the socket. Nothing under
`~/.cache/tmux-acp-hub` is deleted: reopen with `prefix + m` and a fresh
daemon restores every chat from the registry. Restart is transactional:
`prefix + m` waits for its short cleanup lock before creating a replacement
workspace, so opening immediately cannot produce a popup that flashes and is
then killed by the still-running restart.

If an adapter answers `session/load` or `session/resume` with a transient error,
the popup stays on the same saved chat and shows three explicit choices above
the composer: **Retry restore**, **Start fresh** (keeps the local transcript),
or **Chats**. It never creates or adopts a replacement conversation silently.
The private `daemon.log` records only lifecycle ids/status/errors for this flow,
not prompt text or environment values.

**Reset (deletes every chat).** To start from zero:

```sh
plugin_dir="$(tmux show-option -gqv @acp_hub_dir)"
node "$plugin_dir/bin/acp-hub.mjs" reset
```

Same as `restart`, plus it wipes all persisted chats, drafts, input history,
pastes, and the log. Asks for confirmation (pass `--yes` to skip, e.g. in
scripts); your `agents.json` config is never touched.

`stop` still exists for just stopping the daemon. Whenever the daemon goes
away — `stop`, `restart`, a crash, or a `kill -9` — open popups notice the
lost connection, print why, and close themselves; they no longer linger as
unresponsive windows.

`/debug` temporarily prints hub internals and long fallback details into the
chat pane. Sanity checklist:

- `prefix + m` opens/minimizes the project popup.
- `prefix + y` opens the Command Center (config actions use tmux UI, not chat text).
- `prefix + s` shows tmux sessions outside ACP, the chat selector inside.
- `prefix + 9`/`0` create, `prefix + (`/`)` focus Codex/Claude chats.

## Tests

```sh
npm test
```

Runs all suites. `smoke.mjs` drives the daemon protocol against a fake ACP
agent; `render-stream.mjs` feeds a Markdown table through the renderer in small
chunks; `render-width.mjs` covers the display-width / ANSI wrapping primitives;
`global-layout.mjs` covers semantic prose/code/table reflow and editable word
boundaries; `scroll.mjs` covers proportional paging, SGR mouse parsing, and
input isolation plus click/hover/drag hit testing; `turn-cards.mjs` covers ACP
message grouping and legacy turn migration, while `turn-card-render.mjs`
covers live expansion, completion collapse, header-only interaction, and final-answer rendering;
`message-roles.mjs` covers provider phase normalization, safe metadata persistence,
role-aware chunk merging, and compacted-session restoration;
`frame-render.mjs` covers transcript insets, full-bleed rows, differential paints,
tail scrolling, single-frame structural transitions, explicit pending-composer
geometry, picker restoration, composer-title isolation, event coalescing, and
completed-card caching;
`history-retention.mjs` covers configurable live/persisted retention, UI trimming,
and completed-card cache pruning;
`titles.mjs` covers title precedence, migration, ACP/manual
ownership, and grapheme-aware clipping; `render-live-table.mjs` guards the
progressive table pipeline;
`picker.mjs`, `composer-layout.mjs`, `autocomplete.mjs`, and `highlight.mjs`
cover the UI logic.

For the same checks used before a release—including JavaScript/shell syntax,
the public CLI contract, README links, key overrides, and a plugin load from a
path containing spaces—run:

```sh
npm run check
```

## Maintainer workflow

Adapter releases are discovered separately from user updates. A read-only
scheduled job installs candidates, verifies their exact package identity,
performs an ACP v1 handshake, and checks the capabilities required by the Hub.
Only a second job can open a pin-update PR, and that PR is never merged or
installed for users automatically. See [MAINTENANCE.md](MAINTENANCE.md) for the
support window, security boundary, commands, and manual release checklist.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and upgrade-impacting
changes.

## License

MIT — see [LICENSE](LICENSE).

tmux-acp-hub is an independent project. It is not affiliated with, endorsed
by, or sponsored by the [Agent Client Protocol](https://agentclientprotocol.com)
project, Zed Industries, OpenAI, or Anthropic. "ACP" in the name describes
compatibility: the plugin talks to any agent that implements the protocol.
The ACP specification, SDK, and the default adapters are licensed Apache-2.0
by their respective authors.
