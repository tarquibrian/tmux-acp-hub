#!/usr/bin/env node
// Unit tests for the interactive picker's pure logic: fzf-style filtering and
// header-skipping selection movement, plus the menu item builder.
import assert from "node:assert/strict";
import {
  PopupUi,
  pickerFilterEntries,
  pickerNextIndex,
  formatRelativeAge,
  formatChatPreview,
} from "../bin/acp-hub.mjs";
import { HubDaemon } from "../lib/daemon.mjs";

const strip = (value) => String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

const entries = [
  { label: "Project A", disabled: true },
  { label: "codex idle Fix auth flow", searchText: "codex myproj Fix auth flow idle" },
  { label: "claude responding Refactor", searchText: "claude myproj Refactor tables responding" },
  { label: "New chat", disabled: true },
  { label: "+ New Codex chat", searchText: "new codex Codex ACP" },
  { label: "+ New Claude chat", searchText: "new claude Claude ACP" },
];

// --- pickerFilterEntries ------------------------------------------------------
assert.equal(pickerFilterEntries(entries, ""), entries, "empty query keeps everything");
{
  const filtered = pickerFilterEntries(entries, "codex");
  assert.ok(filtered.every((entry) => !entry.disabled), "headers dropped while filtering");
  assert.equal(filtered.length, 2);
}
{
  const filtered = pickerFilterEntries(entries, "new claude");
  assert.equal(filtered.length, 1, "all words must match");
  assert.equal(strip(filtered[0].label), "+ New Claude chat");
}
{
  const filtered = pickerFilterEntries(entries, "REFACTOR");
  assert.equal(filtered.length, 1, "matching is case-insensitive");
}
{
  const noSearchText = [{ label: "\x1b[1mBold label\x1b[0m" }];
  assert.equal(
    pickerFilterEntries(noSearchText, "bold label").length,
    1,
    "falls back to the ANSI-stripped label",
  );
}
assert.equal(pickerFilterEntries(entries, "nomatch").length, 0);

// A Ctrl+O menu is a complete scene: its capacity is based on the terminal,
// not on the transcript rows left above a pinned composer.
{
  const ui = Object.create(PopupUi.prototype);
  ui.canPaintPinned = () => true;
  ui.pinnedOutputRows = () => 7;
  const previousRows = process.stdout.rows;
  process.stdout.rows = 24;
  try {
    assert.equal(ui.pickerViewportRows(), 7, "ordinary full-screen picker stays in transcript region");
    assert.equal(ui.pickerViewportRows({ fullViewport: true }), 24);
    assert.equal(ui.pickerListCapacity({ fullViewport: true }), 20);
  } finally {
    process.stdout.rows = previousRows;
  }
}

