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
const { stringDisplayWidth } = await import("../lib/render.mjs");

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
    transcriptEntries: [""],
    activityMode: "compact",
    showInternalEvents: false,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    mdHeldLine: null,
    liveCodeBlock: null,
    liveCodeBlockPaintTimer: null,
    liveCodeBlockPaintPending: false,
    liveTable: null,
    liveTablePaintTimer: null,
    liveTablePaintPending: false,
    suppressTranscriptPaint: false,
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

const transcriptRows = (ui, width = 99) =>
  ui.transcriptEntries.flatMap((entry) => ui.transcriptEntryRows(entry, width));
const transcriptText = (ui) => strip(transcriptRows(ui).join("\n"));

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
  const headerLine = transcriptRows(ui).find((line) => strip(line).includes("Name"));
  const wideLine = transcriptRows(ui).find((line) => strip(line).includes("a-much-longer-name-entry"));
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
  const blocks = ui.transcriptEntries.filter((entry) => entry?.kind === "code-block");
  assert.equal(blocks.length, 1, "a fence is retained as one semantic block");
  assert.equal(blocks[0].lang, "python");
  assert.deepEqual(blocks[0].lines, ["print('hi')"]);
  const compact = ui.transcriptEntryRows(blocks[0], 50);
  assert.ok(compact.every((row) => stringDisplayWidth(row) < 50));
  assert.equal(new Set(compact.map((row) => stringDisplayWidth(row))).size, 1);

  const preview = ui.renderMarkdownDetached("```text\nPlan 5/5\nok\n```", 50).split("\n");
  assert.ok(preview.every((row) => stringDisplayWidth(row) < 50));
  assert.equal(new Set(preview.map((row) => stringDisplayWidth(row))).size, 1);
}

// --- Projection capture is side-effect free ----------------------------------
// Turn cards are assembled in a temporary transcript before the canonical
// viewport is committed. Fenced code and tables must remain semantic-only in
// that phase: painting the temporary buffer produces a visible one-frame flash.
{
  const ui = makeUi();
  let repaints = 0;
  ui.repaintPinnedOutput = () => {
    repaints += 1;
  };

  const codeOutput = captureStdout(() => {
    const entries = ui.captureEventEntries([{
      type: "agent_chunk",
      messageId: "final-code",
      text: "```tmux\nset -g @acp_hub_mouse on\n```\n",
    }]);
    assert.ok(entries.some((entry) => entry?.kind === "code-block"));
  });
  assert.equal(codeOutput, "", "capturing a compact code card never writes to stdout");
  assert.equal(repaints, 0, "capturing a compact code card never repaints the viewport");

  const tableOutput = captureStdout(() => {
    const entries = ui.captureEventEntries([{
      type: "agent_chunk",
      messageId: "final-table",
      text: "| Current | New |\n|---|---|\n| 1.0 | 1.1 |\n\n",
    }]);
    assert.ok(entries.some((entry) => entry?.kind === "table"));
  });
  assert.equal(tableOutput, "", "capturing a table never writes a temporary frame");
  assert.equal(repaints, 0, "capturing a table never repaints the viewport");

  ui.scrollOffsetRows = 6;
  ui.scrollNewRows = 2;
  ui.rawInput = { pinned: true, line: "", cursor: 0 };
  let composerRenders = 0;
  ui.renderRawInput = () => {
    composerRenders += 1;
  };
  captureStdout(() => ui.captureEventEntries([{
    type: "agent_chunk",
    messageId: "scrolled-code",
    text: "```text\nscrolled capture\n```\n",
  }]));
  assert.equal(ui.scrollNewRows, 2, "off-screen capture does not count false scrollback rows");
  assert.equal(composerRenders, 0, "off-screen capture does not repaint the scrolled composer");
}

