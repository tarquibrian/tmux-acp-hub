#!/usr/bin/env node
// Unit tests for the composer autocomplete dropdown: derivation, cycling,
// accept/submit rules, Esc suppression, and layout integration.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;

const { PopupUi } = await import("../bin/acp-hub.mjs");
const stripAnsi = (value) => String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo/demo",
    currentChat: { id: "c1", provider: "codex", status: "idle", cwd: "/repo/demo" },
    config: {
      agents: {
        codex: {
          command: "npx",
          args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
        },
        claude: {
          command: "npx",
          args: ["-y", "@agentclientprotocol/claude-agent-acp@0.59.0"],
        },
      },
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
    inputHistory: [],
    renderRawInput: () => {},
    saveRawDraft: () => {},
  });
  return ui;
}

const session = (line, cursor = line.length) => ({
  pinned: true,
  line,
  cursor,
  autocompleteIndex: 0,
  autocompleteKey: "",
  autocompleteSuppressedKey: "",
});

// --- Derivation -----------------------------------------------------------------
{
  const ui = makeUi();
  const dropdown = ui.activeAutocomplete(session("/mo"));
  assert.ok(dropdown, "slash prefix opens the dropdown");
  assert.equal(dropdown.kind, "command");
  assert.ok(dropdown.matches.length >= 2, "matches /model /modes /mode");
  assert.ok(dropdown.matches.every((m) => m.name.startsWith("/mo")));
}
{
  const ui = makeUi();
  assert.equal(ui.activeAutocomplete(session("//raw")), null, "// bypasses the dropdown");
  assert.equal(ui.activeAutocomplete(session("")), null, "empty line has no dropdown");
  assert.equal(ui.activeAutocomplete(session("/model x")), null, "hidden after the command word");
  assert.equal(ui.activeAutocomplete(session("plain text")), null);
}
{
  const ui = makeUi();
  const dropdown = ui.activeAutocomplete(session("/mode"));
  assert.ok(dropdown, "prefix of longer commands still shows the dropdown");
  assert.equal(dropdown.matches[0].name, "/mode", "exact match sorts first");
}
{
  const ui = makeUi();
  const actions = ui.activeAutocomplete(session("/hub "));
  assert.equal(actions.kind, "subcommand", "/hub arguments use contextual autocomplete");
  assert.deepEqual(
    actions.matches.map((entry) => entry.name),
    ["versions", "updates", "update", "rollback"],
  );

  const update = session("/hub update");
  const updateDropdown = ui.activeAutocomplete(update);
  assert.equal(updateDropdown.matches[0].name, "update", "exact action prefix sorts first");
  assert.ok(ui.handleAutocompleteKey(update, "", { name: "tab" }));
  assert.equal(update.line, "/hub update ", "actions that need an agent advance to level three");

  const provider = session("/hub update c");
  assert.equal(ui.activeAutocomplete(provider).matches[0].name, "codex");
  assert.ok(ui.handleAutocompleteKey(provider, "", { name: "tab" }));
  assert.equal(provider.line, "/hub update codex", "provider completion finishes the command");

  const rollback = ui.activeAutocomplete(session("/hub rollback "));
  assert.ok(rollback.matches.some((entry) => entry.name === "codex"));
  assert.equal(
    rollback.matches.some((entry) => entry.name === "all"),
    false,
    "rollback never advertises the update-only all target",
  );
}
{
  const ui = makeUi();
  const actions = ui.activeAutocomplete(session("/mcp "));
  assert.equal(actions.kind, "subcommand", "/mcp exposes its administrative actions");
  assert.ok(actions.matches.some((entry) => entry.name === "diagnostics"));
  assert.ok(actions.matches.some((entry) => entry.name === "add"));

  const add = session("/mcp add");
  assert.ok(ui.handleAutocompleteKey(add, "", { name: "tab" }));
  assert.equal(add.line, "/mcp add ");

  const transport = ui.activeAutocomplete(session("/mcp add filesystem "));
  assert.deepEqual(
    transport.matches.slice(0, 3).map((entry) => entry.name),
    ["stdio", "http", "sse"],
  );

  const scope = ui.activeAutocomplete(
    session("/mcp add filesystem stdio node --scope pro"),
  );
  assert.equal(scope.matches[0].name, "project");

  ui.mcpInventory = {
    entries: [
      { name: "docs server", source: "managed", transport: "stdio", status: "pending" },
      { name: "static-only", source: "static", transport: "stdio", status: "applied" },
    ],
  };
  const managed = session("/mcp disable doc");
  assert.equal(ui.activeAutocomplete(managed).matches[0].name, "docs server");
  assert.ok(ui.handleAutocompleteKey(managed, "", { name: "tab" }));
  assert.equal(managed.line, "/mcp disable 'docs server'");
  assert.equal(
    ui.activeAutocomplete(session("/mcp disable static")),
    null,
    "mutating actions never suggest read-only static entries",
  );
}
{
  const ui = makeUi();
  ui.fileMentionMatches = () => ["src/app.ts", "src/api.ts"];
  const dropdown = ui.activeAutocomplete(session("see @ap"));
  assert.ok(dropdown, "@query opens the mention dropdown");
  assert.equal(dropdown.kind, "mention");
  assert.equal(dropdown.matches[0].name, "@src/app.ts");
}

