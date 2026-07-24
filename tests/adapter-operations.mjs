#!/usr/bin/env node
import assert from "node:assert/strict";
import { HubDaemon } from "../lib/daemon.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeDaemon() {
  const daemon = new HubDaemon({
    defaultAgent: "claude",
    agents: {
      claude: {
        label: "Claude ACP",
        command: "npx",
        args: ["-y", "@agentclientprotocol/claude-agent-acp@0.59.0"],
      },
      custom: { label: "Custom", command: "/opt/custom-acp", args: [] },
    },
  });
  const events = [];
  daemon.broadcastGlobal = (event) => events.push(event);
  daemon.logLifecycle = () => {};
  daemon.busyChatSummaries = () => [];
  return { daemon, events };
}

// Starting returns immediately, publishes durable phase snapshots, and keeps
// the completed result until a client explicitly acknowledges it.
{
  const { daemon, events } = makeDaemon();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  daemon.adapterVersions = {
    descriptor: (provider) => ({
      provider,
      label: "Claude ACP",
      managed: provider !== "custom",
    }),
    versions: async () => ({
      providers: [{
        provider: "claude",
        label: "Claude ACP",
        managed: true,
        configuredVersion: "0.59.0",
        activeVersion: null,
      }],
    }),
    update: async (_provider, options) => {
      options.onProgress({ phase: "download", provider: "claude", version: "0.60.0" });
      await gate;
      options.onProgress({ phase: "handshake", provider: "claude", version: "0.60.0" });
      return {
        ok: true,
        provider: "claude",
        configuredVersion: "0.59.0",
        activeVersion: null,
        pendingVersion: "0.60.0",
        requiresRestart: true,
      };
    },
  };

  const started = await daemon.startAdapterOperation("update", "claude", { force: true });
  assert.equal(started.status, "running");
  assert.equal(started.phase, "checking");
  assert.equal(daemon.currentAdapterOperation().id, started.id);
  await tick();
  assert.equal(daemon.currentAdapterOperation().phase, "download");

  const duplicate = await daemon.startAdapterOperation("update", "claude", { force: true });
  assert.equal(duplicate.id, started.id, "a repeated command rejoins the in-flight operation");
  await assert.rejects(
    daemon.startAdapterOperation("rollback", "claude"),
    /already running/,
  );

  release();
  await tick();
  await tick();
  const completed = daemon.currentAdapterOperation();
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.phase, "staged");
  assert.equal(completed.version, "0.60.0");
  assert.equal(completed.result.requiresRestart, true);
  assert.equal(completed.result.items[0].pendingVersion, "0.60.0");
  assert.ok(
    events.some((event) => event.type === "adapter_operation" && event.operation?.phase === "handshake"),
    "phase progress is broadcast as recoverable operation snapshots",
  );

  daemon.markCurrentChat = () => {};
  daemon.chats.set("chat-1", {
    id: "chat-1",
    provider: "claude",
    providerLabel: "Claude ACP",
    cwd: "/repo/demo",
    projectName: "demo",
    title: "Update test",
    status: "idle",
    history: [],
    promptQueue: [],
  });
  const subscription = await daemon.subscribe({ subscriptions: new Set() }, "chat-1");
  assert.equal(
    subscription.adapterOperation.id,
    started.id,
    "a reopened popup receives the current operation with its chat subscription",
  );

  assert.deepEqual(daemon.ackAdapterOperation(started.id), { ok: true, operation: null });
  assert.equal(daemon.currentAdapterOperation(), null);
  assert.equal(events.at(-1).operation, null);
}

// Failures become an actionable terminal state instead of disappearing into a
// transient notification, and unmanaged commands are rejected before work is detached.
{
  const { daemon } = makeDaemon();
  daemon.adapterVersions = {
    descriptor: (provider) => ({ provider, managed: provider !== "custom" }),
    versions: async () => ({
      providers: [{
        provider: "claude",
        label: "Claude ACP",
        managed: true,
        configuredVersion: "0.59.0",
      }],
    }),
    update: async () => { throw new Error("registry unavailable"); },
  };

  await assert.rejects(
    daemon.startAdapterOperation("update", "custom"),
    /not managed/,
  );
  const started = await daemon.startAdapterOperation("update", "claude");
  await tick();
  const failed = daemon.currentAdapterOperation();
  assert.equal(failed.id, started.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /registry unavailable/);
}

console.log("adapter operation tests passed");
