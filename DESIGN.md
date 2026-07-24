# tmux-acp-hub · Visual Design System

Current direction: **shared prompt surfaces** (editable card + static transcript
card) with one resolved theme accent overridden by semantic state colors.

## Principles

1. **Shared prompt language** — the live composer and submitted prompts share a
   full-width shaded surface and edge rail; each remains an independent variant
   so editing affordances never leak into history.
2. **One accent, semantic override** — `vanzi` uses the family pink everywhere;
   `agent` resolves the same token to Codex blue or Claude orange. Attention
   states always win: permission/auth = yellow, error = red, regardless of theme.
3. **One vocabulary** — every glyph, color, and spacing rule comes from the
   tokens below. No raw color codes or ad-hoc glyphs at call sites.
4. **Degrade gracefully** — small popups retain the card geometry but drop
   embedded pickers; non-TTY drops color, and
   `ACP_HUB_INTERACTIVE_UI=0` keeps the legacy flows.

## Audit — current inconsistencies this system replaces

- Colors scattered as raw codes across three languages: `colour170/43/39`
  (provider) duplicated in `lib.sh`, `switcher.sh`, and JS `providerColorName`;
  `colour236/244/245` shading inline in JS; named ANSI (`cyan`, `yellow`)
  elsewhere. No single palette.
- Glyph grammar mixed: plan uses ASCII `x`/`>`/`-` while status uses `●◐◌⏸⊘✗○`;
  activity tree uses `└` but plan doesn't; menu bullets `•` vs `-` vs `+`.
- Divider zoo: `─` (hr, activity), `━` (table header), plain `--`; widths
  computed three different ways.
- Composer is a flat shaded band: divider-as-title above, unpadded footer
  below, `^`/`v` overflow markers, placeholder "message".
- Slash-command and `@file` completion render as a plain dim hint line; Tab
  completes only unique matches — no visible selection model.
- Permission requests used to render inside Activity and then open a second
  chooser. They now exclusively own the composer's shared upper panel; only
  the compact decision audit remains in the normal transcript.
- Label grammar differs per surface: switcher `glyph status Provider title`,
  toggle menu `project · provider status · title`, chats picker mixes both.

## Tokens

### Palette (256-color, tmux-safe)

| Token            | Value            | Use |
|------------------|------------------|-----|
| `provider.claude`| `colour173`      | Claude accents (characteristic orange) |
| `provider.codex` | `colour39`       | Codex accents (characteristic blue) |
| `provider.other` | Vanzi accent     | unknown adapter fallback in `agent` |
| `accent.vanzi`   | `@acp_hub_accent` / `colour168` | family accent in `vanzi` and fallback in `agent` |
| `sem.ok`         | `colour114`      | soft shared green; idle, allowed, success, done markers |
| `sem.okStrong`   | `colour78`       | solid success glyphs, diff additions, and current selection |
| `sem.busy`       | ANSI cyan        | responding/thinking/working, spinner |
| `sem.warn`       | ANSI yellow      | permission, auth, queued, cancelling |
| `sem.err`        | `colour168`      | subdued Vanzi pink; error, denied, critical context |
| `motion.low`     | `colour179`      | readable resting gold for animated status text |
| `motion.mid`     | `colour221`      | wave/breathe transition |
| `motion.high`    | `colour228`      | wave/breathe highlight |
| `motion.peak`    | `colour230`      | travelling shimmer peak |
| `fg.muted`       | `colour244`      | meta text, hints, separators |
| `fg.faint`       | `colour240`      | Activity rails/intersections, quiet structure |
| `bg.surface`     | `colour235`      | editable and submitted prompt surfaces |
| `fg.placeholder` | `colour245`      | placeholder on `bg.surface` |
| `fg.menu`        | `#b9b9b9`        | readable unselected chat/menu titles |

Rule: every structural surface asks `lib/theme.mjs` for one accent. `vanzi`
ignores provider identity; `agent` resolves the provider attached to that
surface (including restored user turns). Permission/auth/error switch the live
card rail to their semantic color and never inherit the structural accent.

