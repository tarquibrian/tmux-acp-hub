#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

delete process.env.TMUX;
const {
  loadHistorySettings,
  retainHistoryByTurns,
  writeJsonFileSync,
} = await import("../lib/core.mjs");
const { HubDaemon } = await import("../lib/daemon.mjs");
const { PopupUi } = await import("../bin/acp-hub.mjs");

const previousLimit = process.env.ACP_HUB_HISTORY_LIMIT;
try {
  process.env.ACP_HUB_HISTORY_LIMIT = "750";
  assert.equal(loadHistorySettings().eventLimit, 750);
  process.env.ACP_HUB_HISTORY_LIMIT = "5";
  assert.equal(loadHistorySettings().eventLimit, 200, "unsafe tiny limits are clamped");
  process.env.ACP_HUB_HISTORY_LIMIT = "99999";
  assert.equal(loadHistorySettings().eventLimit, 20000, "runaway limits are bounded");
} finally {
  if (previousLimit === undefined) delete process.env.ACP_HUB_HISTORY_LIMIT;
  else process.env.ACP_HUB_HISTORY_LIMIT = previousLimit;
}

// Registry/state writes replace a complete temporary file atomically; no
// reader can observe the truncated JSON window of an in-place rewrite.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-atomic-json-"));
  const file = path.join(dir, "registry.json");
  try {
    writeJsonFileSync(file, { version: 1, chats: [{ id: "old" }] });
    writeJsonFileSync(file, {
      version: 2,
      chats: Array.from({ length: 500 }, (_, index) => ({ id: `chat-${index}` })),
    });
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.version, 2);
    assert.equal(parsed.chats.length, 500);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp-")),
      [],
      "atomic writer cleans temporary files",
    );
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Whole turns are retained as atomic units. Crossing the soft event budget
// drops the oldest complete turn instead of leaving an orphaned response.
{
  const history = [];
  for (let turnSequence = 1; turnSequence <= 4; turnSequence += 1) {
    history.push(
      { type: "user", text: `prompt-${turnSequence}`, turnSequence },
      { type: "thought_chunk", text: `detail-${turnSequence}`, turnSequence },
      { type: "agent_chunk", text: `final-${turnSequence}`, turnSequence },
      { type: "turn_done", stopReason: "end_turn", turnSequence },
    );
  }

  const retained = retainHistoryByTurns(history, 9);
  assert.equal(retained[0].type, "history_boundary");
  assert.deepEqual(
    retained.filter((event) => event.type === "user").map((event) => event.text),
    ["prompt-3", "prompt-4"],
  );
  assert.equal(
    retained.some((event) => event.turnSequence === 2 && event.type !== "history_boundary"),
    false,
  );
  assert.ok(
    retained.every(
      (event, index) =>
        event.type === "history_boundary" ||
        event.type === "user" ||
        retained.slice(0, index).some(
          (candidate) =>
            candidate.type === "user" && candidate.turnSequence === event.turnSequence,
        ),
    ),
    "retained scoped events always have their user boundary",
  );
}

// A single oversized latest turn is compacted but keeps its prompt, latest
// plan snapshot, final response, and durable closing event.
{
  const oversized = [
    { type: "user", text: "large prompt", turnSequence: 8 },
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "tool_update",
      toolCallId: `tool-${index}`,
      status: "completed",
      turnSequence: 8,
    })),
    { type: "plan", entries: [{ content: "last plan" }], turnSequence: 8 },
    { type: "agent_chunk", messageId: "final", text: "defini", turnSequence: 8 },
    { type: "tool_update", toolCallId: "late-tool", status: "completed", turnSequence: 8 },
    { type: "agent_chunk", messageId: "final", text: "tive", turnSequence: 8 },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 8 },
    { type: "queue_dropped", clientPromptIds: ["queued-after-turn"] },
  ];
  const retained = retainHistoryByTurns(oversized, 7);
  assert.ok(retained.length <= 7);
  assert.equal(retained[0].type, "history_boundary");
  assert.ok(retained.some((event) => event.type === "user" && event.text === "large prompt"));
  assert.ok(retained.some((event) => event.type === "plan"));
  assert.equal(
    retained.filter((event) => event.type === "agent_chunk").map((event) => event.text).join(""),
    "definitive",
  );
  assert.ok(retained.some((event) => event.type === "turn_done"));
  assert.equal(retained.at(-1).type, "queue_dropped");
}