// Full-height menu paint clears every popup row in the same synchronized frame;
// no composer-owned provider, Plan, card, metadata, or shortcut row survives.
{
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, { lastRawScrollBottom: 9, lastTranscriptFrame: { rows: ["old"] } });
  const oldTTY = process.stdout.isTTY;
  const oldRows = process.stdout.rows;
  const oldColumns = process.stdout.columns;
  const oldWrite = process.stdout.write;
  let output = "";
  let tabsOutput = "";
  const selectionStates = [];
  process.stdout.isTTY = true;
  process.stdout.rows = 12;
  process.stdout.columns = 80;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    ui.paintPicker({
      title: "ACP Hub",
      hint: "Esc close",
      emptyText: "No chats",
      query: "",
      filterActive: false,
      renaming: null,
      replying: null,
      confirmDelete: null,
      previewEnabled: false,
      fullViewport: true,
      fullHeight: true,
      index: 0,
      scroll: 0,
    }, [
      {
        label: "Chat one",
        renderLabel: (_width, context) => {
          selectionStates.push(context?.selected);
          return "Chat one";
        },
        value: { chatId: "one" },
      },
      {
        label: "Chat two",
        renderLabel: (_width, context) => {
          selectionStates.push(context?.selected);
          return "Chat two";
        },
        value: { chatId: "two" },
      },
    ]);
    tabsOutput = "";
    process.stdout.write = (chunk) => { tabsOutput += String(chunk); return true; };
    ui.paintPicker({
      title: "ACP Hub",
      tabs: "Recent Oldest Projects",
      hint: "Esc close",
      emptyText: "No chats",
      query: "aaaa",
      filterActive: true,
      renaming: null,
      replying: null,
      confirmDelete: null,
      previewEnabled: false,
      fullViewport: true,
      fullHeight: true,
      index: 0,
      scroll: 0,
    }, [{ label: "Chat one", value: { chatId: "one" } }]);
  } finally {
    process.stdout.write = oldWrite;
    process.stdout.isTTY = oldTTY;
    process.stdout.rows = oldRows;
    process.stdout.columns = oldColumns;
  }
  assert.ok(output.includes("\x1b[r"), "the composer scroll region is reset inside the menu frame");
  assert.equal((output.match(/\x1b\[2K/g) || []).length, 12, "all physical rows are replaced");
  assert.match(strip(output), /ACP Hub/);
  assert.doesNotMatch(strip(output), /Codex|Plan|Write a message|full-access/);
  assert.deepEqual(selectionStates, [true, false], "row renderer receives selection emphasis state");
  assert.match(output, /\x1b\[2;3H\x1b\[\?25h/, "ordinary picker cursor lands on query row");
  assert.match(tabsOutput, /\x1b\[3;7H\x1b\[\?25h/, "tabbed picker cursor follows the lower query row");
}

// --- pickerNextIndex ----------------------------------------------------------
assert.equal(pickerNextIndex([], 0, 1), -1, "empty list has no selection");
assert.equal(
  pickerNextIndex([{ label: "x", disabled: true }], 0, 1),
  -1,
  "all-disabled list has no selection",
);
assert.equal(pickerNextIndex(entries, -1, 0), 1, "invalid index resolves to first selectable");
assert.equal(pickerNextIndex(entries, 0, 0), 1, "header index resolves to first selectable");
assert.equal(pickerNextIndex(entries, 1, 1), 2, "moves down");
assert.equal(pickerNextIndex(entries, 2, 1), 4, "skips headers going down");
assert.equal(pickerNextIndex(entries, 4, -1), 2, "skips headers going up");
assert.equal(pickerNextIndex(entries, 1, -1), 1, "clamps at the top");
assert.equal(pickerNextIndex(entries, 5, 1), 5, "clamps at the bottom");
assert.equal(pickerNextIndex(entries, 1, 10), 5, "large jumps clamp at the last selectable");

// --- buildMenuPickerItems -----------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  ui.config = { defaultAgent: "codex" };
  ui.cwd = "/repo/current";
  ui.menuFilters = { provider: "all", scope: "all", order: "projects", query: "", limit: 80 };

  const menu = {
    agents: [
      { id: "codex", label: "Codex ACP" },
      { id: "claude", label: "Claude ACP" },
    ],
    visibleChats: [
      {
        id: "c1",
        provider: "codex",
        projectName: "current",
        title: "Fix auth",
        status: "idle",
        active: true,
        cwd: "/repo/current",
      },
      {
        id: "c2",
        provider: "claude",
        projectName: "other",
        title: "Refactor",
        status: "responding",
        active: true,
        cwd: "/repo/other",
      },
    ],
  };

  const items = ui.buildMenuPickerItems(menu);
  const labels = items.map((item) => strip(item.label));

  assert.ok(labels.some((label) => label.includes("current project")), "local project header");
  assert.ok(labels.some((label) => label.includes("New Codex ACP chat")), "new-chat entries");
  assert.ok(
    labels.some((label) => label.includes("New Codex ACP chat") && label.includes("default")),
    "default agent marked",
  );
  assert.ok(labels.some((label) => label === "other"), "remote project grouped by name");

  const chatItem = items.find((item) => item.value?.type === "chat" && item.value.chatId === "c1");
  assert.ok(chatItem, "chat entry present");
  assert.match(chatItem.searchText, /codex/, "search text includes provider");
  assert.match(chatItem.searchText, /Fix auth/, "search text includes title");

  const newItem = items.find((item) => item.value?.type === "new" && item.value.provider === "claude");
  assert.ok(newItem, "new-chat entry carries provider value");

  const mixedProject = ui.orderChatsForDisplay([
    { id: "claude-old", provider: "claude", projectName: "current", cwd: "/repo/current", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "codex-new", provider: "codex", projectName: "current", cwd: "/repo/current", updatedAt: "2026-02-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(
    mixedProject.map((chat) => chat.id),
    ["codex-new", "claude-old"],
    "Projects groups by project but never splits or sorts by provider",
  );
}

// Chronological modes never split chats by provider. Project context moves
// into each row so one mixed timeline remains understandable.
{
  const ui = Object.create(PopupUi.prototype);
  ui.config = { defaultAgent: "codex" };
  ui.cwd = "/repo/current";
  ui.menuFilters = { provider: "all", scope: "all", order: "recent", query: "", limit: 80 };
  const menu = {
    agents: [],
    visibleChats: [
      { id: "new", provider: "claude", projectName: "two", title: "Newest", cwd: "/repo/two", updatedAt: "2026-02-03T00:00:00.000Z" },
      { id: "mid", provider: "codex", projectName: "one", title: "Middle", cwd: "/repo/one", updatedAt: "2026-02-02T00:00:00.000Z" },
      { id: "old", provider: "claude", projectName: "one", title: "Oldest", cwd: "/repo/one", updatedAt: "2026-02-01T00:00:00.000Z" },
    ],
  };

  const recent = ui.buildMenuPickerItems(menu);
  assert.deepEqual(
    recent.filter((item) => item.value?.type === "chat").map((item) => item.value.chatId),
    ["new", "mid", "old"],
  );
  assert.ok(
    strip(recent.find((item) => item.value?.chatId === "new").label).includes("two"),
    "chronological rows retain project context",
  );

  ui.menuFilters.order = "oldest";
  menu.visibleChats.reverse();
  const oldest = ui.buildMenuPickerItems(menu);
  assert.deepEqual(
    oldest.filter((item) => item.value?.type === "chat").map((item) => item.value.chatId),
    ["old", "mid", "new"],
  );
}

// The daemon applies chronological direction before the limit. Otherwise an
// Oldest view would merely reverse the newest page.
{
  const daemon = Object.create(HubDaemon.prototype);
  daemon.registry = new Map([
    ["old", { id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }],
    ["mid", { id: "mid", updatedAt: "2026-02-01T00:00:00.000Z" }],
    ["new", { id: "new", updatedAt: "2026-03-01T00:00:00.000Z" }],
  ]);
  daemon.chats = new Map();
  daemon.recordSummary = (record) => record;

  assert.deepEqual(
    daemon.chatSummaries({ order: "recent", limit: 2 }).map((chat) => chat.id),
    ["new", "mid"],
  );
  assert.deepEqual(
    daemon.chatSummaries({ order: "oldest", limit: 2 }).map((chat) => chat.id),
    ["old", "mid"],
  );
}

// Preview layouts give the chat list a configurable majority while reserving
// enough columns for a useful transcript preview.
{
  const ui = Object.create(PopupUi.prototype);
  ui.menuListPercent = 58;
  assert.deepEqual(ui.pickerColumnWidths(80, { previewEnabled: true }), {
    previewActive: false,
    listWidth: 80,
    previewWidth: 0,
  });
  assert.deepEqual(ui.pickerColumnWidths(120, { previewEnabled: true }), {
    previewActive: true,
    listWidth: 69,
    previewWidth: 48,
  });
  ui.menuListPercent = 75;
  assert.deepEqual(ui.pickerColumnWidths(96, { previewEnabled: true }), {
    previewActive: true,
    listWidth: 55,
    previewWidth: 38,
  });
}

// Menu controls are deliberately orthogonal: Tab cycles order, plain `s`
// toggles scope through its callback, and Ctrl+O is advertised as an immediate
// scene close. Rebuilds keep using the new server-side order/scope.
{
  const requests = [];
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo/current",
    config: { defaultAgent: "codex" },
    currentChat: null,
    menuDefaultOrder: "recent",
    menuDefaultScope: "project",
    menuFilters: { provider: "all", scope: "project", order: "recent", query: "", limit: 80 },
    hub: {
      call: async (method, params = {}) => {
        requests.push({ method, params });
        if (method === "list_agents") return { agents: [] };
        if (method === "list_chats") return { chats: [] };
        return {};
      },
    },
  });
  ui.interactivePick = async (config) => {
    const plainTabs = () => {
      const previousTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;
      try {
        return strip(config.tabs(80));
      } finally {
        process.stdout.isTTY = previousTTY;
      }
    };
    assert.equal(config.closeWithCtrlO, true);
    assert.match(config.hint, /Tab order · s scope · Ctrl\+O close/);
    assert.match(config.title(), /Current project/);
    assert.equal(plainTabs(), "[Recent] Oldest Projects");
    await config.onTab();
    assert.equal(ui.menuFilters.order, "oldest");
    assert.equal(plainTabs(), "Recent [Oldest] Projects");
    await config.onScope();
    assert.equal(ui.menuFilters.scope, "all");
    assert.match(config.title(), /All projects/);
    return null;
  };

  await ui.runMenuPicker();
  const listCalls = requests.filter((request) => request.method === "list_chats");
  assert.equal(listCalls[0].params.order, "recent");
  assert.equal(listCalls[0].params.cwd, "/repo/current");
  assert.equal(listCalls.at(-1).params.order, "oldest");
  assert.equal(Object.hasOwn(listCalls.at(-1).params, "cwd"), false);
}

// Ordering is rendered as one Vanzi-style tab strip. Plain output remains
// legible and narrow terminals receive compact labels.
{
  const ui = Object.create(PopupUi.prototype);
  ui.menuFilters = { order: "recent", scope: "project" };
  const previousTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    assert.equal(strip(ui.menuOrderTabs(80)), "[Recent] Oldest Projects");
    ui.menuFilters.order = "oldest";
    assert.equal(strip(ui.menuOrderTabs(20)), "Rec [Old] Proj");
  } finally {
    process.stdout.isTTY = previousTTY;
  }

  process.stdout.isTTY = true;
  try {
    const styled = ui.menuOrderTabs(80);
    assert.match(styled, /\x1b\[48;(?:2|5);/, "active tab owns an accent background");
    assert.match(styled, /\x1b\[48;2;14;14;14m/, "inactive tabs use the Vanzi surface");
    assert.match(
      strip(styled),
      /Recent {3}Oldest {3}Projects/,
      "one base-surface gap separates tabs in addition to their inner padding",
    );
  } finally {
    process.stdout.isTTY = previousTTY;
  }
}

// Wider list geometry is useful to content too: long chat titles expand past
// the old fixed 48-cell ceiling, while narrow rows retain semantic metadata.
{
  const ui = Object.create(PopupUi.prototype);
  ui.cwd = "/repo/current";
  ui.menuFilters = { order: "recent", scope: "all" };
  const chat = {
    id: "long",
    provider: "codex",
    projectName: "demo",
    cwd: "/repo/demo",
    title: "A deliberately long chat title that continues beyond forty eight columns",
    updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    active: false,
  };
  const wide = strip(ui.menuChatEntryLabel(chat, 100, { includeProject: true }));
  const narrow = strip(ui.menuChatEntryLabel(chat, 42, { includeProject: true }));
  assert.match(wide, /continues beyond forty eight/);
  assert.ok(narrow.length <= 42);
  assert.match(narrow, /demo · 5m/);
}

// Only the newest asynchronous menu rebuild may commit. This covers rapid
// Tab/s input and live daemon refreshes arriving out of order.
{
  const ui = Object.create(PopupUi.prototype);
  const state = { done: false, rebuildRevision: 0 };
  const applied = [];
  let resolveOld;
  let resolveNew;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  const fresh = new Promise((resolve) => { resolveNew = resolve; });
  const first = ui.runLatestPickerRebuild(state, () => old, (value) => applied.push(value));
  const second = ui.runLatestPickerRebuild(state, () => fresh, (value) => applied.push(value));
  resolveNew("projects");
  await second;
  resolveOld("oldest");
  await first;
  assert.deepEqual(applied, ["projects"]);
}

// --- formatRelativeAge ----------------------------------------------------------
{
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(formatRelativeAge(ago(10 * 1000)), "now");
  assert.equal(formatRelativeAge(ago(37 * 60 * 1000)), "37m");
  assert.equal(formatRelativeAge(ago(8 * 3600 * 1000)), "8h");
  assert.equal(formatRelativeAge(ago(2 * 86400 * 1000)), "2d");
  assert.equal(formatRelativeAge(ago(21 * 86400 * 1000)), "3w");
  assert.equal(formatRelativeAge(ago(90 * 86400 * 1000)), "3mo");
  assert.equal(formatRelativeAge(ago(800 * 86400 * 1000)), "2y");
  assert.equal(formatRelativeAge(""), "", "missing timestamp renders nothing");
  assert.equal(formatRelativeAge("garbage"), "");
}

// --- formatChatPreview ----------------------------------------------------------
{
  const strip = (value) => value.replace(/\[[0-9;]*m/g, "");
  const events = [
    { type: "user", text: "hola" },
    { type: "agent_chunk", text: "Hola. ¿En qué " },
    { type: "agent_chunk", text: "te ayudo?" },
    { type: "thought_chunk", text: "reasoning noise" },
    { type: "tool_call", title: "Read file", kind: "read" },
    { type: "tool_update", title: "Read file", status: "completed" },
    { type: "system", level: "info", text: "Commands available: 12" },
    { type: "plan", entries: [{}, {}, {}] },
    { type: "error", text: "boom" },
  ];

  const lines = formatChatPreview(events, 40, 20).map(strip);
  assert.ok(lines.some((line) => line.includes("❯ hola")), "user line present");
  assert.ok(
    lines.some((line) => line.includes("Hola. ¿En qué te ayudo?")),
    "agent chunks coalesce into one paragraph",
  );
  assert.ok(lines.some((line) => line.includes("⚙ Read file")), "tool call shown");
  assert.ok(lines.some((line) => line.includes("▸ plan · 3 steps")), "plan shown");
  assert.ok(lines.some((line) => line.includes("✗ boom")), "error shown");
  assert.ok(!lines.some((line) => line.includes("reasoning")), "thoughts skipped");
  assert.ok(!lines.some((line) => line.includes("Commands available")), "system noise skipped");

  // Tail cap: only the last maxLines survive, most recent content wins.
  const many = [];
  for (let i = 0; i < 60; i += 1) many.push({ type: "user", text: `msg ${i}` });
  const tail = formatChatPreview(many, 40, 5).map(strip);
  assert.ok(tail.length >= 4 && tail.length <= 5, "tail capped at maxLines");
  assert.ok(tail.some((line) => line.includes("msg 59")), "most recent message kept");

  // Long text wraps to width.
  const wrapped = formatChatPreview(
    [{ type: "agent_chunk", text: "palabra ".repeat(30) }],
    20,
    30,
  ).map(strip);
  assert.ok(wrapped.length > 3, "long paragraph wraps into multiple lines");
  assert.ok(wrapped.every((line) => line.length <= 20), "wrapped lines respect width");

  const intactWord = formatChatPreview(
    [{ type: "agent_chunk", text: "123456789012 palabra final" }],
    16,
    10,
  ).map(strip);
  assert.deepEqual(intactWord, ["123456789012", "palabra final"]);

  assert.deepEqual(formatChatPreview(null, 40, 10), []);
  assert.deepEqual(formatChatPreview([], 4, 10), []);

  // Markdown renderer: agent paragraphs go through it; box-drawing rows
  // (tables) are clipped to the pane width instead of soft-wrapped.
  const render = (text) =>
    text
      .split("\n")
      .map((line) => (line.startsWith("|") ? `│ ${line.replace(/\|/g, "").trim()} │ ${"x".repeat(40)}` : line))
      .join("\n");
  const rendered = formatChatPreview(
    [{ type: "agent_chunk", text: "| head |\n| data |\nplain paragraph that is long enough to wrap around" }],
    24,
    20,
    render,
  ).map(strip);
  const tableRows = rendered.filter((line) => line.includes("│"));
  assert.equal(tableRows.length, 2, "table rows stay one line each");
  assert.ok(tableRows.every((line) => line.length <= 24), "table rows clipped to width");
  assert.ok(
    rendered.filter((line) => line.includes("wrap") || line.includes("plain")).length >= 2,
    "plain paragraphs still wrap",
  );
}

// --- showPermissionPicker ---------------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const calls = [];
  Object.assign(ui, {
    currentChat: { id: "c1" },
    pendingPermission: {
      permissionId: "perm-1",
      toolCall: { title: "Ready to code?" },
      options: [
        { optionId: "opt-allow", name: "Yes, auto-accept edits", kind: "allow_always" },
        { optionId: "opt-manual", name: "Yes, manually approve", kind: "allow_once" },
        { optionId: "opt-no", name: "No, keep planning", kind: "reject_once" },
      ],
    },
    pickerSupported: () => true,
    canPaintPinned: () => true,
    hub: { call: async (method, params) => { calls.push({ method, params }); } },
    quickSelect: async (config) => {
      // The menu was handed exactly the pending options, first preselected.
      assert.equal(config.items.length, 3, "one item per option");
      assert.equal(config.items[0].value, "opt-allow");
      assert.ok(config.items[0].current, "first option preselected");
      assert.ok(config.title.includes("Ready to code?"), "tool title in the menu title");
      return "opt-manual";
    },
  });

  const handled = await ui.showPermissionPicker();
  assert.equal(handled, true, "picker handled the pending permission");
  assert.equal(calls.length, 1, "one response sent");
  assert.deepEqual(calls[0], {
    method: "permission_response",
    params: { permissionId: "perm-1", optionId: "opt-manual" },
  });
  assert.equal(ui.pendingPermission, null, "pending cleared after responding");
}
{
  // Esc keeps the request pending so /allow <n> still works.
  const ui = Object.create(PopupUi.prototype);
  const pending = { permissionId: "perm-2", options: [{ optionId: "o", name: "ok" }], toolCall: null };
  let sent = false;
  Object.assign(ui, {
    pendingPermission: pending,
    pickerSupported: () => true,
    canPaintPinned: () => true,
    hub: { call: async () => { sent = true; } },
    quickSelect: async () => null,
  });
  assert.equal(await ui.showPermissionPicker(), true, "handled even on cancel");
  assert.equal(sent, false, "no response sent on Esc");
  assert.equal(ui.pendingPermission, pending, "request still pending");
}
{
  // No pending permission → not handled, falls through to normal Enter.
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, { pendingPermission: null, pickerSupported: () => true, canPaintPinned: () => true });
  assert.equal(await ui.showPermissionPicker(), false, "nothing to pick");
}

// --- cycleMode (Tab / Shift+Tab) ------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const applied = [];
  Object.assign(ui, {
    currentChat: {
      mode: "plan",
      modes: { availableModes: [{ id: "plan" }, { id: "default" }, { id: "acceptEdits" }] },
    },
    notify: () => {},
    applyMode: async (id) => {
      applied.push(id);
      ui.currentChat = { ...ui.currentChat, mode: id };
    },
  });

  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "default", "Tab moves to the next mode");
  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "acceptEdits");
  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "plan", "Tab wraps past the end");
  await ui.cycleMode(-1);
  assert.equal(applied.at(-1), "acceptEdits", "Shift+Tab wraps backwards");
}
{
  // Match the current mode by any alias, not just id.
  const ui = Object.create(PopupUi.prototype);
  const applied = [];
  Object.assign(ui, {
    currentChat: {
      mode: "Plan Mode",
      modes: { availableModes: [{ id: "plan", label: "Plan Mode" }, { id: "build", label: "Build" }] },
    },
    notify: () => {},
    applyMode: async (id) => applied.push(id),
  });
  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "build", "current matched by label alias, advances to build");
}
{
  // A single mode (or none) never cycles.
  const ui = Object.create(PopupUi.prototype);
  let applied = false;
  Object.assign(ui, {
    currentChat: { mode: "default", modes: { availableModes: [{ id: "default" }] } },
    notify: () => {},
    applyMode: async () => {
      applied = true;
    },
  });
  await ui.cycleMode(1);
  assert.equal(applied, false, "single mode does not cycle");
}

