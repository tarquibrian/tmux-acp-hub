#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  agentMessageGroups,
  buildActivityGroups,
  buildTurnCard,
  canMergeHistoryChunk,
  projectActivityDetails,
  projectTranscriptTurns,
} from "../lib/core.mjs";

const at = (seconds) => `2026-07-18T12:00:${String(seconds).padStart(2, "0")}.000Z`;

// Activity is derived from tool lifecycles, not from individual ACP updates.
// A pending call followed by completion remains one action and adopts the
// latest useful metadata without losing the original title/kind.
{
  const groups = buildActivityGroups([
    {
      type: "tool_call",
      toolCallId: "read-1",
      title: "Read core",
      kind: "read",
      status: "in_progress",
    },
    {
      type: "tool_update",
      toolCallId: "read-1",
      status: "completed",
      summary: "Read lib/core.mjs",
    },
    {
      type: "tool_call",
      toolCallId: "read-2",
      title: "Search renderer",
      kind: "search",
      status: "completed",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Explored");
  assert.equal(groups[0].status, "completed");
  assert.equal(groups[0].actions.length, 2);
  assert.equal(groups[0].actions[0].title, "Read core");
  assert.equal(groups[0].actions[0].summary, "Read lib/core.mjs");
}

// Grouping is chronological: returning to a category after another category
// creates a new run rather than merging distant actions and reordering work.
{
  const groups = buildActivityGroups([
    { type: "tool_call", toolCallId: "edit-1", kind: "edit", status: "completed" },
    { type: "tool_call", toolCallId: "read-1", kind: "read", status: "completed" },
    { type: "tool_call", toolCallId: "edit-2", kind: "edit", status: "failed" },
  ]);
  assert.deepEqual(groups.map((group) => group.name), ["Edited", "Explored", "Edited"]);
  assert.deepEqual(groups.map((group) => group.status), ["completed", "completed", "error"]);

  const cancelled = buildActivityGroups([
    { type: "tool_call", toolCallId: "run-cancelled", kind: "execute", status: "cancelled" },
  ]);
  assert.equal(cancelled[0].status, "cancelled");
}

// Non-tool transcript content is a semantic boundary. Tool updates still
// merge into their original action, while commentary remains in its position.
{
  const projected = projectActivityDetails([
    { type: "tool_call", toolCallId: "run-1", kind: "execute", status: "in_progress" },
    { type: "agent_chunk", messageId: "commentary", text: "Waiting for tests." },
    { type: "tool_update", toolCallId: "run-1", status: "completed" },
    { type: "tool_call", toolCallId: "run-2", kind: "execute", status: "completed" },
  ]);
  assert.deepEqual(projected.map((item) => item.kind), ["activity-group", "event", "activity-group"]);
  assert.equal(projected[0].group.actions.length, 1);
  assert.equal(projected[0].group.actions[0].status, "completed");
  assert.equal(projected[2].group.actions.length, 1);
}

// Group identity follows ACP's toolCallId, so removing a reclassified final
// message cannot invalidate hover/expansion state by shifting event indexes.
{
  const withLeadingMessage = buildActivityGroups([
    { type: "agent_chunk", messageId: "answer", text: "Done." },
    { type: "tool_call", toolCallId: "stable-tool", kind: "read", status: "completed" },
  ]);
  const withoutLeadingMessage = buildActivityGroups([
    { type: "tool_call", toolCallId: "stable-tool", kind: "read", status: "completed" },
  ]);
  assert.equal(withLeadingMessage[0].id, withoutLeadingMessage[0].id);
}

// Exact ACP ids keep message boundaries even when tool activity interrupts a
// message stream. The last logical message is the final answer.
{
  const events = [
    { type: "agent_chunk", messageId: "progress", text: "Checking ", at: at(1) },
    { type: "tool_call", toolCallId: "t1", title: "read", at: at(2) },
    { type: "agent_chunk", messageId: "progress", text: "again", at: at(3) },
    { type: "tool_update", toolCallId: "t1", status: "completed", diffs: [{ path: "a.js" }], at: at(4) },
    { type: "agent_chunk", messageId: "final", text: "Done.", at: at(5) },
  ];
  const groups = agentMessageGroups(events);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].events.map((event) => event.text).join(""), "Checking again");

  const card = buildTurnCard({
    turnSequence: 7,
    userEvent: { type: "user", text: "fix it", at: at(0) },
    events,
    doneEvent: { type: "turn_done", stopReason: "end_turn", at: at(6) },
  });
  assert.equal(card.status, "completed");
  assert.equal(card.finalText, "Done.");
  assert.equal(card.finalMessageId, "final");
  assert.equal(card.actionCount, 1);
  assert.deepEqual(card.changedFiles, ["a.js"]);
  assert.equal(card.durationMs, 6000);
  assert.ok(card.detailEvents.some((event) => event.messageId === "progress"));
}

// Without message ids, only contiguous agent runs may be treated as a logical
// message. A tool boundary therefore separates progress from the final text.
{
  const card = buildTurnCard({
    turnSequence: 2,
    userEvent: { type: "user", text: "legacy", at: at(0) },
    events: [
      { type: "agent_chunk", text: "I will inspect.", at: at(1) },
      { type: "tool_call", toolCallId: "legacy-tool", at: at(2) },
      { type: "agent_chunk", text: "Final answer", at: at(3) },
      { type: "agent_chunk", text: " continued", at: at(4) },
    ],
    doneEvent: { type: "turn_done", stopReason: "end_turn", at: at(5) },
  });
  assert.equal(card.finalText, "Final answer continued");
  assert.equal(card.finalMessageId, null);
}

// Legacy histories infer sequences; explicit sequences also recover a turn
// whose leading user event was truncated by the persistence limit.
{
  const projection = projectTranscriptTurns([
    { type: "system", text: "ready", at: at(0) },
    { type: "user", text: "one", at: at(1) },
    { type: "agent_chunk", text: "first", at: at(2) },
    { type: "turn_done", stopReason: "end_turn", at: at(3) },
    { type: "agent_chunk", text: "truncated final", turnSequence: 9, at: at(4) },
    { type: "turn_done", stopReason: "cancelled", turnSequence: 9, at: at(5) },
  ]);
  assert.equal(projection[0].kind, "event");
  assert.equal(projection[1].turnSequence, 1);
  assert.equal(projection[1].finalText, "first");
  assert.equal(projection[2].turnSequence, 9);
  assert.equal(projection[2].status, "cancelled");
  assert.equal(projection[2].finalText, "truncated final");
}

for (const [stopReason, expected] of [
  ["cancelled", "cancelled"],
  ["error", "error"],
  ["max_tokens", "partial"],
]) {
  const card = buildTurnCard({
    turnSequence: 1,
    userEvent: { type: "user", at: at(0) },
    events: [],
    doneEvent: { type: "turn_done", stopReason, at: at(1) },
  });
  assert.equal(card.status, expected);
}

const active = buildTurnCard({
  turnSequence: 3,
  userEvent: { type: "user", at: at(0) },
  events: [{ type: "thought_chunk", text: "working", at: at(1) }],
});
assert.equal(active.status, "active");
assert.equal(active.completedAt, null);

const inferredDuration = buildTurnCard({
  turnSequence: 4,
  userEvent: { type: "user", at: at(1) },
  events: [],
  doneEvent: { type: "turn_done", stopReason: "end_turn", durationMs: null, at: at(4) },
});
assert.equal(inferredDuration.durationMs, 3000, "null duration falls back to event timestamps");

// Provider phases are semantic boundaries, not merely presentation hints.
// Codex's final answer must be classifiable before turn_done so the UI never
// needs to move it out of Activity after streaming has finished.
{
  const events = [
    {
      type: "agent_chunk",
      messageId: "commentary",
      messageRole: "commentary",
      text: "Inspecting the repository.",
      at: at(1),
    },
    { type: "tool_call", toolCallId: "read", title: "Read files", at: at(2) },
    {
      type: "agent_chunk",
      messageId: "answer",
      messageRole: "final",
      text: "Everything is ready.",
      at: at(3),
    },
  ];
  const activeCard = buildTurnCard({
    turnSequence: 5,
    userEvent: { type: "user", text: "inspect", at: at(0) },
    events,
  });
  const settledCard = buildTurnCard({
    turnSequence: 5,
    userEvent: { type: "user", text: "inspect", at: at(0) },
    events,
    doneEvent: { type: "turn_done", stopReason: "end_turn", at: at(4) },
  });

  assert.equal(activeCard.finalText, "Everything is ready.");
  assert.deepEqual(activeCard.finalEvents, settledCard.finalEvents);
  assert.ok(activeCard.detailEvents.some((event) => event.messageRole === "commentary"));
  assert.ok(!activeCard.detailEvents.some((event) => event.messageRole === "final"));
}

// Agents without a phase signal keep live output in Activity and use the
// established last-message fallback only after their turn has settled.
{
  const events = [{ type: "agent_chunk", messageId: "unknown", text: "Legacy answer", at: at(1) }];
  const activeCard = buildTurnCard({ turnSequence: 6, events });
  const settledCard = buildTurnCard({
    turnSequence: 6,
    events,
    doneEvent: { type: "turn_done", stopReason: "end_turn", at: at(2) },
  });
  assert.equal(activeCard.finalText, "");
  assert.equal(activeCard.detailEvents.length, 1);
  assert.equal(settledCard.finalText, "Legacy answer");
}

assert.equal(
  canMergeHistoryChunk(
    { type: "agent_chunk", messageId: "shared", messageRole: "commentary" },
    { type: "agent_chunk", messageId: "shared", messageRole: "final" },
  ),
  false,
  "different semantic roles never merge even if an adapter reuses a message id",
);

console.log("turn card tests passed");