### Glyphs

| Group      | Set |
|------------|-----|
| status     | `●` idle · active loader `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (`wave`/`breathe`/`spinner`) · `◐` reduced-motion busy · `◌` starting · `⏸` permission · `⊘` auth · `✗` error · `⚠` warning · `○` stopped · `·` saved |
| provider   | `❋` Claude · `⬡` Codex · `◆` other — accent-colored, overridable per agent via `icon` in agents.json. Chat labels read icon → title → info everywhere; the tmux status bar shows the status glyph only when the chat needs attention |
| plan       | `✓` done · `▸` in progress · `·` pending · `⊘` skipped |
| markers    | `┃` prompt rail · `❯` selection/user-echo · `│` echo continuation · `●` current value (pickers) · `•` bullet · `└` `├` tree |
| rules      | `─` section divider · `━` table header rule |
| overflow   | `↑ N more` / `↓ N more` (replaces `^`/`v`) |

### Spacing

- 1 blank line between conversation turns (existing `pendingResponseBreak`).
- Transcript text: 1-space left gutter; tree items indent 2, summaries 6 dim.
- Composer header, upper panels, metadata content and external hints share the
  three-cell content column (`rail + two-cell gap`).
- Dividers span `min(width, 96)`.

## Component specs

### Composer (editable prompt card)

```
  Queue 2 · Next: review the wrapper… · +1 more
   ◐ responding  Plan 2/4 ● ● ◐ ○ 50% In progress

     ✓ inspect the renderer
     ▸ move the plan into the smart header
     · run the complete suite

┃
┃  how do I make the table wider▏
┃  second wrapped line…
┃
┃  [ GPT-5.6 SOL ][ XHigh ][ Full access ]        23% · +1 mcp · ~/.config

  / commands · @ files · Ctrl+J newline

