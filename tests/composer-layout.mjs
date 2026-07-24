#!/usr/bin/env node
// Unit tests for the editable prompt-card layout: geometry, compact-mode
// degradation, overflow counters, and a paint smoke test for the card surface.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;
// The card accent falls back to the provider color only when no
// @acp_hub_accent tmux option is readable; drop TMUX so a developer's own
// theme cannot leak into the assertions.
delete process.env.TMUX;

const { PopupUi } = await import("../bin/acp-hub.mjs");
const {
  attachmentChip,
  attachmentCursorTarget,
  attachmentDeletionRange,
  attachmentTokenRanges,
  expandRangeToAttachmentTokens,
  rawInputVisualLines,
} = await import("../lib/core.mjs");

const strip = (value) => String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo/demo",
    currentChat: {
      id: "c1",
      provider: "codex",
      providerLabel: "Codex ACP",
      projectName: "demo",
      status: "idle",
      cwd: "/repo/demo",
    },
    rawInput: null,
    pendingAttachments: [],
    pendingPermission: null,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    composerAnimationFrame: 0,
    activePicker: null,
    lastRawInputLayout: null,
    lastRawScrollBottom: null,
  });
  return ui;
}

const session = (line = "") => ({ pinned: true, line, cursor: line.length });

// --- MCP administrative command grammar ---------------------------------------
{
  const ui = makeUi();
  const stdio = ui.parseMcpDefinitionArguments(
    "filesystem stdio npx -y @modelcontextprotocol/server-filesystem /repo --scope agent-project --env TOKEN=${MCP_TOKEN}",
  );
  assert.equal(stdio.name, "filesystem");
  assert.equal(stdio.transport, "stdio");
  assert.equal(stdio.command, "npx");
  assert.deepEqual(stdio.args, ["-y", "@modelcontextprotocol/server-filesystem", "/repo"]);
  assert.deepEqual(stdio.scope, { provider: "current", project: "current" });
  assert.deepEqual(stdio.env, [{ name: "TOKEN", value: "${MCP_TOKEN}" }]);

  const http = ui.parseMcpDefinitionArguments(
    "context7 http https://example.test/mcp --scope global --header Authorization=${MCP_AUTH}",
  );
  assert.equal(http.url, "https://example.test/mcp");
  assert.deepEqual(http.headers, [{ name: "Authorization", value: "${MCP_AUTH}" }]);
  const duplicateCommandName = ui.parseMcpDefinitionArguments([
    "add",
    "stdio",
    "add",
    "--scope",
    "project",
  ]);
  assert.equal(duplicateCommandName.name, "add");
  assert.equal(duplicateCommandName.command, "add");
  assert.throws(
    () => ui.parseMcpDefinitionArguments("broken websocket ws://example.test"),
    /stdio, http, or sse/,
  );

  const draft = session("");
  draft.draftKey = "chat:c1";
  ui.rawInput = draft;
  let saved = false;
  let rendered = false;
  let notice = "";
  ui.saveRawDraft = () => {
    saved = true;
  };
  ui.renderRawInput = () => {
    rendered = true;
  };
  ui.notify = (value) => {
    notice = value;
  };
  assert.equal(ui.seedMcpAddDraft(), true);
  assert.match(draft.line, /^\/mcp add server-name stdio command/);
  assert.equal(draft.cursor, draft.line.indexOf("server-name"));
  assert.equal(saved, true);
  assert.equal(rendered, true);
  assert.match(notice, /edit the MCP template/);
  draft.line = "keep this prompt";
  assert.equal(ui.seedMcpAddDraft(), true);
  assert.equal(draft.line, "keep this prompt", "MCP administration never destroys a draft");
  assert.match(notice, /current draft kept/);

  let opened = false;
  ui.showMcpAdminPicker = async () => {
    opened = true;
    return true;
  };
  ui.closeComposerFooterExpansion = () => true;
  assert.equal(await ui.openComposerFooterControl("mcp"), true);
  assert.equal(opened, true, "the footer MCP diagnostic opens the inline administrator");

  ui.hub = {
    call: async () => ({
      ok: false,
      pending: true,
      requiresNewSession: true,
      error: "no restore",
      chat: ui.currentChat,
    }),
  };
  assert.equal(await ui.applyMcpConfiguration(), false);
  assert.match(notice, /open a new chat/);
}

