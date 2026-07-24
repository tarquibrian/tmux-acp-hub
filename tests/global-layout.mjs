#!/usr/bin/env node

import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 19;
process.stdout.rows = 30;
delete process.env.TMUX;

const { PopupUi } = await import("../bin/acp-hub.mjs");
const { stripAnsi, stringDisplayWidth } = await import("../lib/render.mjs");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    markdownFence: false,
    markdownFenceLang: "",
    chunkBuffer: "",
    chunkBufferMarkdown: false,
    chunkBufferDim: false,
    pendingResponseBreak: false,
    lastStreamEventKey: "",
    questionActive: false,
    rawInput: null,
    closed: false,
    transcriptEntries: [""],
    activityMode: "compact",
    showInternalEvents: false,
    lastPlanSignature: "",
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    mdHeldLine: null,
    liveTable: null,
    liveTablePaintTimer: null,
    liveTablePaintPending: false,
    lastRawScrollBottom: null,
    activePicker: null,
  });
  return ui;
}

function renderStream(text, chunkSize) {
  const ui = makeUi();
  const original = process.stdout.write;
  process.stdout.write = () => true;
  try {
    for (let index = 0; index < text.length; index += chunkSize) {
      ui.renderResponseChunk({ text: text.slice(index, index + chunkSize), messageId: "m1" });
    }
    ui.flushChunkBuffer({ force: true });
  } finally {
    process.stdout.write = original;
  }
  return ui;
}

const response =
  "123456789012 palabra final\n\n" +
  "- una lista bastante larga para envolver correctamente\n" +
  "> una cita bastante larga para envolver correctamente\n\n" +
  "| Name | Type |\n" +
  "|---|---|\n" +
  "| a-much-longer-name | directory |\n\n" +
  "```js\n" +
  "const palabraMuyLarga = 1234567890;\n" +
  "```\n" +
  "After code.\n";

const ui = renderStream(response, 5);
const entries = ui.transcriptEntries.filter((entry) => entry && typeof entry === "object");

// Agent prose is stored semantically and reflows without splitting words.
const paragraph = entries.find((entry) => entry.kind === "prose" && !entry.firstPrefix);
assert.ok(paragraph, "plain agent paragraph stored as prose");
assert.deepEqual(ui.transcriptEntryRows(paragraph, 18).map(stripAnsi), [
  "123456789012",
  "palabra final",
]);
assert.equal(ui.transcriptEntryRows(paragraph, 30).length, 1, "resize reflows original prose");

// Markdown prefixes survive on every continuation with hanging indentation.
const list = entries.find((entry) => entry.kind === "prose" && stripAnsi(entry.firstPrefix || "").includes("-"));
assert.ok(list, "list entry remains semantic");
const listRows = ui.transcriptEntryRows(list, 18).map(stripAnsi);
assert.ok(listRows[0].startsWith("- "));
assert.ok(listRows.slice(1).every((row) => row.startsWith("  ")));

const quote = entries.find((entry) => entry.kind === "prose" && stripAnsi(entry.firstPrefix || "").includes("|"));
assert.ok(quote, "quote entry remains semantic");
assert.ok(ui.transcriptEntryRows(quote, 18).map(stripAnsi).every((row) => row.startsWith("| ")));

// Tables and fenced code retain semantic source for resize.
const table = entries.find((entry) => entry.kind === "table");
assert.ok(table && table.sourceLines.length === 3, "table source retained in one semantic entry");
for (const width of [18, 30]) {
  assert.ok(
    ui.transcriptEntryRows(table, width).every((row) => stringDisplayWidth(row) <= width),
    `table respects width ${width}`,
  );
}

const code = entries.find((entry) => entry.kind === "code-block");
assert.ok(code, "fenced code stored as one semantic block");
assert.equal(code.lang, "js");
assert.deepEqual(code.lines, ["const palabraMuyLarga = 1234567890;"]);
const codeIndex = ui.transcriptEntries.indexOf(code);
assert.ok(codeIndex >= 0);
assert.ok(
  ui.transcriptEntryIsBlank(ui.transcriptEntries[codeIndex - 1]),
  "compact code preserves one Markdown separator above",
);
assert.ok(
  !ui.transcriptEntryIsBlank(ui.transcriptEntries[codeIndex + 1]),
  "compact code uses its own bottom spacer instead of an external blank",
);
const codeRows = ui.transcriptEntryRows(code, 18);
assert.ok(codeRows.length > 1, "long code uses hard wrapping");
assert.ok(codeRows.every((row) => row.startsWith("\x1b[48;5;235m")), "every code row keeps its background");
assert.ok(codeRows.every((row) => stringDisplayWidth(row) === 18), "code background is padded to full width");
const wideCodeRows = ui.transcriptEntryRows(
  { kind: "code-block", lang: "text", lines: ["Plan 5/5", "ok"] },
  40,
);
assert.ok(wideCodeRows.every((row) => stringDisplayWidth(row) === 12));
assert.ok(wideCodeRows.every((row) => stringDisplayWidth(row) < 40));