// --- Active-turn Markdown snapshots -----------------------------------------
// A leading pipe is ambiguous until the header separator arrives. Active
// projections retain that fragment instead of flashing it as prose, while
// ordinary partial prose and confirmed table rows remain progressive.
{
  const ui = makeUi();
  const captureStreaming = (text) => ui.captureEventEntries([{
    type: "agent_chunk",
    messageId: "streaming-answer",
    text,
  }], { streaming: true });

  const lonePipe = captureStreaming("Intro.\n\n|");
  assert.ok(lonePipe.some((entry) => entry?.kind === "prose" && entry.text === "Intro."));
  assert.ok(
    !lonePipe.some((entry) => entry?.kind === "prose" && /^\s*\|/.test(strip(entry.text))),
    "a partial table rail stays hidden until its structure is known",
  );

  const partialHeader = captureStreaming("| Name | Type |");
  assert.equal(partialHeader.length, 0, "an unterminated table header remains a candidate");

  const completeHeader = captureStreaming("| Name | Type |\n");
  assert.equal(completeHeader.length, 0, "a header waits for its separator during an active turn");

  const partialSeparator = captureStreaming("| Name | Type |\n---");
  assert.equal(
    partialSeparator.length,
    0,
    "a partial separator cannot force the held header back into provisional prose",
  );

  const confirmed = captureStreaming(
    "| Name | Type |\n|---|---|\n| one | file |\npartial",
  );
  const tableEntry = confirmed.find((entry) => entry?.kind === "table");
  assert.deepEqual(
    tableEntry?.sourceLines,
    ["| Name | Type |", "|---|---|", "| one | file |"],
    "confirmed rows render progressively while the incomplete row stays pending",
  );
  assert.ok(
    !confirmed.some((entry) => entry?.kind === "prose" && /partial/.test(strip(entry.text))),
    "a confirmed table retains the next row even before its first pipe arrives",
  );

  const prose = captureStreaming("ordinary partial prose");
  assert.ok(
    prose.some((entry) => entry?.kind === "prose" && entry.text === "ordinary partial prose"),
    "normal prose keeps its word-by-word snapshot",
  );

  const fenced = captureStreaming("```text\n| literal code");
  const codeEntry = fenced.find((entry) => entry?.kind === "code-block");
  assert.deepEqual(codeEntry?.lines, ["| literal code"], "pipes inside code are never table candidates");

  const settledPipe = ui.captureEventEntries([{
    type: "agent_chunk",
    messageId: "settled-answer",
    text: "|",
  }]);
  assert.ok(
    settledPipe.some((entry) => entry?.kind === "prose" && entry.text === "|"),
    "turn completion releases an unconfirmed candidate as literal prose",
  );

  const growingTable = "| Name | Type |\n|---|---|\n| hub | plugin |\n";
  for (let end = 1; end <= growingTable.length; end += 1) {
    const snapshot = captureStreaming(growingTable.slice(0, end));
    assert.ok(
      !snapshot.some(
        (entry) => entry?.kind === "prose" && /^\s*\|/.test(strip(entry.text)),
      ),
      `prefix ${end} never exposes a raw leading pipe`,
    );
  }
}

// A failed semantic capture must restore both the live transcript and the
// render transaction. Otherwise one malformed event can leave every later
// frame suppressed or expose the temporary capture buffer.
{
  const ui = makeUi();
  const stableEntries = [{ kind: "prose", text: "stable transcript" }];
  ui.transcriptEntries = stableEntries;
  ui.transcriptProjectionDepth = 0;
  ui.transcriptRenderPhase = "live";
  const renderEvent = ui.renderEvent;
  ui.renderEvent = () => {
    throw new Error("synthetic projection failure");
  };
  assert.throws(
    () => ui.captureEventEntries([{ type: "agent_chunk", text: "ignored" }]),
    /synthetic projection failure/,
  );
  ui.renderEvent = renderEvent;
  assert.equal(ui.transcriptEntries, stableEntries, "the canonical transcript is restored");
  assert.equal(ui.transcriptProjectionDepth, 0, "projection nesting is restored");
  assert.equal(ui.transcriptRenderPhase, "live", "the renderer returns to its live phase");
  assert.equal(ui.suppressTranscriptPaint, false, "later terminal commits remain enabled");
}