// --- replyToChatFromPicker -------------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const calls = [];
  Object.assign(ui, {
    notify: (m) => calls.push({ notify: m }),
    hub: { call: async (method, params) => { calls.push({ method, params }); } },
  });

  await ui.replyToChatFromPicker({ value: { chatId: "codex-1" } }, "hello there");
  assert.deepEqual(
    calls[0],
    { method: "send_prompt", params: { chatId: "codex-1", text: "hello there" } },
    "reply sends the prompt to the chat",
  );
}
{
  // No chatId → nothing sent.
  const ui = Object.create(PopupUi.prototype);
  let sent = false;
  Object.assign(ui, { notify: () => {}, hub: { call: async () => { sent = true; } } });
  await ui.replyToChatFromPicker({ value: {} }, "x");
  assert.equal(sent, false, "missing chatId sends nothing");
}
{
  // A send failure surfaces via notify instead of throwing.
  const ui = Object.create(PopupUi.prototype);
  let notified = "";
  Object.assign(ui, {
    notify: (m) => { notified = m; },
    hub: { call: async () => { throw new Error("adapter down"); } },
  });
  await ui.replyToChatFromPicker({ value: { chatId: "c" } }, "hi");
  assert.match(notified, /reply failed.*adapter down/, "failure is reported, not thrown");
}
{
  // canReply gates on chat.active in the chats picker items.
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo",
    currentChat: { id: "other" },
    hub: { call: async () => ({ chats: [
      { id: "live", provider: "codex", projectName: "repo", cwd: "/repo", active: true, status: "idle" },
      { id: "saved", provider: "codex", projectName: "repo", cwd: "/repo", active: false },
    ] }) },
    orderChatsForDisplay: (chats) => chats,
  });
  const items = await ui.buildChatsPickerItems();
  const rows = items.filter((i) => !i.disabled);
  assert.equal(rows.find((r) => r.value.chatId === "live").canReply, true, "live chat can be replied to");
  assert.equal(rows.find((r) => r.value.chatId === "saved").canReply, false, "saved chat cannot");
}