// Legacy histories that already begin mid-turn cannot recover their missing
// prompt, but the loss is explicit instead of silently presenting a complete
// conversation.
{
  const legacy = retainHistoryByTurns([
    { type: "thought_chunk", text: "orphan", turnSequence: 19 },
    { type: "agent_chunk", text: "answer", turnSequence: 19 },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 19 },
  ], 200);
  assert.equal(legacy[0].type, "history_boundary");
  assert.equal(legacy[0].partialTurn, true);
  assert.equal(legacy[0].turnSequence, 19);
}

// The daemon applies one turn-aware limit to both its live chat and persisted
// record. Standalone metadata still uses the budget normally.
{
  const daemon = new HubDaemon({ defaultAgent: "codex", agents: {} });
  daemon.historyLimit = 200;
  daemon.persistState = () => {};
  daemon.broadcast = () => {};
  daemon.saveRegistry = () => {};
  const chat = {
    id: "history-chat",
    history: [],
    updatedAt: new Date(0).toISOString(),
    turnSequence: 0,
  };
  const record = { id: chat.id, history: [] };
  daemon.registry.set(chat.id, record);

  for (let index = 0; index < 205; index += 1) {
    daemon.addEvent(chat, { type: "system", text: `event-${index}` });
  }

  assert.equal(chat.history.length, 200);
  assert.equal(chat.history[0].type, "history_boundary");
  assert.equal(chat.history[1].text, "event-6");
  assert.equal(record.history.length, 200);
  assert.equal(record.history[0].type, "history_boundary");
  assert.equal(record.history[1].text, "event-6");
}

// UI retention follows the configured event window, while its semantic entry
// buffer can be larger. Completed-card cache entries disappear with evicted
// turns instead of accumulating for the lifetime of the popup.
{
  const ui = Object.assign(Object.create(PopupUi.prototype), {
    historyEvents: [],
    historyEventLimit: 200,
    transcriptEntries: [],
    transcriptEntryLimit: 5000,
    transcriptPadding: 0,
    turnCardProjectionCache: new Map(),
    liveTable: null,
  });

  for (let index = 0; index < 205; index += 1) {
    ui.appendHistoryEvent({ type: "system", text: `event-${index}` });
  }
  assert.equal(ui.historyEvents.length, 200);
  assert.equal(ui.historyEvents[0].type, "history_boundary");
  assert.equal(ui.historyEvents[1].text, "event-6");

  const retained = { kind: "turn-card", turn: { id: "retained" } };
  const evicted = { kind: "turn-card", turn: { id: "evicted" } };
  ui.transcriptEntries = [retained];
  ui.turnCardProjectionCache.set("retained|compact|0", retained);
  ui.turnCardProjectionCache.set("evicted|compact|0", evicted);
  assert.equal(ui.pruneTurnCardProjectionCache(), 1);
  assert.deepEqual([...ui.turnCardProjectionCache.keys()], ["retained|compact|0"]);

  ui.transcriptEntries = Array.from({ length: 5005 }, (_, index) => ({
    kind: "prose",
    text: `row-${index}`,
  }));
  assert.equal(ui.trimTranscriptBuffer(), 5);
  assert.equal(ui.transcriptEntries.length, 5000);
  assert.equal(ui.transcriptEntries[0].text, "row-5");

  const topProbe = ui.collectTranscriptRowsFromEnd(20, 20, Number.MAX_SAFE_INTEGER);
  assert.equal(topProbe.atTop, true);
  assert.equal(topProbe.total, 5000);
  const topWindow = ui.collectTranscriptRowsFromEnd(20, 20, topProbe.total - 20);
  assert.equal(topWindow.rows[0], "row-5", "the retained head remains reachable by scroll");
}

console.log("history retention tests passed");