// A timer retained by the event loop from an older code card must not repaint
// a newer block or clear its timer slot.
{
  const callbacks = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => {
    const timer = { callback, unref() {} };
    callbacks.push(timer);
    return timer;
  };
  globalThis.clearTimeout = () => {};
  try {
    const ui = makeUi();
    let repaints = 0;
    ui.repaintPinnedOutput = () => {
      repaints += 1;
    };
    ui.paintTranscriptRows = () => {};

    ui.startLiveCodeBlock("text");
    ui.liveCodeBlock.entry.lines.push("old");
    ui.scheduleLiveCodeBlockPaint();
    ui.scheduleLiveCodeBlockPaint();
    ui.finalizeLiveCodeBlock();

    ui.startLiveCodeBlock("text");
    ui.liveCodeBlock.entry.lines.push("new");
    ui.scheduleLiveCodeBlockPaint();
    ui.scheduleLiveCodeBlockPaint();
    const currentTimer = ui.liveCodeBlockPaintTimer;
    const beforeOrphan = repaints;
    callbacks[0].callback();

    assert.equal(repaints, beforeOrphan, "an orphaned callback cannot repaint the new card");
    assert.equal(
      ui.liveCodeBlockPaintTimer,
      currentTimer,
      "an orphaned callback cannot clear the new card timer",
    );
    ui.finalizeLiveCodeBlock();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

// Tables use the same block identity rule: an orphaned timer cannot consume a
// pending paint that belongs to the next table.
{
  const callbacks = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => {
    const timer = { callback, unref() {} };
    callbacks.push(timer);
    return timer;
  };
  globalThis.clearTimeout = () => {};
  try {
    const ui = makeUi();
    let paints = 0;
    ui.paintTranscriptRows = () => {};
    ui.paintLiveTable = () => {
      paints += 1;
    };

    ui.startLiveTable(["| Old |", "|---|"]);
    ui.scheduleLiveTablePaint();
    ui.scheduleLiveTablePaint();
    ui.finalizeLiveTable();

    ui.startLiveTable(["| New |", "|---|"]);
    ui.scheduleLiveTablePaint();
    ui.scheduleLiveTablePaint();
    const currentTimer = ui.liveTablePaintTimer;
    const beforeOrphan = paints;
    callbacks[0].callback();

    assert.equal(paints, beforeOrphan, "an orphaned callback cannot repaint the new table");
    assert.equal(ui.liveTablePaintTimer, currentTimer, "the new table keeps its timer slot");
    ui.finalizeLiveTable();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

// Closing an already-current block is a semantic transition, not another
// visual frame. Only pending content may trigger the final paint.
{
  const codeUi = makeUi();
  let codeRepaints = 0;
  codeUi.paintTranscriptRows = () => {};
  codeUi.repaintPinnedOutput = () => {
    codeRepaints += 1;
  };
  codeUi.startLiveCodeBlock("text");
  codeUi.liveCodeBlock.entry.lines.push("stable");
  codeUi.scheduleLiveCodeBlockPaint();
  const beforeCodeFinalize = codeRepaints;
  codeUi.finalizeLiveCodeBlock();
  assert.equal(
    codeRepaints,
    beforeCodeFinalize,
    "closing an unchanged code card does not repaint it twice",
  );

  const tableUi = makeUi();
  captureStdout(() => tableUi.startLiveTable(["| A | B |", "|---|---|"]));
  tableUi.liveTable.sourceLines.push("| 1 | 2 |");
  captureStdout(() => tableUi.scheduleLiveTablePaint());
  const tableFinalizeOutput = captureStdout(() => tableUi.finalizeLiveTable());
  assert.equal(tableFinalizeOutput, "", "closing an unchanged table emits no duplicate frame");
}

console.log("render-live-table test passed");
