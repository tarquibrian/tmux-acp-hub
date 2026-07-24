#!/usr/bin/env node

import assert from "node:assert/strict";

process.stdout.isTTY = false;

const { PopupUi } = await import("../bin/acp-hub.mjs");
const { projectTranscriptTurns } = await import("../lib/core.mjs");

function makeUi() {
  return Object.assign(Object.create(PopupUi.prototype), {
    currentChat: {
      id: "c1",
      provider: "codex",
      projectName: "demo",
      status: "idle",
      turnSequence: 21,
    },
    historyEvents: [],
    pendingPromptSubmissions: new Map(),
    promptSubmissionSequence: 0,
    historyEventLimit: 5000,
    transcriptProjectionTimer: null,
    rebuildTranscriptProjection: () => {},
  });
}

// The submitted prompt belongs to the semantic projection immediately. A
// repaint before the daemon acknowledgement must never erase it.
{
  const ui = makeUi();
  const pending = ui.stagePromptSubmission("okey perfecto entonces empecemos", {
    clientPromptId: "prompt-1",
    at: "2026-07-18T17:13:08.000Z",
  });

  assert.equal(pending.state, "pending");
  assert.equal(pending.turnSequence, 22);
  assert.equal(
    projectTranscriptTurns(ui.transcriptProjectionEvents())[0].userEvent.text,
    "okey perfecto entonces empecemos",
  );

  // This is the critical old failure: a full semantic rebuild used to know
  // nothing about the locally echoed row and could make it disappear.
  assert.equal(
    projectTranscriptTurns(ui.transcriptProjectionEvents())[0].userEvent.clientPromptId,
    "prompt-1",
  );
}

// Multiline prompts retain their complete structure in the optimistic model;
// no later canonical or agent event should be required to reveal every line.
{
  const ui = makeUi();
  const text = "first line\n\nthird line\nfourth line";
  ui.stagePromptSubmission(text, {
    clientPromptId: "prompt-multiline",
    at: "2026-07-18T17:14:00.000Z",
  });
  const optimistic = projectTranscriptTurns(ui.transcriptProjectionEvents())[0];
  assert.equal(optimistic.userEvent.text, text);
  assert.equal(optimistic.userEvent.text.split("\n").length, 4);

  ui.appendHistoryEvent({
    type: "user",
    text,
    clientPromptId: "prompt-multiline",
    turnSequence: optimistic.turnSequence,
    at: "2026-07-18T17:14:00.150Z",
  });
  assert.equal(ui.reconcilePromptSubmission(ui.historyEvents.at(-1)), true);
  const canonical = projectTranscriptTurns(ui.transcriptProjectionEvents())[0];
  assert.equal(canonical.userEvent.text, text);
  assert.equal(ui.pendingPromptSubmissions.size, 0);
}

// Canonical acknowledgement replaces the optimistic event by identity. Two
// equal texts are still two real turns and must never be deduplicated by text.
{
  const ui = makeUi();
  ui.stagePromptSubmission("mismo texto", {
    clientPromptId: "prompt-a",
    at: "2026-07-18T17:13:08.000Z",
  });
  ui.stagePromptSubmission("mismo texto", {
    clientPromptId: "prompt-b",
    at: "2026-07-18T17:13:25.000Z",
  });

  ui.appendHistoryEvent({
    type: "user",
    text: "mismo texto",
    clientPromptId: "prompt-a",
    turnSequence: 22,
    at: "2026-07-18T17:13:08.320Z",
  });
  ui.reconcilePromptSubmission(ui.historyEvents.at(-1));
  ui.appendHistoryEvent({
    type: "turn_done",
    stopReason: "cancelled",
    turnSequence: 22,
    at: "2026-07-18T17:13:11.846Z",
  });

  const firstProjection = projectTranscriptTurns(ui.transcriptProjectionEvents());
  assert.equal(firstProjection.length, 2);
  assert.equal(firstProjection[0].status, "cancelled");
  assert.equal(firstProjection[0].userEvent.clientPromptId, "prompt-a");
  assert.equal(firstProjection[1].userEvent.clientPromptId, "prompt-b");

  ui.appendHistoryEvent({
    type: "user",
    text: "mismo texto",
    clientPromptId: "prompt-b",
    turnSequence: 23,
    at: "2026-07-18T17:13:25.877Z",
  });
  ui.reconcilePromptSubmission(ui.historyEvents.at(-1));
  ui.appendHistoryEvent({
    type: "turn_done",
    stopReason: "cancelled",
    turnSequence: 23,
    at: "2026-07-18T17:13:28.280Z",
  });

  const settled = projectTranscriptTurns(ui.transcriptProjectionEvents());
  assert.equal(settled.length, 2);
  assert.deepEqual(
    settled.map((turn) => turn.userEvent.clientPromptId),
    ["prompt-a", "prompt-b"],
  );
  assert.deepEqual(settled.map((turn) => turn.status), ["cancelled", "cancelled"]);
  assert.equal(ui.pendingPromptSubmissions.size, 0);
}

// A queued prompt belongs to the fixed queue shelf, never to the transcript.
// It becomes a user turn only when the daemon publishes its canonical event.
{
  const ui = makeUi();
  ui.currentChat.status = "responding";
  const queued = ui.stagePromptSubmission("se ejecuta despues", {
    clientPromptId: "queued-1",
    turnSequence: 22,
  });
  assert.equal(queued.queued, true);
  assert.equal(ui.pendingPromptSubmissions.size, 1);
  assert.equal(projectTranscriptTurns(ui.transcriptProjectionEvents()).length, 0);
  assert.equal(ui.queueShelfCount(), 1);
  assert.match(ui.queueShelfLine(80), /Queue 1.*Next: se ejecuta despues/);

  ui.appendHistoryEvent({
    type: "user",
    text: "se ejecuta despues",
    clientPromptId: "queued-1",
    turnSequence: 22,
    at: "2026-07-18T17:20:00.000Z",
  });
  assert.equal(ui.reconcilePromptSubmission(ui.historyEvents.at(-1)), true);
  assert.equal(
    projectTranscriptTurns(ui.transcriptProjectionEvents())[0].userEvent.text,
    "se ejecuta despues",
  );
  assert.equal(ui.queueShelfCount(), 0);
}

// Cancelling removes an acknowledged queued prompt by stable id without
// affecting a different active/canonical turn.
{
  const ui = makeUi();
  ui.currentChat.status = "responding";
  ui.stagePromptSubmission("se descarta", {
    clientPromptId: "queued-1",
    turnSequence: 22,
  });
  assert.equal(ui.discardPromptSubmission("queued-1", { render: false }), true);
  assert.equal(ui.pendingPromptSubmissions.size, 0);
  assert.equal(ui.discardPromptSubmission("queued-1", { render: false }), false);
}

console.log("prompt lifecycle tests passed");