// --- Cycling + accept ------------------------------------------------------------
{
  const ui = makeUi();
  const s = session("/mo");
  const first = ui.activeAutocomplete(s);
  const count = first.matches.length;

  assert.ok(ui.handleAutocompleteKey(s, "", { name: "down" }), "down cycles");
  assert.equal(ui.activeAutocomplete(s).index, 1 % count);
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "up" }), "up cycles back");
  assert.equal(ui.activeAutocomplete(s).index, 0);
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "n", ctrl: true }), "ctrl+n cycles down");
  assert.equal(ui.activeAutocomplete(s).index, 1 % count);
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "p", ctrl: true }), "ctrl+p cycles up");
  assert.equal(ui.activeAutocomplete(s).index, 0);

  assert.ok(ui.handleAutocompleteKey(s, "", { name: "return" }), "enter accepts a completion");
  assert.match(s.line, /^\/\w+ $/, "line replaced with command + trailing space");
  assert.equal(s.cursor, s.line.length);
}
{
  const ui = makeUi();
  const s = session("/mode");
  assert.equal(
    ui.handleAutocompleteKey(s, "", { name: "return" }),
    false,
    "enter on an exactly-typed command falls through to submit",
  );
  assert.equal(s.line, "/mode", "line untouched");
}
{
  const ui = makeUi();
  ui.fileMentionMatches = () => ["src/app.ts"];
  const s = session("see @ap");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "return" }), "enter accepts the mention");
  assert.equal(s.line, "see @src/app.ts");
}
{
  const ui = makeUi();
  const s = session("/he");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "right" }), "right at EOL accepts");
  assert.match(s.line, /^\/help /);
}
{
  const ui = makeUi();
  const s = session("/mo");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "tab" }), "tab completes the selection");
  assert.match(s.line, /^\/\w+ $/, "tab replaced the line with the completion");
  assert.equal(s.cursor, s.line.length);
}

// --- Esc suppression --------------------------------------------------------------
{
  const ui = makeUi();
  const s = session("/mo");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "escape" }), "esc dismisses");
  assert.equal(ui.activeAutocomplete(s), null, "suppressed for the same input");
  s.line = "/mod";
  assert.ok(ui.activeAutocomplete(s), "typing re-opens the dropdown");
}

// Selection-only navigation uses the small upper-panel repaint path. It must
// not ask the full composer/transcript frame to redraw on every arrow press.
{
  const ui = makeUi();
  const s = session("/mo");
  let upperPanelPaints = 0;
  let fullPaints = 0;
  ui.repaintComposerUpperPanel = () => { upperPanelPaints += 1; };
  ui.renderRawInput = () => { fullPaints += 1; };
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "down" }));
  assert.equal(upperPanelPaints, 1);
  assert.equal(fullPaints, 0, "selection does not repaint the complete composer");
}