```

The responsive smart header is one left-aligned sequence. It shows
`icon + Codex/Claude` while quiet, replaces both icon and label with the
animated live state during agent activity, and appends the canonical Plan
summary immediately afterward when one exists. `Ctrl+P` inserts the wrapped
phase body below that header. It requests the complete list without a selected
phase, controls footer, private viewport, or configurable row cap; only the
physical popup height may clip an exceptional Plan. This drawer is visibility,
not focus: the composer
continues to accept editing, Vim motions, commands, and submission, and only
`Ctrl+P` or `Esc` closes it. In Vim, that `Esc` continues into the ordinary
editor-mode transition. The upper panel grows toward the transcript, so
opening it never changes card or cursor rows. One composer-owned blank row separates
the transcript from the smart header; another separates the header or active
shelf from the continuous theme-accented `┃` rail and `colour235` surface.

Queued requests occupy the same exclusive shelf as menus and the expanded Plan,
directly below the smart header. They render as contiguous ordered rows, with a
single blank row above the list and the ordinary card gap below, and enter the
transcript only when the daemon starts their actual turn. Hidden queue state is
never discarded. The footer count remains as a compact secondary signal.

Adapter maintenance is another non-modal shelf owner. `/hub update` and
`/hub rollback` always confirm through a visible quickselect, then hand work to
one daemon-owned operation with an id and semantic phase. Autocomplete may
temporarily cover its progress; the operation itself survives popup closure and
is returned by the next chat subscription. Running phases never capture input.
Terminal success exposes restart/dismiss actions through empty `Enter`, while a
failure exposes retry/dismiss; neither result is reduced to a transient tmux
message. Shelf priority is quickselect > autocomplete > adapter operation >
expanded Plan > queue.

Active-state motion is a single header-scoped controller, never a transcript
animation. The Braille loader remains active in `wave`, `breathe`, and
`spinner`. `wave` (default) moves luminance across one status grapheme every
120 ms, then leaves a 900 ms quiet pause before restarting; `breathe` changes
the complete label intensity, `spinner` disables only the text luminance, and
`off` is the reduced-motion path with a static semantic glyph. All modes
preserve the same plain-text status and display width. The timer exists only for starting,
thinking, planning, working, responding, or cancelling; permission/auth/error,
idle states and full-screen overlays stop it. Every tick uses synchronized
output, clears only the smart-header row and restores the input cursor.

Pending permission requests outrank every other shelf owner. Their numbered
choices replace a transient menu, autocomplete, expanded Plan or queue without
finishing the composer; draft text and cursor never move. `Esc` dismisses the
list while retaining the pending authority, empty `Enter` reopens it, and a
decision restores the covered shelf in the same frame. Raw request events are
persisted for recovery/debugging but omitted from the normal transcript.

- Rail: resolved theme accent; permission/auth → `sem.warn`, error → `sem.err`.
- Smart header swaps the complete quiet provider identity for the animated
  `loader + state` while work is active, then appends badges and Plan in the same
  left-aligned flow. Plan progressively reduces from full progress/state to
  `Plan done/total` as width narrows.
- The `┃` rail uses the terminal/default background; every cell after it keeps
  `bg.surface`. Placeholder:
  `Write a message · / commands · @ files` in `fg.placeholder`.
- Input grows 1→6 rows; overflow rows show `↑2 more`/`↓1 more` in the shaded
  separator immediately before metadata.
- Metadata is the final shaded card row and receives no blank row beneath it.
  A semantic segment model keeps humanized model/effort/access controls in a
  left-to-right row of persistent theme-aware mini-cards with one surface-free
  cell between cards, then continues immediately into volatile diagnostics
  separated by middots. No synthetic space-between gap is introduced. The first visible card
  keeps the resolved accent; other cards retain a dark background, and hover
  decorates only its target without transferring the primary accent.
  Model and effort cards are mouse-expandable, non-modal groups in this same
  physical row. Values come exclusively from ACP `configOptions`; model choices
  use the resolved accent over neutral alternatives; effort choices use only
  the stronger/darker neutral pair and borrow the theme accent on hover,
  and each choice owns an independent hitbox. Choice surfaces are contiguous
  inside a group; the two-cell gap exists only between categories. Hover uses
  the active group's bright accent with dark text as a selection preview and
  never adds an underline.
  Exactly one expanded choice owns that accent: it transfers from the current
  value to the hovered/pending candidate, then returns when preview ends.
  Expanded groups suppress volatile
  diagnostics, preserve safety/access cards while width permits, and fall back
  to `‹`/`›` horizontal paging before they would alter card height. A different
  value remains pending in place until `session/set_config_option` succeeds;
  failure leaves the group open. The existing `/model` and `/effort` upper-panel
  pickers remain the keyboard path, and permission always closes/preempts a group.
  Each supported control owns an independent mouse region and opens its inline
  interaction without resolving the composer; transcript repaints cannot erase
  those regions. MCP uses the same route: its diagnostic opens a nested
  administrative picker in the shared upper panel, while managed changes remain
  pending until an explicit, safe apply. Raw ACP ids remain canonical underneath
  presentation labels.
  Width pressure removes low-priority path, roots, MCP and draft data one unit
  at a time while preserving access and pending authority. The external
  shortcut hint has one plain blank row above and below. The context meter keeps
  green/yellow/red by usage; queue uses `sem.warn`.
- Attachment labels and chips remain inside the card before its bottom padding.
- Below 15 rows the card and requested gaps remain, while the shortcut hint is
  omitted and completion uses the classic flow instead of embedded pickers.
- Scroll badge in the smart header: `[↑ 12 new · PgDn]`.

### MCP administration

- Static descriptors come from `agents.json`; managed descriptors live in a
  separate atomic `0600` registry inside a `0700` directory. Loads and corrupt
  backups reassert the same modes.
- Canonical descriptors are private adapter input. Every RPC, event, persisted
  chat summary and UI path receives one public projection that omits
  environment/header values and redacts credential flags, authorization
  arguments, URL userinfo and sensitive query values while preserving harmless
  arguments for diagnostics.
- Effective resolution is deterministic by scope and name:
  `agent+project > project > agent > global`, with managed entries winning a
  same-scope tie.
- The Hub validates and materializes descriptors, then ACP owns the server
  process/network connection. HTTP and SSE are capability-gated.
- Applying a changed descriptor set is an idle-only session transaction:
  restore with the new payload, roll back with the prior payload on failure, or
  require a new chat without disturbing the current one when restore is not
  advertised.
- Registry corruption is isolated to a timestamped backup; health and `/mcp`
  report recovery without rendering stored secret values.
- Schema validation rejects non-portable environment names, invalid HTTP header
  tokens, CR/LF header injection, URL credentials and control characters in
  process commands/arguments before materialization.

### Autocomplete dropdown (slash + `@file`)

```
  ❯ /model    set model config option
    /modes    show provider modes
    /mode     set provider mode

