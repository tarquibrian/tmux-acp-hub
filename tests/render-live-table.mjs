#!/usr/bin/env node
// Regression test: with the pinned composer layout active, a streamed markdown
// table must render progressively (each completed row appears as it arrives,
// re-rendered in place as column widths grow) instead of buffering until the
// table ends. Also guards the transcript buffer against raw pipe rows.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;

const { PopupUi } = await import("../bin/acp-hub.mjs");

const strip = (value) => String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    markdownFence: false,
    chunkBuffer: "",
    chunkBufferMarkdown: false,
    chunkBufferDim: false,
    pendingResponseBreak: false,
    lastStreamEventKey: "",
    questionActive: false,
    rawInput: null,
    closed: false,
    transcriptLines: [""],
    activityMode: "compact",
    showInternalEvents: false,
    lastActivityGroup: "",
    activityGroupLineCount: 0,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    mdHeldLine: null,
    liveTable: null,
    liveTablePaintTimer: null,
    liveTablePaintPending: false,
    // Pinned scroll region active: enables the progressive table machine.
    lastRawScrollBottom: 24,
  });
  return ui;
}

function captureStdout(fn) {
  let captured = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

const transcriptText = (ui) => strip(ui.transcriptLines.join("\n"));

// --- Progressive rendering ---------------------------------------------------
{
  const ui = makeUi();
  const feed = (text) => captureStdout(() => ui.renderResponseChunk({ text, messageId: "m1" }));

  feed("Summary:\n\n| Name | Type |\n");
  assert.equal(ui.mdHeldLine, "| Name | Type |", "table header is held until the separator arrives");
  assert.ok(transcriptText(ui).includes("Summary:"), "prose before the table flushes immediately");
  assert.ok(!transcriptText(ui).includes("| Name"), "held header is not in the transcript yet");

  feed("|---|---|\n");
  assert.ok(ui.liveTable, "live table starts after header + separator");
  assert.match(transcriptText(ui), /Name\s+Type/, "formatted header rendered before any body row");
  assert.ok(!transcriptText(ui).includes("|---"), "separator never renders raw");

  const screenAfterFirstRow = feed("| .claude | dir |\n");
  assert.match(transcriptText(ui), /\.claude\s+dir/, "first body row rendered as soon as it completed");
  assert.match(strip(screenAfterFirstRow), /\.claude/, "first body row painted to the screen immediately");
  assert.ok(!transcriptText(ui).includes("| .claude"), "body row not raw in transcript");

  feed("| a-much-longer-name-entry | directory |\n");
  assert.match(
    transcriptText(ui),
    /a-much-longer-name-entry\s+directory/,
    "wider row re-renders the block with recomputed widths",
  );
  const headerLine = ui.transcriptLines.find((line) => strip(line).includes("Name"));
  const wideLine = ui.transcriptLines.find((line) => strip(line).includes("a-much-longer-name-entry"));
  assert.ok(headerLine && wideLine, "table block lines exist in the transcript");

  feed("\nDone.\n");
  assert.equal(ui.liveTable, null, "table finalizes on the first non-table line");
  assert.ok(transcriptText(ui).includes("Done."), "prose after the table renders");

  captureStdout(() => ui.flushChunkBuffer({ force: true }));
  assert.equal(ui.mdHeldLine, null);
  assert.equal(ui.liveTable, null);
}

// --- Held row that never becomes a table -------------------------------------
{
  const ui = makeUi();
  const feed = (text) => captureStdout(() => ui.renderResponseChunk({ text, messageId: "m1" }));

  feed("costs 3 | 4 euros\n");
  assert.equal(ui.mdHeldLine, "costs 3 | 4 euros", "pipe-looking prose is held one line");
  feed("plain text follows\n");
  assert.equal(ui.mdHeldLine, null);
  assert.ok(transcriptText(ui).includes("costs 3 | 4 euros"), "held prose renders as-is");
  assert.ok(transcriptText(ui).includes("plain text follows"));
}

// --- Force flush renders a dangling held row ---------------------------------
{
  const ui = makeUi();
  const feed = (text) => captureStdout(() => ui.renderResponseChunk({ text, messageId: "m1" }));

  feed("| Col A | Col B |\n");
  assert.equal(ui.mdHeldLine, "| Col A | Col B |");
  captureStdout(() => ui.flushChunkBuffer({ force: true }));
  assert.equal(ui.mdHeldLine, null);
  assert.ok(transcriptText(ui).includes("| Col A | Col B |"), "dangling header renders as plain text at turn end");
}

// --- Code fences suspend table detection --------------------------------------
{
  const ui = makeUi();
  const feed = (text) => captureStdout(() => ui.renderResponseChunk({ text, messageId: "m1" }));

  feed("```sql\n| not | a | table |\n```\n");
  assert.equal(ui.liveTable, null);
  assert.ok(transcriptText(ui).includes("| not | a | table |"), "fenced content passes through raw");
  assert.equal(ui.markdownFence, false, "fence closed");
}

// --- Fenced code renders as a shaded band --------------------------------------
{
  const ui = makeUi();
  const feed = (text) => captureStdout(() => ui.renderResponseChunk({ text, messageId: "m1" }));

  const painted = feed("```python\nprint('hi')\n```\nDone.\n");
  assert.ok(painted.includes("\x1b[48;5;235m"), "code lines carry the shaded background");
  assert.ok(transcriptText(ui).includes("python"), "language header inside the band");
  assert.ok(!transcriptText(ui).includes("[python]"), "bracket tag is gone");
  assert.ok(transcriptText(ui).includes("print('hi')"), "code content intact");
  assert.ok(!strip(painted).includes("```"), "fence markers never render");
}

console.log("render-live-table test passed");
