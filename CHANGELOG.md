# Changelog

All notable changes to tmux-acp-hub are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.2.0] - Unreleased

### Added

- Persistent full-turn replay, draft/input history, canonical plans, chat
  titles, queue state, and turn-aware history retention across daemon restarts.
- Structured turn cards with live Activity, collapsed completed work, exact
  Codex final-answer separation, and a safe fallback for adapters without
  message-role metadata.
- Fixed and expandable plan panel with lifecycle-aware carry-over, progress,
  error/cancellation presentation, mouse interaction, and a configurable key.
- Word-aware global wrapping, display-width handling, syntax-highlighted code
  and diffs, internal scrolling, mouse wheel/click/hover support, and atomic
  attachment tokens.
- Normalized fenced-code aliases and tmux-aware commands, options and formats;
  declared languages use a subdued semantic label and unlabeled fences remain
  headerless.
- ACP modes, config options, provider commands, authentication, MCP reporting,
  command autocomplete, and a native Command Center.
- Queue presentation, Vim composer mode, guarded cancellation, configurable
  Activity icons, title policies, and theme-agnostic tmux status counters.
- Public `acp-hub --help` and `--version` commands, release checks, and CI.
- Transactional adapter version management through `/hub` and the CLI, with a
  private version store, ACP v1 handshake verification, pending activation,
  offline registry cache, update notices, rollback, a nested adapter-manager
  picker, contextual subcommand completion, actionable fallback guidance, and
  current-versus-new comparison tables.
- Daemon-owned adapter operations with visible confirmation, recoverable phase
  progress in the composer's shared shelf, explicit staged/failure actions, and
  popup-independent download and verification.
- A canonical adapter compatibility manifest, real-package ACP/capability CI
  matrix, weekly read-only release detection, and a separately permissioned
  maintainer PR workflow that never auto-merges or rewrites user installations.
- A scoped MCP manager with an inline `/mcp` picker, managed atomic registry,
  static/managed precedence, environment-backed secrets, executable and
  capability preflight, interactive footer access, pending activation, safe
  session reconnect/rollback, and new-chat fallback for adapters that cannot
  restore sessions.

### Changed

- Composer metadata is now one continuous semantic flow: human-readable model,
  effort, and access values form one-cell-separated interactive Vanzi
  mini-cards, followed immediately by responsive context and draft/session
  diagnostics. The first visible card keeps the pink accent, while every other
  card retains its own dark surface and hover remains local.
- Editable and submitted prompt-card rails retain their semantic accent but no
  longer inherit the card background; shading starts after the `┃` cell.
  Clicking a supported card opens its contextual interaction without changing
  the draft; raw ACP ids remain untouched and pending permissions still preempt
  configuration controls.
- Model and effort metadata cards now expand their ACP-advertised choices
  horizontally in place. Model choices use the resolved theme accent over a
  neutral group surface, effort uses a stronger/darker neutral pair, and each value
  is directly clickable. Expanded
  values now touch without internal gaps; hover previews the candidate in
  bright pink with no underline and temporarily yields the current value's
  accent, so exactly one expanded chip is bright at a time. Category boundaries
  remain separate. The
  single-row layout hides volatile diagnostics first, adds `‹`/`›` paging when
  needed, waits for `session/set_config_option` acknowledgement before closing,
  and stays open on failure; `/model` and `/effort` remain keyboard fallbacks.
- The composer's active status now defaults to a subtle 256-colour travelling
  shimmer over `thinking`/`working`/`responding` while retaining the rotating
  Braille loader. The faster 120 ms traversal rests for 900 ms between passes;
  `wave`, whole-word `breathe`, loader-only `spinner`, `off`, interval, and
  pause are configurable from tmux. A single scoped timer repaints only the
  smart header and stops for permissions, settled states and overlays.
- Activity's vertical rail and `├─`/`└─` intersections now use the quieter
  `colour240` structural tier, leaving state icons and action labels dominant.
- Success, permission, Activity, and Plan completion share the syntax palette's
  soft green (`colour114`); diff additions and current selections use only one
  restrained stronger variant (`colour78`) for solid icons, diff additions,
  and current selections. Errors and critical context use a
  softer Vanzi-derived pink (`colour168`) instead of terminal-defined ANSI red.
