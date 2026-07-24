#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chatAccessLabel,
  chatModeConfigOption,
  chatModeEntries,
  chatModeValue,
  resolveAccessTarget,
  resolveModeEntries,
  syncChatModeFromConfig,
} from "../lib/core.mjs";
import { HubDaemon } from "../lib/daemon.mjs";
import { PopupUi } from "../bin/acp-hub.mjs";

const modeOption = (currentValue = "read-only") => ({
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue,
  options: [
    { value: "read-only", name: "Read-only", description: "Ask before changes" },
    { value: "agent", name: "Agent", description: "Workspace write" },
    { value: "agent-full-access", name: "Agent full access", description: "No sandbox" },
  ],
});

// Modern configOptions are authoritative even when legacy modes disagree.
{
  const chat = {
    mode: "legacy-plan",
    modes: {
      currentModeId: "legacy-plan",
      availableModes: [{ id: "legacy-plan" }, { id: "legacy-code" }],
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gpt-test",
        options: [{ value: "gpt-test", name: "GPT Test" }],
      },
      modeOption(),
    ],
  };
  assert.equal(chatModeConfigOption(chat)?.id, "mode");
  assert.equal(chatModeValue(chat), "read-only");
  assert.equal(chatAccessLabel(chat), "read-only");
  assert.deepEqual(chatModeEntries(chat).map((entry) => entry.id), [
    "read-only",
    "agent",
    "agent-full-access",
  ]);
  assert.deepEqual(resolveAccessTarget(chat, "read-only"), {
    kind: "config",
    configId: "mode",
    value: "read-only",
  });
  assert.equal(resolveAccessTarget(chat, "plan"), null, "read-only is never aliased to plan");
  assert.deepEqual(resolveAccessTarget(chat, "full"), {
    kind: "config",
    configId: "mode",
    value: "agent-full-access",
  }, "a unique literal substring may complete the provider's real id");
}

// Claude-style don'tAsk is not mislabeled as full access.
{
  const chat = {
    configOptions: [{
      id: "mode",
      category: "mode",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
        { value: "dontAsk", name: "Don't Ask", description: "Deny if not pre-approved" },
      ],
    }],
  };
  assert.equal(resolveAccessTarget(chat, "full"), null);
  assert.equal(resolveAccessTarget(chat, "dontAsk")?.value, "dontAsk");
}

// Legacy-only agents still work, but partial matches must be unique.
{
  const chat = { modes: { availableModes: [{ id: "ask" }, { id: "architect" }, { id: "code" }] } };
  assert.deepEqual(resolveAccessTarget(chat, "code"), { kind: "mode", value: "code" });
  assert.equal(resolveModeEntries(chatModeEntries(chat), "a"), null, "ambiguous shorthand is rejected");
}

// A model option must never be mistaken for mode just because "model" contains "mode".
{
  const chat = {
    mode: "legacy-safe",
    configOptions: [{ id: "model", currentValue: "mode-looking-model" }],
  };
  syncChatModeFromConfig(chat);
  assert.equal(chat.mode, "legacy-safe");
  assert.equal(chatModeConfigOption(chat), null);
}

// setMode prefers session/set_config_option and does not touch the legacy API.
{
  const daemon = new HubDaemon({ defaultAgent: "fake", agents: {} });
  const calls = [];
  const chat = {
    id: "mode-chat",
    provider: "fake",
    providerLabel: "Fake ACP",
    cwd: "/tmp",
    projectName: "tmp",
    title: "Mode test",
    status: "idle",
    statusDetail: "Ready",
    sessionId: "session-1",
    peer: {
      call: async (method, params) => {
        calls.push({ method, params });
        return { configOptions: [modeOption(params.value)] };
      },
    },
    modes: { currentModeId: "legacy-plan", availableModes: [{ id: "legacy-plan" }] },
    configOptions: [modeOption()],
    configValues: {},
    permissionState: null,
    history: [],
    promptQueue: [],
  };
  daemon.chats.set(chat.id, chat);
  daemon.rememberChat = () => {};
  daemon.broadcast = () => {};
  daemon.addEvent = () => {};
  daemon.persistState = () => {};
  daemon.scheduleTmuxSync = () => {};

  const result = await daemon.setMode(chat.id, "agent");
  assert.equal(result.modeId, "agent");
  assert.deepEqual(calls.map((call) => call.method), ["session/set_config_option"]);
  assert.equal(chatModeValue(chat), "agent");
}