// --- Layout integration ------------------------------------------------------------
{
  const ui = makeUi();
  const s = session("/mo");
  const plainSession = session("hello");
  ui.rawInput = plainSession;
  const plain = ui.rawInputLayout(plainSession);
  ui.rawInput = s;
  const layout = ui.rawInputLayout(s);
  assert.ok(layout.dropdownRows >= 2, "dropdown rows reserved");
  assert.equal(layout.upperPanelKind, "autocomplete");
  assert.equal(layout.dropdownPadRow, layout.upperPanelRow);
  assert.equal(layout.dropdownPadRow, layout.headerRow + 1, "one blank row follows the smart header");
  assert.equal(layout.dropdownRow, layout.headerRow + 2, "suggestions start after the top gap");
  assert.equal(layout.upperPanelRows, layout.dropdownRows + 1);
  assert.ok(layout.dropdownRow < layout.headerGapRow);
  assert.ok(layout.headerGapRow < layout.cardTopRow, "suggestions remain above the card");
  assert.equal(
    layout.footerRow,
    layout.cardBottomRow,
    "card metadata remains visible while the dropdown is open",
  );
  assert.equal(layout.hintRows, plain.hintRows, "external hint keeps its fixed row");
  assert.match(ui.inputHint(s.line), /Ctrl\+N\/Ctrl\+P select/);
  assert.ok(layout.composerRows.includes(layout.dropdownPadRow));
  for (const key of [
    "cardTopRow",
    "inputRow",
    "cardMetaGapRow",
    "footerRow",
    "cardBottomRow",
    "infoGapTopRow",
    "hintRow",
    "infoGapBottomRow",
  ]) {
    assert.equal(layout[key], plain[key], `${key} is stable while suggestions are open`);
  }
  assert.ok(layout.composerRows.includes(layout.dropdownRow), "dropdown rows cleared on change");

  const paints = [];
  const painter = {
    to(column, row) { paints.push(["to", column, row]); return this; },
    clearLine() { return this; },
    text(value) { paints.push(["text", stripAnsi(value)]); return this; },
  };
  ui.paintAutocompleteDropdown(painter, layout, layout.columns - 1);
  const firstSuggestion = paints.find(([kind]) => kind === "text")?.[1] || "";
  assert.match(firstSuggestion, /^ {3}❯ /, "suggestions share the three-cell header inset");

  assert.equal(plain.dropdownRows, 0);
  assert.equal(plain.footerRow, plain.cardBottomRow, "metadata stays in the card");

  const signatureBefore = ui.composerNonTitleSignature();
  s.autocompleteIndex = Math.min(1, ui.activeAutocomplete(s).matches.length - 1);
  assert.notEqual(
    ui.composerNonTitleSignature(),
    signatureBefore,
    "selection changes participate in differential repaint state",
  );
}

// Dismissing suggestions on an unchanged draft releases only the upper shelf;
// every fixed card/info coordinate remains identical.
{
  const ui = makeUi();
  const s = session("/mo");
  ui.rawInput = s;
  const open = ui.rawInputLayout(s);
  s.autocompleteSuppressedKey = ui.activeAutocomplete(s).key;
  const closed = ui.rawInputLayout(s);
  assert.equal(closed.upperPanelKind, null);
  assert.equal(closed.dropdownRows, 0);
  for (const key of [
    "cardTopRow",
    "inputRow",
    "cardMetaGapRow",
    "footerRow",
    "cardBottomRow",
    "infoGapTopRow",
    "hintRow",
    "infoGapBottomRow",
  ]) {
    assert.equal(closed[key], open[key], `${key} stays fixed when suggestions close`);
  }
}

// Enhanced suggestions gracefully fall back to the classic completion path on
// short popups; they never steal the card's minimum geometry.
{
  const ui = makeUi();
  const s = session("/mo");
  ui.rawInput = s;
  process.stdout.rows = 14;
  const layout = ui.rawInputLayout(s);
  assert.equal(layout.dropdownRows, 0);
  assert.equal(layout.upperPanelKind, null);
  process.stdout.rows = 30;
}

// @file results live only in the upper panel; the stable hint row teaches
// controls instead of duplicating paths below the card.
{
  const ui = makeUi();
  ui.fileMentionMatches = () => ["src/app.ts", "src/api.ts"];
  const s = session("review @src/a");
  ui.rawInput = s;
  assert.ok(ui.activeAutocomplete(s));
  const hint = ui.inputHint(s.line);
  assert.match(hint, /select/);
  assert.doesNotMatch(hint, /src\/app\.ts|src\/api\.ts/);
}