- Compact fenced-code cards preserve one Markdown separator above their shaded
  padding while avoiding the former redundant external blank below.
- Transcript projection is now a side-effect-free transaction: temporary code
  and table captures cannot reach the terminal, stale live-paint timers are
  bound to their originating block, and finalization emits only the canonical
  synchronized frame when visual content actually changed.
- Active Markdown snapshots retain ambiguous leading-pipe fragments until a
  separator confirms a table, preventing a provisional `|` from flashing as
  prose while preserving word-by-word prose, fenced code, and completed table
  rows.
- Temporary mouse-selection mode (`F4` by default) suspends application mouse
  tracking for native tmux/terminal selection and restores it with `Esc`/`F4`.
- Bare mouse drags in ACP chat windows now enter tmux copy-mode and defer
  automatic copying to the user's existing release binding; custom root drag
  bindings are preserved unless native selection is explicitly forced.
- Submitted prompts now use a full-bleed theme-colored `┃` rail at the
  popup's left edge plus one extra inner gap before their text.
- Added `@acp_hub_theme` with `vanzi` (one family-wide pink) and `agent`
  (Codex blue / Claude orange) variants. A central resolver now drives composer,
  submitted/restored prompt rails, footer controls, chat tabs, provider glyphs,
  and tmux window tabs; semantic permission/error/success colors keep priority.
- Prompt padding is now independent from the general transcript/Plan inset, so
  prose and structured output can use three cells while prompts remain at two.
- The live composer now uses an editable full-width prompt card with the same
  shaded surface and `┃` rail language as submitted prompts, a responsive
  smart header whose complete provider identity becomes the active agent state and whose
  adjacent inline Plan progress no longer jumps to the right edge, a phase-only
  Ctrl+P drawer that grows upward without moving the card, integrated
  attachments, internal final-row metadata, and no horizontal box rules. The
  transcript and smart header now have an explicit blank separator, while the
  external shortcut hint retains one blank row above and below. Its variant and
  spacing remain independent from static history cards.
- Command, subcommand, and `@file` autocomplete plus model/mode/effort/hub and
  permission quickselects now share the upper panel with the Plan drawer. Lists
  grow toward the transcript without moving the input card, metadata, or hint;
  their exclusive priority is quickselect, autocomplete, expanded Plan, then
  queue. Selection
  navigation repaints only that panel, and a covered Plan restores its complete
  phase list unchanged. Menus now
  reserve one blank row below the smart header and share its three-cell inset.
- Permission requests now live exclusively in that shared upper panel instead
  of being duplicated inside Activity. They preempt transient menus atomically,
  preserve the active draft and cursor, restore Plan/queue after dismissal or
  resolution, and reconcile decisions made by another connected popup. Raw
  requests remain persisted and are visible only in debug projection; the
  compact decision stays in the transcript as an audit record.
- Queued prompts moved from above the smart header into that exclusive shelf.
  Multiple requests render as contiguous ordered rows; menus and the expanded
  Plan temporarily replace the list and restore it unchanged when they close.
- The Ctrl+O chat menu now owns the complete popup instead of leaving the
  composer visible below it. It suspends the same draft/cursor session, uses
  the full height, restores current Plan and queue state in one frame, and
  switches windows before repainting the previous pane.
- `/restart` and `prefix+m` now share a short-lived transaction lock, preventing
  a newly-opened workspace from being removed by restart cleanup still running
  in the background.
- ACP restore failures remain attached to the original chat and expose explicit
  Retry restore / Start fresh / Chats actions. Starting fresh preserves the
  local transcript; the UI no longer adopts another chat as a silent fallback.
- The chat menu now defaults to a provider-neutral Recent timeline. `Tab`
  cycles Recent/Oldest/Projects, `s` toggles project/all scope, and `Ctrl+O`
  closes directly; oldest pages are selected daemon-side before limiting.
  Its order modes use one-cell-separated Vanzi-style accent tabs, its chat/preview split is wider
  and configurable without starving preview, and titles consume that width
  responsively. Ctrl+O now also enters from preserved transcript scrollback,
  while revision-gated refreshes prevent stale async mode/scope results.
- Chat-menu rows now match model/effort picker contrast: inactive titles and
  section labels are subdued, the selected title is bold, and provider/status
  accents remain semantic instead of making every row visually primary.
