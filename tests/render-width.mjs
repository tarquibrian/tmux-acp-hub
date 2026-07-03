#!/usr/bin/env node
// Unit tests for lib/render.mjs: display-width math, ANSI-aware wrapping, and
// style-preserving truncation.
import assert from "node:assert/strict";
import {
  stringDisplayWidth,
  charDisplayWidth,
  wrapAnsiLine,
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
