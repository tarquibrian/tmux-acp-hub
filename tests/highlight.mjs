#!/usr/bin/env node
// Unit tests for the zero-dependency fenced-code syntax highlighter.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
delete process.env.TMUX;

const { highlightCode } = await import("../bin/acp-hub.mjs");
const { codeLanguageForPath } = await import("../lib/core.mjs");

const KEYWORD = "\x1b[38;5;176m";
const STRING = "\x1b[38;5;114m";
const NUMBER = "\x1b[38;5;179m";
const COMMENT = "\x1b[38;5;245m";
const SPECIAL = "\x1b[38;5;81m";
const END = "\x1b[39m";

// --- File paths select the same language aliases used by fenced code --------
assert.equal(codeLanguageForPath("lib/ui.mjs"), "mjs");
assert.equal(codeLanguageForPath("src/view.tsx"), "tsx");
assert.equal(codeLanguageForPath("scripts/release.zsh"), "zsh");
assert.equal(codeLanguageForPath("Dockerfile"), "dockerfile");
assert.equal(codeLanguageForPath("Makefile"), "makefile");
assert.equal(codeLanguageForPath("tmux.conf"), "tmux");
assert.equal(codeLanguageForPath("/home/user/.tmux.conf"), "tmux");
assert.equal(codeLanguageForPath("assets/blob.unknown"), "");

// --- JavaScript -------------------------------------------------------------------
{
  const out = highlightCode('const x = "hi"; // note', "js");
  assert.ok(out.includes(`${KEYWORD}const${END}`), "js keyword tinted");
  assert.ok(out.includes(`${STRING}"hi"${END}`), "js string tinted");
  assert.ok(out.includes(`${COMMENT}// note${END}`), "js comment tinted");
  assert.ok(!out.includes("\x1b[0m"), "no full resets (would kill the code background)");
}

// --- Comments win over their content ------------------------------------------------
{
  const out = highlightCode('// const "fake" 42', "ts");
  assert.equal(out, `${COMMENT}// const "fake" 42${END}`, "whole comment is one token");
}

// --- Python -----------------------------------------------------------------------
{
  const out = highlightCode("def f(n): # doc", "py");
  assert.ok(out.includes(`${KEYWORD}def${END}`), "python keyword");
  assert.ok(out.includes(`${COMMENT}# doc${END}`), "python comment");
}

// --- Shell ------------------------------------------------------------------------
{
  const out = highlightCode('if [ -f "$1" ]; then # check', "bash");
  assert.ok(out.includes(`${KEYWORD}if${END}`), "shell keyword");
  assert.ok(out.includes(`${COMMENT}# check${END}`), "shell comment");
}

// --- tmux -------------------------------------------------------------------------
{
  const out = highlightCode("set -g @acp_hub_padding '2'", "tmux");
  assert.ok(out.includes(`${KEYWORD}set${END}`), "tmux command tinted");
  assert.ok(out.includes(`${SPECIAL}-g${END}`), "tmux flag tinted");
  assert.ok(out.includes(`${SPECIAL}@acp_hub_padding${END}`), "tmux user option tinted");
  assert.ok(out.includes(`${STRING}'2'${END}`), "tmux value tinted");

  const format = highlightCode("display-message '#{pane_current_path}'", "tmuxconf");
  assert.ok(format.includes(`${KEYWORD}display-message${END}`), "tmux alias uses grammar");
  assert.ok(format.includes(`${SPECIAL}'#{pane_current_path}'${END}`), "tmux format tinted");
  assert.equal(highlightCode("# set -g @fake 2", "tmux"), `${COMMENT}# set -g @fake 2${END}`);
}

// Plain-text fences deliberately remain neutral.
{
  const line = "set -g @acp_hub_padding '2'";
  assert.equal(highlightCode(line, "text"), line);
}

// --- Numbers ----------------------------------------------------------------------
{
  const out = highlightCode("let n = 42.5e3;", "js");
  assert.ok(out.includes(`${NUMBER}42.5e3${END}`), "number tinted");
}

// --- SQL is case-insensitive --------------------------------------------------------
{
  const out = highlightCode("SELECT id FROM users WHERE age > 21", "sql");
  assert.ok(out.includes(`${KEYWORD}SELECT${END}`), "uppercase sql keyword");
  assert.ok(out.includes(`${KEYWORD}FROM${END}`), "second sql keyword");
}

// --- Unknown language passes through -------------------------------------------------
{
  const line = "const looks like code but lang is unknown";
  assert.equal(highlightCode(line, "brainfuck"), line, "unknown lang untouched");
  assert.equal(highlightCode(line, ""), line, "no lang untouched");
}

// --- Keywords inside identifiers stay plain ------------------------------------------
{
  const out = highlightCode("constellation = 1", "js");
  assert.ok(!out.includes(`${KEYWORD}const${END}`), "word-boundary respected");
}

// --- Regex is reusable across calls (lastIndex reset) --------------------------------
{
  const first = highlightCode("return 1", "go");
  const second = highlightCode("return 2", "go");
  assert.ok(first.includes(`${KEYWORD}return${END}`), "first call tints");
  assert.ok(second.includes(`${KEYWORD}return${END}`), "second call tints identically");
}

console.log("highlight test passed");