function permissionChat(id = "permission-chat") {
  return {
    id,
    provider: "fake",
    providerLabel: "Fake ACP",
    cwd: "/tmp",
    projectName: "tmp",
    title: "Permission test",
    status: "permission",
    statusDetail: "Waiting",
    sessionId: "session-permission",
    turnActive: true,
    turnSequence: 3,
    configOptions: [],
    configValues: {},
    modes: null,
    history: [],
    promptQueue: [],
    permissionState: null,
  };
}

function quietDaemon() {
  const daemon = new HubDaemon({ defaultAgent: "fake", agents: {} });
  daemon.persistState = () => {};
  daemon.scheduleTmuxSync = () => {};
  daemon.broadcast = () => {};
  daemon.rememberChat = () => {};
  return daemon;
}

// Decisions are validated, linked to their tool call and retained as audit events.
{
  const daemon = quietDaemon();
  const chat = permissionChat();
  const events = [];
  let adapterResponse = null;
  daemon.addEvent = (_chat, event) => events.push(event);
  daemon.chats.set(chat.id, chat);
  const pending = {
    permissionId: "perm-1",
    chatId: chat.id,
    options: [
      { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    toolCall: { toolCallId: "edit-1", kind: "edit", title: "Editing files" },
    requestedAt: "2026-07-19T00:00:00.000Z",
    resolve: (value) => { adapterResponse = value; },
    timer: setTimeout(() => {}, 60_000),
  };
  daemon.pendingPermissions.set(pending.permissionId, pending);

  assert.throws(
    () => daemon.permissionResponse({ permissionId: pending.permissionId, optionId: "not-offered" }),
    /Unknown permission option/,
  );
  assert.equal(daemon.pendingPermissions.has(pending.permissionId), true, "invalid authority stays pending");

  const result = daemon.permissionResponse({ permissionId: pending.permissionId, optionId: "allow_once" });
  assert.equal(result.ok, true);
  assert.deepEqual(adapterResponse, { outcome: { outcome: "selected", optionId: "allow_once" } });
  assert.equal(chat.permissionState.activeOnce.toolCallId, "edit-1");
  assert.equal(chat.permissionState.activeOnce.scope, "once");
  assert.deepEqual(events.at(-1), {
    type: "permission_decision",
    ...chat.permissionState.lastDecision,
  });
}

// Fail-closed policy selects an offered reject option and never opens a pending picker.
{
  const daemon = quietDaemon();
  const chat = permissionChat("deny-chat");
  const events = [];
  daemon.permissionSettings = { policy: "deny" };
  daemon.addEvent = (_chat, event) => events.push(event);
  daemon.setStatus = (target, status, detail) => {
    target.status = status;
    target.statusDetail = detail;
  };
  daemon.chats.set(chat.id, chat);

  const response = await daemon.handlePermissionRequest(chat, {
    toolCall: { toolCallId: "edit-denied", kind: "edit", title: "Denied edit" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "reject" } });
  assert.equal(daemon.pendingPermissions.size, 0);
  const decision = events.find((event) => event.type === "permission_decision");
  assert.equal(decision.source, "policy");
  assert.equal(decision.scope, "reject_once");
}

// Malformed requests fail closed immediately instead of waiting for timeout.
{
  const daemon = quietDaemon();
  const chat = permissionChat("empty-options-chat");
  const events = [];
  daemon.addEvent = (_chat, event) => events.push(event);
  daemon.setStatus = (target, status, detail) => {
    target.status = status;
    target.statusDetail = detail;
  };
  daemon.chats.set(chat.id, chat);

  const response = await daemon.handlePermissionRequest(chat, {
    toolCall: { toolCallId: "malformed-edit", kind: "edit", title: "Malformed edit" },
    options: [],
  });
  assert.deepEqual(response, { outcome: { outcome: "cancelled" } });
  assert.equal(daemon.pendingPermissions.size, 0);
  const decision = events.find((event) => event.type === "permission_decision");
  assert.equal(decision.source, "system");
  assert.equal(decision.reason, "Adapter supplied no permission options");
}

// Picker and footer expose canonical mode separately from runtime grants.
{
  const ui = Object.create(PopupUi.prototype);
  ui.currentChat = {
    provider: "codex",
    providerLabel: "Codex ACP",
    mode: "legacy-plan",
    modes: { availableModes: [{ id: "legacy-plan" }] },
    configOptions: [modeOption("read-only")],
    permissionPolicy: "prompt",
    permissionState: {
      activeOnce: { toolKind: "edit", optionName: "Allow Once" },
      sessionGrants: [],
    },
  };
  const spec = ui.modesPickerSpec();
  assert.deepEqual(spec.items.map((item) => item.value), ["read-only", "agent", "agent-full-access"]);
  assert.equal(spec.items[0].current, true);
  assert.match(ui.accessPickerSpec().title, /read-only.*allow once: edit/);
  assert.match(String(ui.composerPermissionLabel(ui.currentChat)), /allow once: edit/);
}

// A decision made by another popup reconciles the local upper-panel request
// before repainting, so no stale chooser survives and the composer is painted
// only after its underlying Plan/queue can be restored.
{
  const ui = Object.create(PopupUi.prototype);
  let resolved = "open";
  let paints = 0;
  let scheduled = null;
  Object.assign(ui, {
    closed: false,
    currentChat: { id: "shared-chat", queuedRequests: [] },
    pendingPermission: { permissionId: "shared-perm", options: [] },
    autoShownPermissionId: "shared-perm",
    inlinePicker: {
      purpose: "permission",
      requestId: "shared-perm",
      resolve: (value) => { resolved = value; },
    },
    rawInput: { pinned: true, line: "draft", cursor: 5, done: false },
    pendingPromptSubmissions: new Map(),
    queuedRequestItems: () => [],
    refreshRawInputPrompt: () => {},
    appendHistoryEvent: () => {},
    reconcilePromptSubmission: () => {},
    scheduleTranscriptProjection: (options) => {
      scheduled = options;
      if (options?.immediate && options?.renderComposer) paints += 1;
    },
    renderRawInput: () => { paints += 1; },
  });

  ui.handleHubEvent({
    type: "chat_event",
    chatId: "shared-chat",
    chat: { id: "shared-chat", queuedRequests: [] },
    event: { type: "permission_decision", permissionId: "shared-perm", scope: "once" },
  });

  assert.equal(resolved, null);
  assert.equal(ui.pendingPermission, null);
  assert.equal(ui.inlinePicker, null);
  assert.equal(ui.autoShownPermissionId, null);
  assert.equal(ui.rawInput.line, "draft");
  assert.equal(ui.rawInput.cursor, 5);
  assert.equal(paints, 1, "decision and shelf restoration share the composer repaint");

  paints = 0;
  scheduled = null;
  ui.handleHubEvent({
    type: "chat_event",
    chatId: "shared-chat",
    chat: { id: "shared-chat", status: "permission", queuedRequests: [] },
    event: { type: "permission", permissionId: "next-perm", options: [] },
  });
  assert.equal(scheduled?.immediate, false, "raw request waits for its dedicated shelf event");
  assert.equal(scheduled?.renderComposer, true);
  assert.equal(paints, 0, "no header-only frame flashes before the permission choices");
}

console.log("permissions tests: ok");
