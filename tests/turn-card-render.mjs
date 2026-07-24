#!/usr/bin/env node

import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 80;
process.stdout.rows = 30;
delete process.env.TMUX;

const { PopupUi } = await import("../bin/acp-hub.mjs");
const { stripAnsi, stringDisplayWidth } = await import("../lib/render.mjs");

function makeUi() {
  return Object.assign(Object.create(PopupUi.prototype), {
    currentChat: { id: "c1", provider: "codex", projectName: "demo" },
    historyEvents: [],
    transcriptEntries: [""],
    turnDetailOverrides: new Map(),
    turnDetailsMode: "auto",
    turnDetailsShortcut: "F3",
    interactiveRegions: [],
    hoveredInteractiveKey: "",
    suppressTranscriptPaint: false,
    transcriptProjectionDepth: 0,
    transcriptRenderPhase: "live",
    transcriptProjectionTimer: null,
    markdownFence: false,
    markdownFenceLang: "",
    chunkBuffer: "",
    chunkBufferMarkdown: false,
    chunkBufferDim: false,
    pendingResponseBreak: false,
    lastStreamEventKey: "",
    showInternalEvents: false,
    activityMode: "compact",
    lastPlanSignature: "",
    mdHeldLine: null,
    liveCodeBlock: null,
    liveCodeBlockPaintTimer: null,
    liveCodeBlockPaintPending: false,
    liveTable: null,
    liveTablePaintTimer: null,
    liveTablePaintPending: false,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    lastRawScrollBottom: null,
    rawInput: null,
    activePicker: null,
    questionActive: false,
    closed: false,
    notify: () => {},
  });
}

const history = [
  { type: "user", text: "do it", turnSequence: 1, at: "2026-07-18T12:00:00.000Z" },
  { type: "agent_chunk", text: "I am checking.", messageId: "progress", turnSequence: 1, at: "2026-07-18T12:00:01.000Z" },
  { type: "tool_update", toolCallId: "t1", title: "read files", status: "completed", turnSequence: 1, at: "2026-07-18T12:00:02.000Z" },
  { type: "agent_chunk", text: "Everything is ready.", messageId: "final", turnSequence: 1, at: "2026-07-18T12:00:03.000Z" },
  { type: "turn_done", stopReason: "end_turn", turnSequence: 1, durationMs: 4000, at: "2026-07-18T12:00:04.000Z" },
];

const ui = makeUi();
const originalWrite = process.stdout.write;
process.stdout.write = () => true;
try {
  ui.renderHistory(history);
} finally {
  process.stdout.write = originalWrite;
}

const card = ui.transcriptEntries.find((entry) => entry?.kind === "turn-card");
assert.ok(card, "completed turns become semantic cards");
assert.equal(card.turn.finalText, "Everything is ready.");
assert.equal(ui.transcriptEntries[0]?.kind, "chat-header", "the chat header survives transcript repaints");