// --- showMenuOverlay routing -----------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const switches = [];
  Object.assign(ui, {
    cwd: "/repo",
    currentChat: { id: "chat-here" },
    pickerSupported: () => true,
    canPaintPinned: () => true,
    switchToChatWindow: (arg) => switches.push(arg),
    restorePickerBackdrop: () => { throw new Error("menu overlay must not restore before routing"); },
  });

  ui.runMenuPicker = async () => ({ type: "chat", chatId: "chat-3", cwd: "/repo", provider: "codex" });
  await ui.showMenuOverlay();
  assert.deepEqual(
    switches.at(-1),
    { type: "chat", chatId: "chat-3", cwd: "/repo", provider: "codex" },
    "picking another chat focuses/creates its window",
  );

  switches.length = 0;
  ui.runMenuPicker = async () => ({ type: "chat", chatId: "chat-here" });
  await ui.showMenuOverlay();
  assert.equal(switches.length, 0, "picking the current chat switches nothing");

  ui.runMenuPicker = async () => ({ type: "new", provider: "claude" });
  await ui.showMenuOverlay();
  assert.deepEqual(switches.at(-1), { cwd: "/repo", provider: "claude", action: "new" }, "new chat");

  switches.length = 0;
  ui.runMenuPicker = async () => null;
  assert.equal(await ui.showMenuOverlay(), true, "Esc is still handled");
  assert.equal(switches.length, 0, "Esc switches nothing");
  assert.equal(ui.restoreFullscreenOnNextComposer, true, "the next composer owns restoration");
}