// A visible autocomplete panel has input priority over a previously expanded
// Plan. Ctrl+P travels suggestions and must not collapse/move the Plan state.
{
  const ui = makeUi();
  const s = session("/mo");
  ui.rawInput = s;
  ui.planExpanded = true;
  ui.planBandAllocation = () => ({ planRows: 3, gapRows: 0 });
  const covered = ui.rawInputLayout(s);
  assert.equal(covered.upperPanelKind, "autocomplete");
  assert.equal(covered.planRows, 0);
  const count = ui.activeAutocomplete(s).matches.length;
  ui.handleRawKeypress(s, "", { name: "p", ctrl: true }, () => {});
  assert.equal(s.autocompleteIndex, (count - 1 + count) % count);
  assert.equal(ui.planExpanded, true, "hidden Plan drawer state is preserved");
  s.line = "plain";
  s.cursor = s.line.length;
  const restored = ui.rawInputLayout(s);
  assert.equal(restored.upperPanelKind, "plan", "Plan drawer returns after suggestions close");
  assert.equal(restored.planRows, 3);
}

// Vim keeps its modal Esc contract while closing the visible suggestion panel
// in the same transition.
{
  const ui = makeUi();
  const s = {
    ...session("/mo"),
    draftKey: "chat:c1",
    vimMode: "insert",
    vimOp: "",
    vimCount: "",
    vimFind: "",
    vimReplace: false,
    vimGPending: false,
  };
  ui.rawInput = s;
  ui.vimEnabled = true;
  ui.refreshRawInputPrompt = () => {};
  ui.handleRawKeypress(s, "", { name: "escape" }, () => {});
  assert.equal(s.vimMode, "normal");
  assert.equal(ui.activeAutocomplete(s), null, "the same Esc dismisses suggestions");
}

// The recovery command is discoverable from the composer.
{
  const ui = makeUi();
  const names = ui.chatCommands().map((entry) => entry.name);
  assert.ok(names.includes("/restart"), "/restart is in the command list");
}

// /hub opens the same inline-menu system as model/mode, then narrows rollback
// providers to adapters that actually have a verified previous version.
{
  const ui = makeUi();
  const spec = ui.inlinePickerSpecFor("/hub");
  assert.equal(spec.title, "Hub adapters");
  assert.deepEqual(spec.items.map((item) => item.value), ["versions", "updates", "update", "rollback"]);

  let pickerItems = null;
  let command = "";
  ui.hub = {
    call: async () => ({
      providers: [
        {
          provider: "codex",
          label: "Codex ACP",
          managed: true,
          configuredVersion: "1.1.4",
          activeVersion: "1.1.5",
          previousVersion: "1.1.4",
        },
        {
          provider: "claude",
          label: "Claude ACP",
          managed: true,
          configuredVersion: "0.59.0",
          activeVersion: "0.60.0",
          previousVersion: null,
        },
      ],
    }),
  };
  ui.quickSelect = async ({ items }) => {
    pickerItems = items;
    return "codex";
  };
  ui.confirmHubPickerAction = async (action, provider) => { command = `${action} ${provider}`; };
  assert.equal(await ui.showHubProviderPicker("rollback"), true);
  assert.deepEqual(pickerItems.map((item) => item.value), ["codex"]);
  assert.equal(command, "rollback codex");
}

// Picker-driven mutations confirm inside the picker stack instead of opening
// a nested text question over the still-live composer.
{
  const ui = makeUi();
  let dispatched = null;
  ui.quickSelect = async ({ items }) => {
    assert.equal(items[0].value, "cancel");
    assert.equal(items[0].current, true, "safe cancellation is selected by default");
    return "confirm";
  };
  ui.handleHubVersionCommand = async (command, options) => {
    dispatched = { command, options };
  };
  assert.equal(await ui.confirmHubPickerAction("update", "codex"), true);
  assert.deepEqual(dispatched, {
    command: "update codex",
    options: { confirmed: true, pickerFlow: true },
  });
}

// A fully typed mutation also becomes an inline confirmation. It never falls
// through to the old raw y/N question where subsequent slash commands could
// be consumed as answers.
{
  const ui = makeUi();
  const spec = ui.inlinePickerSpecFor("/hub update claude");
  assert.equal(spec.title, "Confirm update · claude");
  assert.deepEqual(spec.items.map((item) => item.value), ["cancel", "confirm"]);
  let dispatched = null;
  ui.handleHubVersionCommand = async (command, options) => {
    dispatched = { command, options };
  };
  assert.equal(await spec.apply("confirm"), true);
  assert.deepEqual(dispatched, {
    command: "update claude",
    options: { confirmed: true, pickerFlow: true },
  });
}

