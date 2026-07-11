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

![ACP Hub popup over Neovim: a Claude chat rendering a Markdown table, the
half-box composer, and the tab bar showing a Codex and a Claude chat.](assets/screenshot.png)

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
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
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)

## Requirements

| Need | Version / note |
|------|----------------|
| tmux | >= 3.4 |
| Node.js | >= 18 (no npm dependencies; the plugin is self-contained) |
| ACP adapters | fetched on demand via `npx` — Codex `codex-acp`, Claude Code `claude-agent-acp` |

Each provider authenticates through its own CLI/account the first time
(`/auth` inside a chat). Check your environment:

```sh
node ~/.config/tmux/plugins/tmux-acp-hub/bin/acp-hub.mjs health
```

## Installation

With [TPM](https://github.com/tmux-plugins/tpm), add to `~/.tmux.conf`:

```tmux
set -g @plugin 'tarquibrian/tmux-acp-hub'
```

Then `prefix + I` to install. Manual install:

```sh
git clone https://github.com/tarquibrian/tmux-acp-hub \
  ~/.config/tmux/plugins/tmux-acp-hub
```

```tmux
run '~/.config/tmux/plugins/tmux-acp-hub/acp-hub.tmux'
```

## Authentication

The hub speaks [ACP](https://agentclientprotocol.com) to adapter processes;
authentication belongs to the agent CLI behind each adapter, so **you do not
need a paid plan** — an API key works too:

| Provider | Plan login | API key |
|----------|-----------|---------|
| Codex (`codex-acp`) | `codex login` | `OPENAI_API_KEY` |
| Claude Code (`claude-agent-acp`) | `claude /login` | `ANTHROPIC_API_KEY` |

Adapters inherit the daemon's environment, so an exported key just works. To
scope a key to one agent, add an `env` block in
`~/.config/tmux-acp-hub/agents.json`:

```json
{
  "agents": {
    "codex": {
      "command": "npx",
      "args": ["-y", "@zed-industries/codex-acp@0.16.0"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

If an adapter starts unauthenticated, the chat drops into an auth state (yellow
composer border): `/auth` lists the login methods the adapter advertises and
`/auth <id|n>` runs one (browser OAuth flows open externally). Credentials are
stored by the agent CLIs themselves (`~/.codex`, `~/.claude`), never by the hub.

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

Inside a `acp-*` workspace, `prefix + s` opens a tree-style selector of every ACP
chat across projects, with aligned columns (icon, title, status, last activity,
mode, model) and a live preview:

![The prefix+s tree selector listing chats across projects with status, time,
mode and model columns.](assets/switcher.png)

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
| `Tab` | toggle project / all-projects scope |
| `Ctrl+S` | send a one-line reply to a live chat without leaving the list (idle → starts a turn, busy → queues; preview refreshes) |
| `Ctrl+E` | rename the highlighted chat inline |
| `Ctrl+D` (twice) | delete permanently; closes its tab if open |
| `Ctrl+R` | re-import provider sessions |
| `Esc` | leave filter mode, then clear the filter, then close the overlay |

![The menu overlay: a filterable chat list on the left with per-chat status,
age, mode and model, and a live transcript preview of the highlighted chat on
the right.](assets/menu.png)

Picking a chat focuses its window (or creates one); from a cold-start menu it
loads the chat into that pane. When the popup is ≥ 96 columns wide, a preview
pane on the right shows the highlighted chat's transcript tail — live and saved
alike. Chats needing attention (permission/auth/error) sort to the top. Set
`ACP_HUB_INTERACTIVE_UI=0` for the old text menu.

Inside a chat you can also reach the menu overlay with `←` on an empty composer
or `Ctrl+O` (any input; your draft is kept and restored on `Esc`).

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
| `/modes`, `/mode <value>` | Show / set the ACP session mode. |
| `/access <profile>` | Friendly access alias: `read-only`, `agent`, `full`, `plan`, `auto`. |
| `/config [id value]` | Show adapter config options, or set one. |
| `/commands` | Show provider commands reported through ACP. |
| `/plan` | Show the current execution plan with per-step status. |
| `/roots`, `/roots add\|remove\|clear <path>` | Show / edit extra workspace directories (applied on reopen). |
| `/changes` (`/diff`) | Picker of the files edited in this chat (path + `+/-` counts); Enter expands the chosen file's git-style diff into the transcript. |

`/model`, `/effort`, `/modes`, and `/access` open a compact numbered picker
above the composer with the current value marked `●` — `1-9` picks directly,
`↑↓`/`j`/`k` move, `Enter`/`l` applies, `Esc`/`h` cancels (tmux menus / text as
fallback; `ACP_HUB_INTERACTIVE_UI=0` forces them).

### Prompt input

| Command | Action |
|---------|--------|
| `/compose` | Multiline prompt; finish with a single `.` line. |
| `/edit` | Write a prompt in `$VISUAL` / `$EDITOR`. |
| `@file` | Mention and attach a project file inline (opens autocomplete). |
| `/attach <path>…` | Attach files to the next prompt (image / resource / link by capability). |
| `/attachments`, `/files` | Show pending attachments. |
| `/detach <n>\|last\|all` | Remove pending attachments. |
| `//command` | Send a slash command straight to the provider. |
| `/agent <text>` | Send raw text straight to the provider. |

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
| `/mcp` | List the MCP servers passed to this chat's session. |
| `/q <text>` or `?<text>` | Filter chats by title/project/path/provider/session. |
| `/p <provider>`, `/s <scope>`, `/clear` | Filter provider (`codex`/`claude`/`all`), scope (`project`/`all`), or reset. |
| `/cancel` | Cancel the current turn and pending permission requests. |
| `/rename <title>`, `/title <title>` | Name the current chat for menus/search. |
| `/close` | Stop the ACP adapter, keep saved session metadata. |
| `/delete` | Permanently delete the current chat (confirms; removes the provider session when `sessionCapabilities.delete` is advertised). |
| `/activity <mode>` | Tool activity rendering: `compact`, `hidden`, or `debug`. |
| `/debug` | Toggle internal hub events in the chat pane. |
| `/exit` | Close the popup client only (the agent keeps running). |

## How it works

The popup is only a client. A background daemon keeps ACP agent processes alive
through `~/.cache/tmux-acp-hub/hub.sock`, so closing the popup does not kill
the chat. The daemon also owns tmux window metadata (`@acp_hub_status` and
friends) and re-syncs the matching window on every chat change, so status
glyphs in the status bar and the `prefix + s` switcher stay fresh even when no
popup is attached.

A permission request raised while the popup is closed stays pending (status
`permission`, visible in tmux badges) and re-surfaces when you reopen the popup;
unanswered requests cancel after a five-minute timeout. When an adapter reports
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
- The transcript (last 200 events) is persisted with the session metadata, so
  it survives daemon restarts — restored chats replay even when the adapter
  can't reload history.
- A chat window is named after its chat title (a clean provider label like
  `Codex` until the title is known). **Identity is the `@acp_hub_chat_id`
  window option, not the name** — `prefix + ,` renames the chat (title + window
  name together), never the internal id.
- Splitting panes inside a chat window is plain tmux; extra panes are not chats.

Workspaces are named `acp-<project>` (with a `-2`/`-3` suffix when two projects
share a basename; the owning project is tracked in `@acp_hub_project_path`,
and legacy `acp-project-hash` sessions are reused while they live). They are
hidden from the normal `prefix + s` chooser. Set `@acp_hub_workspace_scope` to
`global` to restore the single `acp-hub` workspace mode.

In the status bar each window renders as a minimal label from chat metadata —
the provider icon in its accent color (`❋` Claude, `⬡` Codex, `◆` others;
override per agent with `icon` in `agents.json`), the chat title, and a status
glyph only while the chat needs attention (e.g. `❋ Refactor auth ⠹`). Chat
titles default to `New chat`, `New chat 2`, … (restored → `Saved chat`); project
and provider are their own columns, so titles stay short.

### The composer

The chat input uses a pinned raw terminal composer when TTY support is
available.

**Layout.** The transcript scrolls above a half-box composer: a single top rule
embeds the status (with an animated spinner while working), the provider name,
and any badges — tinted with the provider accent, yellow for permission/auth,
red for errors. Below it, a flat input, then a metadata footer such as
`gpt-5.5 xhigh · 45k/200k (23%) $0.12 · auto · ~/.config` (context-window and
cost segments appear on ACP `usage_update`). When the mode changes behavior, the
divider shows compact badges (`[PLAN]`, `[READ-ONLY]`, `[FULL-ACCESS]`,
`[ACCEPT-EDITS]`); extra roots show `+N roots`, MCP servers `+N mcp`. On popups
shorter than 15 rows — or with `ACP_HUB_COMPOSER_BOX=0` — it falls back to the
flat divider layout.

**Editing.** Left/right, Home/End (`Ctrl+A`/`Ctrl+E`), `Ctrl+U`, `Ctrl+K`,
`Ctrl+W`, `Ctrl+Y`, `Alt+B`, `Alt+F`, Up/Down history, and `Ctrl+R` reverse
search. Multiline with `Ctrl+J`, `Alt+J`, or `Alt+Enter`; plain `Enter` sends.
The composer grows to six rows (`↑ N more` / `↓ N more` counters beyond that).
`Esc` cancels an active turn (the draft is kept) — and if the composer is
empty, the just-sent prompt is restored into it, so "wait, one more thing" is
cancel → tweak → Enter. Otherwise double `Esc` clears the input into the kill
ring (`Ctrl+Y`). `Ctrl+C` cancels an active turn and clears the input, else
clears the input, else exits. `Ctrl+L` repaints the
whole screen. `Alt+E` opens the draft in `$VISUAL`/`$EDITOR` (blocking, in
this pane) and reloads the buffer into the composer on exit — the natural way
to write long prompts.

**Draft cost.** While you type, the footer shows an estimated token count for
the draft (`~1.5k tok`): composer text at ~4 chars/token, pending attachments
by size (images at a flat estimate), and `@file` mentions resolved via
`fs.stat` — file *sizes* are read, never contents. It's a local
order-of-magnitude signal, not an API count; it turns yellow past 32k.

**Vim mode.** `/vim` toggles modal editing (persisted; `ACP_HUB_VIM=1` also
enables it). `Esc` then switches insert → normal instead of cancelling — with
vim on, cancel a turn with `Ctrl+C`, or `Esc` while already in normal mode
(a first `Esc` there clears any pending count/operator). Normal mode supports
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
current mode and the footer access label follows it. `←` backs out to the menu
overlay in the same pane (the agent-view "detach" gesture); `Esc` returns to the
chat.

**Autocomplete.** Typing `/` or `@` opens a dropdown below the composer:
`Ctrl+N`/`Ctrl+P` (or arrows) travel, `Tab`/`Enter`/`→` accept (`Enter` still
submits an exact command), `Esc` dismisses. On the flat layout, `Tab` keeps the
classic unique-match completion.

**Paste and attachments.** Bracketed paste is on, so pasted code/logs insert as
one operation and internal newlines don't submit. Pasting file paths attaches
those files; very large text blocks are stored as temporary file attachments.
Each attachment drops an inline `[Image #N]` / `[File #N]` / `[Pasted #N +L
lines]` token at the cursor so the prompt records where it belongs, and the
pending set is listed in a grouped section under the input (`Images (2)` /
`Attachments (3)` + chips). Backspace over a token deletes it whole and
detaches the file; on an empty composer it removes the last attachment.
`Enter` on an empty composer with pending attachments sends them.

**Scrolling.** The internal scroll is the primary way to review the transcript
— it re-renders from the buffer (last 4000 lines), so wrapping and colors stay
correct at any position. `PgUp`/`PgDn` page without leaving the input, `Home`
jumps to the top while scrolled, `End`/`Esc`/submitting return to the live
tail. A `[SCROLL]` badge (with `+N new`) shows when output arrives while
scrolled, and the hint row lists the keys. `Ctrl+L` redraws from the buffer.
tmux copy-mode (`prefix+[`) and the mouse wheel still work but read tmux's own
scrollback, which can hold stale frames from earlier repaints — prefer the
internal scroll. Drafts and input history persist per chat; browsing history
with `↑`/`↓` stashes your in-progress draft and restores it when you come back
down.

Queueing: sending while a turn is active queues the prompt (`N queued` in the
footer) and dispatches in order; `/cancel` drops the queue. Env kill-switches:
`ACP_HUB_PINNED_INPUT=0` (inline raw prompt), `ACP_HUB_RAW_INPUT=0` (Node
readline), `ACP_HUB_BRACKETED_PASTE=0`.

### Markdown and tool rendering

Agent responses use a small terminal Markdown renderer: headings, inline code,
bold/italic, links, images, blockquotes, lists, checklists, fenced code blocks
(syntax-highlighted), horizontal rules, and streamed tables. Tables render
without pipes, with aligned width-aware columns; while the pinned composer is
active they render progressively (header on separator, each row as it completes,
re-painted when a wider row changes widths). Width math is display-aware (CJK,
emoji stay aligned). It is not a full CommonMark parser; unsupported Markdown
falls back to readable plain text.

Tool lifecycle events use `compact` rendering by default: completed read/search
tools group as `Explored`, edit/write as `Edited`, command-like as `Ran`. File
edits render as a git-style diff — a `path (+added -removed)` header followed by
green additions, red deletions, and dim context, split into hunks (`⋮` marks
skipped lines). `/activity hidden` gives a conversation-only transcript;
`/activity debug` or `/debug` renders the full ACP/tool event stream.
Reasoning/thought chunks are hidden in normal mode. ACP `plan` updates render a
`Plan (done/total)` block with per-step markers (`x` done, `>` in progress, `-`
pending) and skip identical repeats.

## Configuration

Override providers in `~/.config/tmux-acp-hub/agents.json`, using the same
shape as `agents.json` in this plugin.

### Adapters and model updates

The hub has **no hardcoded model list**: models, modes, and reasoning efforts
come from the adapter at session start, which reads them from the agent CLI
underneath. A new provider model arrives by updating those two layers — no
plugin change:

- Bump the adapter pin in `agents.json`
  (`@zed-industries/codex-acp@x.y.z`, `@agentclientprotocol/claude-agent-acp@x.y.z`),
  or use `@latest`.
- Keep the underlying CLIs (`codex`, `claude`) current as you already do.

Default adapters:

- `codex`: `npx -y @zed-industries/codex-acp@0.16.0`
- `claude`: `npx -y @agentclientprotocol/claude-agent-acp@0.57.0`

`acp-hub.mjs health` prints the pinned versions. After changing a pin, restart
the daemon (`acp-hub.mjs stop`).

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

Attach MCP servers with a top-level `mcpServers` array (all agents) and/or a
per-agent one. They are passed to `session/new`, `session/load`, and
`session/resume`. `stdio` servers work everywhere; `http`/`sse` are sent only
when the agent advertises the matching `mcpCapabilities` (skipped ones are
reported in the chat). `env`/`headers` accept an ACP `[{name,value}]` list or a
plain `{KEY: "value"}` object.

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
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  ]
}
```

Use `/mcp` or the Command Center `MCP servers` entry to see what was sent; the
footer shows a `+N mcp` segment.

### tmux options

Set with `set -g @option value` in `~/.tmux.conf`.

| Option | Default | Purpose |
|--------|---------|---------|
| `@acp_hub_session_prefix` | `acp` | Workspace session prefix. |
| `@acp_hub_popup_width` / `_height` | `90%` / `85%` | Popup size. |
| `@acp_hub_accent` | provider accent | UI accent (`#rrggbb` or a 256-color number). |
| `@acp_hub_default_agent` | `codex` | Provider for `prefix + m` cold starts. |
| `@acp_hub_workspace_scope` | per-project | Set `global` for one shared workspace. |
| `@acp_hub_node` | `node` | Node binary to launch the daemon/UI. |

