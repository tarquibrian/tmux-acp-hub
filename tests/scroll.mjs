#!/usr/bin/env node

import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;
delete process.env.TMUX;

const { PopupUi } = await import("../bin/acp-hub.mjs");

function makeUi() {
  const deltas = [];
  const ui = Object.assign(Object.create(PopupUi.prototype), {
    currentChat: { id: "c1", provider: "codex", status: "idle" },
    pendingAttachments: [],
    inlinePicker: null,
    vimEnabled: false,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    scrollPagePercent: 40,
    mouseScrollEnabled: true,
    mouseScrollRows: 4,
    mouseClickEnabled: true,
    mouseHoverEnabled: true,
    interactiveRegions: [],
    hoveredInteractiveKey: "",
    rawInputLayout: () => ({ outputBottom: 24 }),
    scrollTranscript: (delta) => deltas.push(delta),
  });
  return { ui, deltas };
}

const session = {
  pinned: true,
  line: "draft",
  cursor: 5,
  searchActive: false,
  pasteActive: false,
  mouseSequence: "",
  mouseSequenceAt: 0,
  autocompleteIndex: 0,
  autocompleteKey: "",
  autocompleteSuppressedKey: "",
};

// Paging changes transcript and cursor/composer state in one scene commit.
// It must not render the composer first and repaint the transcript afterward.
{
  const ui = Object.assign(Object.create(PopupUi.prototype), {
    rawInput: { ...session },
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    rawInputLayout: () => ({ outputBottom: 24, columns: 100 }),
    canPaintPinned: () => true,
    collectTranscriptRowsFromEnd: () => ({ atTop: false, total: 100 }),
  });
  const renders = [];
  ui.renderRawInput = (options) => renders.push(options);

  ui.scrollTranscript(4);

  assert.equal(ui.scrollOffsetRows, 4);
  assert.deepEqual(renders, [{ forceOutput: true }]);
}

// Page keys retain most of the previous screen as visual context.
{
  const { ui, deltas } = makeUi();
  assert.equal(ui.transcriptPageRows(session), 10);
  ui.handleRawKeypress(session, "", { name: "pageup" }, () => {});
  ui.handleRawKeypress(session, "", { name: "pagedown" }, () => {});
  assert.deepEqual(deltas, [10, -10]);

  ui.scrollPagePercent = 25;
  assert.equal(ui.transcriptPageRows(session), 6, "page percentage is configurable");
}

function feedMouse(ui, target, sequence) {
  for (const fragment of [SGR_PREFIX, ...sequence.slice(SGR_PREFIX.length)]) {
    assert.equal(
      ui.consumeRawMouseKeypress(target, fragment, { sequence: fragment }),
      true,
      `mouse fragment consumed: ${JSON.stringify(fragment)}`,
    );
  }
}

const SGR_PREFIX = "\x1b[<";

// readline splits SGR reports into ESC[< plus ordinary characters. The parser
// consumes all fragments and turns only wheel presses into transcript deltas.
{
  const { ui, deltas } = makeUi();
  const target = { ...session };
  feedMouse(ui, target, "\x1b[<64;10;5M");
  feedMouse(ui, target, "\x1b[<65;10;5M");
  feedMouse(ui, target, "\x1b[<68;10;5M"); // Shift + wheel up.
  assert.deepEqual(deltas, [4, -4, 4]);

  feedMouse(ui, target, "\x1b[<0;10;5M");
  feedMouse(ui, target, "\x1b[<64;10;5m"); // Release reports do not scroll.
  assert.deepEqual(deltas, [4, -4, 4], "clicks and releases are consumed without scrolling");
  assert.equal(ui.consumeRawMouseKeypress(target, "a", { sequence: "a" }), false);
}

// Mouse reports are intercepted before Vim/autocomplete and never mutate the
// draft, even though readline exposes their digits as ordinary keypresses.
{
  const { ui, deltas } = makeUi();
  ui.vimEnabled = true;
  ui.inlinePicker = { items: [{ value: "x" }], index: 0 };
  const target = {
    ...session,
    draftKey: "chat:c1",
    vimMode: "normal",
    mouseSequence: "",
    mouseSequenceAt: 0,
  };
  for (const fragment of [SGR_PREFIX, ..."64;10;5M"]) {
    ui.handleRawKeypress(target, fragment, { sequence: fragment }, () => {});
  }
  assert.equal(target.line, "draft");
  assert.deepEqual(deltas, [4]);
}

// The SGR decoder preserves coordinates, motion, release, and modifiers.
{
  const { ui } = makeUi();
  assert.deepEqual(ui.decodeSgrMouseSequence("\x1b[<0;10;5M"), {
    type: "press",
    button: 0,
    x: 9,
    y: 4,
    shift: false,
    alt: false,
    ctrl: false,
    motion: false,
  });
  assert.equal(ui.decodeSgrMouseSequence("\x1b[<32;11;5M").type, "move");
  assert.equal(ui.decodeSgrMouseSequence("\x1b[<0;10;5m").type, "release");
  const modified = ui.decodeSgrMouseSequence("\x1b[<28;10;5M");
  assert.equal(modified.shift, true);
  assert.equal(modified.alt, true);
  assert.equal(modified.ctrl, true);
}

