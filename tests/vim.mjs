#!/usr/bin/env node
// Unit tests for the composer's vim mode: mode transitions, motions, operators
// and the kill-ring round trip.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;
delete process.env.TMUX;

const { PopupUi } = await import("../bin/vanzi-hub.mjs");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    vimEnabled: true,
    killRing: [],
    scrollOffsetRows: 0,
    pendingAttachments: [],
    currentChat: { id: "c1", status: "idle" },
    cancelRequested: 0,
  });
  ui.renderRawInput = () => {};
  ui.refreshRawInputPrompt = () => {};
  ui.saveRawDraft = () => {};
  ui.scrollTranscript = () => {};
  ui.requestCancelCurrentTurn = () => {
    ui.cancelRequested += 1;
    return ui.cancelRequested > 0 && ui.currentChat.status === "responding";
  };
  return ui;
}

function makeSession(line, cursor = line.length) {
  return {
    line,
    cursor,
    draftKey: "chat:c1",
    vimMode: "insert",
    vimOp: "",
    vimCount: "",
    vimFind: "",
    vimReplace: false,
    vimGPending: false,
    vimUndoStack: [],
    vimRedoStack: [],
    vimAnchor: 0,
    vimVisualLine: false,
    vimLastChange: null,
    vimChangePending: null,
    vimInsertStart: 0,
    pasteActive: false,
    pinned: true,
  };
}

const key = (name, extra = {}) => ({ name, ...extra });
const press = (ui, session, ch) => ui.handleVimKeypress(session, ch, key(ch.length === 1 ? ch : ch));

// Esc leaves insert for normal mode, stepping the cursor back vim-style.
{
  const ui = makeUi();
  const s = makeSession("hola mundo");
  assert.equal(ui.handleVimKeypress(s, "", key("escape")), true);
  assert.equal(s.vimMode, "normal");
  assert.equal(s.cursor, 9);
}

// Insert mode passes ordinary keys through to the default handler.
{
  const ui = makeUi();
  const s = makeSession("abc");
  assert.equal(ui.handleVimKeypress(s, "x", key("x")), false);
}

// Motions: 0 $ w b h l e.
{
  const ui = makeUi();
  const s = makeSession("uno dos tres", 0);
  s.vimMode = "normal";
  press(ui, s, "$");
  assert.equal(s.cursor, 11);
  press(ui, s, "0");
  assert.equal(s.cursor, 0);
  press(ui, s, "w");
  assert.equal(s.line.slice(s.cursor), "dos tres");
  press(ui, s, "e");
  assert.equal(s.cursor, 6); // end of "dos"
  press(ui, s, "b");
  assert.equal(s.line.slice(s.cursor), "dos tres");
  press(ui, s, "l");
  press(ui, s, "h");
  assert.equal(s.line.slice(s.cursor), "dos tres");
}

// x deletes under the cursor; u undoes it.
{
  const ui = makeUi();
  const s = makeSession("abc", 1);
  s.vimMode = "normal";
  press(ui, s, "x");
  assert.equal(s.line, "ac");
  press(ui, s, "u");
  assert.equal(s.line, "abc");
}

// dd kills the whole line into the kill ring; p pastes it back.
{
  const ui = makeUi();
  const s = makeSession("linea unica", 4);
  s.vimMode = "normal";
  press(ui, s, "d");
  press(ui, s, "d");
  assert.equal(s.line, "");
  assert.equal(ui.killRing[0], "linea unica");
  press(ui, s, "p");
  assert.equal(s.line, "linea unica");
}

// dd on the first of two lines removes the line and its newline.
{
  const ui = makeUi();
  const s = makeSession("uno\ndos", 1);
  s.vimMode = "normal";
  press(ui, s, "d");
  press(ui, s, "d");
  assert.equal(s.line, "dos");
}

// cw uses ce semantics: changes the word, keeps the following space.
{
  const ui = makeUi();
  const s = makeSession("foo bar", 0);
  s.vimMode = "normal";
  press(ui, s, "c");
  press(ui, s, "w");
  assert.equal(s.line, " bar");
  assert.equal(s.vimMode, "insert");
}

// o opens a line below and enters insert; O above.
{
  const ui = makeUi();
  const s = makeSession("solo", 2);
  s.vimMode = "normal";
  press(ui, s, "o");
  assert.equal(s.line, "solo\n");
  assert.equal(s.vimMode, "insert");
}

// Enter is not consumed in normal mode (submit still works).
{
  const ui = makeUi();
  const s = makeSession("enviar", 0);
  s.vimMode = "normal";
  assert.equal(ui.handleVimKeypress(s, "", key("return")), false);
}