// Confirmation starts background daemon work and retains its operation model;
// it does not await installation or ask for another textual confirmation.
{
  const ui = makeUi();
  const operation = {
    id: "adapter-1",
    action: "update",
    provider: "claude",
    status: "running",
    phase: "checking",
  };
  const calls = [];
  ui.hub = {
    call: async (method, params) => {
      calls.push([method, params]);
      return { operation };
    },
  };
  ui.setHubOperation = (value) => { ui.hubOperation = value; };
  await ui.handleHubVersionCommand("update claude", { confirmed: true });
  assert.deepEqual(calls, [["adapter_update_start", { provider: "claude", force: true }]]);
  assert.equal(ui.hubOperation, operation);
}

// Operation events replace transient progress notices, and an empty Enter on a
// settled result opens actions without resolving or clearing the composer.
{
  const ui = makeUi();
  let notices = 0;
  let actions = 0;
  let finishes = 0;
  ui.closed = false;
  ui.notify = () => { notices += 1; };
  ui.setHubOperation = (value) => { ui.hubOperation = value; };
  const operation = {
    id: "adapter-3",
    action: "update",
    provider: "claude",
    status: "succeeded",
    phase: "staged",
    result: { requiresRestart: true, items: [] },
  };
  ui.handleHubEvent({ type: "adapter_operation", operation });
  assert.equal(ui.hubOperation, operation);
  ui.handleHubEvent({
    type: "adapter_update_progress",
    update: { provider: "claude", phase: "ready", version: "0.60.0" },
  });
  assert.equal(notices, 0, "legacy progress does not overwrite the durable shelf");

  const draft = session("");
  ui.rawInput = draft;
  ui.showHubOperationActions = async () => { actions += 1; return true; };
  ui.handleRawKeypress(draft, "", { name: "enter" }, () => { finishes += 1; });
  assert.equal(actions, 1);
  assert.equal(finishes, 0);
}
{
  const ui = makeUi();
  let title = "";
  let notice = "";
  ui.hubOperation = {
    id: "adapter-2",
    action: "update",
    provider: "claude",
    providerLabel: "Claude ACP",
    status: "succeeded",
    phase: "staged",
    result: { requiresRestart: true, busyChats: [], items: [] },
  };
  ui.pickerSupported = () => true;
  ui.canPaintPinned = () => true;
  ui.quickSelect = async (config) => {
    title = config.title;
    assert.equal(config.items[0].value, "later");
    assert.equal(config.items[0].current, true);
    return "later";
  };
  ui.acknowledgeHubOperation = async () => true;
  ui.notify = (value) => { notice = value; };
  assert.equal(await ui.showHubOperationActions(), true);
  assert.match(title, /activate with restart/);
  assert.match(notice, /\/restart activates/);
}

// Version output has a header, labelled rows, and blank separation between
// providers instead of concatenating help and state into one dense block.
{
  const ui = makeUi();
  const lines = [];
  ui.logLine = (line = "") => lines.push(stripAnsi(line));
  ui.printHubVersions({
    settings: { channel: "stable" },
    providers: [
      {
        provider: "codex",
        label: "Codex ACP",
        managed: true,
        state: "not_prepared",
        package: "@agentclientprotocol/codex-acp",
        configuredVersion: "1.1.4",
        installed: [],
        globalCli: { command: "codex", version: "0.144.4", path: "/bin/codex" },
      },
      {
        provider: "claude",
        label: "Claude ACP",
        managed: true,
        state: "pending",
        package: "@agentclientprotocol/claude-agent-acp",
        configuredVersion: "0.59.0",
        pendingVersion: "0.60.0",
        installed: [{ version: "0.60.0", dependencies: {} }],
      },
    ],
  });
  assert.equal(lines[0], "");
  assert.equal(lines[1], "Adapter versions");
  assert.ok(lines.some((line) => /package\s+@agentclientprotocol\/codex-acp/.test(line)));
  assert.ok(lines.some((line) => /active\s+.*npx fallback/.test(line)));
  assert.ok(lines.some((line) => line.includes("Codex ACP") && line.includes("npx fallback")));
  assert.ok(lines.some((line) => line.includes("/hub update codex")));
  const claudeHeading = lines.findIndex((line) => line.includes("Claude ACP"));
  assert.equal(lines[claudeHeading - 1], "", "providers are separated by a blank row");
}

