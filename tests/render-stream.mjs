#!/usr/bin/env node
// Regression test: a markdown table streamed in small chunks must render as a
// formatted table, not raw pipes. Reproduces the bug where a chunk boundary in
// the middle of a table row let the header/separator flush early, leaving the
// data rows to render raw.
import assert from "node:assert/strict";
import { PopupUi } from "../bin/vanzi-hub.mjs";

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
  });
  return ui;
}

const strip = (v) => String(v).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function renderStreamed(text, chunkSize) {
  const ui = makeUi();
  let captured = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    captured += s;
    return true;
  };
  try {
    for (let i = 0; i < text.length; i += chunkSize) {
      ui.renderResponseChunk({ text: text.slice(i, i + chunkSize), messageId: "m1" });
    }
    ui.flushChunkBuffer({ force: true }); // simulate turn_done
  } finally {
    process.stdout.write = orig;
  }
  return strip(captured);
}

const table =
  "Here is a table:\n\n" +
  "| Name | Type | Size |\n" +
  "|---|---:|---:|\n" +
  "| .antigravitycli | dir | 0B |\n" +
  "| .claude | dir | 4.0K |\n" +
  "| nvim | dir | 144K |\n" +
  "\nDone.\n";

for (const chunkSize of [3, 5, 8, 17, 1000]) {
  const out = renderStreamed(table, chunkSize);
  assert.ok(
    !/\|\s*Name\s*\|\s*Type\s*\|/.test(out),
    `chunkSize=${chunkSize}: table rendered raw with pipes:\n${out}`,
  );
  assert.ok(/Name/.test(out) && /nvim/.test(out) && /Done\./.test(out), `chunkSize=${chunkSize}: content missing`);
}

console.log("render-stream test passed");