// Esc in normal mode requests a turn cancel when the agent is active.
{
  const ui = makeUi();
  ui.currentChat.status = "responding";
  const s = makeSession("x", 0);
  s.vimMode = "normal";
  ui.handleVimKeypress(s, "", key("escape"));
  assert.equal(ui.cancelRequested, 1);
}

// gg jumps to the start, G to the end.
{
  const ui = makeUi();
  const s = makeSession("uno\ndos", 5);
  s.vimMode = "normal";
  press(ui, s, "g");
  press(ui, s, "g");
  assert.equal(s.cursor, 0);
  press(ui, s, "G");
  assert.equal(s.cursor, s.line.length);
}

// Counts: 3x deletes three chars, 2w moves two words.
{
  const ui = makeUi();
  const s = makeSession("abcdef", 0);
  s.vimMode = "normal";
  press(ui, s, "3");
  press(ui, s, "x");
  assert.equal(s.line, "def");
}
{
  const ui = makeUi();
  const s = makeSession("uno dos tres cuatro", 0);
  s.vimMode = "normal";
  press(ui, s, "2");
  press(ui, s, "w");
  assert.equal(s.line.slice(s.cursor), "tres cuatro");
}

// f jumps onto the char; dt deletes up to (not including) it.
{
  const ui = makeUi();
  const s = makeSession("abc=def", 0);
  s.vimMode = "normal";
  press(ui, s, "f");
  press(ui, s, "=");
  assert.equal(s.cursor, 3);
  press(ui, s, "0");
  press(ui, s, "d");
  press(ui, s, "t");
  press(ui, s, "=");
  assert.equal(s.line, "=def");
}

// f with a missing char fails without moving.
{
  const ui = makeUi();
  const s = makeSession("abc", 0);
  s.vimMode = "normal";
  press(ui, s, "f");
  press(ui, s, "z");
  assert.equal(s.cursor, 0);
}

// r replaces the char under the cursor in place.
{
  const ui = makeUi();
  const s = makeSession("gato", 0);
  s.vimMode = "normal";
  press(ui, s, "r");
  press(ui, s, "p");
  assert.equal(s.line, "pato");
  assert.equal(s.vimMode, "normal");
}

// s substitutes the char and enters insert.
{
  const ui = makeUi();
  const s = makeSession("xy", 0);
  s.vimMode = "normal";
  press(ui, s, "s");
  assert.equal(s.line, "y");
  assert.equal(s.vimMode, "insert");
}

// yy yanks without deleting; p pastes it.
{
  const ui = makeUi();
  const s = makeSession("copia", 2);
  s.vimMode = "normal";
  press(ui, s, "y");
  press(ui, s, "y");
  assert.equal(s.line, "copia");
  assert.equal(ui.killRing[0], "copia");
}

// dd on the last of two lines eats the preceding newline.
{
  const ui = makeUi();
  const s = makeSession("uno\ndos", 5);
  s.vimMode = "normal";
  press(ui, s, "d");
  press(ui, s, "d");
  assert.equal(s.line, "uno");
}

// 2dd removes two lines.
{
  const ui = makeUi();
  const s = makeSession("a\nb\nc", 0);
  s.vimMode = "normal";
  press(ui, s, "2");
  press(ui, s, "d");
  press(ui, s, "d");
  assert.equal(s.line, "c");
}

// Undo is a stack now; U redoes.
{
  const ui = makeUi();
  const s = makeSession("abc", 0);
  s.vimMode = "normal";
  press(ui, s, "x");
  press(ui, s, "x");
  assert.equal(s.line, "c");
  press(ui, s, "u");
  assert.equal(s.line, "bc");
  press(ui, s, "u");
  assert.equal(s.line, "abc");
  press(ui, s, "U");
  assert.equal(s.line, "bc");
}

// Esc with a pending operator clears it instead of cancelling the turn.
{
  const ui = makeUi();
  ui.currentChat.status = "responding";
  const s = makeSession("abc", 0);
  s.vimMode = "normal";
  press(ui, s, "d");
  ui.handleVimKeypress(s, "", key("escape"));
  assert.equal(s.vimOp, "");
  assert.equal(ui.cancelRequested, 0);
  ui.handleVimKeypress(s, "", key("escape"));
  assert.equal(ui.cancelRequested, 1);
}

// X deletes backwards; ~ toggles case.
{
  const ui = makeUi();
  const s = makeSession("abc", 2);
  s.vimMode = "normal";
  press(ui, s, "X");
  assert.equal(s.line, "ac");
  press(ui, s, "0");
  press(ui, s, "~");
  assert.equal(s.line, "Ac");
}

// Vim only drives the main draft-backed composer, not nested prompts.
{
  const ui = makeUi();
  const s = makeSession("abc", 0);
  s.draftKey = "";
  assert.equal(ui.handleVimKeypress(s, "", key("escape")), false);
}