// Update checks lead with an adaptive current/new comparison and retain exact
// remediation commands for fallback, update, and pending states.
{
  const ui = makeUi();
  const lines = [];
  ui.logLine = (line = "") => lines.push(stripAnsi(line));
  ui.printHubVersions({
    settings: { channel: "stable" },
    providers: [
      {
        provider: "codex",
        label: "Codex ACP",
        managed: true,
        state: "outdated",
        package: "@agentclientprotocol/codex-acp",
        configuredVersion: "1.1.4",
        activeVersion: "1.1.4",
        availableVersion: "1.2.0",
        updateAvailable: true,
        installed: [],
      },
      {
        provider: "claude",
        label: "Claude ACP",
        managed: true,
        state: "not_prepared",
        package: "@agentclientprotocol/claude-agent-acp",
        configuredVersion: "0.59.0",
        availableVersion: "0.59.0",
        updateAvailable: false,
        installed: [],
      },
    ],
  }, { title: "Adapter updates", checked: true });
  const output = lines.join("\n");
  assert.match(output, /Adapter\s+Current\s+New\s+Status/);
  assert.match(output, /Codex ACP\s+1\.1\.4\s+1\.2\.0\s+Update/);
  assert.match(output, /Claude ACP\s+0\.59\.0 \(npx\)\s+0\.59\.0\s+Prepare/);
  assert.match(output, /\/hub update codex/);
  assert.match(output, /\/hub update claude/);
  assert.doesNotMatch(output, /not prepared/);
}

// Edge-state matrix: deprecated candidates block restart guidance, registry
// downgrades are never presented as New, and the table fits inside transcript
// padding on narrow terminals.
{
  const ui = makeUi();
  ui.transcriptPadding = 1;
  const deprecatedPending = {
    provider: "codex",
    label: "Codex ACP",
    managed: true,
    configuredVersion: "1.1.4",
    activeVersion: "1.1.4",
    pendingVersion: "1.2.0",
    availableVersion: "1.2.0",
    deprecated: "package retired",
  };
  assert.deepEqual(ui.hubDisplayState(deprecatedPending), { label: "deprecated", color: "red" });
  const deprecatedGuide = ui.hubGuidanceEntries([deprecatedPending]);
  assert.equal(deprecatedGuide[0].command, undefined);
  assert.match(deprecatedGuide[0].text, /Do not activate pending 1\.2\.0/);
  assert.match(stripAnsi(ui.hubUpdateComparisonTable([deprecatedPending])), /Review/);

  const registryLower = {
    provider: "codex",
    label: "Codex ACP",
    managed: true,
    configuredVersion: "2.0.0",
    activeVersion: "2.0.0",
    availableVersion: "1.9.0",
    updateAvailable: false,
  };
  const lowerTable = stripAnsi(ui.hubUpdateComparisonTable([registryLower]));
  assert.match(lowerTable, /Codex ACP\s+2\.0\.0\s+2\.0\.0\s+Current/);
  assert.doesNotMatch(lowerTable, /1\.9\.0/);

  const previousColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
  try {
    const contentWidth = ui.transcriptContentWidth();
    const narrow = stripAnsi(ui.hubUpdateComparisonTable([
      registryLower,
      { ...registryLower, provider: "claude", label: "Claude Agent ACP" },
    ])).split("\n");
    assert.ok(
      narrow.every((line) => line.length <= contentWidth),
      "comparison table respects the padded transcript content width",
    );
  } finally {
    Object.defineProperty(process.stdout, "columns", { value: previousColumns, configurable: true });
  }
}

