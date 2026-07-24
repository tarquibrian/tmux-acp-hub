#!/usr/bin/env node
// Unit tests for lib/render.mjs: display-width math, ANSI-aware wrapping, and
// style-preserving truncation.
import assert from "node:assert/strict";
import {
  stringDisplayWidth,
  charDisplayWidth,
  layoutAnsiText,
  layoutEditableLine,
  textOffsetAtDisplayColumn,
  wrapAnsiLine,
  wrapAnsiWords,
  truncateAnsiToWidth,
  stripAnsi,
} from "../lib/render.mjs";

const strip = (value) => stripAnsi(value);

// stringDisplayWidth
assert.equal(stringDisplayWidth("hello"), 5);
assert.equal(stringDisplayWidth(""), 0);
assert.equal(stringDisplayWidth("\x1b[1mbold\x1b[0m"), 4, "ANSI sequences are zero width");
assert.equal(stringDisplayWidth("日本語"), 6, "CJK is double width");
assert.equal(stringDisplayWidth("한글"), 4, "Hangul is double width");
assert.equal(stringDisplayWidth("🚀"), 2, "emoji is double width");
assert.equal(stringDisplayWidth("café"), 4, "precomposed accent is one column");
assert.equal(stringDisplayWidth("café"), 4, "combining accent is zero width");
assert.equal(stringDisplayWidth("a​b"), 2, "zero-width space is zero width");

// charDisplayWidth
assert.equal(charDisplayWidth("a"), 1);
assert.equal(charDisplayWidth("字"), 2);
assert.equal(charDisplayWidth("́"), 0);

// wrapAnsiLine: plain hard wrap
assert.deepEqual(wrapAnsiLine("abcdef", 3), ["abc", "def"]);
assert.deepEqual(wrapAnsiLine("abcd", 3), ["abc", "d"]);
assert.deepEqual(wrapAnsiLine("", 10), [""], "empty line keeps one blank row");
assert.deepEqual(wrapAnsiLine("ab", 10), ["ab"], "short line does not wrap");
assert.deepEqual(
  layoutAnsiText("abcdef", 3, { mode: "hard" }),
  wrapAnsiLine("abcdef", 3),
  "hard adapter delegates to the shared layout engine",
);
assert.equal(strip(layoutAnsiText("abcdef", 4, { mode: "truncate" })[0]), "abc…");

// wrapAnsiWords: prose moves a whole word when it would cross the edge.
assert.deepEqual(wrapAnsiWords("123456789012 palabra final", 16), [
  "123456789012",
  "palabra final",
]);
assert.deepEqual(wrapAnsiWords("one two three", 7), ["one two", "three"]);
assert.deepEqual(wrapAnsiWords("one    two", 8), ["one", "two"], "boundary whitespace is dropped");
assert.deepEqual(
  layoutAnsiText("one two three", 7, { mode: "word" }),
  wrapAnsiWords("one two three", 7),
  "word adapter delegates to the shared layout engine",
);
assert.deepEqual(
  layoutAnsiText("permission", 1, { mode: "word", continuationWidth: 10 }),
  ["", "permission"],
  "a long prefix may yield before a word that fits the continuation",
);

// Only a token wider than a complete row falls back to a hard wrap.
assert.deepEqual(wrapAnsiWords("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);

// ANSI state survives a word boundary just like it does in the hard wrapper.
{
  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  const rows = wrapAnsiWords(`${green}alpha beta${reset}`, 5);
  assert.deepEqual(rows.map(strip), ["alpha", "beta"]);
  assert.ok(rows[0].startsWith(green));
  assert.ok(rows[0].endsWith(reset));
  assert.ok(rows[1].startsWith(green), "continuation re-opens the active style");
}

// Editable word layout keeps source ranges while omitting soft-boundary space.
{
  const text = "123456789012 palabra final";
  const rows = layoutEditableLine(text, 16);
  assert.deepEqual(rows.map((row) => row.text), ["123456789012", "palabra final"]);
  assert.deepEqual(rows.map(({ start, end }) => [start, end]), [[0, 13], [13, 26]]);
  assert.equal(rows[0].contentEnd, 12, "separator stays mapped but is not rendered");
  assert.equal(rows[0].end, rows[1].start, "editable source ranges stay contiguous");
  assert.equal(textOffsetAtDisplayColumn("日ab", 2), 1, "display columns map back to code units");

  const trailing = layoutEditableLine("palabra   ", 16);
  assert.deepEqual(trailing.map((row) => row.text), ["palabra   "]);
  assert.equal(trailing[0].width, 10, "typed trailing spaces occupy cursor columns");

  const trailingWrap = layoutEditableLine("1234 ", 4);
  assert.deepEqual(trailingWrap.map((row) => row.text), ["1234", " "]);
  assert.deepEqual(
    trailingWrap.map(({ start, end }) => [start, end]),
    [[0, 4], [4, 5]],
    "a trailing space crossing the edge gets its own source-mapped row",
  );

  const unicode = layoutEditableLine("ab 日本語 palabra", 7);
  assert.ok(unicode.every((row) => stringDisplayWidth(row.text) <= 7));
  assert.ok(unicode.every((row, index) => index === 0 || unicode[index - 1].end === row.start));
  assert.deepEqual(layoutEditableLine("abcdefghijkl", 5).map((row) => row.text), [
    "abcde",
    "fghij",
    "kl",
  ]);
}

// wrapAnsiLine: wide chars never split across a column boundary
{
  const rows = wrapAnsiLine("ab字cd", 3);
  assert.deepEqual(rows, ["ab", "字c", "d"], "wide char moves to next row instead of overflowing");
  for (const row of rows) assert.ok(stringDisplayWidth(row) <= 3);
}

// wrapAnsiLine: ANSI styles carry across wrapped rows and rows self-terminate
{
  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  const rows = wrapAnsiLine(`${green}abcdef${reset}`, 3);
  assert.equal(rows.length, 2);
  assert.equal(strip(rows[0]), "abc");
  assert.equal(strip(rows[1]), "def");
  assert.ok(rows[0].startsWith(green), "first row keeps opening style");
  assert.ok(rows[0].endsWith(reset), "styled row is closed with a reset");
  assert.ok(rows[1].startsWith(green), "continuation row re-opens the style");
  assert.ok(rows[1].includes(reset), "continuation row is reset");
}

// wrapAnsiLine: visible width budget is respected with mixed content
{
  const rows = wrapAnsiLine("\x1b[1mtítulo\x1b[0m con 日本語 y 🚀 emoji", 8);
  for (const row of rows) {
    assert.ok(stringDisplayWidth(row) <= 8, `row too wide: ${JSON.stringify(row)}`);
  }
  assert.equal(strip(rows.join("")), "título con 日本語 y 🚀 emoji");
}

// truncateAnsiToWidth
assert.equal(truncateAnsiToWidth("hello", 10), "hello", "no cut when it fits");
{
  const cut = truncateAnsiToWidth("hello world", 6);
  assert.equal(strip(cut), "hello…");
  assert.ok(stringDisplayWidth(cut) <= 6);
}
{
  const cut = truncateAnsiToWidth("\x1b[32mgreen text\x1b[0m", 6);
  assert.ok(cut.startsWith("\x1b[32m"), "style preserved when truncating");
  assert.equal(strip(cut), "green…");
  assert.ok(stringDisplayWidth(cut) <= 6);
}
{
  const cut = truncateAnsiToWidth("日本語テキスト", 5);
  assert.ok(stringDisplayWidth(cut) <= 5, "wide chars respect the width limit");
  assert.ok(strip(cut).endsWith("…"));
}

console.log("render-width test passed");