// Adjacent compact fences preserve exactly one external separator between
// their internally padded rectangles.
{
  const adjacent = renderStream("```text\none\n```\n\n```tmux\nset -g status on\n```\n", 3);
  const meaningful = adjacent.transcriptEntries.filter(
    (entry) => !adjacent.transcriptEntryIsBlank(entry),
  );
  assert.deepEqual(meaningful.map((entry) => entry.kind), ["code-block", "code-block"]);
  const first = adjacent.transcriptEntries.indexOf(meaningful[0]);
  const second = adjacent.transcriptEntries.indexOf(meaningful[1]);
  assert.equal(second, first + 2, "exactly one external blank remains between compact cards");
}

// Stream chunk boundaries do not change semantic layout.
const oneChunk = renderStream(response, response.length);
const rows = (instance) =>
  instance.transcriptEntries.flatMap((entry) => instance.transcriptEntryRows(entry, 18)).map(stripAnsi);
assert.deepEqual(rows(ui), rows(oneChunk));

// Scroll collection lays out semantic rows at the requested viewport width.
const collected = ui.collectTranscriptRowsFromEnd(18, 200, 0).rows.map(stripAnsi);
const expectedCollected = rows(ui);
while (expectedCollected.at(-1) === "") expectedCollected.pop();
assert.deepEqual(collected, expectedCollected);

// Reasoning/debug prose and plan entries use the same word policy.
const auxiliary = makeUi();
auxiliary.activityMode = "debug";
const original = process.stdout.write;
process.stdout.write = () => true;
try {
  auxiliary.renderThoughtChunk({
    text: "123456789012 pensamiento completo\n",
    messageId: "thought-1",
  });
  auxiliary.flushChunkBuffer({ force: true });
  auxiliary.renderPlan(
    [{ status: "pending", content: "123456789012 palabra completa dentro del plan" }],
    { replay: true },
  );
} finally {
  process.stdout.write = original;
}
const thought = auxiliary.transcriptEntries.find((entry) => entry?.kind === "prose" && entry.dim);
assert.deepEqual(auxiliary.transcriptEntryRows(thought, 18).map(stripAnsi), [
  "123456789012",
  "pensamiento",
  "completo",
]);
const plan = auxiliary.transcriptEntries.find(
  (entry) => entry?.kind === "prose" && stripAnsi(entry.firstPrefix || "").includes("·"),
);
assert.ok(plan, "plan content is semantic prose");
const planRows = auxiliary.transcriptEntryRows(plan, 18).map(stripAnsi);
assert.ok(planRows.some((row) => row.trim() === "palabra"), "plan keeps palabra intact");
assert.ok(!planRows.some((row) => /pala$|^\s*bra/.test(row)), "plan never splits palabra");

const permissionUi = makeUi();
process.stdout.write = () => true;
try {
  permissionUi.renderPermission({
    toolCall: { title: "full authorization to edit files", kind: "edit" },
    options: [{ name: "Permitir una vez" }],
  });
} finally {
  process.stdout.write = original;
}
assert.equal(
  permissionUi.transcriptEntries.length,
  1,
  "normal transcript leaves a pending permission to the composer shelf",
);
permissionUi.showInternalEvents = true;
process.stdout.write = () => true;
try {
  permissionUi.renderPermission({
    toolCall: { title: "full authorization to edit files", kind: "edit" },
    options: [{ name: "Permitir una vez" }],
  });
} finally {
  process.stdout.write = original;
}
const permission = permissionUi.transcriptEntries.find(
  (entry) => entry?.kind === "prose" && stripAnsi(entry.firstPrefix || "").includes("Permission"),
);
const permissionRows = permissionUi.transcriptEntryRows(permission, 18).map(stripAnsi);
assert.ok(permissionRows.every((row) => stringDisplayWidth(row) <= 18));
assert.ok(permissionRows.some((row) => row.includes("authorization")), "long card prefix yields to a full word");
assert.ok(!permissionRows.some((row) => /autorizaci$|^▎ on/.test(row)), "permission title is not split");

console.log("global layout test passed");