// --- Ctrl+O suspends the same composer session and restores it atomically --------
{
  const ui = Object.create(PopupUi.prototype);
  const draft = { done: false };
  let opened = 0;
  Object.assign(ui, {
    currentChat: { id: "chat-here" },
    scrollOffsetRows: 12,
    fullscreenOverlay: null,
    pickerSupported: () => true,
    canPaintPinned: () => true,
    saveRawDraft: () => {},
    openMenuOverlayFromComposer: async () => { opened += 1; },
  });
  assert.equal(ui.triggerMenuFromComposer(draft), false, "left-arrow path stays disabled in scrollback");
  assert.equal(
    ui.triggerMenuFromComposer(draft, { allowScrolled: true }),
    true,
    "Ctrl+O opens from scrollback",
  );
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(ui.scrollOffsetRows, 12, "opening the menu does not destroy transcript position");
}

{
  const ui = Object.create(PopupUi.prototype);
  const inputListener = () => {};
  const draft = {
    pinned: true,
    done: false,
    line: "first line\nsecond line",
    cursor: 5,
    onKeypress: inputListener,
    bracketedPaste: false,
    overlaySuspended: false,
    resizeHandler: null,
  };
  const renders = [];
  Object.assign(ui, {
    rawInput: draft,
    fullscreenOverlay: null,
    lastRawInputLayout: { outputBottom: 10 },
    lastRawScrollBottom: 10,
    lastTranscriptFrame: { rows: ["old"] },
    stopComposerAnimation: () => {},
    syncComposerAnimation: () => {},
    renderRawInput: (options) => renders.push(options),
  });

  process.stdin.on("keypress", inputListener);
  try {
    assert.equal(ui.suspendComposerForOverlay(draft), true);
    assert.equal(draft.overlaySuspended, true);
    assert.equal(process.stdin.listeners("keypress").includes(inputListener), false);

    // State may continue changing while the menu owns the pixels; the draft
    // object itself is never reconstructed or moved to the end.
    ui.currentChat = { plan: { entries: [{ content: "latest" }] }, queued: 2 };
    assert.equal(ui.resumeComposerFromOverlay(draft), true);
    assert.equal(ui.rawInput, draft);
    assert.equal(draft.line, "first line\nsecond line");
    assert.equal(draft.cursor, 5);
    assert.equal(process.stdin.listeners("keypress").includes(inputListener), true);
    assert.deepEqual(renders, [{ forceOutput: true, clearScreen: true, clear: true }]);
    assert.equal(ui.lastRawInputLayout, null);
    assert.equal(ui.lastRawScrollBottom, null);
    assert.equal(ui.lastTranscriptFrame, null);
  } finally {
    process.stdin.off("keypress", inputListener);
  }
}