### Environment variables

| Variable | Effect |
|----------|--------|
| `ACP_HUB_INTERACTIVE_UI=0` | Use the old text menus instead of the pickers. |
| `ACP_HUB_COMPOSER_BOX=0` | Force the flat composer (no half-box). |
| `ACP_HUB_PINNED_INPUT=0` | Inline raw prompt instead of the pinned composer. |
| `ACP_HUB_RAW_INPUT=0` | Fall back to Node readline. |
| `ACP_HUB_BRACKETED_PASTE=0` | Disable bracketed paste. |
| `ACP_HUB_DEBUG_UI=1` | Show internal hub events (same as `/debug`). |

## Privacy and state

Chat transcripts (last 200 events per chat) are persisted in plain text in
`~/.cache/tmux-acp-hub/registry.json` so chats survive restarts. Prompt drafts
and input history live in `drafts.json` and `input-history.json` in the same
directory; corrupt JSON is backed up as `.bad-*` and recreated.

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

## Troubleshooting

**Restart (keeps every chat).** If the popup misbehaves, the daemon hangs, or
state looks stale — type `/restart` in any chat, or from a terminal:

```sh
node ~/.config/tmux/plugins/tmux-acp-hub/bin/acp-hub.mjs restart
```

It stops the daemon (gracefully if it answers, `SIGTERM`/`SIGKILL` via the pid
file if it's hung), closes the hidden workspace tmux sessions — with the
daemon down they're just dead views — and cleans up the socket. Nothing under
`~/.cache/tmux-acp-hub` is deleted: reopen with `prefix + m` and a fresh
daemon restores every chat from the registry.

**Reset (deletes every chat).** To start from zero:

```sh
node ~/.config/tmux/plugins/tmux-acp-hub/bin/acp-hub.mjs reset
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
`render-live-table.mjs` guards the progressive table pipeline; `picker.mjs`,
`composer-layout.mjs`, `autocomplete.mjs`, and `highlight.mjs` cover the UI
logic.
