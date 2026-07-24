#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  formatProviderCommand,
  mergeCommandDescriptors,
  normalizeProviderCommands,
  projectTranscriptTurns,
  retainHistoryByTurns,
  resolveProviderCommand,
  stripAnsi,
} from "../lib/core.mjs";
import { HubDaemon } from "../lib/daemon.mjs";

const providerCommands = [
  {
    name: "status",
    description: "Show session status",
    input: { hint: "[section]" },
  },
  {
    name: "plan",
    description: "Enter plan mode",
    _meta: {
      commandAction: {
        kind: "setConfigOption",
        configId: "collaboration_mode",
        value: "plan",
        resetValue: "default",
        presentation: "state",
      },
    },
  },
  { name: "$review", description: "Run the review skill" },
  { name: "review", aliases: ["inspect"], input: { hint: "<target>" } },
  { name: "future", _meta: { commandAction: { kind: "executeArbitraryCode" } } },
];

{
  const commands = normalizeProviderCommands(providerCommands);
  assert.equal(commands.length, 5);
  assert.deepEqual(
    commands.map((command) => [command.name, command.origin, command.presentation]),
    [
      ["/status", "provider", "informational"],
      ["/plan", "provider", "state"],
      ["/$review", "skill", "work"],
      ["/review", "provider", "work"],
      ["/future", "provider", "work"],
    ],
  );
  assert.equal(commands[0].inputHint, "[section]");
  assert.deepEqual(commands[1].action, {
    kind: "setConfigOption",
    configId: "collaboration_mode",
    value: "plan",
    resetValue: "default",
    presentation: "state",
  });
  assert.equal(commands[4].action, null, "unknown metadata is never interpreted locally");
  assert.match(stripAnsi(formatProviderCommand(commands[0])), /\/status \[section\].*Show session status/);

  const caseVariants = normalizeProviderCommands([
    { name: "status", description: "first" },
    { name: "STATUS", description: "duplicate" },
  ]);
  assert.equal(caseVariants.length, 1, "provider commands deduplicate case-insensitively");
}

{
  const retained = retainHistoryByTurns(
    [
      { type: "command", text: "/compact", name: "compact", turnSequence: 4 },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "tool_update",
        toolCallId: `noise-${index}`,
        turnSequence: 4,
      })),
      { type: "command_result", text: "Command /compact completed", turnSequence: 4 },
      { type: "turn_done", stopReason: "end_turn", turnSequence: 4 },
    ],
    4,
  );
  assert.ok(retained.some((event) => event.type === "command"));
  assert.ok(retained.some((event) => event.type === "command_result"));
  assert.ok(retained.some((event) => event.type === "turn_done"));
}

{
  const projection = projectTranscriptTurns([
    {
      type: "command",
      text: "/status model",
      name: "status",
      presentation: "informational",
      turnSequence: 9,
      at: "2026-07-18T12:00:00.000Z",
    },
    {
      type: "agent_chunk",
      text: "Model: fake",
      messageRole: "final",
      turnSequence: 9,
    },
    { type: "turn_done", stopReason: "end_turn", turnSequence: 9 },
  ]);
  assert.equal(projection.length, 1);
  assert.equal(projection[0].requestKind, "command");
  assert.equal(projection[0].userEvent.type, "command");
  assert.equal(projection[0].finalText, "Model: fake");
}

{
  const daemon = new HubDaemon({ defaultAgent: "fake", agents: {} });
  const emitted = [];
  daemon.rememberChat = () => {};
  daemon.addEvent = (_chat, event) => emitted.push(event);
  const chat = { availableCommands: [] };
  daemon.handleSessionUpdate(chat, {
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "first", input: { hint: "<path>" } },
        { name: "$dynamic-skill", description: "Loaded later" },
      ],
    },
  });
  assert.deepEqual(chat.availableCommands.map((command) => command.command), ["first", "$dynamic-skill"]);
  assert.equal(chat.availableCommands[0].inputHint, "<path>");
  assert.equal(chat.availableCommands[1].origin, "skill");
  assert.equal(emitted[0].text, "Commands available: 2");
}

{
  const merged = mergeCommandDescriptors(
    [
      { name: "/plan", hint: "show the pinned plan" },
      { name: "/help", hint: "hub help" },
      { name: "/hub", hint: "manage Hub adapters" },
    ],
    [...providerCommands, { name: "hub", description: "Provider-owned hub command" }],
  );
  const localPlan = merged.find((command) => command.origin === "hub" && command.command === "plan");
  const providerPlan = merged.find(
    (command) => command.origin === "provider" && command.command === "plan",
  );
  const status = merged.find((command) => command.command === "status");
  const inspect = merged.find((command) => command.aliasOf === "review");
  const providerHub = merged.find(
    (command) => command.origin === "provider" && command.command === "hub",
  );
  assert.equal(localPlan.name, "/plan");
  assert.equal(providerPlan.name, "//plan", "a collision advertises the explicit provider escape");
  assert.equal(providerPlan.collision, true);
  assert.equal(status.name, "/status", "non-colliding provider commands use normal slash syntax");
  assert.equal(inspect.name, "/inspect", "provider aliases are completion targets");
  assert.equal(inspect.hint.includes("Alias for /review"), true);
  assert.equal(providerHub.name, "//hub", "the Hub namespace keeps an explicit provider escape");

  const caseCollision = mergeCommandDescriptors(
    [{ name: "/plan", hint: "Hub plan" }],
    [{ name: "Plan", description: "Provider plan" }],
  ).find((command) => command.origin === "provider");
  assert.equal(caseCollision.name, "//Plan", "Hub precedence cannot be bypassed by casing");
}

{
  const resolved = resolveProviderCommand("/review src/lib core", providerCommands);
  assert.equal(resolved.descriptor.command, "review");
  assert.equal(resolved.arguments, "src/lib core");
  assert.equal(resolved.text, "/review src/lib core");

  const alias = resolveProviderCommand("/inspect --staged", providerCommands);
  assert.equal(alias.descriptor.command, "review");
  assert.equal(alias.text, "/review --staged", "aliases resolve to the provider's canonical command");

  const forced = resolveProviderCommand("//plan", providerCommands);
  assert.equal(forced.force, true);
  assert.equal(forced.text, "/plan");
  assert.equal(resolveProviderCommand("/missing", providerCommands), null);

  const canonicalWins = resolveProviderCommand("/status", [
    { name: "review", aliases: ["status"] },
    { name: "status" },
  ]);
  assert.equal(
    canonicalWins.descriptor.command,
    "status",
    "canonical provider commands outrank aliases regardless of report order",
  );
}

console.log("command system tests passed");