// --- adoptChatInPane passthrough -------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  delete process.env.TMUX_PANE; // no pane → skips the tmux option write
  let called = false;
  const result = await ui.adoptChatInPane(async () => {
    called = true;
    return "chat-loop-result";
  });
  assert.equal(called, true, "adoptChatInPane runs the open function");
  assert.equal(result, "chat-loop-result", "and returns its result (the chat loop)");
}

// --- answerPermission maps a bare option number to its optionId ------------------
{
  const ui = Object.create(PopupUi.prototype);
  const calls = [];
  Object.assign(ui, {
    pendingPermission: {
      permissionId: "perm-1",
      options: [
        { optionId: "opt-allow", kind: "allow_once", name: "allow once" },
        { optionId: "opt-always", kind: "allow_always", name: "always allow" },
        { optionId: "opt-reject", kind: "reject_once", name: "reject" },
      ],
    },
    hub: { call: async (method, params) => calls.push({ method, params }) },
  });

  await ui.answerPermission("/allow 2", "allow");
  assert.deepEqual(
    calls[0],
    { method: "permission_response", params: { permissionId: "perm-1", optionId: "opt-always" } },
    "a bare option number answers the matching option",
  );
  assert.equal(ui.pendingPermission, null, "the request is cleared after answering");
}

