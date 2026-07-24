#!/usr/bin/env node

import assert from "node:assert/strict";

process.stdout.isTTY = true;
delete process.env.TMUX;

const { PopupUi } = await import("../bin/acp-hub.mjs");
const { stringDisplayWidth, stripAnsi } = await import("../lib/render.mjs");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    currentChat: { id: "c1", provider: "codex" },
    transcriptEntries: [""],
    liveTable: null,
    pendingResponseBreak: false,
  });
  return ui;
}

const plainRows = (ui, text, width) =>
  ui.layoutUserTurnRows(text, width, "codex").map((row) => stripAnsi(row));

// Semantic content rows do not own the full-bleed edge rail.
{
  const ui = makeUi();
  assert.deepEqual(plainRows(ui, "hi", 18), ["hi"]);
}

// Explicitly multiline input uses a continuous rail, including blank lines.
{
  const ui = makeUi();
  assert.deepEqual(plainRows(ui, "hi\nhi\n\nhi", 18), ["hi", "hi", "", "hi"]);
}

// Soft wrapping moves the complete word and gives every continuation a rail.
{
  const ui = makeUi();
  assert.deepEqual(plainRows(ui, "123456789012 palabra final", 18), [
    "123456789012",
    "palabra final",
  ]);
}

// Manual and automatic wrapping compose without losing the block rail.
{
  const ui = makeUi();
  const rows = plainRows(
    ui,
    "intro\n\nuno dos tres cuatro cinco seis siete\n\nfin",
    18,
  );
  assert.deepEqual(rows, [
    "intro",
    "",
    "uno dos tres",
    "cuatro cinco seis",
    "siete",
    "",
    "fin",
  ]);
}

// A token wider than the entire content area is the only case hard-wrapped.
{
  const ui = makeUi();
  const token = "abcdefghijklmnopqrst";
  const rows = plainRows(ui, token, 12);
  assert.deepEqual(rows, ["abcdefghijkl", "mnopqrst"]);
  assert.equal(rows.join(""), token);
}

// Display-column width, rather than JS string length, bounds Unicode content.
{
  const ui = makeUi();
  const rows = ui.layoutUserTurnRows("café 日本語 🚀 palabra", 14, "codex");
  for (const row of rows) {
    assert.ok(stringDisplayWidth(row) <= 14, `row exceeded width: ${JSON.stringify(stripAnsi(row))}`);
  }
}

// User turns stay semantic in the transcript and reflow at the current width.
{
  const ui = makeUi();
  const entry = ui.recordUserTurn("uno dos tres cuatro cinco seis", "codex");
  assert.deepEqual(entry, {
    kind: "user",
    text: "uno dos tres cuatro cinco seis",
    provider: "codex",
  });
  assert.equal(typeof ui.transcriptEntries[1], "object");

  const wide = ui.transcriptEntryRows(entry, 24).map(stripAnsi);
  const narrow = ui.transcriptEntryRows(entry, 12).map(stripAnsi);
  assert.ok(narrow.length > wide.length, "narrow resize produces a fresh reflow");
  assert.ok(
    narrow
      .filter((row) => row.trim())
      .every((row) => row.startsWith("┃")),
  );
}

// Replay forwards multiline text unchanged instead of cleanInline flattening it.
{
  const ui = makeUi();
  let captured = "";
  ui.emitUserTurn = (text) => {
    captured = text;
  };
  ui.renderUserTurn("hi\nhi\nhi");
  assert.equal(captured, "hi\nhi\nhi");
  assert.equal(ui.pendingResponseBreak, true);
}

// Provider passthrough commands keep their internal line structure too.
{
  const ui = makeUi();
  assert.equal(ui.submittedInputDisplayText("/agent first\nsecond"), "first\nsecond");
  assert.equal(ui.submittedInputDisplayText("//compact"), "/compact");
}

// Attachment labels added to persisted user events remain inside the block.
{
  const ui = makeUi();
  const source = "review\n[IMAGE1] shot.png\n[FILE1] notes.txt";
  assert.deepEqual(plainRows(ui, source, 30), [
    "review",
    "",
    "[IMAGE1] shot.png",
    "[FILE1] notes.txt",
  ]);
  const styled = ui.layoutUserTurnRows(source, 30, "codex");
  assert.ok(styled.find((row) => stripAnsi(row).includes("[IMAGE1]"))?.includes("\x1b[38;5;168m"));
  assert.ok(
    ui
      .layoutUserTurnRows("review [Image #1] please", 40, "codex")
      .some((row) => row.includes("\x1b[38;5;168m[Image #1]\x1b[39m")),
  );

  ui.transcriptPadding = 2;
  const band = ui.transcriptEntryRows(
    { kind: "user", provider: "codex", text: source },
    36,
  );
  assert.ok(
    band.every((row) => !row.startsWith("\x1b[48;5;235m")),
    "the submitted-prompt rail stays outside the shaded background",
  );
  assert.ok(
    band.every((row) => row.includes("┃\x1b[0m\x1b[48;5;235m")),
    "the shaded surface begins immediately after the rail",
  );
  assert.ok(band.every((row) => stringDisplayWidth(row) === 36));
  assert.ok(band.every((row) => stripAnsi(row).startsWith("┃")));
  assert.ok(band.slice(1, -1).every((row) => stripAnsi(row).startsWith("┃  ")));
  assert.ok(stripAnsi(band[0]).slice(1).trim() === "");
  assert.ok(stripAnsi(band.at(-1)).slice(1).trim() === "");
  assert.ok(band.every((row) => row.includes("\x1b[38;5;168m\x1b[1m┃")));
}

// Agent mode follows the semantic provider attached to each persisted turn;
// repainting/restoring history therefore never borrows the current chat hue.
{
  const ui = makeUi();
  ui.themeVariant = "agent";
  const codex = ui.transcriptEntryRows(
    { kind: "user", provider: "codex", text: "codex prompt" },
    30,
  );
  const claude = ui.transcriptEntryRows(
    { kind: "user", provider: "claude", text: "claude prompt" },
    30,
  );
  assert.ok(codex.every((row) => row.includes("\x1b[38;5;39m\x1b[1m┃")));
  assert.ok(claude.every((row) => row.includes("\x1b[38;5;173m\x1b[1m┃")));
}

console.log("user turn render test passed");