┃  /mo▏
┃
```

- Appears in the shared upper panel below the smart header and above the card
  (max 5 rows). Quickselect > autocomplete > expanded Plan > queue is the
  exclusive ownership order; covered Plan and queue state are retained.
- One blank upper-panel row separates menus from the header. Menu titles,
  selection markers, and option rows reuse the composer's three-cell content
  inset instead of introducing an independent margin.
- The card, internal metadata, and external hint never move. The panel grows
  upward and `headerGapRow` is its sole lower separator.
- The hint row becomes a key guide while results remain exclusively above.
- Selection movement repaints only upper-panel rows. Closing suggestions
  restores the unchanged complete Plan list.
- `↑`/`↓`/`Tab` cycle, `Enter`/`→` accept, `Esc` dismiss, typing refines.
- Same row grammar as pickers: `❯` selection, name + dim hint column.
- `@` mentions: same dropdown listing matched project files.

### Transcript blocks (flat)

- **User turn**: one theme-accented `┃` rail on the terminal/default background
  in column zero across the full-width shaded block, including its vertical padding. Short, wrapped, multiline,
  and attachment text remains bold one cell beyond the normal content inset,
  leaving an explicit inner gap after the rail.
- **Activity group**: `● Explored` (bold) with indented child rows. Groups
  branch from the turn rail with `├─` while more detail follows and `└─` for
  the final block; no horizontal divider is added. Commentary aligns with the
  action-content column without receiving a branch. The group glyph inherits
  `sem.busy` while running and `sem.ok` when done.
- **Turn summary**: completed direct answers without renderable Activity omit
  the inert `Worked for…` row. Expandable work, semantic commands, exceptional
  outcomes, and reported metrics whose details are unavailable retain an
  explicit header.
- **Plan**: `Plan (2/4)` bold + token markers (`✓ ▸ · ⊘`), replacing `x > -`.
  The smart header owns the summary; its non-modal phase drawer uses
  `max(0, transcriptInset - 1)`, expands to the complete phase list, and never
  displaces the card or captures ordinary composer input. It has no navigation
  or phase selection of its own.
- **Permission**: the blocking request has no normal transcript block; its
  `sem.warn` numbered quickselect lives in the upper composer shelf and is
  restored there when a popup reopens. The settled choice remains as one
  compact allowed/rejected audit row. `/debug` may project the raw request.
- **Chat header** (`printChatTitle`): `● Codex · myproject · Refactor auth`
  one line, theme-accented glyph, dim path on second line only in debug.
- **Errors**: `✗ message` in `sem.err` (drop the `[error]` bracket tag).
- **Submitted prompts**: theme rail and prompt text sit inside a full-width
  `colour235` band; the band reaches both edges while content uses the shared
  independently configurable prompt inset. One shaded spacer row above and below supplies
  vertical padding without becoming an external transcript gap.
- **Code blocks**: fenced content renders as one compact `colour235` rectangle
  sized to its longest visual row and capped by the inner transcript width,
  with two internal cells on all four sides. It shows a subdued language label
  only when the fence declares one. Canonical
  language aliases drive lightweight token grammars; tmux receives dedicated
  command, flag, user-option and format highlighting, while unknown or plain
  text remains untouched.
  Resize recomputes wrapping and rectangle width from semantic source lines.
  Non-TTY output stays plain.

### Pickers (already close to spec)

- Title row: bold title + dim counter. Query row: `❯` + query.
- Rows: `❯` selection (cyan), `●` current (green), headers bold flat.
- Bottom hint row dim. No boxes — pickers are transient, flat is right.
- Normalize label grammar everywhere: `<glyph+status>  <Provider>  <title>  <meta>`
  for chats; `<value> · <label>` for options.
- The chat menu defaults to one provider-neutral recent-activity timeline.
  `Tab` cycles Recent/Oldest/Projects, plain `s` toggles project/all scope, and
  `Ctrl+O` closes the scene directly. Oldest-first ordering happens in the
  daemon before its page limit; Projects never uses provider as a hidden group.
- Order modes form a family tab strip with one base-surface cell between tabs:
  resolved accent/dark active tab, `#0e0e0e` inactive surfaces, one-cell inner
  horizontal padding, compact labels below 26 columns, and a bracketed non-TTY
  fallback. This deliberately echoes tmux window tabs so sibling plugins share
  one recognizable visual grammar.