// --- maybeAutoOpenPermission opens once per request, then defers to the composer -
{
  const ui = Object.create(PopupUi.prototype);
  let shown = 0;
  Object.assign(ui, {
    pendingPermission: { permissionId: "perm-9", options: [{ optionId: "a" }] },
    autoShownPermissionId: null,
    pickerSupported: () => true,
    canHostInlinePicker: () => true,
    showPermissionPicker: async () => {
      shown += 1;
      return true;
    },
  });

  assert.equal(await ui.maybeAutoOpenPermission(), true, "opens for a new request");
  assert.equal(ui.autoShownPermissionId, "perm-9", "records the shown request id");
  assert.equal(await ui.maybeAutoOpenPermission(), false, "does not reopen the same request");
  assert.equal(shown, 1, "picker shown exactly once");
}
{
  // No pinned picker (e.g. text-menu fallback): never auto-open — the banner and
  // bare-number answering take over instead.
  const ui = Object.create(PopupUi.prototype);
  let shown = false;
  Object.assign(ui, {
    pendingPermission: { permissionId: "p", options: [{ optionId: "a" }] },
    autoShownPermissionId: null,
    pickerSupported: () => false,
    canHostInlinePicker: () => true,
    showPermissionPicker: async () => {
      shown = true;
      return true;
    },
  });
  assert.equal(await ui.maybeAutoOpenPermission(), false, "no picker support → no auto-open");
  assert.equal(shown, false, "picker not shown");
}

