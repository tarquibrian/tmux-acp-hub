#!/usr/bin/env node
// Unit tests for the boxed composer layout: geometry, degrade rule, overflow
// counters, and a paint smoke test for the box borders.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;
// The composer accent falls back to the provider color only when no
// @acp_hub_accent tmux option is readable; drop TMUX so a developer's own
// theme cannot leak into the assertions.
delete process.env.TMUX;

const { PopupUi } = await import("../bin/acp-hub.mjs");

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
    composerSpinnerFrame: 0,
    activePicker: null,
    lastRawInputLayout: null,
    lastRawScrollBottom: null,
  });
  return ui;
}

const session = (line = "") => ({ pinned: true, line, cursor: line.length });

// --- Geometry: boxed layout on a normal-size popup -----------------------------
{
  const ui = makeUi();
  const layout = ui.rawInputLayout(session(""));
  assert.equal(layout.boxed, true, "boxed on 30 rows");
  // gap + top rule + input + bottom rule + footer + hint = 6 composer rows.
  // The hint row is always reserved inside a chat so typing never slides it.
  assert.equal(layout.outputBottom, 30 - 6);
  assert.equal(layout.gapRow, 24, "blank gap row between transcript and box");
  assert.equal(layout.dividerRow, 25, "top rule row");
  assert.equal(layout.inputRow, 26);
  assert.equal(layout.boxBottomRow, 27, "bottom rule wraps the input");
  assert.equal(layout.footerRow, 28);
  assert.equal(layout.hintRow, 29, "hint row is always reserved");
  assert.ok(layout.composerRows.includes(layout.boxBottomRow), "bottom rule cleared on layout change");
  assert.ok(layout.composerRows.includes(layout.gapRow), "gap row cleared on layout change");
  const flatWidth = ui.rawInputTextWidth(session(""), 100, false);
  assert.equal(layout.inputWidth, flatWidth, "flush band: same input width as flat");
}

// --- Degrade rule ---------------------------------------------------------------
{
  const ui = makeUi();
  process.stdout.rows = 12;
  const layout = ui.rawInputLayout(session(""));
  assert.equal(layout.boxed, false, "small popups fall back to the flat layout");
  assert.equal(layout.boxBottomRow, null);
  process.stdout.rows = 30;
}
{
  const ui = makeUi();
  process.env.ACP_HUB_COMPOSER_BOX = "0";
  assert.equal(ui.rawInputLayout(session("")).boxed, false, "env kill-switch works");
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
  assert.ok(/─ .*Codex.*─/.test(plain), "top rule carries the provider identity while quiet");
  assert.ok(!plain.includes("idle"), "quiet status is not spelled out in the rule");
  assert.ok(!plain.includes("╭") && !plain.includes("╰"), "no box corners");
  assert.ok(!plain.includes("│"), "no side borders");
  assert.ok((plain.match(/─{20,}/g) || []).length >= 1, "bottom rule painted");
  assert.ok(plain.includes("hello box"), "input text painted");
  assert.ok(out.includes("\x1b[38;5;39m"), "codex accent (blue) tints the rule");
}

// --- Attention state overrides the border color ----------------------------------
{
  const ui = makeUi();
  ui.currentChat.status = "permission";
  ui.pendingPermission = { permissionId: "p1", options: [] };
  assert.equal(ui.composerBorderSeq(), "\x1b[33m", "permission turns the border yellow");
  ui.currentChat.status = "error";
  ui.pendingPermission = null;
  assert.equal(ui.composerBorderSeq(), "\x1b[31m", "error turns the border red");
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

// --- Cancel-to-edit: cancelling a turn restores the just-sent prompt ---------------
{
  const ui = makeUi();
  ui.currentChat.status = "responding";
  ui.hub = { call: async () => ({ ok: true }) };
  ui.notify = () => {};
  ui.saveRawDraft = () => {};
  ui.killRing = [];
  ui.lastSentPrompt = { chatId: "c1", text: "arregla el bug del scroll" };

  // Empty composer: Esc-cancel restores the sent prompt for editing.
  ui.rawInput = { line: "", cursor: 0 };
  assert.equal(ui.requestCancelCurrentTurn(), true);
  assert.equal(ui.rawInput.line, "arregla el bug del scroll");
  assert.equal(ui.rawInput.cursor, ui.rawInput.line.length);

  // Composer already has NEW text: never overwritten by the restore.
  ui.rawInput = { line: "otra cosa", cursor: 9 };
  assert.equal(ui.requestCancelCurrentTurn(), true);
  assert.equal(ui.rawInput.line, "otra cosa");

  // Ctrl+C with text: clears it and skips the restore (explicit discard).
  ui.rawInput = { line: "borrador nuevo", cursor: 14 };
  assert.equal(ui.cancelCurrentTurnFromInput(ui.rawInput), true);
  assert.equal(ui.rawInput.line, "", "Ctrl+C keeps the composer empty");
  assert.ok(ui.killRing.includes("borrador nuevo"), "discarded text goes to the kill ring");

  // Wrong chat: no restore.
  ui.rawInput = { line: "", cursor: 0 };
  ui.lastSentPrompt = { chatId: "other", text: "ajeno" };
  assert.equal(ui.requestCancelCurrentTurn(), true);
  assert.equal(ui.rawInput.line, "");
}

// --- Inline picker (/model etc.) lives in the dropdown zone ------------------------
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

  const session = { line: "/model", cursor: 6, pinned: true, draftKey: "chat:c1" };
  ui.rawInput = session;
  ui.renderRawInput = () => {};

  // Enter on "/model" opens the inline picker instead of resolving the prompt.
  assert.equal(ui.maybeOpenInlinePicker(session), true);
  assert.ok(ui.inlinePicker, "picker state set");
  assert.equal(session.line, "", "input cleared, composer stays live");
  assert.equal(ui.inlinePicker.index, 1, "selection starts on the current value");

  // Layout: the list takes the dropdown zone below the input (items + title).
  const layout = ui.rawInputLayout(session);
  assert.equal(layout.dropdownRows, 4, "3 items + title row");
  assert.ok(layout.dropdownRow > layout.inputRow, "list renders below the input");
  assert.equal(layout.footerRow, null, "footer yields to the list");

  // Keys: navigation, number-pick, esc.
  ui.handleInlinePickerKey(session, "", { name: "down" });
  assert.equal(ui.inlinePicker.index, 2);
  ui.handleInlinePickerKey(session, "", { name: "up" });
  assert.equal(ui.inlinePicker.index, 1);
  assert.equal(ui.handleInlinePickerKey(session, "1", { name: "1" }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, { id: "model", value: "gpt-5.5" }, "number applies that option");
  assert.equal(ui.inlinePicker, null, "picker closes after apply");

  // Esc closes without applying; a printable key closes and falls through.
  assert.equal(ui.maybeOpenInlinePicker({ ...session, line: "/model" }), true);
  ui.rawInput.line = "";
  assert.equal(ui.handleInlinePickerKey(ui.rawInput, "", { name: "escape" }), true);
  assert.equal(ui.inlinePicker, null);
  assert.equal(ui.maybeOpenInlinePicker({ ...session, line: "/model" }), true);
  assert.equal(ui.handleInlinePickerKey(ui.rawInput, "x", { name: "x" }), false, "typing falls through");
  assert.equal(ui.inlinePicker, null, "typing closes the list");
}

console.log("composer-layout test passed");