- Chat rows reuse the option-picker contrast hierarchy: `fg.menu` unselected title
  and section copy, bold selected title, theme-accented identity glyph, and
  semantic live status left intact. Selection—not every stored title—owns the
  strongest foreground contrast.
- With a transcript preview, the chat column uses a configurable 58% target
  while reserving at least 38 columns for preview; narrow layouts give the list
  the complete width. Chat labels are rendered against that actual width and
  drop secondary metadata before truncating the title.
- The Ctrl+O chat menu is an exclusive full-height scene. It suspends the live
  composer object instead of resolving it, hides every composer-owned row, and
  restores transcript + latest Plan/queue + draft/cursor atomically on `Esc`.
  Scrollback position survives the scene too. A chat selection switches tmux
  windows before the previous pane repaints.

Session restoration is identity-preserving. A non-capability
`session/load`/`session/resume` failure becomes structured `restoreFailure`
state on the same chat. The shared composer shelf offers retry, an explicit
fresh ACP session with the local transcript retained, or Chats. A detached
restart owns `restart.lock`; every cold workspace launch waits for that
transaction before it creates a tmux view.

### Mouse selection

A conditional root `MouseDrag1Pane` binding sends bare drags in windows carrying
`@acp_hub_chat_id` to `copy-mode -M`; click, hover, and wheel reports remain in
the renderer. Its release/copy policy stays user-owned. The Hub wraps only the
stock tmux binding unless `@acp_hub_mouse_native_select=force`, and preserves
custom bindings otherwise. `F4` remains a fallback that temporarily suspends
DECSET 1000/1003/1006 and advertises `[SELECT]`; `Esc`/`F4` restores tracking.

### tmux surfaces

- Window status / switcher / toggle-menu labels adopt the same grammar:
  `<glyph> <Provider> <title>` with the resolved theme accent
  (single source: JS emits the format strings; shell consumes cached values —
  full dedup deferred to R4).
- Native display-menus keep tmux styling (quick actions only).

## Phases

| Phase | Scope | Size |
|-------|-------|------|
| **V1** | Composer box + placeholder + overflow + footer polish + scroll badge + degrade rule | core, ~1 día |
| **V2** | Autocomplete dropdown (slash + `@file`) with selection cycling | medium |
| **V3** | Transcript blocks: user rail, permission decision/error/activity/header restyle | medium |
| **V4** | Label grammar normalization (pickers + tmux surfaces) + token extraction into one module | small |
| **V5** | Theme resolver: `@acp_hub_theme` (`vanzi` / `agent`) plus custom Vanzi accent | complete |

Implementation anchors: composer = `rawInputLayout` / `renderPinnedRawInput` /
`inputHint`; dropdown = new state in `handleRawKeypress` + paint in
`renderPinnedRawInput`; transcript blocks = `renderUserTurn`, `renderPlan`,
`renderPermission`, `renderActivityEvent`, `printChatTitle`, `renderEvent`;
tokens land in `lib/render.mjs` or a new `lib/theme.mjs`.
