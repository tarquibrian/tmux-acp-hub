#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(TEST_DIR, "..");
const HUB_BIN = path.join(PLUGIN_DIR, "bin", "acp-hub.mjs");
const FAKE_AGENT = path.join(TEST_DIR, "fake-acp-agent.mjs");

class JsonSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Hub socket closed"));
      }
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;

    this.socket.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
  }

  close() {
    this.socket.end();
  }

  handleData(chunk) {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;

      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      const message = JSON.parse(line);
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;

        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        continue;
      }

      for (const handler of this.eventHandlers) {
        handler(message);
      }
    }
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tmux-acp-hub-"));
const hubHome = path.join(tmp, "hub");
const socketPath = path.join(hubHome, "hub.sock");
const configPath = path.join(tmp, "agents.json");
const projectPath = path.join(tmp, "project");
const extraPath = path.join(tmp, "extra-root");
const mcpArgumentSecret = "mcp-rpc-argument-secret-canary";
const mcpUrlSecret = "mcp-rpc-query-secret-canary";

await fs.mkdir(projectPath, { recursive: true });
await fs.mkdir(extraPath, { recursive: true });
await fs.writeFile(
  configPath,
  `${JSON.stringify(
    {
      defaultAgent: "fake",
      agents: {
        fake: {
          label: "Fake ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
        },
        fakeauth: {
          label: "Fake Auth ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          env: { FAKE_REQUIRE_AUTH: "1" },
        },
        fakerestore: {
          label: "Fake Restore ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          env: { FAKE_RESTORE_FAILURE: "1" },
        },
        fakemcp: {
          label: "Fake MCP ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          mcpServers: [
            { name: "echo-mcp", command: "node", args: ["-e", "0"], env: {} },
            {
              name: "gated-mcp",
              type: "http",
              url: `https://example.test/mcp?access_token=${mcpUrlSecret}`,
              headers: {},
            },
          ],
        },
        fakemcpnew: {
          label: "Fake MCP New Session ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          env: { FAKE_NO_RESTORE: "1" },
        },
        fakemcprollback: {
          label: "Fake MCP Rollback ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          env: { FAKE_FAIL_MCP_NAME: "broken-mcp" },
        },
      },
    },
    null,
    2,
  )}\n`,
);

const env = {
  ...process.env,
  ACP_HUB_HOME: hubHome,
  ACP_HUB_SOCKET: socketPath,
  ACP_HUB_CONFIG: configPath,
  ACP_HUB_MCP_CONFIG: path.join(tmp, "mcp.json"),
  ACP_HUB_TITLE_POLICY: "agent-first",
  ACP_HUB_TAB_TITLE_MAX_WIDTH: "32",
  FAKE_EXPECT_CWD: projectPath,
  FAKE_EXTRA_DIR: extraPath,
  MCP_SECRET_TEST: "never-expose-this",
  FAKE_EXPECT_MCP_ARG_SECRET: mcpArgumentSecret,
};

const daemonLogs = [];
let daemon = startDaemon();

try {
  const hub = await connectWithRetry(socketPath);
  const events = [];
  hub.onEvent((event) => events.push(event));

  const adapterVersions = await hub.call("adapter_versions");
  assert.equal(adapterVersions.settings.channel, "stable");
  assert.equal(
    adapterVersions.providers.find((provider) => provider.provider === "fake")?.state,
    "unmanaged",
  );

  const chat = await hub.call("ensure_chat", { provider: "fake", cwd: projectPath });
  assert.equal(chat.status, "idle");
  assert.equal(chat.mode, "test");
  assert.equal(chat.title, "New chat");
  assert.equal(
    chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-small",
  );

  await hub.call("subscribe", { chatId: chat.id });
  const modelUpdate = await hub.call("set_config_option", {
    chatId: chat.id,
    configId: "model",
    value: "large",
  });
  assert.equal(
    modelUpdate.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );

  const effortUpdate = await hub.call("set_config_option", {
    chatId: chat.id,
    configId: "effort",
    value: "high",
  });
  assert.equal(
    effortUpdate.chat.configOptions.find((option) => option.id === "effort")?.currentValue,
    "high",
  );

  const modeUpdate = await hub.call("set_mode", {
    chatId: chat.id,
    modeId: "plan",
  });
  assert.equal(modeUpdate.chat.mode, "plan");

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "config",
    "--chat-id",
    chat.id,
    "--value",
    JSON.stringify({ configId: "model", value: "small" }),
  ]);
  const actionConfig = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(
    actionConfig.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-small",
  );
  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "config",
    "--chat-id",
    chat.id,
    "--value",
    JSON.stringify({ configId: "model", value: "large" }),
  ]);
  const actionConfigRestore = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(
    actionConfigRestore.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "mode",
    "--chat-id",
    chat.id,
    "--value",
    "test",
  ]);
  const actionMode = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(actionMode.chat.mode, "test");

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "access",
    "--chat-id",
    chat.id,
    "--value",
    "plan",
  ]);
  const actionAccess = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(actionAccess.chat.mode, "plan");

  const rootsUpdate = await hub.call("set_roots", {
    chatId: chat.id,
    additionalDirectories: [extraPath],
  });
  assert.deepEqual(rootsUpdate.chat.additionalDirectories, [extraPath]);
  assert.equal(rootsUpdate.requiresRestart, true);

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "roots-clear",
    "--chat-id",
    chat.id,
  ]);
  const actionRootsClear = await hub.call("subscribe", { chatId: chat.id });
  assert.deepEqual(actionRootsClear.chat.additionalDirectories, []);

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "roots-add",
    "--chat-id",
    chat.id,
    "--value",
    extraPath,
  ]);
  const actionRootsAdd = await hub.call("subscribe", { chatId: chat.id });
  assert.deepEqual(actionRootsAdd.chat.additionalDirectories, [extraPath]);

  // Rename now runs through the composer's in-process prompt (no CLI/shell
  // action), so a title with quotes can never break a command. Exercise the
  // daemon RPC the composer calls, including such a title.
  await hub.call("rename_chat", { chatId: chat.id, title: `Bob's "fake" chat` });
  const actionRename = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(actionRename.chat.title, `Bob's "fake" chat`);

  const activeSubmission = await hub.call("send_prompt", {
    chatId: chat.id,
    text: "plan permission",
    clientPromptId: "smoke-active-prompt",
  });
  assert.equal(activeSubmission.clientPromptId, "smoke-active-prompt");
  assert.ok(activeSubmission.turnSequence > 0);
  await waitFor(() => events.some((event) => event.event === "permission_request"));

  // A pending permission must survive a popup close and be re-surfaced when the
  // chat is re-subscribed, so a reopened popup can still answer it.
  const permEvent = events.find((event) => event.event === "permission_request");
  const resubscribe = await hub.call("subscribe", { chatId: chat.id });
  assert.ok(resubscribe.pendingPermission, "subscribe should surface the pending permission");
  assert.equal(resubscribe.pendingPermission.permissionId, permEvent.permissionId);
  // The manual rename owns the title: neither prompts nor ACP may replace it.
  assert.equal(resubscribe.chat.title, `Bob's "fake" chat`, "pinned title survives prompts");

  // promptQueueing: a prompt sent while the turn is still active is queued, not
  // rejected; cancelling the turn drops the queued prompts.
  const queuedWhileBusy = await hub.call("send_prompt", {
    chatId: chat.id,
    text: "queued while busy",
    clientPromptId: "smoke-queued-prompt",
  });
  assert.equal(queuedWhileBusy.queued, true);
  assert.equal(queuedWhileBusy.queueLength, 1);
  assert.equal(queuedWhileBusy.chat.queued, 1);
  assert.deepEqual(queuedWhileBusy.chat.queuedRequests.map((item) => item.preview), [
    "queued while busy",
  ]);
  const commandWhileBusy = await hub.call("execute_provider_command", {
    chatId: chat.id,
    command: "/compact",
    clientCommandId: "smoke-queued-compact",
  });
  assert.equal(commandWhileBusy.queued, true);
  assert.equal(commandWhileBusy.queueLength, 2);
  assert.deepEqual(commandWhileBusy.chat.queuedRequests.map((item) => item.kind), [
    "prompt",
    "command",
  ]);

  const cancel = await hub.call("cancel", { chatId: chat.id });
  assert.equal(cancel.cancelledPermissions, 1);
  assert.equal(cancel.droppedQueue, 2);
  assert.deepEqual(cancel.droppedPromptIds, ["smoke-queued-prompt"]);
  assert.deepEqual(cancel.droppedCommandIds, ["smoke-queued-compact"]);

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.event?.type === "permission_decision" &&
        event.event?.permissionId === permEvent.permissionId,
    ),
  );
  const cancelledPermission = events.find(
    (event) =>
      event.type === "chat_event" &&
      event.event?.type === "permission_decision" &&
      event.event?.permissionId === permEvent.permissionId,
  )?.event;
  assert.equal(cancelledPermission.scope, "cancelled");
  assert.equal(cancelledPermission.toolCallId, "fake-plan-tool");

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.event?.type === "turn_done" &&
        event.event?.stopReason === "cancelled",
    ),
  );
  const cancelledDone = [...events].reverse().find(
    (event) => event.type === "chat_event" && event.event?.type === "turn_done",
  )?.event;
  assert.ok(cancelledDone.turnSequence > 0, "turn_done keeps its canonical turn association");
  assert.ok(cancelledDone.startedAt && cancelledDone.completedAt, "turn timestamps are persisted");
  assert.ok(Number.isFinite(cancelledDone.durationMs), "turn duration is measured by the daemon");
  const cancelledUser = [...events].reverse().find(
    (event) =>
      event.type === "chat_event" &&
      event.event?.type === "user" &&
      event.event?.turnSequence === cancelledDone.turnSequence,
  )?.event;
  assert.equal(cancelledUser?.startedAt, cancelledDone.startedAt);
  assert.equal(cancelledUser?.clientPromptId, "smoke-active-prompt");
  const cancelledPlanChat = (await hub.call("subscribe", { chatId: chat.id })).chat;
  assert.equal(cancelledPlanChat.plan.lifecycle, "cancelled");
  assert.equal(
    cancelledPlanChat.plan.entries[0].status,
    "in_progress",
    "turn cancellation decorates the plan without forging an ACP step status",
  );

  // /usage is available only because this fake adapter advertises it; the
  // provider-independent usage_update still feeds the composer footer.
  await hub.call("execute_provider_command", { chatId: chat.id, command: "/usage" });
  await waitFor(() => events.some((event) => event.chat?.usage?.used === 45000));
  const usageChat = (await hub.call("subscribe", { chatId: chat.id })).chat;
  assert.equal(usageChat.usage.used, 45000);
  assert.equal(usageChat.usage.size, 200000);
  assert.equal(usageChat.usage.cost.amount, 0.12);

  // chat_preview: the picker preview pane fetches the transcript tail for any
  // known chat (live here; registry records use the same code path).
  const preview = await hub.call("chat_preview", { chatId: chat.id });
  assert.equal(preview.chatId, chat.id);
  assert.equal(preview.active, true);
  assert.ok(Array.isArray(preview.events) && preview.events.length > 0);
  assert.ok(preview.events.some((event) => event.type === "user"));
  await assert.rejects(hub.call("chat_preview", { chatId: "nope" }), /Unknown chat/);

  // plan: the latest plan is kept as chat state so a panel/footer can show live
  // step progress instead of only appending to the transcript.
  const planMark = events.length;
  await hub.call("send_prompt", { chatId: chat.id, text: "draft a plan" });
  await waitFor(() => events.slice(planMark).some((event) => event.chat?.plan?.entries?.length === 3));
  await waitFor(() =>
    events.slice(planMark).some(
      (event) => event.type === "chat_state" && event.chat?.id === chat.id && event.chat?.status === "idle",
    ),
  );
  const planChat = (await hub.call("subscribe", { chatId: chat.id })).chat;
  assert.equal(planChat.plan.entries.length, 3);
  assert.equal(planChat.plan.entries[0].status, "completed");
  assert.equal(planChat.plan.entries[1].status, "in_progress");
  assert.equal(planChat.plan.entries[2].status, "pending");
  assert.equal(planChat.plan.lifecycle, "incomplete", "unfinished end_turn is not presented as active");
  assert.ok(planChat.plan.revision >= 2, "ACP replacement and turn settlement advance revisions");

  // Dynamic ACP commands use their own semantic request boundary. Informational
  // and state commands must not rename the chat or advance/retire its Plan.
  assert.ok(planChat.availableCommands.some((command) => command.command === "status"));
  assert.ok(planChat.availableCommands.some((command) => command.command === "$fake-skill"));
  const commandTitle = planChat.title;
  const commandPlan = JSON.stringify(planChat.plan);
  const commandMode = planChat.mode;
  const statusMark = events.length;
  const statusCommand = await hub.call("execute_provider_command", {
    chatId: chat.id,
    command: "/status model",
    clientCommandId: "smoke-command-status",
  });
  assert.equal(statusCommand.queued, false);
  await waitFor(() =>
    events.slice(statusMark).some(
      (event) =>
        event.type === "chat_event" &&
        event.event?.type === "turn_done" &&
        event.event?.requestKind === "command",
    ),
  );
  let commandChat = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(commandChat.chat.title, commandTitle);
  assert.equal(JSON.stringify(commandChat.chat.plan), commandPlan);
  const statusBoundary = commandChat.history.find(
    (event) => event.type === "command" && event.clientCommandId === "smoke-command-status",
  );
  assert.equal(statusBoundary.text, "/status model");
  assert.equal(statusBoundary.presentation, "informational");

  const compactMark = events.length;
  await hub.call("execute_provider_command", {
    chatId: chat.id,
    command: "/compact",
    clientCommandId: "smoke-command-compact",
  });
  await waitFor(() =>
    events.slice(compactMark).some(
      (event) => event.type === "chat_state" && event.chat?.statusDetail === "Compacting context",
    ),
  );
  await waitFor(() =>
    events.slice(compactMark).some(
      (event) => event.type === "chat_event" && event.event?.type === "turn_done",
    ),
  );
  commandChat = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(JSON.stringify(commandChat.chat.plan), commandPlan);
  assert.ok(
    commandChat.history.some(
      (event) => event.type === "command_result" && /Command \/compact completed/.test(event.text),
    ),
  );

  const planModeMark = events.length;
  await hub.call("execute_provider_command", {
    chatId: chat.id,
    command: "/plan",
    clientCommandId: "smoke-command-plan",
  });
  await waitFor(() =>
    events.slice(planModeMark).some(
      (event) => event.type === "chat_event" && event.event?.clientCommandId === "smoke-command-plan",
    ),
  );
  await waitFor(() =>
    events.slice(planModeMark).some(
      (event) => event.type === "chat_event" && event.event?.type === "turn_done",
    ),
  );
  commandChat = await hub.call("subscribe", { chatId: chat.id });
  const toggledMode = commandMode === "plan" ? "test" : "plan";
  assert.equal(
    commandChat.chat.mode,
    toggledMode,
    "known setConfigOption metadata uses ACP config safely",
  );
  assert.equal(commandChat.chat.title, commandTitle);
  assert.equal(JSON.stringify(commandChat.chat.plan), commandPlan);
  assert.ok(
    commandChat.history.some(
      (event) => event.type === "command_result" && event.text === `mode set to ${toggledMode}`,
    ),
  );
  const resetModeMark = events.length;
  await hub.call("execute_provider_command", {
    chatId: chat.id,
    command: "/plan",
    clientCommandId: "smoke-command-plan-reset",
  });
  await waitFor(() =>
    events.slice(resetModeMark).some(
      (event) => event.type === "chat_event" && event.event?.type === "turn_done",
    ),
  );
  commandChat = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(commandChat.chat.mode, commandMode, "resetValue toggles a matching state command off");
  assert.equal(JSON.stringify(commandChat.chat.plan), commandPlan);
  await assert.rejects(
    hub.call("execute_provider_command", { chatId: chat.id, command: "/not-advertised" }),
    /Unknown provider command/,
  );

  // tool-call diffs: a file edit surfaces a structured git-style diff (path,
  // +/- counts, hunk rows) so the UI renders it instead of "diff <path>".
  const diffMark = events.length;
  await hub.call("send_prompt", { chatId: chat.id, text: "show me a diff" });
  await waitFor(() =>
    events.slice(diffMark).some((event) => event.type === "chat_event" && event.event?.diffs?.length),
  );
  const diffEvent = events
    .slice(diffMark)
    .find((event) => event.type === "chat_event" && event.event?.diffs?.length);
  const diff = diffEvent.event.diffs[0];
  assert.equal(diff.path, "sample.js", "diff carries the file path");
  assert.ok(diff.added >= 1 && diff.removed >= 1, "diff counts additions and deletions");
  assert.ok(
    diff.hunks[0].rows.some((row) => row.sign === "+" && row.text.includes("const c")),
    "diff hunks include the added line",
  );

  // list_changes aggregates the edited files (latest diff per path) that back
  // the /changes picker.
  const changes = await hub.call("list_changes", { chatId: chat.id });
  const sampleChange = changes.files.find((file) => file.path === "sample.js");
  assert.ok(sampleChange, "list_changes lists the edited file");
  assert.ok(sampleChange.hunks.length > 0, "the change carries diff hunks");
  await assert.rejects(hub.call("list_changes", { chatId: "nope" }), /Unknown chat/);

  // promptQueueing drain: a prompt queued during an active turn is dispatched
  // once that turn finishes.
  const drainMark = events.length;
  await hub.call("send_prompt", { chatId: chat.id, text: "trigger permission" });
  await waitFor(() => events.slice(drainMark).some((event) => event.event === "permission_request"));
  const drainPerm = events.slice(drainMark).reverse().find((event) => event.event === "permission_request");
  const drainQueued = await hub.call("send_prompt", { chatId: chat.id, text: "draft a plan" });
  assert.equal(drainQueued.queued, true);
  const drainCommand = await hub.call("execute_provider_command", {
    chatId: chat.id,
    command: "/status queue",
    clientCommandId: "smoke-queued-command",
  });
  assert.equal(drainCommand.queued, true);
  assert.equal(drainCommand.queueLength, 2);
  const permissionResult = await hub.call("permission_response", {
    permissionId: drainPerm.permissionId,
    optionId: "allow",
  });
  assert.equal(permissionResult.chat.mode, "plan", "a one-time grant never renames the base mode");
  assert.equal(permissionResult.chat.permissionState.activeOnce.scope, "once");
  assert.equal(permissionResult.chat.permissionState.activeOnce.toolCallId, "fake-tool");
  await waitFor(() =>
    events.slice(drainMark).some(
      (event) =>
        event.type === "chat_event" &&
        event.event?.type === "permission_decision" &&
        event.event?.permissionId === drainPerm.permissionId,
    ),
  );
  const permissionAudit = (await hub.call("subscribe", { chatId: chat.id })).history.find(
    (event) =>
      event.type === "permission_decision" && event.permissionId === drainPerm.permissionId,
  );
  assert.equal(permissionAudit.optionId, "allow");
  assert.equal(permissionAudit.scope, "once");
  assert.equal(permissionAudit.source, "user");
  assert.equal(permissionAudit.toolCallId, "fake-tool");
  await waitFor(() =>
    events
      .slice(drainMark)
      .some(
        (event) =>
          event.type === "chat_event" &&
          event.event?.type === "user" &&
          /draft a plan/.test(event.event?.text || ""),
      ),
  );
  await waitFor(() =>
    events
      .slice(drainMark)
      .some(
        (event) =>
          event.type === "chat_event" &&
          event.event?.type === "command" &&
          event.event?.clientCommandId === "smoke-queued-command",
      ),
  );
  const drained = (await hub.call("subscribe", { chatId: chat.id })).chat;
  assert.equal(drained.queued, 0);
  assert.equal(
    drained.permissionState.activeOnce,
    null,
    "allow_once authority is retired no later than the end of its turn",
  );

  // authenticate: an adapter that needs auth reports `auth` status with the
  // advertised methods; authenticating retries session creation to reach idle.
  const authChat = await hub.call("ensure_chat", { provider: "fakeauth", cwd: projectPath });
  assert.equal(authChat.status, "auth");
  assert.ok(authChat.authMethods.some((method) => method.id === "token"));
  assert.equal(authChat.sessionId, null);
  const authResult = await hub.call("authenticate", { chatId: authChat.id, methodId: "token" });
  assert.equal(authResult.chat.status, "idle");
  assert.ok(authResult.chat.sessionId);
  await hub.call("close_chat", { chatId: authResult.chat.id });

  // MCP servers: configured servers are passed to session/new. stdio is always
  // supported; http is gated out because this adapter advertises no
  // mcpCapabilities, so only the stdio server reaches the agent.
  const mcpChat = await hub.call("new_chat", { provider: "fakemcp", cwd: projectPath });
  assert.equal(mcpChat.status, "idle");
  assert.equal(mcpChat.title, "mcp-ok:1");
  assert.equal(mcpChat.mcpServers.length, 1);
  assert.equal(mcpChat.mcpServers[0].name, "echo-mcp");
  const initialMcpInventory = await hub.call("mcp_list", { chatId: mcpChat.id });
  assertMcpSecretsRedacted(initialMcpInventory);
  assert.equal(initialMcpInventory.entries.length, 2);
  assert.equal(
    initialMcpInventory.entries.find((entry) => entry.name === "echo-mcp")?.status,
    "applied",
  );
  assert.equal(
    initialMcpInventory.entries.find((entry) => entry.name === "gated-mcp")?.status,
    "unsupported",
  );
  const managedMcp = await hub.call("mcp_upsert", {
    chatId: mcpChat.id,
    server: {
      name: "managed-echo",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)", "--token", mcpArgumentSecret],
      env: [{ name: "TOKEN", value: "${MCP_SECRET_TEST}" }],
      scope: { provider: "current", project: "current" },
    },
  });
  assert.equal(managedMcp.inventory.pending, true);
  assertMcpSecretsRedacted(managedMcp);
  assert.match(JSON.stringify(managedMcp), /redacted/);
  assert.deepEqual(managedMcp.server.envNames, ["TOKEN"]);
  assert.equal(Object.hasOwn(managedMcp.server, "env"), false);
  const mcpPreflight = await hub.call("mcp_test", {
    chatId: mcpChat.id,
    id: managedMcp.server.id,
  });
  assert.equal(mcpPreflight.ok, true);
  assertMcpSecretsRedacted(mcpPreflight);
  const appliedMcp = await hub.call("mcp_apply", { chatId: mcpChat.id });
  assert.equal(appliedMcp.ok, true);
  assertMcpSecretsRedacted(appliedMcp);
  assert.equal(appliedMcp.chat.mcpApplyPending, false);
  assert.deepEqual(
    appliedMcp.chat.mcpServers.map((entry) => entry.name).sort(),
    ["echo-mcp", "managed-echo"],
  );
  const disabledMcp = await hub.call("mcp_toggle", {
    chatId: mcpChat.id,
    id: managedMcp.server.id,
    enabled: false,
  });
  assert.equal(disabledMcp.inventory.pending, true);
  const reappliedMcp = await hub.call("mcp_apply", { chatId: mcpChat.id });
  assert.equal(reappliedMcp.ok, true);
  assert.deepEqual(reappliedMcp.chat.mcpServers.map((entry) => entry.name), ["echo-mcp"]);
  await hub.call("mcp_remove", { chatId: mcpChat.id, id: managedMcp.server.id });
  await hub.call("close_chat", { chatId: mcpChat.id });

  // Applying MCP never destroys a live session whose adapter cannot resume or
  // load it. The configuration remains pending and the UI can direct the user
  // to create a new chat, where session/new receives the new descriptor.
  const newSessionMcpChat = await hub.call("new_chat", {
    provider: "fakemcpnew",
    cwd: projectPath,
  });
  const newSessionManagedMcp = await hub.call("mcp_upsert", {
    chatId: newSessionMcpChat.id,
    server: {
      name: "new-session-only",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      scope: { provider: "current", project: "current" },
    },
  });
  const requiresNewSession = await hub.call("mcp_apply", {
    chatId: newSessionMcpChat.id,
  });
  assert.equal(requiresNewSession.ok, false);
  assert.equal(requiresNewSession.requiresNewSession, true);
  assert.equal(requiresNewSession.chat.status, "idle");
  assert.ok(requiresNewSession.chat.sessionId);
  const activatedNewSessionMcpChat = await hub.call("new_chat", {
    provider: "fakemcpnew",
    cwd: projectPath,
  });
  assert.deepEqual(
    activatedNewSessionMcpChat.mcpServers.map((entry) => entry.name),
    ["new-session-only"],
  );
  await hub.call("close_chat", { chatId: activatedNewSessionMcpChat.id });
  await hub.call("mcp_remove", {
    chatId: newSessionMcpChat.id,
    id: newSessionManagedMcp.server.id,
  });
  await hub.call("close_chat", { chatId: newSessionMcpChat.id });

  // A rejected MCP payload is transactional: reconnect once with the previous
  // private payload and restore its public inventory instead of leaving a
  // partially reconfigured chat.
  const rollbackMcpChat = await hub.call("new_chat", {
    provider: "fakemcprollback",
    cwd: projectPath,
  });
  const rollbackManagedMcp = await hub.call("mcp_upsert", {
    chatId: rollbackMcpChat.id,
    server: {
      name: "broken-mcp",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      scope: { provider: "current", project: "current" },
    },
  });
  const rolledBackMcp = await hub.call("mcp_apply", {
    chatId: rollbackMcpChat.id,
  });
  assert.equal(rolledBackMcp.ok, false);
  assert.equal(rolledBackMcp.rollbackRestored, true);
  assert.equal(rolledBackMcp.chat.status, "idle");
  assert.deepEqual(rolledBackMcp.chat.mcpServers, []);
  await hub.call("mcp_remove", {
    chatId: rollbackMcpChat.id,
    id: rollbackManagedMcp.server.id,
  });
  await hub.call("close_chat", { chatId: rollbackMcpChat.id });

  const secondChat = await hub.call("new_chat", { provider: "fake", cwd: projectPath });
  assert.notEqual(secondChat.id, chat.id);
  assert.equal(secondChat.status, "idle");
  assert.equal(secondChat.title, "New chat 2");
  assert.equal(secondChat.mode, "plan");
  assert.equal(
    secondChat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );
  assert.equal(
    secondChat.configOptions.find((option) => option.id === "effort")?.currentValue,
    "high",
  );

  await hub.call("subscribe", { chatId: chat.id });
  const renamed = await hub.call("rename_chat", { chatId: chat.id, title: "Primary fake chat" });
  assert.equal(renamed.title, "Primary fake chat");

  const currentAgain = await hub.call("ensure_chat", { provider: "fake", cwd: projectPath });
  assert.equal(currentAgain.id, chat.id);
  assert.equal(currentAgain.title, "Primary fake chat");

  await new Promise((resolve) => setTimeout(resolve, 150));
  const selectedProjectChat = runHubCli(["project-chat", "--cwd", projectPath]);
  assert.equal(selectedProjectChat.stdout.trim(), `fake|${chat.id}`);
  const missingProjectChat = runHubCli(["project-chat", "--cwd", extraPath]);
  assert.equal(missingProjectChat.stdout.trim(), "");

  // Without tmux the prefix+m toggle menu must degrade to direct creation
  // (TMUX stripped so the test never draws a menu in the developer's session).
  const headlessToggle = runHubCli(["tmux-toggle-menu", "--cwd", extraPath], { TMUX: "" });
  assert.equal(headlessToggle.stdout.trim(), "create");

  const renamedSearch = await hub.call("list_chats", {
    provider: "fake",
    query: "Primary fake",
    limit: 1,
  });
  assert.equal(renamedSearch.chats[0].id, chat.id);

  await hub.call("send_prompt", { chatId: chat.id, text: "table" });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("nvim"),
    ),
  );
  const tableHistory = await hub.call("subscribe", { chatId: chat.id });
  const tableChunks = tableHistory.history.filter(
    (event) => event.type === "agent_chunk" && event.text?.includes("| Area |"),
  );
  assert.equal(tableChunks.length, 1);
  assert.ok(tableChunks[0].text.includes("| Area |"));
  assert.ok(tableChunks[0].text.includes("| nvim/ |"));

  const renderedTable = renderMarkdown(
    [
      "| File | What it does | Notes |",
      "|---|---|---|",
      "| .gitignore | Ignores DS_Store, copilot, iterm2, tmux plugins except acp-hub, opencode runtime, avante state, lazygit and lazy-lock | Solid. acp-hub exception correct. |",
      "| blink-cmp.lua | blink.cmp config with rust fuzzy, LSP path buffer snippets sources, Tab accept, C-n/p nav, ghost text off, winblend from pumblend | Clean. Ghost text off intentional? |",
    ].join("\n"),
  );
  assert.match(renderedTable, /• File/);
  assert.match(renderedTable, /━+/);
  assert.doesNotMatch(renderedTable, /^\| blink-cmp\.lua \|/m);

  const attachmentPath = path.join(projectPath, "note.md");
  await fs.writeFile(attachmentPath, "# Attached note\n\nhello from attachment\n", "utf8");
  await hub.call("send_prompt", {
    chatId: chat.id,
    text: "attachment test",
    attachments: [attachmentPath],
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("resource:"),
    ),
  );
  const attachmentHistory = await hub.call("subscribe", { chatId: chat.id });
  const attachmentUser = attachmentHistory.history.find(
    (event) => event.type === "user" && event.text.includes("[FILE1] note.md"),
  );
  assert.ok(attachmentUser);

  const imagePath = path.join(projectPath, "screen.png");
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await hub.call("send_prompt", {
    chatId: chat.id,
    text: "attachment image",
    attachments: [imagePath],
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("image:image/png"),
    ),
  );
  const imageHistory = await hub.call("subscribe", { chatId: chat.id });
  const imageUser = imageHistory.history.find(
    (event) => event.type === "user" && event.text.includes("[IMAGE1] screen.png"),
  );
  assert.ok(imageUser);

  await hub.call("send_prompt", {
    chatId: chat.id,
    text: "attachment mention @note.md",
  });
  await waitFor(() =>
    events.filter(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("resource:"),
    ).length >= 2,
  );

  const listed = await hub.call("refresh_sessions", { provider: "fake", cwd: projectPath });
  assert.equal(listed.providers[0].supported, true);
  assert.ok(listed.providers[0].sessions.some((session) => session.sessionId === "listed-session"));
  const listedSession = listed.providers[0].sessions.find(
    (session) => session.sessionId === "listed-session",
  );
  assert.deepEqual(listedSession.additionalDirectories, [extraPath]);

  const listedRestored = await hub.call("subscribe", { chatId: listedSession.id });
  assert.equal(listedRestored.chat.status, "idle");
  assert.equal(listedRestored.chat.mode, "restored");

  // A provider-side restore error is a recoverable state, not permission to
  // create/adopt another chat. Re-subscribing keeps the identity stable;
  // retry is explicit, and Start fresh preserves the local transcript before
  // assigning the newly-created ACP session its canonical id.
  const restoreChat = await hub.call("new_chat", {
    provider: "fakerestore",
    cwd: projectPath,
  });
  await hub.call("send_prompt", {
    chatId: restoreChat.id,
    text: "history survives explicit recovery",
  });
  await hub.call("close_chat", { chatId: restoreChat.id });
  const failedRestore = await hub.call("subscribe", { chatId: restoreChat.id });
  assert.equal(failedRestore.chat.id, restoreChat.id);
  assert.equal(failedRestore.chat.status, "error");
  assert.equal(failedRestore.chat.restoreFailure?.kind, "restore");
  assert.match(failedRestore.chat.restoreFailure?.message || "", /Internal error/);

  const stableFailure = await hub.call("subscribe", { chatId: restoreChat.id });
  assert.equal(stableFailure.chat.id, restoreChat.id, "subscribe never invents a replacement chat");
  assert.equal(stableFailure.chat.restoreFailure?.attemptedAt, failedRestore.chat.restoreFailure.attemptedAt);

  const retriedRestore = await hub.call("retry_restore", { chatId: restoreChat.id });
  assert.equal(retriedRestore.chat.id, restoreChat.id);
  assert.equal(retriedRestore.chat.restoreFailure?.kind, "restore");

  const freshRecovery = await hub.call("recover_chat_fresh", { chatId: restoreChat.id });
  assert.equal(freshRecovery.chat.status, "idle");
  assert.equal(freshRecovery.chat.restoreFailure, null);
  assert.notEqual(freshRecovery.chat.id, restoreChat.id);
  assert.ok(
    freshRecovery.history.some(
      (event) => event.type === "user" && /history survives explicit recovery/.test(event.text || ""),
    ),
    "Start fresh preserves the local transcript",
  );
  const postRecoveryChats = await hub.call("list_chats");
  assert.equal(
    postRecoveryChats.chats.filter((candidate) => candidate.id === freshRecovery.chat.id).length,
    1,
    "recovery publishes one canonical chat identity",
  );
  assert.ok(!postRecoveryChats.chats.some((candidate) => candidate.id === restoreChat.id));

  await hub.call("close_chat", { chatId: chat.id });
  const restored = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(restored.chat.status, "idle");
  assert.equal(restored.chat.mode, "plan");
  assert.equal(
    restored.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );
  assert.equal(
    restored.chat.configOptions.find((option) => option.id === "effort")?.currentValue,
    "high",
  );
  assert.deepEqual(restored.chat.additionalDirectories, [extraPath]);
  assert.equal(restored.chat.plan.entries.length, 3, "plan survives close/reactivate");
  assert.equal(restored.chat.plan.lifecycle, "previous", "a later turn retires the old plan");
  assert.equal(
    restored.chat.plan.previousLifecycle,
    "incomplete",
    "reactivation preserves whether the retired plan may still continue",
  );
  assert.equal(restored.chat.planSupported, true, "observed ACP plan support survives reactivation");
  const restoredUserPrompts = restored.history.filter((event) => event.type === "user");
  assert.ok(restoredUserPrompts.length >= 6, "reactivation restores the conversation, not only its last answer");
  assert.ok(
    restoredUserPrompts.some((event) => event.clientPromptId === "smoke-active-prompt"),
    "the original prompt and its stable submission identity survive reactivation",
  );
  for (const event of restored.history) {
    if (
      !event.turnSequence ||
      event.type === "history_boundary" ||
      event.type === "user" ||
      event.type === "command"
    ) continue;
    assert.ok(
      restored.history.some(
        (candidate) =>
          ["user", "command"].includes(candidate.type) &&
          candidate.turnSequence === event.turnSequence,
      ),
      `turn ${event.turnSequence} retains its request boundary`,
    );
  }

  const chats = await hub.call("list_chats");
  assert.ok(chats.chats.length >= 3);
  assert.ok(chats.chats.some((candidate) => candidate.id === chat.id));
  assert.ok(chats.chats.some((candidate) => candidate.id === secondChat.id));
  assert.ok(chats.chats.some((candidate) => candidate.sessionId === "listed-session"));

  const scoped = await hub.call("list_chats", {
    provider: "fake",
    cwd: projectPath,
    limit: 10,
  });
  assert.ok(scoped.chats.some((candidate) => candidate.id === chat.id));
  assert.ok(scoped.chats.some((candidate) => candidate.id === secondChat.id));

  const filtered = await hub.call("list_chats", {
    provider: "fake",
    query: "fake-large",
    limit: 1,
  });
  assert.equal(filtered.chats.length, 1);
  assert.equal(filtered.chats[0].id, chat.id);

  const listedFiltered = await hub.call("list_chats", {
    provider: "fake",
    query: "listed",
    limit: 1,
  });
  assert.equal(listedFiltered.chats.length, 1);
  assert.equal(listedFiltered.chats[0].sessionId, "listed-session");

  // Title pipeline: the first meaningful prompt is a stable fallback, ACP may
  // replace/evolve it, and a manual rename wins permanently (including after
  // a daemon restart). The tab label is a separately bounded presentation.
  const titled = await hub.call("new_chat", { provider: "fake", cwd: projectPath });
  await hub.call("subscribe", { chatId: titled.id });
  const longLine = `[Image 1] necesito ayuda con usage ${"x".repeat(80)}\nsegunda linea ignorada`;
  let titleMark = events.length;
  await hub.call("send_prompt", { chatId: titled.id, text: longLine });
  await waitFor(() =>
    events.slice(titleMark).some(
      (event) => event.type === "chat_state" && event.chat?.id === titled.id && event.chat?.status === "idle",
    ),
  );
  let titledState = await hub.call("subscribe", { chatId: titled.id });
  assert.ok(
    titledState.chat.title.startsWith("necesito ayuda con"),
    `provisional title from prompt (got: ${titledState.chat.title})`,
  );
  assert.ok(!titledState.chat.title.includes("segunda"), "only the first line is used");
  assert.ok(!titledState.chat.title.includes("[Image"), "attachment markers are omitted");
  assert.equal(titledState.chat.titleSource, "prompt");
  assert.ok(titledState.chat.tabTitle.length <= 32, "tab title has its own compact width");
  const firstFallback = titledState.chat.title;

  titleMark = events.length;
  await hub.call("send_prompt", { chatId: titled.id, text: "report usage for a different topic" });
  await waitFor(() =>
    events.slice(titleMark).some(
      (event) => event.type === "chat_state" && event.chat?.id === titled.id && event.chat?.status === "idle",
    ),
  );
  titledState = await hub.call("subscribe", { chatId: titled.id });
  assert.equal(titledState.chat.title, firstFallback, "later prompts keep the fallback stable");

  titleMark = events.length;
  await hub.call("send_prompt", { chatId: titled.id, text: "agent title: Mejorar títulos de tmux" });
  await waitFor(() =>
    events.slice(titleMark).some(
      (event) => event.chat?.id === titled.id && event.chat?.title === "Mejorar títulos de tmux",
    ),
  );
  titledState = await hub.call("subscribe", { chatId: titled.id });
  assert.equal(titledState.chat.titleSource, "agent");

  await hub.call("rename_chat", { chatId: titled.id, title: "Título manual persistente" });
  titleMark = events.length;
  await hub.call("send_prompt", { chatId: titled.id, text: "agent title: No debe reemplazarlo" });
  await waitFor(() =>
    events.slice(titleMark).some(
      (event) => event.type === "chat_state" && event.chat?.id === titled.id && event.chat?.status === "idle",
    ),
  );
  titledState = await hub.call("subscribe", { chatId: titled.id });
  assert.equal(titledState.chat.title, "Título manual persistente");
  assert.equal(titledState.chat.titleSource, "manual");

  // session/delete (capability-gated), live-peer path: a fresh active chat is
  // deleted through its running adapter and removed from the registry.
  const throwaway = await hub.call("new_chat", { provider: "fake", cwd: projectPath });
  const delActive = await hub.call("delete_chat", { chatId: throwaway.id });
  assert.equal(delActive.providerSupported, true);
  assert.equal(delActive.providerDeleted, true);
  const afterActiveDelete = await hub.call("list_chats");
  assert.ok(!afterActiveDelete.chats.some((candidate) => candidate.id === throwaway.id));

  await hub.call("shutdown");
  hub.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  daemon = startDaemon();
  const restartedHub = await connectWithRetry(socketPath);
  const persisted = await restartedHub.call("list_chats");
  assert.ok(persisted.chats.some((candidate) => candidate.id === chat.id));
  assert.ok(persisted.chats.some((candidate) => candidate.id === secondChat.id));
  assert.ok(persisted.chats.some((candidate) => candidate.sessionId === "listed-session"));
  const persistedTitle = persisted.chats.find((candidate) => candidate.id === titled.id);
  assert.equal(persistedTitle.title, "Título manual persistente");
  assert.equal(persistedTitle.titleSource, "manual", "manual provenance survives daemon restart");
  const persistedPlan = persisted.chats.find((candidate) => candidate.id === chat.id)?.plan;
  assert.equal(persistedPlan?.entries?.length, 3, "canonical plan survives daemon restart");
  assert.equal(persistedPlan?.lifecycle, "previous");
  assert.equal(
    persistedPlan?.previousLifecycle,
    "incomplete",
    "daemon restart preserves the retired plan's terminal provenance",
  );
  assert.equal(
    persisted.chats.find((candidate) => candidate.id === chat.id)?.planSupported,
    true,
    "agent plan capability survives daemon restart",
  );

  // session/delete, saved-path: after a restart the chat is a stored record with
  // no live adapter, so the daemon uses a temporary one to delete it.
  const delSaved = await restartedHub.call("delete_chat", { chatId: chat.id });
  assert.equal(delSaved.providerSupported, true);
  assert.equal(delSaved.providerDeleted, true);
  const afterSavedDelete = await restartedHub.call("list_chats");
  assert.ok(!afterSavedDelete.chats.some((candidate) => candidate.id === chat.id));

  await restartedHub.call("shutdown");
  assertMcpSecretsRedacted(events);
  assertMcpSecretsRedacted(daemonLogs);
  restartedHub.close();

  console.log("tmux-acp-hub smoke test passed");
} catch (error) {
  daemon.kill("SIGTERM");
  console.error(daemonLogs.join(""));
  throw error;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 100));
  daemon.kill("SIGTERM");
  await fs.rm(tmp, { recursive: true, force: true });
}

function startDaemon() {
  const child = spawn(process.execPath, [HUB_BIN, "daemon"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => daemonLogs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => daemonLogs.push(chunk.toString()));
  return child;
}

function runHubCli(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [HUB_BIN, ...args], {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `command failed: ${[HUB_BIN, ...args].join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function renderMarkdown(input) {
  const result = spawnSync(process.execPath, [HUB_BIN, "_render-markdown"], {
    env,
    input,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `render markdown failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

function assertMcpSecretsRedacted(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, new RegExp(mcpArgumentSecret));
  assert.doesNotMatch(serialized, new RegExp(mcpUrlSecret));
  assert.doesNotMatch(serialized, /never-expose-this/);
}

async function connectWithRetry(socketPath) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 5000) {
    try {
      return await connect(socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError || new Error("Could not connect to hub");
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(new JsonSocketClient(socket)));
    socket.once("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for condition");
}