- Unselected chat and New-chat titles use Vanzi's readable `#b9b9b9` tier;
  `colour245` is reserved for metadata and auxiliary section copy.
- Composer metadata now degrades through semantic width candidates: canonical
  access and pending/temporary permission state survive before path, roots,
  MCP, token estimates and other diagnostics. The expanded Plan drops its old
  `[PLAN]` focus badge and teaches `Ctrl+P/Esc` in the aligned external guide.
- The expanded Plan is now non-modal: it grows to show the complete wrapped
  phase list, keeps the composer editable, removes the former selected-phase
  viewport and navigation footer, returns `PgUp`/`PgDn` to transcript scrolling,
  and closes exclusively with `Ctrl+P` or `Esc`.
- Direct answers without Activity omit the inert `Worked for…` summary, while
  actionable, exceptional, command, and missing-detail diagnostic headers stay
  visible.
- MCP entries now expose applied, pending, invalid, unsupported, overridden,
  and out-of-scope states instead of only listing the descriptors passed at
  session creation. The Command Center always exposes MCP administration,
  including when no server is configured.
- The default transcript presentation now expands work while a turn is active
  and collapses it after completion, keeping the final answer stable outside
  the Activity drawer when provider metadata permits.
- Transcript content now uses a two-cell inset; submitted prompts receive a
  full-width shaded band with vertical breathing room, while fenced code uses
  one compact, resize-aware semantic rectangle with two-cell internal padding.
- `PgUp`/`PgDn` move 40% of the viewport and the mouse wheel moves four rows by
  default.
- Primary tmux bindings are configurable with `@acp_hub_key_*`; each can be set
  to `off` without the plugin taking ownership of that key.
- In-chat rename now routes through `Ctrl+G`, avoiding the `Ctrl+O` chat-menu
  binding and shell interpolation of titles.
- The bundled Codex and Claude ACP adapters are pinned to current compatible
  releases; Node 22 or newer is recommended for the Codex adapter.
- Partial per-agent overrides now inherit the plugin command and pin, while an
  explicit user `command`/`args` override remains authoritative and is reported
  by `health` when it diverges.
- Bundled defaults now use verified Codex ACP `1.1.7` and Claude ACP `0.61.0`;
  the compatibility window retains `1.1.5` and `0.60.0` respectively.

### Security

- The repository manifest is explicitly private to prevent accidental npm
  publication; GitHub/TPM remains the only distribution channel for 0.2.0.
- Daemon socket/state writes are hardened and registry replacement is atomic.
- Managed MCP storage uses atomic `0600` writes inside a `0700` directory,
  preserves malformed registries as timestamped backups, and redacts all
  environment/header values from RPC and UI projections.
- MCP now keeps a strict private canonical descriptor/public projection
  boundary: credential arguments and sensitive URL query values are redacted
  from RPC, events, persisted chat summaries and UI while remaining intact for
  the adapter. Registry loads/backups reassert private modes, and validation
  rejects malformed names, header injection and control characters.
- Provider modes now use ACP `configOptions(category=mode)` as the canonical
  source, temporary permission grants remain distinct from the base mode, and
  every request decision is validated and persisted against its tool call.
- Added a configurable fail-closed permission policy that rejects ACP
  escalation requests without inventing cross-provider access aliases.
- `acp-hub health` warns if an `agents.json` containing credential-like values
  is readable by group or other users, without printing names or values.
- Health output redacts common credential flags, authorization headers, URL
  userinfo, and sensitive query parameters from adapter command arguments.

### Upgrade notes

- Reload `~/.tmux.conf` and run `acp-hub restart` after updating so the tmux
  bindings and daemon both use 0.2.0. Existing state is migrated in place.
- Users who need the original tmux behavior for a default key can set the
  corresponding `@acp_hub_key_*` option to `off` before TPM loads the plugin.

## [0.1.0] - 2025-07-30

### Added

- Initial persistent tmux ACP hub with Codex and Claude adapters, popup chat
  workspaces, saved sessions, provider switching, and basic health checks.

[0.2.0]: https://github.com/tarquibrian/tmux-acp-hub/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tarquibrian/tmux-acp-hub/releases/tag/v0.1.0