// A left press/release in the same semantic region toggles once. Motion marks
// the gesture as a drag for the in-app fallback; native tmux routing normally
// intercepts MouseDrag1Pane before that motion reaches the renderer.
{
  const { ui } = makeUi();
  const target = { ...session, mousePress: null };
  let toggles = 0;
  let repaints = 0;
  ui.interactiveRegions = [
    { key: "turn:t1:toggle", turnId: "t1", action: "toggle-turn", x1: 0, x2: 40, y1: 4, y2: 4 },
  ];
  ui.repaintPinnedOutput = () => {
    repaints += 1;
  };
  ui.canPaintPinned = () => true;
  ui.setTurnCardExpanded = (turnId, force, options) => {
    assert.equal(turnId, "t1");
    assert.equal(force, null);
    assert.equal(options.preserveAnchor, true);
    toggles += 1;
  };

  feedMouse(ui, target, "\x1b[<0;10;5M");
  feedMouse(ui, target, "\x1b[<0;10;5m");
  assert.equal(toggles, 1);
  assert.ok(repaints >= 1, "hover state repaints only when its target changes");

  feedMouse(ui, target, "\x1b[<0;10;5M");
  feedMouse(ui, target, "\x1b[<32;11;5M");
  feedMouse(ui, target, "\x1b[<0;10;5m");
  assert.equal(toggles, 1, "drag release never toggles the card");

  feedMouse(ui, target, "\x1b[<4;10;5M");
  feedMouse(ui, target, "\x1b[<4;10;5m");
  assert.equal(toggles, 1, "Shift-click remains available for terminal selection");

  feedMouse(ui, target, "\x1b[<35;70;20M");
  assert.equal(ui.hoveredInteractiveKey, "", "moving outside clears hover");

  let groupToggles = 0;
  ui.interactiveRegions = [
    {
      key: "activity:t1:g1:toggle",
      turnId: "t1",
      activityGroupId: "g1",
      action: "toggle-activity-group",
      x1: 0,
      x2: 40,
      y1: 6,
      y2: 6,
    },
  ];
  ui.setActivityGroupExpanded = (turnId, groupId, force, options) => {
    assert.equal(turnId, "t1");
    assert.equal(groupId, "g1");
    assert.equal(force, null);
    assert.equal(options.preserveAnchor, true);
    groupToggles += 1;
  };
  feedMouse(ui, target, "\x1b[<0;10;7M");
  feedMouse(ui, target, "\x1b[<0;10;7m");
  assert.equal(groupToggles, 1, "group headers use the same guarded click lifecycle");

  ui.interactiveRegions = [
    { key: "turn:t1:toggle", turnId: "t1", action: "toggle-turn", x1: 0, x2: 40, y1: 4, y2: 4 },
  ];
  target.mousePress = {
    key: "turn:t1:toggle",
    x: 9,
    y: 4,
    dragged: false,
    at: Date.now() - 1500,
  };
  feedMouse(ui, target, "\x1b[<0;10;5m");
  assert.equal(toggles, 1, "an orphaned pre-copy-mode press expires without toggling");
}

// Composer controls keep a region set independent from transcript cards.
// Hover repaints only the footer row and guarded clicks reach both collapsed
// cards and values inside an expanded group after transcript refreshes.
{
  const { ui } = makeUi();
  const target = { ...session, mousePress: null };
  let footerPaints = 0;
  let transcriptPaints = 0;
  const opened = [];
  ui.rawInput = target;
  ui.canPaintPinned = () => true;
  ui.paintComposerFooterRow = () => { footerPaints += 1; return true; };
  ui.repaintPinnedOutput = () => { transcriptPaints += 1; };
  ui.openComposerFooterControl = async (control) => {
    opened.push(control);
    return true;
  };
  ui.composerInteractiveRegions = [{
    key: "composer-footer:model",
    action: "open-composer-control",
    control: "model",
    x1: 3,
    x2: 18,
    y1: 26,
    y2: 26,
  }];
  // A later transcript repaint replaces only its own collection.
  ui.interactiveRegions = [{
    key: "turn:t1:toggle",
    action: "toggle-turn",
    turnId: "t1",
    x1: 0,
    x2: 40,
    y1: 4,
    y2: 4,
  }];

  feedMouse(ui, target, "\x1b[<0;8;27M");
  feedMouse(ui, target, "\x1b[<0;8;27m");
  assert.deepEqual(opened, ["model"]);
  assert.ok(footerPaints >= 1, "footer hover has a row-scoped repaint");
  assert.equal(transcriptPaints, 0, "footer hover never repaints Activity/history");
  assert.equal(ui.interactiveRegionAt(8, 26)?.control, "model");

  const selected = [];
  ui.selectComposerFooterOption = async (control, value) => {
    selected.push([control, value]);
    return true;
  };
  ui.composerInteractiveRegions = [{
    key: "composer-footer:model:option:model:1",
    action: "select-composer-footer-option",
    control: "model",
    value: "gpt-5.6-terra",
    x1: 3,
    x2: 20,
    y1: 26,
    y2: 26,
  }];
  feedMouse(ui, target, "\x1b[<0;8;27M");
  feedMouse(ui, target, "\x1b[<0;8;27m");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, [["model", "gpt-5.6-terra"]]);
}