// Deprecation is an independent review condition, not a fake newer release.
{
  const ui = makeUi();
  const lines = [];
  ui.logLine = (line = "") => lines.push(stripAnsi(line));
  ui.printHubVersions({
    settings: { channel: "stable" },
    providers: [{
      provider: "codex",
      label: "Codex ACP",
      managed: true,
      configuredVersion: "1.1.4",
      activeVersion: "1.1.4",
      availableVersion: "1.1.4",
      updateAvailable: false,
      deprecated: "package retired",
    }],
  }, { title: "Adapter updates", checked: true });
  const output = lines.join("\n");
  assert.match(output, /No newer adapter release found/);
  assert.match(output, /1 deprecated adapter requires review/);
  assert.doesNotMatch(output, /update available/);
}

// ACP commands join the same autocomplete model. Hub collisions keep the
// local spelling and advertise the explicit // provider escape.
{
  const ui = makeUi();
  ui.currentChat.availableCommands = [
    { name: "status", description: "Show status", input: { hint: "[section]" } },
    { name: "plan", description: "Provider plan" },
    { name: "mcp", description: "Provider MCP status" },
    { name: "$review", description: "Review skill" },
    { name: "review", description: "Review target", aliases: ["inspect"], input: { hint: "<target>" } },
  ];
  const commands = ui.chatCommands();
  assert.ok(commands.some((command) => command.name === "/status" && command.origin === "provider"));
  assert.ok(commands.some((command) => command.name === "//plan" && command.origin === "provider"));
  assert.ok(commands.some((command) => command.name === "//mcp" && command.origin === "provider"));
  assert.ok(commands.some((command) => command.name === "/$review" && command.origin === "skill"));
  assert.equal(ui.activeAutocomplete(session("/sta")).matches[0].name, "/status");
  assert.equal(ui.activeAutocomplete(session("/STA")).matches[0].name, "/status");
  assert.equal(ui.activeAutocomplete(session("//pl")).matches[0].name, "//plan");
  assert.equal(ui.activeAutocomplete(session("/ins")).matches[0].name, "/inspect");
  assert.match(ui.inputHint("/status"), /\[section\]/);
  assert.match(ui.inputHint("/inspect"), /Alias for \/review/);

  const pickerItems = ui.commandPickerItems();
  const reviewItem = pickerItems.find((item) => item.value === "/review ");
  assert.match(reviewItem.searchText, /\/inspect/, "aliases are searchable in the palette");
  assert.equal(
    pickerItems.some((item) => item.value === "/inspect "),
    false,
    "aliases do not duplicate canonical palette rows",
  );
}

// Hub ownership is case-insensitive, so a casing variation cannot fall through
// to a colliding provider command. Double slash remains the explicit escape.
{
  const ui = makeUi();
  assert.equal(ui.hubCommandForToken("/Plan").name, "/plan");
  assert.equal(ui.hubCommandForToken("//Plan"), null);
}

// An already-open command palette follows ACP available_commands_update state
// instead of remaining a stale snapshot until it is reopened.
{
  const ui = makeUi();
  ui.currentChat.availableCommands = [{ name: "status" }];
  ui.pickerSupported = () => true;
  ui.canPaintPinned = () => true;
  let pickerConfig = null;
  ui.interactivePick = async (config) => {
    pickerConfig = config;
    return null;
  };

  assert.equal(await ui.showProviderCommandsPicker(), true);
  let replaced = null;
  pickerConfig.onEvent(
    {
      type: "chat_state",
      chat: {
        ...ui.currentChat,
        availableCommands: [{ name: "status" }, { name: "usage", aliases: ["tokens"] }],
      },
    },
    { replaceItems: (items) => { replaced = items; } },
  );
  assert.ok(replaced.some((item) => item.value === "/usage"));
  assert.match(
    replaced.find((item) => item.value === "/usage").searchText,
    /\/tokens/,
  );
}

// The auxiliary tmux menu is deliberately bounded; the searchable in-popup
// palette remains the complete command surface.
{
  const ui = makeUi();
  ui.currentChat.availableCommands = Array.from({ length: 30 }, (_, index) => ({
    name: `provider-${index + 1}`,
  }));
  ui.tmuxInsertCommand = (text) => text;
  let shownItems = null;
  ui.showTmuxMenu = (_title, items) => {
    shownItems = items;
    return true;
  };
  assert.equal(ui.showProviderCommandsPanel(), true);
  assert.equal(shownItems.filter((item) => item.command).length, 24);
  assert.ok(shownItems.some((item) => /Showing 24 of 30/.test(item.label || "")));
}

console.log("autocomplete test passed");