// --- Geometry: enhanced card on a normal-size popup ----------------------------
{
  const ui = makeUi();
  const layout = ui.rawInputLayout(session(""));
  assert.equal(layout.enhanced, true, "enhanced on 30 rows");
  // Transcript gap + smart header + card gap + top/input/meta-gap/metadata card
  // rows + the external hint with one blank row on each side = 10 rows.
  assert.equal(layout.outputBottom, 30 - 10);
  assert.equal(layout.gapRow, 20, "one composer-owned row separates transcript and header");
  assert.equal(layout.headerTopGapRow, layout.gapRow);
  assert.ok(layout.composerRows.includes(layout.headerTopGapRow));
  assert.equal(layout.headerRow, 21);
  assert.equal(layout.headerGapRow, 22, "one plain row separates header and card");
  assert.equal(layout.cardTopRow, 23);
  assert.equal(layout.inputRow, 24);
  assert.equal(layout.cardMetaGapRow, 25);
  assert.equal(layout.footerRow, 26, "metadata is the final shaded card row");
  assert.equal(layout.cardBottomRow, layout.footerRow);
  assert.equal(layout.infoGapTopRow, 27, "one plain row separates card and hint");
  assert.equal(layout.hintRow, 28);
  assert.equal(layout.infoGapBottomRow, 29, "one plain row separates info and tmux");
  assert.ok(layout.composerRows.includes(layout.cardBottomRow));
  assert.equal(layout.inputWidth, ui.rawInputTextWidth(session(""), 100));
  assert.equal(ui.composerCardContentColumn(), 3, "rail + two-cell gap precede the cursor");
  assert.equal(
    ui.composerMetaLine("guide"),
    "   guide",
    "the detached shortcut guide shares the composer's three-cell inset",
  );
  assert.equal(layout.inputWidth, 94, "two right-padding cells stay outside editable content");
  const surface = ui.composerCardLine("hello", 99);
  assert.equal(strip(surface).length, 99);
  assert.ok(strip(surface).startsWith("┃  hello"));
  assert.ok(strip(surface).endsWith("  "));
  assert.match(
    surface,
    /\x1b\[1m┃\x1b\[0m\x1b\[48;5;235m/,
    "the rail uses the terminal background before the card surface begins",
  );
}

// --- Responsive metadata keeps safety state before diagnostics -----------------
{
  const ui = makeUi();
  ui.currentChat.model = "gpt-5.6-sol";
  ui.currentChat.effort = "xhigh";
  ui.currentChat.configOptions = [
    {
      id: "model",
      type: "select",
      currentValue: "gpt-5.6-sol",
      options: [
        { value: "gpt-5.6-sol", name: "GPT-5.6 SOL" },
        { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
        { value: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
        { value: "gpt-5", name: "GPT-5" },
      ],
    },
    {
      id: "effort",
      type: "select",
      currentValue: "xhigh",
      options: [
        { value: "xhigh", name: "XHigh" },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
        { value: "low", name: "Low" },
      ],
    },
    {
      id: "mode",
      category: "mode",
      type: "select",
      currentValue: "agent-full-access",
      options: [{ value: "agent-full-access", name: "Agent full access" }],
    },
  ];
  ui.currentChat.usage = { used: 180000, size: 200000 };
  ui.currentChat.mcpServers = [{ name: "one" }, { name: "two" }];
  ui.currentChat.additionalDirectories = ["/repo/shared"];
  ui.currentChat.permissionState = { pending: true };
  ui.pendingAttachments = [{ name: "large.txt", size: 2048, kind: "file" }];

  const styledWide = ui.composerFooter(160);
  const wide = strip(styledWide);
  assert.match(wide, /GPT-5\.6 SOL/);
  assert.match(wide, /XHigh/);
  assert.match(wide, /Full access/);
  assert.match(wide, /permission pending/);
  assert.match(wide, /\+2 mcp/);
  assert.doesNotMatch(wide, /gpt-5\.6-sol|agent-full-access/);
  assert.ok(wide.length < 160, "metadata no longer expands to a synthetic right edge");
  assert.doesNotMatch(
    wide,
    / {4,}/,
    "controls and diagnostics form one continuous flow without space-between",
  );
  assert.match(
    wide,
    /permission pending {1,2}· 180k\/200k \(90%\)/,
    "the first diagnostic follows the final metadata card directly",
  );
  assert.ok(
    styledWide.includes("\x1b[48;2;14;14;14m"),
    "secondary controls keep persistent metadata-card surfaces",
  );
  assert.equal(
    (styledWide.match(/\x1b\[48;5;168m/g) || []).length,
    1,
    "only the first metadata card owns the Vanzi accent",
  );

  const semantic = ui.composerFooterLayout(160);
  assert.deepEqual(
    semantic.placements.map((region) => region.control),
    ["model", "effort", "access", "access", "mcp"],
    "config, pending authority, and MCP expose real click targets",
  );
  assert.equal(
    semantic.placements[1].x1,
    semantic.placements[0].x2 + 2,
    "one surface-free cell separates adjacent metadata cards",
  );
  ui.hoveredInteractiveKey = "composer-footer:effort";
  const hoveredFooter = ui.composerFooter(160);
  assert.equal((hoveredFooter.match(/\x1b\[48;5;168m/g) || []).length, 1);
  assert.match(
    hoveredFooter,
    /\x1b\[48;5;168m.*? GPT-5\.6 SOL /,
    "hover never transfers the primary card's accent",
  );
  assert.match(
    hoveredFooter,
    /\x1b\[48;2;42;42;42m.*? XHigh /,
    "hover decorates only its local metadata card",
  );
  ui.hoveredInteractiveKey = "";
  const composerSession = session("");
  const composerLayout = ui.rawInputLayout(composerSession);
  ui.updateComposerFooterInteractiveRegions(composerSession, composerLayout, semantic);
  assert.equal(ui.composerInteractiveRegions[0].x1, ui.composerCardContentColumn());
  assert.equal(ui.composerInteractiveRegions[0].y1, composerLayout.footerRow);

  const narrow = strip(ui.composerFooter(44));
  assert.match(narrow, /Full access/, "canonical access survives narrow layouts");
  assert.match(narrow, /permission pending/, "pending permission survives narrow layouts");
  assert.doesNotMatch(narrow, /mcp|shared|large\.txt|90%/, "diagnostics disappear first");
  assert.ok(narrow.length <= 44);

  // Clicking model/effort can now expand their ACP-advertised values in the
  // metadata row itself. The row never gains height and volatile diagnostics
  // yield their width while the transient group is open.
  ui.rawInput = session("");
  ui.paintComposerFooterRow = () => true;
  assert.equal(ui.toggleComposerFooterExpansion("model"), true);
  const expandedModel = ui.composerFooterLayout(160);
  const expandedModelText = strip(expandedModel.text);
  assert.match(expandedModelText, /GPT-5\.6 SOL.*GPT-5\.6 Terra.*GPT-5\.6 Luna.*GPT-5/);
  assert.match(expandedModelText, /XHigh/);
  assert.match(expandedModelText, /Full access/);
  assert.doesNotMatch(expandedModelText, /mcp|90%|large\.txt/);
  assert.equal(
    expandedModel.placements.filter((region) => region.action === "select-composer-footer-option").length,
    4,
  );
  assert.ok(
    (expandedModel.text.match(/\x1b\[48;2;14;14;14m/g) || []).length >= 3,
    "unselected models share the theme-neutral group surface",
  );
  assert.match(
    expandedModel.text,
    /\x1b\[48;5;168m.*? GPT-5\.6 SOL /,
    "the current model owns the bright Vanzi pink",
  );
  assert.match(
    expandedModel.text,
    /\x1b\[0m\x1b\[48;2;14;14;14m/,
    "expanded values touch without a surface-free cell between them",
  );
  assert.match(
    expandedModel.text,
    / GPT-5\.6 Terra \x1b\[0m\x1b\[48;2;14;14;14m.*? GPT-5\.6 Luna /,
    "the expanded group contains no internal gap",
  );

  ui.hoveredInteractiveKey = "composer-footer:model:option:model:1";
  const hoveredChoice = ui.composerFooterLayout(160).text;
  assert.equal(
    (hoveredChoice.match(/\x1b\[48;5;168m/g) || []).length,
    1,
    "an expanded group exposes exactly one bright selection/preview accent",
  );
  assert.match(
    hoveredChoice,
    /\x1b\[48;5;168m\x1b\[38;2;14;14;14m.*? GPT-5\.6 Terra /,
    "hover previews the candidate with the same bright pink as a selected model",
  );
  assert.match(
    hoveredChoice,
    /\x1b\[48;2;14;14;14m.*? GPT-5\.6 SOL /,
    "the canonical value yields its bright accent while another candidate is previewed",
  );
  assert.doesNotMatch(hoveredChoice, /\x1b\[4m/, "hover no longer adds an underline");
  ui.hoveredInteractiveKey = "";
  assert.match(
    ui.composerFooterLayout(160).text,
    /\x1b\[48;5;168m.*? GPT-5\.6 SOL /,
    "leaving the group restores the canonical current value",
  );

  const narrowExpanded = ui.composerFooterLayout(34);
  assert.equal(narrowExpanded.expansion.paged, true);
  assert.ok(narrowExpanded.width <= 34);
  assert.ok(
    narrowExpanded.placements.some(
      (region) => region.action === "page-composer-footer-group" && region.delta === 1,
    ),
    "narrow groups expose a next-page hitbox instead of silently truncating values",
  );

  assert.equal(
    await ui.selectComposerFooterOption("model", "gpt-5.6-sol"),
    true,
    "clicking the current value collapses the group",
  );
  assert.equal(ui.composerFooterExpansion, null);

  let applied = null;
  ui.applyConfigOption = async (id, value, options) => {
    applied = { id, value, options };
    return true;
  };
  ui.toggleComposerFooterExpansion("model");
  assert.equal(await ui.selectComposerFooterOption("model", "gpt-5.6-terra"), true);
  assert.deepEqual(applied, {
    id: "model",
    value: "gpt-5.6-terra",
    options: { fallback: false, render: false },
  });
  assert.equal(ui.composerFooterExpansion, null, "ACP acknowledgement collapses the group");

  ui.toggleComposerFooterExpansion("effort");
  const expandedEffort = ui.composerFooterLayout(160);
  assert.match(strip(expandedEffort.text), /GPT-5\.6 SOL.*XHigh.*High.*Medium.*Low.*Full access/);
  assert.match(
    expandedEffort.text,
    /\x1b\[48;2;57;57;57m.*? XHigh /,
    "the current effort uses the stronger neutral surface",
  );
  assert.match(
    expandedEffort.text,
    /\x1b\[48;2;14;14;14m.*? High /,
    "effort alternatives share the dark neutral surface",
  );
  ui.hoveredInteractiveKey = "composer-footer:effort:option:effort:2";
  const hoveredEffort = ui.composerFooterLayout(160).text;
  assert.equal(
    (hoveredEffort.match(/\x1b\[48;5;168m/g) || []).length,
    2,
    "one effort preview accent appears beside the persistent model card",
  );
  assert.match(
    hoveredEffort,
    /\x1b\[48;2;14;14;14m.*? XHigh /,
    "the current effort yields its accent while another level is previewed",
  );
  assert.match(
    hoveredEffort,
    /\x1b\[48;5;168m.*? Medium /,
    "effort hover borrows the current theme accent",
  );
  ui.hoveredInteractiveKey = "";
  ui.handleRawKeypress(ui.rawInput, "", { name: "escape" }, () => {});
  assert.equal(ui.composerFooterExpansion, null, "Esc closes a footer group before arming cancel");

  ui.applyConfigOption = async () => false;
  ui.toggleComposerFooterExpansion("model");
  assert.equal(await ui.selectComposerFooterOption("model", "gpt-5.6-terra"), false);
  assert.equal(
    ui.composerFooterExpansion?.control,
    "model",
    "a rejected ACP change keeps the group available for retry",
  );
  assert.equal(ui.composerFooterSelectionPending, null);
  ui.closeComposerFooterExpansion({ render: false });
}

// Theme variants change only the structural accent. Provider-aware mode uses
// the active ACP hue; neutral effort surfaces and semantic states stay fixed.
{
  const ui = makeUi();
  ui.themeVariant = "agent";
  ui.currentChat.model = "gpt-5.6-sol";
  ui.currentChat.effort = "xhigh";
  let footer = ui.composerFooter(80);
  assert.match(footer, /\x1b\[48;5;39m.*? GPT-5\.6 SOL /);
  assert.match(footer, /\x1b\[48;2;14;14;14m.*? XHigh /);

  ui.currentChat.provider = "claude";
  footer = ui.composerFooter(80);
  assert.match(footer, /\x1b\[48;5;173m.*? GPT-5\.6 SOL /);

  ui.currentChat.status = "permission";
  ui.pendingPermission = { permissionId: "theme-permission", options: [] };
  assert.equal(ui.composerAccentSeq(), "\x1b[33m");
  ui.currentChat.status = "error";
  ui.pendingPermission = null;
  assert.equal(ui.composerAccentSeq(), "\x1b[38;5;168m");
}

// Queued work uses the shared shelf below the smart header. Entries are
// contiguous inside it, with one breathing row above and the ordinary card gap
// below; the bottom-anchored card never moves.
{
  const ui = makeUi();
  const base = ui.rawInputLayout(session(""));
  ui.currentChat.queued = 2;
  ui.currentChat.queuedRequests = [
    { id: "q1", kind: "prompt", preview: "revisa el wrapper", position: 1 },
    { id: "q2", kind: "prompt", preview: "ejecuta las pruebas", position: 2 },
  ];
  const queued = ui.rawInputLayout(session(""));
  assert.equal(queued.upperPanelKind, "queue");
  assert.equal(queued.queueRows, 2);
  assert.equal(queued.upperPanelRows, 3, "top gap + two contiguous queue rows");
  assert.equal(queued.outputBottom, base.outputBottom - 3);
  assert.equal(queued.upperPanelPadRow, queued.headerRow + 1);
  assert.equal(queued.queueRow, queued.headerRow + 2);
  assert.equal(queued.headerGapRow, queued.queueRow + queued.queueRows);
  assert.ok(queued.composerRows.includes(queued.queueRow));
  for (const key of ["headerGapRow", "cardTopRow", "inputRow", "footerRow", "cardBottomRow"]) {
    assert.equal(queued[key], base[key], `${key} stays fixed while queue opens`);
  }
  assert.match(strip(ui.queueShelfLine(80)), /Queue 2 · Next: revisa el wrapper · \+1 more/);
  const queueLines = ui.queueShelfLines(80, queued.queueRows).map(strip);
  assert.match(queueLines[0], /Queue 2 · Next: revisa el wrapper/);
  assert.match(queueLines[1], /^ {7} · 2: ejecuta las pruebas/);
  assert.doesNotMatch(queueLines.join("\n"), /\n\s*\n/, "queue entries have no internal blank row");
  const queuePaints = [];
  const queuePainter = {
    to(column, row) { queuePaints.push([column, row]); return this; },
    clearLine() { return this; },
    text() { return this; },
  };
  ui.paintQueueSection(queuePainter, queued, queued.columns - 1);
  assert.deepEqual(
    queuePaints.filter(([column]) => column === 3).map(([, row]) => row),
    [queued.queueRow, queued.queueRow + 1],
    "queue rows are painted contiguously at the shared content inset",
  );

  const menu = ui.rawInputLayout(session("/mo"));
  assert.equal(menu.upperPanelKind, "autocomplete", "menu temporarily replaces the queue shelf");
  assert.equal(menu.queueRows, 0);
  assert.equal(menu.cardTopRow, queued.cardTopRow);

  ui.planExpanded = true;
  ui.planBandAllocation = () => ({ planRows: 3, gapRows: 0 });
  const plan = ui.rawInputLayout(session(""));
  assert.equal(plan.upperPanelKind, "plan", "expanded Plan temporarily replaces queue");
  assert.equal(plan.queueRows, 0);
}

// Vim reserves Esc for mode transitions, so empty Ctrl+C provides the same
// guarded cancellation. With content it only clears the draft.
{
  const ui = makeUi();
  ui.vimEnabled = true;
  ui.currentChat.status = "responding";
  ui.currentChat.queued = 0;
  ui.inputHistory = [];
  ui.killRing = [];
  ui.renderRawInput = () => {};
  ui.saveRawDraft = () => {};
  ui.notify = () => {};
  let cancelRequests = 0;
  ui.requestCancelCurrentTurn = () => {
    cancelRequests += 1;
    return true;
  };

  const withText = {
    ...session("limpiar"),
    draftKey: "chat:c1",
    vimMode: "insert",
    vimOp: "",
    vimCount: "",
    vimFind: "",
    vimReplace: false,
    vimGPending: false,
  };
  ui.rawInput = withText;
  ui.handleRawKeypress(withText, "", { name: "c", ctrl: true }, () => {});
  assert.equal(withText.line, "");
  assert.equal(cancelRequests, 0);

  ui.handleRawKeypress(withText, "", { name: "c", ctrl: true }, () => {});
  assert.equal(cancelRequests, 0, "first empty Ctrl+C only asks for confirmation");
  assert.match(ui.turnCancelConfirmationLabel(withText), /Press Ctrl\+C again/);
  ui.handleRawKeypress(withText, "", { name: "c", ctrl: true }, () => {});
  assert.equal(cancelRequests, 1);
}

// Outside Vim, empty Ctrl+C is inert: it neither exits nor cancels the agent.
{
  const ui = makeUi();
  ui.vimEnabled = false;
  ui.currentChat.status = "responding";
  ui.renderRawInput = () => {};
  let finished = false;
  let cancelled = false;
  ui.requestCancelCurrentTurn = () => {
    cancelled = true;
    return true;
  };
  const empty = { ...session(""), draftKey: "chat:c1" };
  ui.rawInput = empty;
  ui.handleRawKeypress(empty, "", { name: "c", ctrl: true }, () => { finished = true; });
  assert.equal(cancelled, false);
  assert.equal(finished, false);
}

// --- Compact-mode degradation ----------------------------------------------------
{
  const ui = makeUi();
  process.stdout.rows = 12;
  const layout = ui.rawInputLayout(session(""));
  assert.equal(layout.enhanced, false, "small popups drop embedded picker capacity");
  assert.ok(Number.isInteger(layout.headerGapRow));
  assert.ok(Number.isInteger(layout.infoGapTopRow));
  assert.equal(layout.hintRow, null, "compact mode hides the shortcut hint");
  assert.equal(layout.infoGapBottomRow, null, "one final safety row is enough without a hint");
  process.stdout.rows = 30;
}
{
  const ui = makeUi();
  process.env.ACP_HUB_COMPOSER_ENHANCED = "0";
  assert.equal(ui.rawInputLayout(session("")).enhanced, false, "enhanced-mode switch works");
  delete process.env.ACP_HUB_COMPOSER_ENHANCED;
}
{
  const ui = makeUi();
  process.env.ACP_HUB_COMPOSER_BOX = "0";
  assert.equal(ui.rawInputLayout(session("")).enhanced, false, "legacy env kill-switch works");
  delete process.env.ACP_HUB_COMPOSER_BOX;
}

// --- Multiline growth + overflow counters ---------------------------------------
{
  const ui = makeUi();
  const long = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const layout = ui.rawInputLayout(session(long));
  assert.equal(layout.inputRows, 6, "input grows to the 6-row cap");
  const view = ui.rawInputMultilineViewport(session(long), layout.inputWidth, layout.inputRows);
  assert.equal(view.hiddenAbove + view.hiddenBelow, 4, "10 lines - 6 visible = 4 hidden");
}

// Attachments consume fixed composer rows and therefore move the same viewport
// boundary as a multiline draft or Plan transition.
{
  const ui = makeUi();
  const base = ui.rawInputLayout(session(""));
  ui.pendingAttachments = [{
    kind: "image",
    name: "screenshot.png",
    path: "/tmp/screenshot.png",
    size: 1024,
  }];
  const attached = ui.rawInputLayout(session(""));
  assert.ok(attached.attachmentRows >= 3, "attachments reserve separation, a header, and chips");
  assert.ok(
    attached.attachmentRow < attached.cardBottomRow,
    "attachments remain inside the live card before its bottom padding",
  );
  assert.ok(attached.outputBottom < base.outputBottom);
  assert.ok(attachmentChip(ui.pendingAttachments[0], 0).includes("\x1b[38;5;39m"));

  let painted = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    painted += String(chunk);
    return true;
  };
  try {
    ui.renderPinnedRawInput(session("review"), ui.rawInputLayout(session("review")));
  } finally {
    process.stdout.write = originalWrite;
  }
  const plain = strip(painted);
  assert.ok(plain.includes("┃  review"));
  assert.ok(plain.includes("┃  Images (1)"));
  assert.ok((plain.match(/┃/g) || []).length >= 6, "the attachment area continues the card rail");
}

// Inline attachment labels are one semantic editing unit even though their
// visible label spans several source/display columns.
{
  const text = "before [Image #1] after [Pasted #2 +40 lines]";
  const ranges = attachmentTokenRanges(text);
  assert.equal(ranges.length, 2);
  assert.equal(text.slice(ranges[0].start, ranges[0].end), "[Image #1]");
  assert.equal(attachmentCursorTarget(text, ranges[0].end, -1), ranges[0].start);
  assert.equal(attachmentCursorTarget(text, ranges[0].start, 1), ranges[0].end);
  assert.deepEqual(
    attachmentDeletionRange(text, ranges[0].end, -1),
    ranges[0],
    "backspace after a token selects the complete attachment",
  );
  assert.deepEqual(
    attachmentDeletionRange(text, ranges[1].start, 1),
    ranges[1],
    "Delete before a token selects the complete attachment",
  );
  assert.deepEqual(
    expandRangeToAttachmentTokens(text, ranges[0].start + 2, ranges[0].start + 3),
    { start: ranges[0].start, end: ranges[0].end },
  );

  const ui = makeUi();
  const view = ui.rawInputMultilineViewport(session(text), 80, 2);
  assert.ok(view.rows[0].text.includes("\x1b[38;5;168m[Image #1]\x1b[39m"));

  const editable = session("a[Image #1]b");
  ui.refreshRawInputPrompt = () => {};
  ui.pendingAttachments = [{
    n: 1,
    kind: "image",
    name: "shot.png",
    path: "/tmp/shot.png",
  }];
  editable.cursor = 1;
  ui.moveRawCursorAcrossAttachments(editable, 1);
  assert.equal(editable.cursor, 11, "Right jumps over the complete token");
  ui.moveRawCursorAcrossAttachments(editable, -1);
  assert.equal(editable.cursor, 1, "Left jumps back over the complete token");
  ui.deleteRawInputUnit(editable, 1);
  assert.equal(editable.line, "ab", "Delete removes the complete token");
  assert.equal(ui.pendingAttachments.length, 0, "deleting its token detaches the image");
}

// --- Word-aware editable wrapping + cursor source mapping ------------------------
{
  const text = "123456789012 palabra final";
  const visual = rawInputVisualLines(text, 16);
  assert.deepEqual(visual.map((row) => row.text), ["123456789012", "palabra final"]);
  assert.equal(visual[0].end, visual[1].start, "soft-boundary space remains source-mapped");

  const ui = makeUi();
  ui.rawInputTextWidth = () => 16;
  const draft = session(text);
  draft.cursor = 12;
  assert.equal(ui.moveRawCursorVertically(draft, 1), true);
  assert.equal(draft.cursor, 25, "vertical motion preserves display column on the wrapped row");
  assert.equal(ui.moveRawCursorVertically(draft, -1), true);
  assert.equal(draft.cursor, 12);

  const spaced = session("palabra   ");
  const spacedView = ui.rawInputMultilineViewport(spaced, 16, 6);
  assert.equal(spacedView.rows[0].text, "palabra   ", "trailing spaces remain in the painted row");
  assert.equal(spacedView.cursorColumn, 10, "cursor advances once per trailing space");

  const boundarySpace = session("1234 ");
  const boundaryView = ui.rawInputMultilineViewport(boundarySpace, 4, 6);
  assert.deepEqual(boundaryView.rows.map((row) => row.text), ["1234", " "]);
  assert.equal(boundaryView.cursorRow, 1, "cursor follows a trailing space onto the next row");
  assert.equal(boundaryView.cursorColumn, 1);
}

// --- Placeholder ---------------------------------------------------------------
{
  const ui = makeUi();
  const layout = ui.rawInputLayout(session(""));
  const view = ui.rawInputMultilineViewport(session(""), layout.inputWidth, layout.inputRows);
  assert.ok(view.rows[0].placeholder, "empty composer shows placeholder");
  assert.match(view.rows[0].text, /commands/, "placeholder mentions / commands");
  assert.match(view.rows[0].text, /@ files/, "placeholder mentions @ files");
}

// --- Paint smoke test ------------------------------------------------------------
{
  const ui = makeUi();
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    ui.renderPinnedRawInput(session("hello box"), ui.rawInputLayout(session("hello box")));
  } finally {
    process.stdout.write = original;
  }
  const plain = strip(out);
  assert.ok(plain.includes("   ⬡ Codex"), "provider identity is detached above the card");
  assert.ok(!plain.includes("┃  ⬡ Codex"));
  assert.ok(!plain.includes("idle"), "quiet status is not spelled out in the smart header");
  assert.ok(!/[╭╮╰╯─│]/.test(plain), "legacy box rules and borders are gone");
  assert.ok((plain.match(/┃/g) || []).length >= 3, "the rail spans card padding and input only");
  assert.ok(plain.includes("hello box"), "input text painted");
  const paintedFooter = strip(
    ui.composerFooter(ui.composerCardContentWidth(ui.rawInputLayout(session("hello box")).columns - 1)),
  );
  assert.ok(
    plain.includes(paintedFooter),
    "session metadata remains visible inside the card",
  );
  assert.ok(plain.includes(`┃  ${paintedFooter}`));
  assert.ok(out.includes("\x1b[48;5;235m"), "the live card uses the submitted-prompt shade");
  assert.ok(out.includes("\x1b[38;5;168m"), "Vanzi pink tints the rail by default");
}

// Restoring the terminal scroll region is itself a viewport transition even
// when the semantic composer layout has not changed. It must force one
// transcript repaint because resetting the region invalidates the old frame.
{
  const ui = makeUi();
  const draft = session("");
  const layout = ui.rawInputLayout(draft);
  ui.rawInput = draft;
  ui.lastRawInputLayout = layout;
  ui.enableRawInputLayout = () => true;
  ui.clearRawInputLayoutRows = () => {};
  let repaints = 0;
  ui.repaintPinnedOutput = () => { repaints += 1; };
  ui.renderPinnedRawInput = () => {};
  ui.renderRawInput();
  assert.equal(repaints, 1, "a restored scroll region repaints an otherwise identical layout");
}

// --- Attention state overrides the card accent -----------------------------------
{
  const ui = makeUi();
  ui.currentChat.status = "working";
  ui.statusAnimation = "wave";
  ui.statusAnimationIntervalMs = 120;
  ui.statusAnimationPauseMs = 900;
  const waveFrame0 = ui.composerHeaderLine(80);
  const activeHeader = strip(waveFrame0);
  assert.match(activeHeader, /^ {3}⠋ working/);
  assert.doesNotMatch(activeHeader, /⬡|Codex/);
  ui.composerAnimationFrame = 1;
  const waveFrame1 = ui.composerHeaderLine(80);
  assert.notEqual(waveFrame1, waveFrame0, "wave moves its luminance across the label");
  assert.match(strip(waveFrame1), /^ {3}⠙ working/);
  assert.equal(strip(waveFrame1).length, activeHeader.length, "animation never changes geometry");

  ui.composerAnimationFrame = 10;
  const wavePause = ui.composerHeaderLine(80);
  assert.doesNotMatch(wavePause, /\x1b\[38;5;230m/, "the wave rests after crossing the word");
  ui.composerAnimationFrame = 18;
  assert.match(
    ui.composerHeaderLine(80),
    /\x1b\[38;5;230m/,
    "the wave restarts after the configured quiet pause",
  );
  ui.statusAnimationPauseMs = 0;
  assert.equal(ui.composerStatusAnimationPauseFrames(), 0, "zero explicitly disables the pause");
  ui.statusAnimationPauseMs = 900;

  ui.statusAnimation = "breathe";
  ui.composerAnimationFrame = 0;
  const breatheLow = ui.composerHeaderLine(80);
  ui.composerAnimationFrame = 3;
  const breatheHigh = ui.composerHeaderLine(80);
  assert.notEqual(breatheHigh, breatheLow, "breathe cycles the complete label intensity");
  assert.match(strip(breatheLow), /^ {3}⠋ working/);
  assert.match(strip(breatheHigh), /^ {3}⠸ working/);
  assert.equal(strip(breatheHigh).length, strip(breatheLow).length);

  ui.statusAnimation = "spinner";
  ui.composerAnimationFrame = 0;
  assert.match(strip(ui.composerHeaderLine(80)), /^ {3}⠋ working/);
  ui.composerAnimationFrame = 1;
  assert.match(strip(ui.composerHeaderLine(80)), /^ {3}⠙ working/);

  ui.statusAnimation = "off";
  const staticFrame = ui.composerHeaderLine(80);
  ui.composerAnimationFrame = 7;
  assert.equal(ui.composerHeaderLine(80), staticFrame, "off is fully motionless");
  assert.match(strip(staticFrame), /^ {3}◐ working/);

  ui.currentChat.provider = "claude";
  ui.currentChat.providerLabel = "Claude ACP";
  ui.currentChat.status = "thinking";
  ui.statusAnimation = "wave";
  ui.composerAnimationFrame = 0;
  const claudeHeader = strip(ui.composerHeaderLine(80));
  assert.match(claudeHeader, /^ {3}⠋ thinking/);
  assert.doesNotMatch(claudeHeader, /❋|Claude/);

  ui.currentChat.status = "permission";
  ui.pendingPermission = { permissionId: "p1", options: [] };
  assert.equal(ui.composerAccentSeq(), "\x1b[33m", "permission turns the rail yellow");
  ui.currentChat.status = "error";
  ui.pendingPermission = null;
  assert.equal(ui.composerAccentSeq(), "\x1b[38;5;168m", "error uses the Vanzi error pink");
}

// --- Draft token estimate ---------------------------------------------------------
{
  const { estimateDraftTokens, formatTokenEstimate } = await import("../lib/core.mjs");
  // Text only: ~4 chars/token, ceil.
  assert.equal(estimateDraftTokens("abcdefgh"), 2);
  assert.equal(estimateDraftTokens(""), 0);
  // File attachments count by size; images at a flat cost.
  assert.equal(estimateDraftTokens("", [{ kind: "file", size: 4000 }]), 1000);
  assert.equal(estimateDraftTokens("", [{ kind: "image", size: 999999 }]), 1500);
  // Formatting: plain under 1k, one decimal to 10k, whole k after.
  assert.equal(formatTokenEstimate(0), "");
  assert.equal(formatTokenEstimate(950), "~950 tok");
  assert.equal(formatTokenEstimate(1500), "~1.5k tok");
  assert.equal(formatTokenEstimate(32000), "~32k tok");
}

// The composer label resolves @file mentions through fs.stat and includes
// their size in the estimate.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-tok-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "x".repeat(8000));

  const ui = makeUi();
  ui.cwd = dir;
  ui.currentChat.cwd = dir;
  ui.rawInput = { line: "revisa @notes.txt por favor", cursor: 0 };
  const label = ui.composerDraftTokenLabel();
  // ~27 chars of text (7 tok) + 8000 bytes (2000 tok) ≈ 2.0k
  assert.ok(label.includes("~2.0k tok"), `mention size included (got: ${label})`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Guarded cancellation + input clearing -----------------------------------------
{
  const ui = makeUi();
  ui.currentChat.status = "responding";
  ui.currentChat.queued = 0;
  ui.hub = { call: async () => ({ ok: true }) };
  ui.notify = () => {};
  ui.renderRawInput = () => {};
  ui.saveRawDraft = () => {};
  ui.killRing = [];
  ui.inputHistory = [];
  ui.lastSentPrompt = { chatId: "c1", text: "arregla el bug del scroll" };

  // The explicit cancellation path still preserves cancel-to-edit.
  ui.rawInput = { line: "", cursor: 0, pinned: true };
  assert.equal(ui.requestCancelCurrentTurn(), true);
  assert.equal(ui.rawInput.line, "arregla el bug del scroll");
  assert.equal(ui.rawInput.cursor, ui.rawInput.line.length);

  // Composer already has NEW text: never overwritten by the restore.
  ui.rawInput = { line: "otra cosa", cursor: 9 };
  assert.equal(ui.requestCancelCurrentTurn(), true);
  assert.equal(ui.rawInput.line, "otra cosa");

  // Clearing is now a purely local operation and never requests cancellation.
  let cancelRequests = 0;
  ui.requestCancelCurrentTurn = () => {
    cancelRequests += 1;
    return true;
  };
  ui.rawInput = { line: "borrador nuevo", cursor: 14, pinned: true };
  assert.equal(ui.clearComposerInput(ui.rawInput), true);
  assert.equal(ui.rawInput.line, "", "Ctrl+C keeps the composer empty");
  assert.ok(ui.killRing.includes("borrador nuevo"), "discarded text goes to the kill ring");
  assert.equal(cancelRequests, 0, "clearing the composer never reaches the daemon");

  // Base Esc is a two-step state machine.
  ui.rawInput = { line: "correccion", cursor: 10, pinned: true };
  assert.equal(ui.confirmTurnCancellation(ui.rawInput, "escape"), true);
  assert.equal(cancelRequests, 0);
  assert.match(ui.turnCancelConfirmationLabel(ui.rawInput), /Press Esc again/);
  assert.equal(ui.confirmTurnCancellation(ui.rawInput, "escape"), true);
  assert.equal(cancelRequests, 1);
  assert.equal(ui.rawInput.line, "correccion", "guarded Esc preserves the draft");
}

// --- Inline picker (/model etc.) lives in the shared upper panel -------------------
{
  const ui = makeUi();
  ui.hub = { call: async () => ({ ok: true }) };
  ui.notify = () => {};
  ui.saveRawDraft = () => {};
  let applied = null;
  ui.currentChat.configOptions = [
    {
      id: "model",
      name: "Model",
      currentValue: "gpt-5.4",
      options: [
        { value: "gpt-5.5", label: "GPT-5.5" },
        { value: "gpt-5.4", label: "GPT-5.4" },
        { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
      ],
    },
  ];
  ui.applyConfigOption = async (id, value) => {
    applied = { id, value };
  };
  ui.currentChat.queued = 2;
  ui.currentChat.queuedRequests = [
    { id: "q1", kind: "prompt", preview: "first queued prompt", position: 1 },
    { id: "q2", kind: "prompt", preview: "second queued prompt", position: 2 },
  ];

  const session = { line: "/model", cursor: 6, pinned: true, draftKey: "chat:c1" };
  ui.rawInput = session;
  ui.renderRawInput = () => {};
  ui.paintComposerFooterRow = () => true;
  const stable = ui.rawInputLayout({ ...session, line: "", cursor: 0 });
  assert.equal(stable.upperPanelKind, "queue");

  // Enter on "/model" opens the inline picker instead of resolving the prompt.
  assert.equal(ui.toggleComposerFooterExpansion("model"), true);
  assert.equal(ui.composerFooterExpansion?.control, "model");
  assert.equal(ui.maybeOpenInlinePicker(session), true);
  assert.equal(ui.composerFooterExpansion, null, "the keyboard picker replaces the mouse group");
  assert.ok(ui.inlinePicker, "picker state set");
  assert.equal(session.line, "", "input cleared, composer stays on screen");
  assert.equal(ui.inlinePicker.index, 1, "selection starts on the current value");

  // Layout: the picker owns the upper panel, between the smart header and the
  // fixed card. Metadata and the external hint keep their exact rows.
  const layout = ui.rawInputLayout(session);
  assert.equal(layout.dropdownRows, 4, "3 items + title row");
  assert.equal(layout.upperPanelKind, "quickselect");
  assert.equal(layout.queueRows, 0, "quickselect temporarily replaces queued prompts");
  assert.equal(layout.dropdownPadRow, layout.upperPanelRow);
  assert.equal(layout.dropdownPadRow, layout.headerRow + 1);
  assert.equal(layout.dropdownRow, layout.headerRow + 2);
  assert.equal(layout.upperPanelRows, layout.dropdownRows + 1);
  assert.ok(layout.dropdownRow < layout.cardTopRow, "list renders above the input card");
  assert.equal(layout.footerRow, layout.cardBottomRow, "metadata remains inside the card");
  assert.match(ui.inputHint(session.line), /j\/k select/);
  for (const key of [
    "cardTopRow",
    "inputRow",
    "cardMetaGapRow",
    "footerRow",
    "infoGapTopRow",
    "hintRow",
    "infoGapBottomRow",
  ]) {
    assert.equal(layout[key], stable[key], `${key} stays fixed while picker is open`);
  }

  const pickerPaints = [];
  const pickerPainter = {
    to(column, row) { pickerPaints.push(["to", column, row]); return this; },
    clearLine() { return this; },
    text(value) { pickerPaints.push(["text", strip(value)]); return this; },
  };
  ui.paintAutocompleteDropdown(pickerPainter, layout, layout.columns - 1);
  const pickerLines = pickerPaints
    .filter(([kind]) => kind === "text")
    .map(([, value]) => value);
  assert.match(pickerLines[0], /^ {3}Model/, "picker title shares the header inset");
  assert.ok(
    pickerLines.slice(1).every((line) => line.startsWith("   ")),
    "every picker option keeps the same left inset",
  );

  ui.planExpanded = true;
  let upperPanelPaints = 0;
  ui.repaintComposerUpperPanel = () => { upperPanelPaints += 1; };
  ui.handleRawKeypress(session, "j", { name: "j" }, () => {});
  assert.equal(ui.inlinePicker.index, 2, "quickselect keeps priority over a hidden Plan drawer");
  assert.equal(ui.planExpanded, true);
  assert.equal(upperPanelPaints, 1, "quickselect navigation repaints only the upper panel");
  ui.planExpanded = false;
  ui.inlinePicker.index = 1;

  // Keys: full capture — vim navigation, number-pick, swallowed printables.
  ui.handleInlinePickerKey(session, "j", { name: "j" });
  assert.equal(ui.inlinePicker.index, 2, "j moves down");
  ui.handleInlinePickerKey(session, "k", { name: "k" });
  assert.equal(ui.inlinePicker.index, 1, "k moves up");
  assert.equal(ui.handleInlinePickerKey(session, "x", { name: "x" }), true, "printables swallowed");
  assert.ok(ui.inlinePicker, "picker stays open on stray keys");
  assert.equal(session.line, "", "nothing leaks into the input");
  assert.equal(ui.handleInlinePickerKey(session, "1", { name: "1" }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, { id: "model", value: "gpt-5.5" }, "number applies that option");
  assert.equal(ui.inlinePicker, null, "picker closes after apply");
  assert.equal(ui.rawInputLayout(session).upperPanelKind, "queue", "queue returns after selection");

  // Esc and h close without applying.
  assert.equal(ui.maybeOpenInlinePicker({ ...session, line: "/model" }), true);
  assert.equal(ui.handleInlinePickerKey(session, "", { name: "escape" }), true);
  assert.equal(ui.inlinePicker, null);
  assert.equal(ui.maybeOpenInlinePicker({ ...session, line: "/model" }), true);
  assert.equal(ui.handleInlinePickerKey(session, "h", { name: "h" }), true, "h backs out");
  assert.equal(ui.inlinePicker, null);

  // quickSelect routes through the inline picker while the composer is live.
  ui.pickerSupported = () => true;
  ui.lastRawScrollBottom = 20;
  const quick = ui.quickSelect({
    title: "Mode",
    items: [
      { label: "read-only", value: "read-only" },
      { label: "auto", value: "auto", current: true },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ui.inlinePicker, "quickSelect opened inline");
  assert.equal(ui.inlinePicker.index, 1, "current value preselected");
  ui.handleInlinePickerKey(session, "l", { name: "l" });
  assert.equal(await quick, "auto", "l resolves the awaited quickSelect");
}

// A live ACP permission replaces any transient upper-panel menu without
// finishing the composer. Draft text/cursor stay intact; Esc restores the
// covered queue, and a later explicit reopen can answer the same request.
{
  const ui = makeUi();
  const calls = [];
  let paints = 0;
  let displaced = "not resolved";
  let finishes = 0;
  ui.pickerSupported = () => true;
  ui.canPaintPinned = () => true;
  ui.canHostInlinePicker = () => true;
  ui.renderRawInput = () => { paints += 1; };
  ui.hub = {
    call: async (method, params) => {
      calls.push({ method, params });
      return { chat: { ...ui.currentChat, status: "responding" } };
    },
  };
  ui.currentChat.queued = 1;
  ui.currentChat.queuedRequests = [
    { id: "q1", kind: "prompt", preview: "queued while blocked", position: 1 },
  ];
  ui.pendingPermission = {
    permissionId: "perm-inline",
    toolCall: { title: "Edit workspace", kind: "edit" },
    options: [
      { optionId: "once", name: "Allow Once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
  ui.autoShownPermissionId = null;
  const draft = {
    ...session("texto sin enviar"),
    draftKey: "chat:c1",
    done: false,
    finish: () => { finishes += 1; },
  };
  ui.rawInput = draft;
  ui.composerFooterExpansion = { control: "model", offset: 0 };
  ui.inlinePicker = {
    title: "Model",
    hint: "",
    items: [{ label: "old", value: "old" }],
    index: 0,
    purpose: "quickselect",
    requestId: "",
    resolve: (value) => { displaced = value; },
  };

  assert.equal(ui.maybeOpenPermissionPanel(), true);
  assert.equal(ui.composerFooterExpansion, null, "blocking authority closes footer groups");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(displaced, null, "permission displaces the previous menu without applying it");
  assert.equal(finishes, 0, "composer is never resolved or recreated");
  assert.equal(draft.line, "texto sin enviar");
  assert.equal(draft.cursor, "texto sin enviar".length);
  assert.equal(ui.inlinePicker?.purpose, "permission");
  assert.equal(ui.inlinePicker?.requestId, "perm-inline");
  assert.match(strip(ui.inlinePicker?.title), /Permission.*Edit workspace/);
  assert.equal(ui.rawInputLayout(draft).upperPanelKind, "quickselect");
  assert.equal(paints, 1, "replacement is painted as one upper-panel frame");

  ui.handleInlinePickerKey(draft, "", { name: "escape" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.pendingPermission?.permissionId, "perm-inline", "Esc keeps authority pending");
  assert.equal(ui.rawInputLayout(draft).upperPanelKind, "queue", "covered queue returns after Esc");

  assert.equal(ui.maybeOpenPermissionPanel({ force: true }), true);
  await new Promise((resolve) => setImmediate(resolve));
  const paintsBeforeDecision = paints;
  ui.handleInlinePickerKey(draft, "1", { name: "1" });
  assert.equal(
    paints,
    paintsBeforeDecision,
    "selection does not flash Plan/queue before the authority is accepted",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    method: "permission_response",
    params: { permissionId: "perm-inline", optionId: "once" },
  }]);
  assert.equal(ui.pendingPermission, null);
  assert.equal(ui.inlinePicker, null);
  assert.equal(ui.rawInputLayout(draft).upperPanelKind, "queue");
}

// A failed session restore owns the same shared shelf, keeps the draft alive,
// and performs only the recovery action the user explicitly selects.
{
  const ui = makeUi();
  const calls = [];
  const applied = [];
  ui.currentChat = {
    ...ui.currentChat,
    status: "error",
    sessionId: "saved-session",
    restoreFailure: {
      kind: "restore",
      sessionId: "saved-session",
      message: "Internal error",
      attemptedAt: "2026-07-21T12:00:00.000Z",
    },
  };
  ui.rawInput = {
    ...session("draft intact"),
    draftKey: "chat:c1",
    done: false,
  };
  ui.inlinePicker = null;
  ui.autoShownRestoreFailureKey = null;
  ui.pickerSupported = () => true;
  ui.canPaintPinned = () => true;
  ui.canHostInlinePicker = () => true;
  ui.renderRawInput = () => {};
  ui.applyRestoreRecoveryResult = (result) => applied.push(result);
  ui.notify = () => {};
  ui.hub = {
    call: async (method, params) => {
      calls.push({ method, params });
      return { chat: { ...ui.currentChat, restoreFailure: null }, history: [] };
    },
  };

  assert.equal(ui.maybeOpenRestoreRecoveryPanel(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.inlinePicker?.purpose, "restore-recovery");
  assert.match(strip(ui.inlinePicker?.title), /Restore failed.*Internal error/);
  assert.equal(ui.rawInput.line, "draft intact");
  ui.handleInlinePickerKey(ui.rawInput, "1", { name: "1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ method: "retry_restore", params: { chatId: "c1" } }]);
  assert.equal(applied.length, 1);

  calls.length = 0;
  applied.length = 0;
  ui.currentChat.restoreFailure = {
    kind: "restore",
    sessionId: "saved-session",
    message: "Internal error",
    attemptedAt: "2026-07-21T12:00:01.000Z",
  };
  ui.autoShownRestoreFailureKey = null;
  assert.equal(ui.maybeOpenRestoreRecoveryPanel(), true);
  await new Promise((resolve) => setImmediate(resolve));
  ui.inlinePicker.index = 1;
  ui.handleInlinePickerKey(ui.rawInput, "", { name: "enter" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ method: "recover_chat_fresh", params: { chatId: "c1" } }]);
  assert.equal(applied.length, 1);
  assert.match(ui.inputHint("draft intact"), /restore failed.*Enter recovery choices/);
}

// Adapter maintenance uses the same non-modal shelf as Plan/queue. Its phase
// survives ordinary composer repaints, while typed autocomplete may cover it
// temporarily without discarding the operation.
{
  const ui = makeUi();
  ui.hubOperation = {
    id: "adapter-op-1",
    action: "update",
    provider: "claude",
    providerLabel: "Claude ACP",
    status: "running",
    phase: "handshake",
    fromVersion: "0.59.0",
    version: "0.60.0",
    result: null,
  };
  ui.rawInput = { ...session(""), done: false };
  const layout = ui.rawInputLayout(ui.rawInput);
  assert.equal(layout.upperPanelKind, "hub-operation");
  assert.equal(layout.planRows, 0);
  assert.equal(layout.queueRows, 0);
  assert.ok(layout.dropdownRows >= 3);
  assert.match(ui.inputHint(""), /maintenance continues.*input remains active/);
  assert.doesNotThrow(() => ui.composerNonTitleSignature());

  const paints = [];
  const painter = {
    to(column, row) { paints.push(["to", column, row]); return this; },
    clearLine() { return this; },
    text(value) { paints.push(["text", strip(value)]); return this; },
  };
  ui.paintHubOperationSection(painter, layout, layout.columns - 1);
  const text = paints.filter(([kind]) => kind === "text").map(([, value]) => value).join("\n");
  assert.match(text, /Claude ACP · Updating/);
  assert.match(text, /Testing ACP handshake/);
  assert.match(text, /0\.59\.0 → 0\.60\.0/);

  const typing = { ...session("/mo"), done: false };
  ui.rawInput = typing;
  const autocompleteLayout = ui.rawInputLayout(typing);
  assert.equal(autocompleteLayout.upperPanelKind, "autocomplete");
  assert.equal(ui.hubOperation.id, "adapter-op-1", "covered operation remains recoverable");
}

console.log("composer-layout test passed");
