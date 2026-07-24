#!/usr/bin/env node

import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 40;
process.stdout.rows = 20;
delete process.env.TMUX;

const { PopupUi } = await import("../bin/acp-hub.mjs");
const { stringDisplayWidth, stripAnsi } = await import("../lib/render.mjs");

function makeUi() {
  return Object.assign(Object.create(PopupUi.prototype), {
    currentChat: { id: "c1", provider: "codex", projectName: "demo", status: "thinking" },
    transcriptEntries: [],
    transcriptPadding: 1,
    promptPadding: 1,
    turnDetailOverrides: new Map(),
    turnDetailsMode: "auto",
    hoveredInteractiveKey: "",
    interactiveRegions: [],
    lastTranscriptFrame: null,
    projectedTranscriptRevision: 0,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    rawInput: null,
    activePicker: null,
    pendingPermission: null,
    pendingAttachments: [],
    planPinMode: "auto",
    planCompletedBehavior: "collapse",
    planExpanded: false,
    composerAnimationFrame: 0,
    vimEnabled: false,
    cwd: "/tmp/demo",
  });
}

class RecordingPainter {
  constructor() {
    this.operations = [];
  }

  to(column, row) {
    this.operations.push(["to", column, row]);
    return this;
  }

  clearLine() {
    this.operations.push(["clear"]);
    return this;
  }

  text(value) {
    this.operations.push(["text", String(value)]);
    return this;
  }
}

const clearCount = (painter) =>
  painter.operations.filter(([operation]) => operation === "clear").length;

// A stale layout callback cannot paint an older semantic model over a newer
// submit/cancel frame.
{
  const ui = makeUi();
  ui.transcriptEntries = [{ kind: "prose", text: "newest" }];
  ui.projectedTranscriptRevision = 7;
  const current = new RecordingPainter();
  ui.paintTranscriptViewport(current, 4, 12);
  assert.equal(ui.lastTranscriptFrame.modelRevision, 7);

  ui.transcriptEntries = [{ kind: "prose", text: "stale" }];
  ui.projectedTranscriptRevision = 6;
  const stale = new RecordingPainter();
  ui.paintTranscriptViewport(stale, 4, 12);
  assert.equal(stale.operations.length, 0);
  assert.ok(ui.lastTranscriptFrame.rows.some((row) => row.includes("newest")));

  ui.transcriptEntries = [{ kind: "prose", text: "newer" }];
  ui.projectedTranscriptRevision = 8;
  const newer = new RecordingPainter();
  ui.paintTranscriptViewport(newer, 4, 12);
  assert.ok(clearCount(newer) >= 1);
  assert.ok(ui.lastTranscriptFrame.rows.some((row) => row.includes("newer")));
}

// Plain rows use a one-cell inset and wrap against the inner width.
{
  const ui = makeUi();
  const rows = ui.transcriptEntryRows({ kind: "prose", text: "123456789 palabra" }, 12);
  assert.deepEqual(rows.map(stripAnsi), [" 123456789", " palabra"]);
  assert.ok(rows.every((row) => stringDisplayWidth(row) <= 11));
}

// Full-bleed rows retain their background at both edges while their content is inset.
{
  const ui = makeUi();
  const code = ui.transcriptEntryRows({ kind: "code", text: "hello", lang: "" }, 12)[0];
  assert.ok(code.startsWith("\x1b[48;5;235m"));
  assert.equal(stringDisplayWidth(code), 12);
  assert.ok(stripAnsi(code).startsWith(" hello"));
  assert.ok(stripAnsi(code).endsWith(" "));

  const card = {
    kind: "turn-card",
    turn: { id: "t1", status: "completed", durationMs: 2000, actionCount: 1, changedFiles: [] },
    detailEntries: [{ kind: "prose", text: "detail" }],
    finalEntries: [{ kind: "prose", text: "final" }],
  };
  ui.hoveredInteractiveKey = "turn:t1:toggle";
  const header = ui.transcriptEntryVisualRows(card, 24).find((row) => row.interactiveKey).text;
  assert.ok(header.startsWith("\x1b[48;5;236m"));
  assert.equal(stringDisplayWidth(header), 24);
  assert.ok(stripAnsi(header).startsWith(" ▸ Worked for 2s"));
  assert.ok(stripAnsi(header).endsWith(" "));
}