// --- showChangesPicker expands the picked file's diff ---------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const printed = [];
  const files = [
    { path: "a.js", added: 2, removed: 1, hunks: [{ rows: [{ sign: "+", text: "x" }] }] },
    { path: "b.js", added: 0, removed: 3, hunks: [{ rows: [{ sign: "-", text: "y" }] }] },
  ];
  Object.assign(ui, {
    currentChat: { id: "c1", title: "t" },
    hub: {
      call: async (method, params) => {
        assert.equal(method, "list_changes");
        assert.equal(params.chatId, "c1");
        return { files };
      },
    },
    pickerSupported: () => true,
    canPaintPinned: () => true,
    interactivePick: async (config) => {
      assert.equal(config.items.length, 3, "all-files entry + one per file");
      return "b.js";
    },
    logLine: () => {},
    renderDiff: (diff) => printed.push(diff.path),
    notify: () => {},
  });

  await ui.showChangesPicker();
  assert.deepEqual(printed, ["b.js"], "expands only the picked file's diff");
}
{
  // No edits yet → notify, never open the picker.
  const ui = Object.create(PopupUi.prototype);
  let notified = "";
  Object.assign(ui, {
    currentChat: { id: "c1" },
    hub: { call: async () => ({ files: [] }) },
    notify: (message) => {
      notified = message;
    },
    interactivePick: async () => {
      throw new Error("picker should not open with no changes");
    },
  });
  await ui.showChangesPicker();
  assert.match(notified, /no file changes/);
}

console.log("picker test passed");