// Visual mode: v + motion selects, d deletes the inclusive span.
{
  const ui = makeUi();
  const s = makeSession("uno dos tres", 0);
  s.vimMode = "normal";
  press(ui, s, "v");
  assert.equal(s.vimMode, "visual");
  press(ui, s, "e"); // cursor on the last char of "uno"
  press(ui, s, "d");
  assert.equal(s.line, " dos tres");
  assert.equal(s.vimMode, "normal");
  assert.equal(ui.killRing[0], "uno");
}

// Visual y yanks and returns to normal without changing the line.
{
  const ui = makeUi();
  const s = makeSession("copia esto", 0);
  s.vimMode = "normal";
  press(ui, s, "v");
  press(ui, s, "3");
  press(ui, s, "l");
  press(ui, s, "y");
  assert.equal(s.line, "copia esto");
  assert.equal(ui.killRing[0], "copi");
  assert.equal(s.vimMode, "normal");
}

// Visual c deletes the selection and enters insert.
{
  const ui = makeUi();
  const s = makeSession("cambiar", 0);
  s.vimMode = "normal";
  press(ui, s, "v");
  press(ui, s, "l");
  press(ui, s, "c");
  assert.equal(s.line, "mbiar");
  assert.equal(s.vimMode, "insert");
}

// V selects whole lines; d removes them.
{
  const ui = makeUi();
  const s = makeSession("uno\ndos\ntres", 5);
  s.vimMode = "normal";
  press(ui, s, "V");
  press(ui, s, "d");
  assert.equal(s.line, "uno\ntres");
}

// o swaps anchor and cursor inside visual.
{
  const ui = makeUi();
  const s = makeSession("abcdef", 2);
  s.vimMode = "normal";
  press(ui, s, "v");
  press(ui, s, "l");
  press(ui, s, "l");
  assert.equal(s.cursor, 4);
  press(ui, s, "o");
  assert.equal(s.cursor, 2);
  assert.equal(s.vimAnchor, 4);
}

// Esc in visual backs out to normal, selection dropped, no cancel request.
{
  const ui = makeUi();
  ui.currentChat.status = "responding";
  const s = makeSession("abc", 0);
  s.vimMode = "normal";
  press(ui, s, "v");
  ui.handleVimKeypress(s, "", key("escape"));
  assert.equal(s.vimMode, "normal");
  assert.equal(ui.cancelRequested, 0);
}

// % jumps between matching brackets, both directions, and works under d.
{
  const ui = makeUi();
  const s = makeSession("f(a, (b))", 1);
  s.vimMode = "normal";
  press(ui, s, "%");
  assert.equal(s.cursor, 8);
  press(ui, s, "%");
  assert.equal(s.cursor, 1);
  press(ui, s, "d");
  press(ui, s, "%");
  assert.equal(s.line, "f");
}

// . repeats a delete (x) and an operator change (dw).
{
  const ui = makeUi();
  const s = makeSession("aabb", 0);
  s.vimMode = "normal";
  press(ui, s, "x");
  press(ui, s, ".");
  assert.equal(s.line, "bb");
}
{
  const ui = makeUi();
  const s = makeSession("uno dos tres", 0);
  s.vimMode = "normal";
  press(ui, s, "d");
  press(ui, s, "w");
  press(ui, s, ".");
  assert.equal(s.line, "tres");
}

// . replays cw including the text typed in insert mode.
{
  const ui = makeUi();
  const s = makeSession("foo bar", 0);
  s.vimMode = "normal";
  press(ui, s, "c");
  press(ui, s, "w"); // ce semantics: "foo" gone, insert mode
  assert.equal(s.vimMode, "insert");
  // Simulate typing "X Y" through the default insert path.
  s.line = `X${s.line}`;
  s.cursor = 1;
  ui.handleVimKeypress(s, "", key("escape"));
  assert.equal(s.line, "X bar");
  assert.deepEqual(s.vimLastChange.insert, "X");
  press(ui, s, "w"); // onto "bar"
  press(ui, s, ".");
  assert.equal(s.line, "X X");
}

// . repeats r with its replacement char.
{
  const ui = makeUi();
  const s = makeSession("aa", 0);
  s.vimMode = "normal";
  press(ui, s, "r");
  press(ui, s, "z");
  press(ui, s, "l");
  press(ui, s, ".");
  assert.equal(s.line, "zz");
}

// Deleting to a line end never leaves the cursor on the newline.
{
  const ui = makeUi();
  const s = makeSession("ab\ncd", 1);
  s.vimMode = "normal";
  press(ui, s, "x");
  assert.equal(s.line, "a\ncd");
  assert.equal(s.cursor, 0);
}

console.log("vim test passed");
