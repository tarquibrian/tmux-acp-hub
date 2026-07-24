#!/usr/bin/env node

import assert from "node:assert/strict";

delete process.env.TMUX;

const {
  agentMessageRoleFromUpdate,
  buildTurnCard,
  retainHistoryByTurns,
} = await import("../lib/core.mjs");
const { HubDaemon } = await import("../lib/daemon.mjs");

assert.equal(
  agentMessageRoleFromUpdate({ _meta: { codex: { phase: "commentary" } } }),
  "commentary",
);
assert.equal(
  agentMessageRoleFromUpdate({ _meta: { codex: { phase: "final_answer" } } }),
  "final",
);
assert.equal(agentMessageRoleFromUpdate({ _meta: { claude: { phase: "answer" } } }), "unknown");
assert.equal(agentMessageRoleFromUpdate({}), "unknown");

// The daemon stores only the normalized role, never a provider's arbitrary
// metadata payload (which may grow or contain unrelated private extensions).
{
  const daemon = new HubDaemon({ defaultAgent: "codex", agents: {} });
  const emitted = [];
  daemon.setStatus = () => {};
  daemon.addEvent = (_chat, event) => emitted.push(event);
  daemon.handleSessionUpdate({}, {
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "Done." },
      _meta: {
        codex: { phase: "final_answer" },
        unrelated: { secret: "do not persist" },
      },
    },
  });

  assert.deepEqual(emitted, [{
    type: "agent_chunk",
    text: "Done.",
    messageId: "answer",
    messageRole: "final",
  }]);
  assert.equal("_meta" in emitted[0], false);
}

// Live and persisted histories retain the normalized role, and chunks with a
// reused message id cannot cross the commentary/final boundary.
{
  const daemon = new HubDaemon({ defaultAgent: "codex", agents: {} });
  daemon.historyLimit = 200;
  daemon.persistState = () => {};
  daemon.saveRegistry = () => {};
  daemon.broadcast = () => {};
  const chat = {
    id: "role-chat",
    history: [{ type: "user", text: "test roles", turnSequence: 1 }],
    turnActive: true,
    turnStartedAt: new Date(0).toISOString(),
    turnSequence: 1,
  };
  const record = { id: chat.id, history: [] };
  daemon.registry.set(chat.id, record);

  daemon.addEvent(chat, {
    type: "agent_chunk",
    messageId: "reused",
    messageRole: "commentary",
    text: "Progress.",
  });
  daemon.addEvent(chat, {
    type: "agent_chunk",
    messageId: "reused",
    messageRole: "final",
    text: "Answer.",
  });

  const liveChunks = chat.history.filter((event) => event.type === "agent_chunk");
  const savedChunks = record.history.filter((event) => event.type === "agent_chunk");
  assert.equal(liveChunks.length, 2);
  assert.deepEqual(liveChunks.map((event) => event.messageRole), ["commentary", "final"]);
  assert.deepEqual(savedChunks.map((event) => event.messageRole), ["commentary", "final"]);
}

// Compaction preserves an explicitly classified final answer even if a later
// commentary event exists. Reopening the retained history must project the
// same final response instead of falling back to whichever message came last.
{
  const history = [
    { type: "user", text: "compact", turnSequence: 4 },
    ...Array.from({ length: 10 }, (_, index) => ({
      type: "tool_update",
      toolCallId: `tool-${index}`,
      status: "completed",
      turnSequence: 4,
    })),
    {
      type: "agent_chunk",
      messageId: "answer",
      messageRole: "final",
      text: "Stable ",
      turnSequence: 4,
    },
    {
      type: "agent_chunk",
      messageId: "answer",
      messageRole: "final",
      text: "answer.",
      turnSequence: 4,
    },
    {
      type: "agent_chunk",
      messageId: "late-commentary",
      messageRole: "commentary",
      text: "Late diagnostic.",
      turnSequence: 4,
    },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 4 },
  ];
  const retained = retainHistoryByTurns(history, 6);
  const events = retained.filter((event) => event.type !== "history_boundary" && event.type !== "user" && event.type !== "turn_done");
  const card = buildTurnCard({
    turnSequence: 4,
    userEvent: retained.find((event) => event.type === "user"),
    events,
    doneEvent: retained.find((event) => event.type === "turn_done"),
  });
  assert.equal(card.finalText, "Stable answer.");
  assert.ok(card.finalEvents.every((event) => event.messageRole === "final"));
}

console.log("message role tests passed");