// User prompts own a full-width band while their content observes the global inset.
{
  const ui = makeUi();
  ui.transcriptPadding = 2;
  ui.promptPadding = 2;
  const rows = ui.transcriptEntryRows(
    { kind: "user", provider: "codex", text: "first line\n\nlast line" },
    24,
  );
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => !row.startsWith("\x1b[48;5;235m")));
  assert.ok(rows.every((row) => row.includes("┃\x1b[0m\x1b[48;5;235m")));
  assert.ok(rows.every((row) => stringDisplayWidth(row) === 24));
  assert.ok(stripAnsi(rows[0]).slice(1).trim() === "");
  assert.ok(stripAnsi(rows.at(-1)).slice(1).trim() === "");
  assert.deepEqual(rows.map(stripAnsi).map((row) => row[0]), ["┃", "┃", "┃", "┃", "┃"]);
  assert.deepEqual(rows.slice(1, -1).map(stripAnsi).map((row) => row.slice(0, 3)), ["┃  ", "┃  ", "┃  "]);
  assert.ok(rows.every((row) => stripAnsi(row).endsWith("  ")));
}

// General transcript content and submitted prompts own independent insets.
{
  const ui = makeUi();
  ui.transcriptPadding = 3;
  ui.promptPadding = 2;
  const prose = ui.transcriptEntryRows({ kind: "prose", text: "answer" }, 24).map(stripAnsi);
  const prompt = ui.transcriptEntryRows(
    { kind: "user", provider: "codex", text: "question" },
    24,
  ).map(stripAnsi);
  assert.ok(prose[0].startsWith("   answer"));
  assert.ok(prompt[1].startsWith("┃  question"));
  assert.ok(prompt[1].endsWith("  "));
}

// Fenced code is one compact rectangle aligned to the content inset. Its
// width follows the longest visual row and is recomputed on resize.
{
  const ui = makeUi();
  ui.transcriptPadding = 2;
  const entry = {
    kind: "code-block",
    lang: "text",
    lines: ["Plan 5/5", "ok"],
  };
  const wide = ui.transcriptEntryRows(entry, 30);
  assert.equal(wide.length, 5);
  assert.ok(wide.every((row) => stripAnsi(row).startsWith("  ")));
  assert.ok(stripAnsi(wide[1]).startsWith("    text"));
  assert.ok(stripAnsi(wide[2]).startsWith("    Plan 5/5"));
  assert.ok(stripAnsi(wide[1]).endsWith("  ") && stripAnsi(wide[2]).endsWith("  "));
  assert.ok(wide.every((row) => stringDisplayWidth(row) === 14));
  assert.ok(wide.every((row) => stringDisplayWidth(row) < 30));
  assert.ok(wide.every((row) => row.indexOf("\x1b[48;5;235m") > 0));
  assert.ok(wide[1].includes("\x1b[38;5;246m"), "language label is visibly secondary");
  assert.ok(!wide[2].includes("\x1b[38;5;246m"), "label color does not leak into code");

  const narrow = ui.transcriptEntryRows(
    { ...entry, lines: ["1234567890123456789012345"] },
    16,
  );
  assert.ok(narrow.length > wide.length);
  assert.ok(narrow.every((row) => stringDisplayWidth(row) <= 14));

  const unlabeled = ui.transcriptEntryRows(
    { kind: "code-block", lang: "", lines: ["plain"] },
    30,
  );
  assert.equal(unlabeled.length, 3, "unlabeled fence has no empty header row");
  assert.ok(stripAnsi(unlabeled[1]).includes("plain"));
}

// The framebuffer skips identical frames and repaints only a changed row.
{
  const ui = makeUi();
  const first = { kind: "prose", text: "one" };
  ui.transcriptEntries = [first];

  const initial = new RecordingPainter();
  ui.paintTranscriptViewport(initial, 4, 12);
  assert.equal(clearCount(initial), 4, "the first frame initializes the viewport");

  const identical = new RecordingPainter();
  ui.paintTranscriptViewport(identical, 4, 12);
  assert.equal(clearCount(identical), 0, "an identical frame emits no row clears");

  first.text = "changed";
  const changed = new RecordingPainter();
  ui.paintTranscriptViewport(changed, 4, 12);
  assert.equal(clearCount(changed), 1, "a local text change repaints one row");

  ui.transcriptEntries.push({ kind: "prose", text: "tail" });
  const shifted = new RecordingPainter();
  ui.paintTranscriptViewport(shifted, 4, 12);
  assert.equal(clearCount(shifted), 1, "a one-row tail shift paints only the new row");
  assert.ok(
    shifted.operations.some(([operation, value]) => operation === "text" && value === "\r\n"),
    "tail growth uses the terminal scroll region",
  );
}