const boundaryUi = makeUi();
process.stdout.write = () => true;
try {
  boundaryUi.renderHistory([
    { type: "history_boundary", partialTurn: true, turnSequence: 9 },
    { type: "agent_chunk", text: "restored tail", turnSequence: 9 },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 9 },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
assert.ok(
  boundaryUi.transcriptEntries
    .flatMap((entry) => boundaryUi.transcriptEntryRows(entry, 80))
    .map(stripAnsi)
    .some((row) => row.includes("Earlier history is incomplete")),
  "legacy partial restoration is visible instead of silently losing its prompt",
);

// Informational/state commands retain a semantic command boundary and use a
// compact command header instead of pretending that they were normal work.
const commandUi = makeUi();
process.stdout.write = () => true;
try {
  commandUi.renderHistory([
    {
      type: "command",
      text: "/status model",
      name: "status",
      presentation: "informational",
      clientCommandId: "command-1",
      turnSequence: 3,
      at: "2026-07-18T12:00:00.000Z",
    },
    {
      type: "agent_chunk",
      text: "Model: codex-test",
      messageRole: "final",
      turnSequence: 3,
    },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 3, durationMs: 800 },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
const commandRows = commandUi.transcriptEntries
  .flatMap((entry) => commandUi.transcriptEntryRows(entry, 60))
  .map(stripAnsi);
assert.ok(commandRows.some((row) => row.includes("⌘ /status model")));
assert.ok(commandRows.some((row) => row.includes("/status · <1s")));
assert.ok(commandRows.some((row) => row.includes("Model: codex-test")));
assert.ok(!commandRows.some((row) => row.includes("Worked for")));

// A direct final answer has no detail drawer, so an inert `Worked for…` row
// would add noise without offering an action or explaining an exceptional end.
const directUi = makeUi();
const directCard = {
  kind: "turn-card",
  turn: {
    id: "direct-1",
    status: "completed",
    durationMs: 2_000,
    actionCount: 0,
    changedFiles: [],
  },
  detailEntries: [],
  finalEntries: [{ kind: "prose", text: "Short answer." }],
};
const directRows = directUi.transcriptEntryRows(directCard, 60);
assert.deepEqual(directRows.map((row) => stripAnsi(row.text ?? row)), ["", "Short answer."]);
assert.ok(!directRows.some((row) => row.interactiveKey));

const failedCard = {
  ...directCard,
  turn: { ...directCard.turn, id: "failed-1", status: "error" },
};
assert.ok(
  directUi.transcriptEntryRows(failedCard, 60).map((row) => stripAnsi(row.text ?? row))
    .some((row) => row.includes("Failed after 2s")),
  "exceptional outcomes keep a static explanatory summary",
);

const retainedMetricsCard = {
  ...directCard,
  turn: { ...directCard.turn, id: "metrics-1", actionCount: 2 },
};
assert.ok(
  directUi.transcriptEntryRows(retainedMetricsCard, 60).map((row) => stripAnsi(row.text ?? row))
    .some((row) => row.includes("2 tool calls · details unavailable")),
  "reported work without renderable detail remains explicit instead of becoming misleading",
);

const activeCompactUi = makeUi();
process.stdout.write = () => true;
try {
  activeCompactUi.renderHistory([
    {
      type: "command",
      text: "/compact",
      name: "compact",
      presentation: "state",
      turnSequence: 4,
      at: "2026-07-18T12:01:00.000Z",
    },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
assert.ok(
  activeCompactUi.transcriptEntries
    .flatMap((entry) => activeCompactUi.transcriptEntryRows(entry, 60))
    .map(stripAnsi)
    .some((row) => row.includes("Compacting…")),
  "state commands expose their live phase before producing output",
);

const collapsed = ui.transcriptEntryRows(card, 60).map(stripAnsi);
assert.ok(collapsed.some((row) => row.includes("Worked for 4s")));
assert.ok(collapsed.some((row) => row.includes("1 tool call")));
assert.ok(collapsed.some((row) => row.includes("Everything is ready.")));
assert.ok(!collapsed.some((row) => row.includes("Click to")), "the header is the only toggle row");
assert.ok(!collapsed.some((row) => row.includes("I am checking.")));
assert.equal(
  ui.transcriptEntryVisualRows(card, 60).filter((row) => row.interactiveKey).length,
  1,
  "only the turn header owns an interactive hit region",
);

ui.turnDetailsMode = "hidden";
const hidden = ui.transcriptEntryRows(card, 60).map(stripAnsi);
assert.deepEqual(hidden, ["", "Everything is ready."], "hidden policy shows only the final answer");
ui.setTurnCardExpanded(card.turn.id, true);
assert.ok(ui.transcriptEntryRows(card, 60).map(stripAnsi).some((row) => row.includes("I am checking.")));
ui.setTurnCardExpanded(card.turn.id, false);
assert.deepEqual(
  ui.transcriptEntryRows(card, 60).map(stripAnsi),
  ["", "Everything is ready."],
  "collapsing again restores the strict hidden policy",
);
ui.turnDetailsMode = "auto";

ui.setTurnCardExpanded(card.turn.id, true);
const expanded = ui.transcriptEntryRows(card, 60).map(stripAnsi);
assert.ok(expanded.some((row) => row.includes("I am checking.")));
assert.ok(expanded.some((row) => row.includes("read files")));
assert.ok(!expanded.some((row) => row.includes("Click to")));

// Tool groups share one compact tree: prose keeps the rail without gaining a
// branch, while the final visible action closes it with a terminal elbow.
const compactActivityUi = makeUi();
process.stdout.write = () => true;
try {
  compactActivityUi.renderHistory([
    { type: "user", text: "compact activity", turnSequence: 7, at: "2026-07-18T12:07:00.000Z" },
    { type: "tool_update", toolCallId: "edit", kind: "edit", title: "Editing files", status: "completed", turnSequence: 7 },
    { type: "tool_update", toolCallId: "read", title: "Read files", status: "completed", turnSequence: 7 },
    {
      type: "agent_chunk",
      text: "Reviewing the result.",
      messageId: "commentary-7",
      messageRole: "commentary",
      turnSequence: 7,
    },
    { type: "tool_update", toolCallId: "run", title: "Run tests", status: "completed", turnSequence: 7 },
    { type: "agent_chunk", text: "Compact result.", messageId: "final", turnSequence: 7 },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 7, durationMs: 5000 },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
const compactActivityCard = compactActivityUi.transcriptEntries.find(
  (entry) => entry?.kind === "turn-card",
);
compactActivityUi.setTurnCardExpanded(compactActivityCard.turn.id, true);
const compactActivityRawRows = compactActivityUi.transcriptEntryRows(compactActivityCard, 60);
const compactActivityRows = compactActivityRawRows.map(stripAnsi);
assert.ok(
  compactActivityRawRows.some((row) => row.includes("\x1b[38;5;78m●\x1b[0m")),
  "completed Activity icons use the stronger green without tinting their labels",
);
assert.ok(
  compactActivityRawRows.some((row) => row.includes("\x1b[38;5;240m├─\x1b[0m")),
  "Activity intersections use the faint structural tier",
);
assert.ok(
  compactActivityRawRows.some((row) => row.includes("\x1b[38;5;240m│\x1b[0m")),
  "Activity rails share the same subtle structural tone",
);

{
  const permissionUi = makeUi();
  let rendered = "";
  permissionUi.logProse = (text) => { rendered = String(text); };
  permissionUi.renderPermissionDecision({
    scope: "once",
    optionName: "Allow Once",
    toolKind: "execute",
  });
  assert.ok(rendered.includes("\x1b[38;5;78m✓\x1b[0m"));
  assert.ok(rendered.includes("\x1b[38;5;114mPermission · Allow Once · once · execute\x1b[0m"));
}
assert.ok(
  compactActivityRows.some((row) => /^├─ ● Edited$/.test(row)),
  JSON.stringify(compactActivityRows),
);
assert.ok(compactActivityRows.some((row) => /^├─ ● Explored$/.test(row)));
assert.ok(
  compactActivityRows.some((row) => /^└─ ● Ran$/.test(row)),
  JSON.stringify(compactActivityRows),
);
assert.ok(compactActivityRows.some((row) => /^│ {4}Editing files$/.test(row)));
assert.ok(
  compactActivityRows.some((row) => /^│ {4}Reviewing the result\.$/.test(row)),
  "free commentary aligns with action text without gaining a branch",
);
assert.ok(
  !compactActivityRows.some((row) => /^[├└]─.*Reviewing the result\./.test(row)),
  "free commentary never becomes a tree intersection",
);
assert.ok(compactActivityRows.some((row) => /^ {5}Run tests$/.test(row)));
assert.ok(!compactActivityRows.some((row) => /^[│ ]*─{3,}$/.test(row)));
assert.equal(
  compactActivityRows.filter((row) => row.startsWith("└─")).length,
  1,
  "the tree owns one terminal branch",
);
const compactHeaderIndex = compactActivityRows.findIndex((row) => row.includes("Worked for"));
assert.equal(compactActivityRows[compactHeaderIndex + 1], "│", "header owns one rail spacer");
for (const label of ["Explored"]) {
  const index = compactActivityRows.findIndex((row) => row === `├─ ● ${label}`);
  assert.equal(compactActivityRows[index - 1], "│", `${label} has one leading spacer`);
  assert.notEqual(compactActivityRows[index - 2], "│", `${label} never gains a double spacer`);
}
const terminalIndex = compactActivityRows.findIndex((row) => row === "└─ ● Ran");
assert.equal(compactActivityRows[terminalIndex - 1], "│", "the terminal group keeps one leading spacer");
assert.notEqual(compactActivityRows[terminalIndex - 2], "│");
const finalGroupAction = compactActivityRows.findIndex((row) => row.includes("Run tests"));
assert.notEqual(
  compactActivityRows[finalGroupAction + 1],
  "│",
  "the final detail block never owns a trailing rail spacer",
);
for (const width of [1, 2, 6, 12]) {
  assert.ok(
    compactActivityUi
      .transcriptEntryRows(compactActivityCard, width)
      .every((row) => stringDisplayWidth(row) <= width),
    `activity tree fits a ${width}-column viewport`,
  );
}

// Per-category icons may be configured from tmux. A shared slot keeps labels,
// child rows, and free prose aligned even when one icon occupies two columns.
compactActivityUi.activityIcons = {
  edited: "✎",
  explored: "🔎",
  ran: "$",
  tools: "◇",
};
const customIconRows = compactActivityUi
  .transcriptEntryRows(compactActivityCard, 60)
  .map(stripAnsi);
for (const [label, icon] of [
  ["Edited", "✎"],
  ["Explored", "🔎"],
  ["Ran", "$"],
]) {
  const row = customIconRows.find((candidate) => candidate.includes(label));
  assert.ok(row?.includes(icon), `${label} uses its configured icon`);
  assert.equal(
    stringDisplayWidth(row.slice(0, row.indexOf(label))),
    6,
    `${label} remains aligned in the shared two-column icon slot`,
  );
}
for (const text of ["Reviewing the result.", "Run tests"]) {
  const row = customIconRows.find((candidate) => candidate.includes(text));
  assert.equal(
    stringDisplayWidth(row.slice(0, row.indexOf(text))),
    6,
    `${text} follows the configured icon geometry`,
  );
}
compactActivityUi.activityIcons.ran = "\x1b[31mTOO\x1b[0m";
assert.ok(
  compactActivityUi
    .transcriptEntryRows(compactActivityCard, 60)
    .map(stripAnsi)
    .some((row) => row.includes("●") && row.includes("Ran")),
  "unsafe or over-wide icon values fall back to the default dot",
);

// A group cannot close the tree if chronological prose still follows it. The
// prose carries the rail and ends naturally without an extra dangling row.
const trailingProseUi = makeUi();
process.stdout.write = () => true;
try {
  trailingProseUi.renderHistory([
    { type: "user", text: "trailing prose", turnSequence: 71 },
    { type: "tool_update", toolCallId: "run-71", kind: "execute", title: "Run checks", status: "completed", turnSequence: 71 },
    {
      type: "agent_chunk",
      text: "Checks passed.",
      messageId: "commentary-71",
      messageRole: "commentary",
      turnSequence: 71,
    },
    {
      type: "agent_chunk",
      text: "Final result.",
      messageId: "final-71",
      messageRole: "final",
      turnSequence: 71,
    },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 71, durationMs: 1000 },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
const trailingProseCard = trailingProseUi.transcriptEntries.find(
  (entry) => entry?.kind === "turn-card",
);
trailingProseUi.setTurnCardExpanded(trailingProseCard.turn.id, true);
const trailingProseRows = trailingProseUi
  .transcriptEntryRows(trailingProseCard, 60)
  .map(stripAnsi);
assert.ok(trailingProseRows.some((row) => row === "├─ ● Ran"));
const trailingCommentaryIndex = trailingProseRows.findIndex(
  (row) => row === "│    Checks passed.",
);
assert.ok(trailingCommentaryIndex > 0);
assert.notEqual(trailingProseRows[trailingCommentaryIndex + 1], "│");
assert.ok(!trailingProseRows.some((row) => row.startsWith("└─")));

// Tool lifecycles become one semantic action, consecutive categories gain a
// compact count, and completed group details stay collapsed until requested.
const groupedActivityUi = makeUi();
process.stdout.write = () => true;
try {
  groupedActivityUi.renderHistory([
    { type: "user", text: "group activity", turnSequence: 8, at: "2026-07-18T12:08:00.000Z" },
    {
      type: "tool_call",
      toolCallId: "read-1",
      kind: "read",
      title: "Read a remarkably long renderer description without splitting words",
      status: "in_progress",
      summary: "Inspect the semantic renderer",
      turnSequence: 8,
    },
    { type: "tool_update", toolCallId: "read-1", status: "completed", turnSequence: 8 },
    { type: "tool_update", toolCallId: "read-2", kind: "search", title: "Search tests", status: "completed", turnSequence: 8 },
    { type: "agent_chunk", text: "Grouped result.", messageId: "final", turnSequence: 8 },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 8, durationMs: 5000 },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
const groupedActivityCard = groupedActivityUi.transcriptEntries.find(
  (entry) => entry?.kind === "turn-card",
);
const groupedEntry = groupedActivityCard.detailEntries.find(
  (entry) => entry?.kind === "activity-group",
);
assert.equal(groupedEntry.group.actions.length, 2, "call/update lifecycle is not duplicated");
assert.equal(groupedEntry.group.status, "completed");
groupedActivityUi.setTurnCardExpanded(groupedActivityCard.turn.id, true);
const groupedCollapsedRows = groupedActivityUi
  .transcriptEntryRows(groupedActivityCard, 42)
  .map(stripAnsi);
assert.ok(groupedCollapsedRows.some((row) => row.includes("Explored · 2")));
assert.equal(
  groupedCollapsedRows.filter((row) => row.includes("Read a remarkably")).length,
  1,
  "one action may wrap but is projected only once",
);
assert.ok(!groupedCollapsedRows.some((row) => row.includes("Inspect the semantic renderer")));
assert.ok(
  groupedActivityUi.setActivityGroupExpanded(
    groupedActivityCard.turn.id,
    groupedEntry.group.id,
    true,
  ),
);
const groupedExpandedRows = groupedActivityUi
  .transcriptEntryRows(groupedActivityCard, 42)
  .map(stripAnsi);
assert.ok(groupedExpandedRows.some((row) => row.includes("Inspect the semantic renderer")));
assert.ok(
  groupedActivityUi
    .transcriptEntryVisualRows(groupedActivityCard, 42)
    .some((row) => row.action === "toggle-activity-group"),
  "a group with details owns an interactive header",
);

// While a turn is active, available details are open by default and pending
// status remains part of the semantic group instead of a transient print.
const liveGroupUi = makeUi();
process.stdout.write = () => true;
try {
  liveGroupUi.renderHistory([
    { type: "user", text: "live group", turnSequence: 9, at: "2026-07-18T12:09:00.000Z" },
    {
      type: "tool_call",
      toolCallId: "run-live",
      kind: "execute",
      title: "Run tests",
      status: "in_progress",
      summary: "npm test",
      turnSequence: 9,
    },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
const liveGroupCard = liveGroupUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
const liveGroupEntry = liveGroupCard.detailEntries.find((entry) => entry?.kind === "activity-group");
assert.equal(liveGroupEntry.group.status, "active");
assert.ok(
  liveGroupUi
    .transcriptEntryRows(liveGroupCard, 42)
    .map(stripAnsi)
    .some((row) => row.includes("In progress · 1 action")),
  "active header reports semantic metrics without a timer",
);
const liveGroupCardWithFile = {
  ...liveGroupCard,
  turn: { ...liveGroupCard.turn, changedFiles: ["sample.mjs"] },
};
assert.ok(
  liveGroupUi
    .transcriptEntryRows(liveGroupCardWithFile, 42)
    .map(stripAnsi)
    .some((row) => row.includes("In progress · 1 action · 1 file")),
  "active header adds known file metrics without inventing zero-valued fields",
);
assert.ok(
  liveGroupUi.transcriptEntryRows(liveGroupCard, 42).map(stripAnsi).some((row) => row.includes("npm test")),
  "live group details are open by default",
);
const liveGroupId = liveGroupEntry.group.id;
process.stdout.write = () => true;
try {
  liveGroupUi.renderHistory([
    { type: "user", text: "live group", turnSequence: 9, at: "2026-07-18T12:09:00.000Z" },
    {
      type: "tool_call",
      toolCallId: "run-live",
      kind: "execute",
      title: "Run tests",
      status: "in_progress",
      summary: "npm test",
      turnSequence: 9,
    },
    { type: "tool_update", toolCallId: "run-live", status: "completed", turnSequence: 9 },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
const updatedLiveCard = liveGroupUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
const updatedLiveGroup = updatedLiveCard.detailEntries.find((entry) => entry?.kind === "activity-group");
assert.equal(updatedLiveGroup.group.id, liveGroupId, "lifecycle updates keep stable group identity");
assert.equal(updatedLiveGroup.group.actions.length, 1, "completion updates in place");
assert.equal(updatedLiveGroup.group.status, "completed");

// File metadata stays compact after completion; the full diff remains
// available through the nested group disclosure.
const diffGroupUi = makeUi();
process.stdout.write = () => true;
try {
  diffGroupUi.renderHistory([
    { type: "user", text: "edit", turnSequence: 10, at: "2026-07-18T12:10:00.000Z" },
    {
      type: "tool_update",
      toolCallId: "edit-file",
      kind: "edit",
      title: "Edit sample.js",
      status: "completed",
      diffs: [
        {
          path: "sample.mjs",
          added: 1,
          removed: 1,
          hunks: [
            {
              rows: [
                { sign: "-", text: "const oldValue = 1;" },
                { sign: "+", text: "const newValue = 2;" },
              ],
            },
          ],
        },
      ],
      turnSequence: 10,
    },
    { type: "agent_chunk", text: "Edited.", messageId: "final", turnSequence: 10 },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 10 },
  ]);
} finally {
  process.stdout.write = originalWrite;
}
const diffGroupCard = diffGroupUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
const diffGroupEntry = diffGroupCard.detailEntries.find((entry) => entry?.kind === "activity-group");
diffGroupUi.setTurnCardExpanded(diffGroupCard.turn.id, true);
const compactDiffRows = diffGroupUi.transcriptEntryRows(diffGroupCard, 42).map(stripAnsi);
assert.ok(compactDiffRows.some((row) => row.includes("Edited · 1 file")));
assert.ok(compactDiffRows.some((row) => row.startsWith("└─ ● Edited")));
assert.ok(!compactDiffRows.some((row) => row.includes("- old")));
diffGroupUi.setActivityGroupExpanded(diffGroupCard.turn.id, diffGroupEntry.group.id, true);
const expandedDiffRows = diffGroupUi.transcriptEntryRows(diffGroupCard, 42).map(stripAnsi);
assert.ok(expandedDiffRows.some((row) => row.includes("sample.mjs (+1 -1)")));
assert.ok(expandedDiffRows.some((row) => row.includes("- const oldValue")));
assert.ok(expandedDiffRows.some((row) => row.includes("+ const newValue")));
const expandedDiffAnsi = diffGroupUi.transcriptEntryRows(diffGroupCard, 42);
const highlightedAddition = expandedDiffAnsi.find((row) => stripAnsi(row).includes("+ const newValue"));
assert.ok(highlightedAddition.includes("\x1b[38;5;78m+\x1b[0m"), "only the addition sign owns strong diff green");
assert.ok(
  highlightedAddition.includes("\x1b[38;5;176mconst\x1b[39m"),
  "diff payload reuses syntax highlighting inferred from the path",
);

ui.hoveredInteractiveKey = `turn:${card.turn.id}:toggle`;
const hovered = ui.transcriptEntryVisualRows(card, 60).find((row) => row.interactiveKey);
assert.ok(hovered.text.startsWith("\x1b[48;5;236m"), "hover uses the softer full-row background");

const activeUi = makeUi();
process.stdout.write = () => true;
try {
  activeUi.renderHistory(history.slice(0, 2));
} finally {
  process.stdout.write = originalWrite;
}
const activeCard = activeUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
const activeExpanded = activeUi.transcriptEntryRows(activeCard, 60).map(stripAnsi);
assert.ok(activeExpanded.some((row) => row.includes("▾ In progress")));
assert.ok(!activeExpanded.some((row) => row.includes("Working for")));
assert.ok(
  !activeExpanded.some((row) => row.includes("tool call")),
  "the active header does not use settled tool-call wording",
);
const activeHeaderIndex = activeExpanded.findIndex((row) => row.includes("▾ In progress"));
assert.equal(activeExpanded[activeHeaderIndex + 1], "│", "active content is separated from its header");
assert.ok(activeExpanded[activeHeaderIndex + 2].includes("I am checking."));
assert.ok(
  activeExpanded.some((row) => row.includes("I am checking.")),
  "auto reveals provisional activity while the turn is live",
);
assert.equal(
  activeUi.transcriptEntryVisualRows(activeCard, 60).filter((row) => row.interactiveKey).length,
  1,
  "live activity has one header hit region",
);
activeUi.setTurnCardExpanded(activeCard.turn.id, false);
assert.ok(
  activeUi.transcriptEntryRows(activeCard, 60).map(stripAnsi).some((row) => row.includes("▸ In progress")),
  "collapsed live activity keeps a neutral header",
);
assert.ok(
  !activeUi.transcriptEntryRows(activeCard, 60).map(stripAnsi).some((row) => row.includes("I am checking.")),
  "the live drawer can still be collapsed manually",
);
activeUi.setTurnCardExpanded(activeCard.turn.id, true);
const activeProjectionRows = activeUi.transcriptEntries.reduce(
  (total, entry) => total + activeUi.transcriptEntryRows(entry, 79).length,
  0,
);
activeUi.scrollOffsetRows = 20;

for (const event of history.slice(2)) activeUi.appendHistoryEvent(event);
activeUi.rebuildTranscriptProjection();
const settledCard = activeUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
const settledRows = activeUi.transcriptEntryRows(settledCard, 60).map(stripAnsi);
const settledProjectionRows = activeUi.transcriptEntries.reduce(
  (total, entry) => total + activeUi.transcriptEntryRows(entry, 79).length,
  0,
);
assert.ok(settledRows.some((row) => row.includes("Worked for 4s")));
assert.ok(settledRows.some((row) => row.includes("1 tool call")));
assert.ok(settledRows.some((row) => row.includes("Everything is ready.")));
assert.ok(!settledRows.some((row) => row.includes("I am checking.")), "turn_done auto-collapses activity");
assert.equal(activeUi.turnDetailOverrides.has(settledCard.turn.id), false, "settled defaults are normalized");
assert.equal(
  activeUi.scrollOffsetRows,
  Math.max(0, 20 + settledProjectionRows - activeProjectionRows),
  "automatic collapse preserves the historical scroll anchor",
);

// Codex exposes commentary/final phases while streaming. The final response
// therefore renders outside the Activity rail before turn_done and remains in
// the same semantic container after the card settles.
const phasedHistory = [
  { type: "user", text: "phase test", turnSequence: 2, at: "2026-07-18T12:01:00.000Z" },
  {
    type: "agent_chunk",
    text: "Checking details.",
    messageId: "commentary",
    messageRole: "commentary",
    turnSequence: 2,
    at: "2026-07-18T12:01:01.000Z",
  },
  {
    type: "agent_chunk",
    text: "Stable final response.",
    messageId: "answer",
    messageRole: "final",
    turnSequence: 2,
    at: "2026-07-18T12:01:02.000Z",
  },
];
const phasedUi = makeUi();
process.stdout.write = () => true;
try {
  phasedUi.renderHistory(phasedHistory);
} finally {
  process.stdout.write = originalWrite;
}
const phasedActiveCard = phasedUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
const phasedActiveRows = phasedUi.transcriptEntryRows(phasedActiveCard, 60).map(stripAnsi);
const liveFinalRow = phasedActiveRows.find((row) => row.includes("Stable final response."));
assert.ok(liveFinalRow, "the explicit final answer is visible while the turn is active");
assert.ok(!liveFinalRow.startsWith("│"), "the explicit final answer is outside Activity's rail");
assert.ok(
  phasedActiveRows.some((row) => row.startsWith("│    ") && row.includes("Checking details.")),
  "commentary remains inside Activity's rail",
);
const liveFinalEntries = structuredClone(phasedActiveCard.finalEntries);

phasedUi.appendHistoryEvent({
  type: "turn_done",
  stopReason: "end_turn",
  turnSequence: 2,
  durationMs: 3000,
  at: "2026-07-18T12:01:03.000Z",
});
phasedUi.rebuildTranscriptProjection();
const phasedSettledCard = phasedUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
assert.deepEqual(
  phasedSettledCard.finalEntries,
  liveFinalEntries,
  "turn_done does not reclassify or rebuild the final response container",
);
const settledFinalRow = phasedUi
  .transcriptEntryRows(phasedSettledCard, 60)
  .map(stripAnsi)
  .find((row) => row.includes("Stable final response."));
assert.equal(
  settledFinalRow,
  liveFinalRow,
  "the final response keeps the same width and wrapping after Activity collapses",
);

assert.equal(
  ui.turnCardDuration({
    durationMs: null,
    startedAt: "2026-07-18T12:00:00.000Z",
    completedAt: "2026-07-18T12:00:06.500Z",
  }),
  6500,
  "null duration falls back to settled timestamps instead of becoming zero",
);
const fastOutcome = {
  ...settledCard,
  turn: { ...settledCard.turn, durationMs: 450 },
};
assert.ok(
  ui.transcriptEntryRows(fastOutcome, 60).map(stripAnsi).some((row) => row.includes("Worked for <1s")),
  "sub-second completed turns never regress to a misleading 0s label",
);

const emptyActiveUi = makeUi();
process.stdout.write = () => true;
try {
  emptyActiveUi.renderHistory(history.slice(0, 1));
} finally {
  process.stdout.write = originalWrite;
}
const emptyActiveCard = emptyActiveUi.transcriptEntries.find(
  (entry) => entry?.kind === "turn-card",
);
assert.deepEqual(
  emptyActiveUi.transcriptEntryRows(emptyActiveCard, 60),
  [],
  "a submitted prompt leaves thinking as the only visible live status until activity exists",
);
const emptyUserIndex = emptyActiveUi.transcriptEntries.findIndex(
  (entry) => entry?.kind === "user",
);
const emptyCardIndex = emptyActiveUi.transcriptEntries.indexOf(emptyActiveCard);
assert.equal(
  emptyCardIndex,
  emptyUserIndex + 1,
  "an empty live card does not leave a standalone separator after the submitted prompt",
);
const emptyTail = emptyActiveUi.collectTranscriptRowsFromEnd(79, 3).rows.map(stripAnsi);
assert.match(
  emptyTail.find((row) => /do it/.test(row)) || "",
  /do it/,
  "the submitted prompt remains the last visible block until real activity arrives",
);
assert.equal(
  emptyTail.at(-1).slice(1).trim(),
  "",
  "the prompt block retains shaded bottom padding behind its edge rail while waiting for activity",
);
Object.assign(emptyActiveUi.currentChat, {
  status: "working",
  turnActive: true,
  turnSequence: 1,
  planSupported: true,
  mode: "plan",
  plan: null,
});
Object.assign(emptyActiveUi, {
  cwd: "/repo/demo",
  pendingAttachments: [],
  pendingPermission: null,
  composerAnimationFrame: 0,
  inlinePicker: null,
  lastRawInputLayout: null,
  planPinMode: "auto",
  planCompletedBehavior: "collapse",
  planAwaitingPolicy: "auto",
  planExpanded: false,
});
const awaitingLayout = emptyActiveUi.rawInputLayout({ pinned: true, line: "", cursor: 0 });
assert.equal(awaitingLayout.planRows, 0, "awaiting Plan is summarized by the smart header");
assert.equal(awaitingLayout.gapRow, awaitingLayout.outputBottom);
assert.match(stripAnsi(emptyActiveUi.composerHeaderLine(79)), /Plan.*Awaiting agent plan/);

const emptyProjectionRows = emptyActiveUi.transcriptEntries.reduce(
  (total, entry) => total + emptyActiveUi.transcriptEntryRows(entry, 79).length,
  0,
);
emptyActiveUi.scrollOffsetRows = 7;
emptyActiveUi.appendHistoryEvent(history[1]);
emptyActiveUi.rebuildTranscriptProjection();
const newlyVisibleCard = emptyActiveUi.transcriptEntries.find(
  (entry) => entry?.kind === "turn-card",
);
const newlyVisibleRows = emptyActiveUi.transcriptEntryRows(newlyVisibleCard, 60).map(stripAnsi);
assert.equal(newlyVisibleRows[0], "", "visible Activity owns exactly one leading separator");
assert.match(newlyVisibleRows[1], /In progress/);
assert.equal(newlyVisibleRows[2], "│", "the header owns one internal rail spacer");
assert.match(
  newlyVisibleRows[3],
  /^│ /,
  "expanded Activity content follows the normalized spacer",
);
const visibleProjectionRows = emptyActiveUi.transcriptEntries.reduce(
  (total, entry) => total + emptyActiveUi.transcriptEntryRows(entry, 79).length,
  0,
);
assert.equal(
  emptyActiveUi.scrollOffsetRows,
  7 + visibleProjectionRows - emptyProjectionRows,
  "the empty-to-visible Activity transition preserves the historical scroll anchor",
);

for (const [status, label] of [
  ["error", "Failed after 2s"],
  ["cancelled", "Cancelled after 2s"],
  ["partial", "Stopped after 2s"],
]) {
  const outcome = {
    ...settledCard,
    turn: { ...settledCard.turn, status, durationMs: 2500 },
  };
  assert.ok(
    ui.transcriptEntryRows(outcome, 60).map(stripAnsi).some((row) => row.includes(label)),
    `${status} uses its settled duration label`,
  );
}

// A completed response containing a compact card is projected off-screen and
// committed exactly once. The code-card finalizer must not expose the partial
// capture before rebuildTranscriptProjection reaches its canonical commit.
{
  const frameUi = makeUi();
  frameUi.historyEvents = [
    { type: "user", text: "show config", turnSequence: 11 },
    {
      type: "agent_chunk",
      messageId: "answer",
      messageRole: "final",
      text: "Result:\n\n```tmux\nset -g @acp_hub_mouse on\n```\n",
      turnSequence: 11,
    },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 11, durationMs: 1200 },
  ];
  frameUi.transcriptRevision = 3;
  frameUi.projectedTranscriptRevision = 2;
  frameUi.turnCardProjectionCache = new Map();
  frameUi.activityGroupOverrides = new Map();
  frameUi.pendingPromptSubmissions = new Map();
  frameUi.lastRawScrollBottom = 20;
  let commits = 0;
  frameUi.repaintPinnedOutput = () => {
    assert.equal(frameUi.transcriptRenderPhase, "live");
    assert.equal(frameUi.transcriptProjectionDepth, 0);
    commits += 1;
  };

  frameUi.rebuildTranscriptProjection();

  assert.equal(commits, 1, "the completed code card reaches the terminal in one canonical commit");
  const frameCard = frameUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
  assert.ok(frameCard?.finalEntries.some((entry) => entry?.kind === "code-block"));
}

// Active turn cards inherit the streaming Markdown snapshot policy. A table's
// first pipe remains pending until the separator confirms the structure, then
// the same final-answer container exposes the semantic table progressively.
{
  const tableUi = makeUi();
  const tableHistory = [
    { type: "user", text: "show versions", turnSequence: 12 },
    {
      type: "agent_chunk",
      messageId: "table-answer",
      messageRole: "final",
      text: "Versions:\n\n|",
      turnSequence: 12,
    },
  ];
  process.stdout.write = () => true;
  try {
    tableUi.renderHistory(tableHistory);
  } finally {
    process.stdout.write = originalWrite;
  }
  let tableCard = tableUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
  assert.ok(tableCard.finalEntries.some((entry) => entry?.kind === "prose" && entry.text === "Versions:"));
  assert.ok(
    !tableCard.finalEntries.some(
      (entry) => entry?.kind === "prose" && /^\s*\|/.test(stripAnsi(entry.text)),
    ),
    "the ACP turn card never exposes the provisional table rail",
  );

  tableUi.appendHistoryEvent({
    type: "agent_chunk",
    messageId: "table-answer",
    messageRole: "final",
    text: " Name | Version |\n|---|---|\n| hub | 0.2 |\nadap",
    turnSequence: 12,
  });
  tableUi.rebuildTranscriptProjection();
  tableCard = tableUi.transcriptEntries.find((entry) => entry?.kind === "turn-card");
  const streamedTable = tableCard.finalEntries.find((entry) => entry?.kind === "table");
  assert.deepEqual(
    streamedTable?.sourceLines,
    ["| Name | Version |", "|---|---|", "| hub | 0.2 |"],
  );
  assert.ok(
    !tableCard.finalEntries.some(
      (entry) => entry?.kind === "prose" && /adap/.test(stripAnsi(entry.text)),
    ),
    "the incomplete next row remains pending inside the integrated projection",
  );
}

// F3 owns turn details; Ctrl+O keeps its established chat-menu action.
{
  const keyUi = makeUi();
  keyUi.planExpanded = false;
  keyUi.planShortcut = "C-p";
  keyUi.turnDetailsShortcut = "F3";
  keyUi.inlinePicker = null;
  keyUi.vimEnabled = false;
  keyUi.pendingAttachments = [];
  keyUi.consumeRawMouseKeypress = () => false;
  keyUi.handleAutocompleteKey = () => false;
  keyUi.handleRawHistorySearchKey = () => false;
  keyUi.handleBracketedPasteKey = () => false;
  keyUi.handleRawEscapePrefix = () => false;
  keyUi.shouldInsertRawNewline = () => false;
  let detailToggles = 0;
  let menuOpens = 0;
  keyUi.toggleLatestTurnDetails = () => {
    detailToggles += 1;
    return true;
  };
  keyUi.triggerMenuFromComposer = () => {
    menuOpens += 1;
    return true;
  };
  const draft = { line: "draft", cursor: 5, pinned: true };
  keyUi.handleRawKeypress(draft, "", { name: "f3" }, () => {});
  keyUi.handleRawKeypress(draft, "\x0f", { name: "o", ctrl: true }, () => {});
  assert.equal(detailToggles, 1);
  assert.equal(menuOpens, 1);
}

console.log("turn card render tests passed");