// Footer cards without multiple inline values route to the same picker specs
// as slash commands. An
// existing non-permission picker is replaced; pending authority always wins.
{
  const { ui } = makeUi();
  ui.rawInput = { ...session, done: false };
  const opened = [];
  let closed = 0;
  let permissionReopened = 0;
  ui.showConfigOptionPicker = async (id, title) => {
    opened.push([id, title]);
    return true;
  };
  ui.showAccessPicker = async () => {
    opened.push(["access", "Access"]);
    return true;
  };
  ui.closeInlinePicker = () => {
    closed += 1;
    ui.inlinePicker = null;
  };

  ui.inlinePicker = { purpose: "quickselect" };
  await ui.openComposerFooterControl("model");
  await ui.openComposerFooterControl("effort");
  await ui.openComposerFooterControl("access");
  assert.equal(closed, 1, "clicking a different tab replaces the existing picker");
  assert.deepEqual(opened, [
    ["model", "Model"],
    ["effort", "Effort"],
    ["access", "Access"],
  ]);

  ui.pendingPermission = { permissionId: "p1", options: [] };
  ui.maybeOpenPermissionPanel = ({ force }) => {
    assert.equal(force, true);
    permissionReopened += 1;
    return true;
  };
  await ui.openComposerFooterControl("model");
  assert.equal(permissionReopened, 1);
  assert.equal(opened.length, 3, "config tabs never cover pending authority");
}

// Tracking is explicitly bracketed so tmux forwards mouse reports only while
// the pinned composer owns the terminal.
{
  const { ui } = makeUi();
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    ui.enableMouseTracking();
    ui.disableMouseTracking();
  } finally {
    process.stdout.write = original;
  }
  assert.equal(
    output,
    "\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?1006l\x1b[?1003l\x1b[?1000l",
  );

  ui.mouseHoverEnabled = false;
  output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    ui.enableMouseTracking();
    ui.disableMouseTracking();
  } finally {
    process.stdout.write = original;
  }
  assert.equal(output, "\x1b[?1000h\x1b[?1006h\x1b[?1006l\x1b[?1000l");
}

// Full-screen pickers suspend motion reports and restore them on close, so
// hover bytes can never leak into a picker filter or rename field.
{
  const { ui } = makeUi();
  ui.rawInput = {
    ...session,
    mouseTracking: true,
    mouseTrackingSuspended: false,
    mousePress: { key: "turn:t1:toggle" },
  };
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    const suspended = ui.suspendComposerMouseTracking();
    assert.equal(suspended, true);
    assert.equal(ui.rawInput.mouseTrackingSuspended, true);
    assert.equal(ui.rawInput.mousePress, null);
    ui.resumeComposerMouseTracking(suspended);
    assert.equal(ui.rawInput.mouseTrackingSuspended, false);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(
    output,
    "\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?1000h\x1b[?1003h\x1b[?1006h",
  );
}

// Selection mode hands drag gestures back to tmux/the terminal and restores
// the exact application tracking protocol afterwards.
{
  const { ui } = makeUi();
  const session = {
    pinned: true,
    mouseTracking: true,
    mouseTrackingSuspended: false,
    mouseSelectionMode: false,
    mousePress: { key: "turn:t1:toggle" },
    mouseSequence: "partial",
    mouseSequenceAt: Date.now(),
  };
  ui.rawInput = session;
  ui.renderRawInput = () => {};
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    assert.equal(ui.setMouseSelectionMode(session, true), true);
    assert.equal(session.mouseSelectionMode, true);
    assert.equal(session.mouseTrackingSuspended, true);
    assert.equal(session.mousePress, null);
    assert.equal(session.mouseSequence, "");
    assert.match(ui.inputHint(""), /selection mode.*Esc\/F4 close/);
    assert.ok(ui.composerBadges({}, "idle").includes("[SELECT]"));

    ui.setMouseSelectionMode(session, false);
    assert.equal(session.mouseSelectionMode, false);
    assert.equal(session.mouseTrackingSuspended, false);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(
    output,
    "\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?1000h\x1b[?1003h\x1b[?1006h",
  );
}

console.log("scroll test passed");