// Submitting a multiline draft grows the transcript viewport before the next
// empty composer is mounted. The scroll region must be committed inside the
// same atomic frame; otherwise only the first prompt row lands in the old
// region while the remaining rows are painted over the composer and cached as
// if they were visible.
{
  const ui = makeUi();
  ui.transcriptEntries = [{
    kind: "user",
    provider: "codex",
    text: "first line\n\nthird line\nfourth line",
  }];
  ui.lastRawScrollBottom = 4;
  ui.lastTranscriptFrame = {
    width: 24,
    outputRows: 4,
    rows: ["", "", "", "previous tail"],
    modelRevision: 1,
  };
  ui.projectedTranscriptRevision = 2;

  let firstPaint = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    firstPaint += String(chunk);
    return true;
  };
  try {
    ui.repaintPinnedOutput({ columns: 25, outputBottom: 7 });
  } finally {
    process.stdout.write = originalWrite;
  }

  const region = firstPaint.indexOf("\x1b[1;7r");
  const firstCursorMove = firstPaint.search(/\x1b\[\d+;\d+H/);
  assert.ok(region >= 0, "the repaint commits the new seven-row scroll region");
  assert.ok(region < firstCursorMove, "viewport geometry is committed before row painting");
  assert.equal(ui.lastRawScrollBottom, 7);
  assert.equal(ui.lastTranscriptFrame.outputRows, 7);
  assert.deepEqual(
    ui.lastTranscriptFrame.rows.slice(-6).map((row) => stripAnsi(row).trimEnd()),
    ["┃", "┃ first line", "┃", "┃ third line", "┃ fourth line", "┃"],
    "the committed frame contains both internal spacers and every prompt line",
  );

  let identicalPaint = "";
  process.stdout.write = (chunk) => {
    identicalPaint += String(chunk);
    return true;
  };
  try {
    ui.repaintPinnedOutput({ columns: 25, outputBottom: 7 });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(identicalPaint, "", "stable geometry keeps the zero-write identical-frame fast path");
}

// A structural composer transition is one synchronized terminal write. The
// scroll region, repaired transcript rows, and next composer must never become
// separately visible frames.
{
  const ui = makeUi();
  const oldLayout = {
    rows: 12,
    columns: 25,
    outputBottom: 4,
    composerRows: [4, 5, 6, 7, 8, 9, 10, 11],
  };
  const nextLayout = {
    rows: 12,
    columns: 25,
    outputBottom: 7,
    composerRows: [7, 8, 9, 10, 11],
  };
  ui.rawInput = { pinned: true, line: "", cursor: 0, done: false };
  ui.rawInputLayout = () => nextLayout;
  ui.lastRawInputLayout = oldLayout;
  ui.lastRawScrollBottom = oldLayout.outputBottom;
  ui.transcriptEntries = [{ kind: "user", provider: "codex", text: "complete prompt" }];
  ui.projectedTranscriptRevision = 4;
  ui.renderPinnedRawInput = (_session, layout, painter) => {
    painter.text("<COMPOSER>");
    ui.lastRawInputLayout = layout;
  };

  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    ui.renderRawInput();
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(writes.length, 1, "the complete structural transition has one terminal commit");
  const frame = writes[0];
  assert.equal((frame.match(/\x1b\[\?2026h/g) || []).length, 1);
  assert.ok(frame.indexOf("\x1b[1;7r") < frame.indexOf("complete prompt"));
  assert.ok(frame.indexOf("complete prompt") < frame.indexOf("<COMPOSER>"));
}

// The interval between input sessions has an explicit non-interactive owner.
// Repaints during daemon dispatch therefore never infer an empty composer from
// rawInput=null.
{
  const ui = makeUi();
  const oldSession = { pinned: true, line: "one\ntwo\nthree", cursor: 13, prompt: "> " };
  const oldLayout = {
    rows: 12,
    columns: 25,
    outputBottom: 4,
    inputRow: 8,
    composerRows: [4, 5, 6, 7, 8, 9, 10, 11],
  };
  const nextLayout = {
    rows: 12,
    columns: 25,
    outputBottom: 7,
    inputRow: 8,
    composerRows: [7, 8, 9, 10, 11],
  };
  ui.rawInput = oldSession;
  ui.lastRawInputLayout = oldLayout;
  ui.lastRawScrollBottom = oldLayout.outputBottom;
  ui.rawInputLayout = (candidate) => {
    assert.ok(candidate, "layout never receives a null transition session");
    return candidate.line ? oldLayout : nextLayout;
  };
  ui.renderPinnedRawInput = (candidate, layout, painter) => {
    assert.equal(candidate.line, "");
    assert.equal(candidate.done, true);
    painter.text("<PENDING-COMPOSER>");
    ui.lastRawInputLayout = layout;
  };

  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    ui.beginPinnedInputTransition(oldSession);
  } finally {
    process.stdout.write = originalWrite;
  }

  ui.rawInput = null;
  assert.equal(ui.pinnedSceneLayout(), nextLayout);
  assert.equal(ui.pendingPinnedInput.line, "");
  assert.equal(writes.length, 1, "the pending scene is committed atomically");
  assert.ok(writes[0].includes("<PENDING-COMPOSER>"));
}

// Closing a full-screen picker invalidates the physical transcript and asks
// the unified scene renderer for exactly one forced restoration.
{
  const ui = makeUi();
  ui.rawInput = { pinned: true, line: "", cursor: 0, done: false };
  ui.lastRawScrollBottom = 7;
  ui.lastTranscriptFrame = { rows: ["logically cached"] };
  const renders = [];
  ui.renderRawInput = (options) => renders.push(options);

  ui.restorePickerBackdrop();

  assert.equal(ui.lastTranscriptFrame, null);
  assert.deepEqual(renders, [{ forceOutput: true }]);
}

// Mounting the next empty composer clears both its rows and the previous tall
// composer's rows. Some previous rows have just become transcript space; that
// clear must invalidate the optimistic frame or the differential painter will
// incorrectly skip the prompt lines erased from the physical terminal.
{
  const ui = makeUi();
  const oldLayout = {
    columns: 25,
    rows: 12,
    outputBottom: 4,
    composerRows: [4, 5, 6, 7, 8, 9, 10, 11],
  };
  const nextLayout = {
    columns: 25,
    rows: 12,
    outputBottom: 7,
    composerRows: [7, 8, 9, 10, 11],
  };
  ui.rawInputLayout = () => nextLayout;
  ui.lastRawScrollBottom = nextLayout.outputBottom;
  ui.transcriptEntries = [{
    kind: "user",
    provider: "codex",
    text: "first line\n\nthird line\nfourth line",
  }];
  ui.projectedTranscriptRevision = 3;
  ui.lastTranscriptFrame = null;

  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    ui.repaintPinnedOutput(nextLayout);
  } finally {
    process.stdout.write = originalWrite;
  }
  ui.rawInput = { pinned: true, line: "", cursor: 0, done: false };
  ui.lastRawInputLayout = oldLayout;
  ui.clearRawInputLayoutRows = () => {};
  ui.renderPinnedRawInput = () => {};

  let repairedPaint = "";
  process.stdout.write = (chunk) => {
    repairedPaint += String(chunk);
    return true;
  };
  try {
    ui.renderRawInput();
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.ok(
    repairedPaint.includes("fourth line"),
    "the new composer repaints transcript rows cleared from the previous composer band",
  );
}

// The animated status owns only the detached provider header row.
{
  const ui = makeUi();
  ui.rawInput = { pinned: true, done: false, line: "", cursor: 0 };
  ui.rawInputLayout = () => ({ columns: 40, headerRow: 7, enhanced: true });
  ui.restoreComposerCursor = () => {};
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    assert.equal(ui.paintComposerHeaderRow(), true);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal((output.match(/\x1b\[2K/g) || []).length, 1);
  assert.ok(output.includes("\x1b[8;1H"), "only the smart header row is addressed");
  assert.ok(!output.includes("\x1b[48;5;235m"));
  assert.ok(!output.includes("┃"));
}

// One scoped timer drives every status effect. It resets on state changes,
// honours the configured cadence, and never runs for permission or `off`.
{
  const ui = makeUi();
  ui.rawInput = { pinned: true, done: false, line: "", cursor: 0 };
  ui.statusAnimation = "wave";
  ui.statusAnimationIntervalMs = 135;
  ui.composerAnimationTimer = null;
  ui.composerAnimationKey = "";
  let scheduled = null;
  let scheduledInterval = 0;
  let cleared = 0;
  let headerPaints = 0;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback, interval) => {
    scheduled = callback;
    scheduledInterval = interval;
    return { unref() {} };
  };
  globalThis.clearInterval = () => { cleared += 1; };
  ui.paintComposerHeaderRow = () => { headerPaints += 1; return true; };

  try {
    ui.syncComposerAnimation();
    assert.equal(scheduledInterval, 135);
    assert.equal(ui.composerAnimationFrame, 0);
    scheduled();
    assert.equal(ui.composerAnimationFrame, 1);
    assert.equal(headerPaints, 1);

    ui.currentChat.status = "permission";
    ui.syncComposerAnimation();
    assert.equal(cleared, 1, "permission stops the motion timer");
    assert.equal(ui.composerAnimationTimer, null);
    assert.equal(ui.composerAnimationFrame, 0, "a new semantic state resets the cycle");

    ui.currentChat.status = "thinking";
    ui.statusAnimation = "off";
    scheduled = null;
    ui.syncComposerAnimation();
    assert.equal(scheduled, null, "off never allocates a timer");
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

// A status-only chat_state transition updates the smart header without
// repainting the transcript that turn_done has just committed.
{
  const ui = makeUi();
  ui.closed = false;
  ui.currentChat = { id: "c1", provider: "codex", status: "thinking", plan: null };
  ui.rawInput = { pinned: true, line: "", cursor: 0 };
  ui.composerNonTitleSignature = () => "stable-composer";
  ui.canCancelCurrentTurn = () => false;
  ui.clearTurnCancelConfirmation = () => {};
  ui.refreshRawInputPrompt = () => {};
  ui.flushChunkBuffer = () => {};
  ui.syncTmuxWindow = () => {};
  let headerPaints = 0;
  let composerPaints = 0;
  let transcriptPaints = 0;
  ui.paintComposerHeaderRow = () => {
    headerPaints += 1;
    return true;
  };
  ui.renderRawInput = () => {
    composerPaints += 1;
  };
  ui.repaintPinnedOutput = () => {
    transcriptPaints += 1;
  };

  ui.handleHubEvent({
    type: "chat_state",
    chat: { id: "c1", provider: "codex", status: "idle", plan: null },
  });

  assert.equal(headerPaints, 1, "the settled status updates only the smart header");
  assert.equal(composerPaints, 0, "stable composer geometry is not repainted");
  assert.equal(transcriptPaints, 0, "chat_state does not repaint the completed answer");
}

// Width changes recompute compact-card geometry, but the changed viewport is
// still committed as one synchronized frame rather than clear + redraw frames.
{
  const ui = makeUi();
  ui.transcriptEntries = [{ kind: "code-block", lang: "tmux", lines: ["set -g @x value"] }];
  ui.lastRawScrollBottom = 8;
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    ui.repaintPinnedOutput({ columns: 32, outputBottom: 8 });
    ui.repaintPinnedOutput({ columns: 22, outputBottom: 8 });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(writes.length, 2, "initial layout and resize each use one terminal commit");
  for (const frame of writes) {
    assert.equal((frame.match(/\x1b\[\?2026h/g) || []).length, 1);
    assert.equal((frame.match(/\x1b\[\?2026l/g) || []).length, 1);
  }
}

// Streaming notifications coalesce into one projection frame, and completed
// semantic cards are captured once instead of replayed on every later chunk.
{
  const ui = makeUi();
  ui.transcriptProjectionTimer = null;
  let projections = 0;
  ui.rebuildTranscriptProjection = () => {
    projections += 1;
  };
  for (let index = 0; index < 10; index += 1) ui.scheduleTranscriptProjection();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(projections, 1, "a streaming burst produces one projection frame");

  ui.activityMode = "compact";
  ui.showInternalEvents = false;
  ui.turnCardProjectionCache = new Map();
  let captures = 0;
  ui.captureEventEntries = (events) => {
    captures += 1;
    return events.map((event) => ({ kind: "prose", text: event.text || "event" }));
  };
  const turn = {
    id: "completed-turn",
    status: "completed",
    events: [{ type: "tool_update", text: "detail" }],
    detailEvents: [{ type: "tool_update", text: "detail" }],
    finalEvents: [{ type: "agent_chunk", text: "final" }],
  };
  assert.equal(ui.turnCardTranscriptEntry(turn), ui.turnCardTranscriptEntry(turn));
  assert.equal(captures, 2, "completed detail/final capture is cached after its first projection");
}

// An exception in the outer projection cannot strand the renderer in its
// no-commit phase and suppress all subsequent UI updates.
{
  const ui = makeUi();
  ui.transcriptProjectionDepth = 0;
  ui.transcriptRenderPhase = "live";
  ui.suppressTranscriptPaint = false;
  ui.transcriptRevision = 1;
  ui.transcriptProjectionEvents = () => [{ type: "system", text: "broken" }];
  ui.renderEvent = () => {
    throw new Error("synthetic rebuild failure");
  };

  assert.throws(() => ui.rebuildTranscriptProjection(), /synthetic rebuild failure/);
  assert.equal(ui.transcriptProjectionDepth, 0);
  assert.equal(ui.transcriptRenderPhase, "live");
  assert.equal(ui.suppressTranscriptPaint, false);
}

console.log("frame render tests passed");
