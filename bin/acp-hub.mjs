#!/usr/bin/env node
// tmux-acp-hub CLI: subcommands, tmux menus/panels, and the entry point.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import * as readlineTerminal from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
// (no imports needed from ../lib/render.mjs)
import {
  providerIconFor,
  formatChatPreview,
  formatRelativeAge,
  highlightCode,
  c,
  parseArgs,
  mkdirp,
  readJsonIfExists,
  loadConfig,
  configCredentialEnvNames,
  redactCommandArgs,
  npxAdapterPin,
  compareSemver,
  parseNpmViewInfo,
  resolveProjectRoot,
  projectName,
  pickerFilterEntries,
  pickerNextIndex,
  cleanInline,
  stripAnsi,
  hasPendingMarkdownTable,
  renderMarkdownTable,
  truncateText,
  displayPath,
  normalizeAdditionalDirectories,
  configOptionId,
  resolveConfigOption,
  chatConfigLabel,
  configOptionMenuValues,
  configOptionValueMatches,
  modeEntries,
  resolveAccessTarget,
  valueLabel,
  compactTmuxText,
  formatConfigOption,
  formatProviderCommand,
  formatContextUsage,
  mcpServerLabel,
  buildMcpPanelItems,
  buildAuthPanelItems,
  buildPlanPanelItems,
  buildRootsPanelItems,
  orderProjectChats,
  displayTmuxMenu,
  tmuxDisplayMessage,
  tmuxPaneFormat,
  syncTmuxChatMetadata,
  isAcpPane,
  tmuxSubmitToPane,
  submitCommandToTmuxPane,
  tmuxInsertToPane,
  tmuxConfirmCommand,
  tmuxPanelCommand,
  actionPayload,
  parseActionPayload,
  tmuxActionCommand,
  tmuxConfirmActionCommand,
  tmuxRunWorkspace,
  DEFAULT_CONFIG,
  HUB_DIR,
  HUB_VERSION,
  USER_CONFIG_PATH,
  SOCKET_PATH,
  PID_PATH,
  RESTART_LOCK_PATH,
  LOG_PATH,
  STATE_PATH,
  REGISTRY_PATH,
  DRAFTS_PATH,
  INPUT_HISTORY_PATH,
  PASTES_DIR,
} from "../lib/core.mjs";
import {
  canConnectToSocket,
  connectHub,
} from "../lib/rpc.mjs";
import { HubDaemon } from "../lib/daemon.mjs";
import {
  PopupUi,
} from "../lib/ui.mjs";
import {
  AdapterVersionManager,
  formatVersionState,
} from "../lib/versions.mjs";
import {
  MCP_REGISTRY_PATH,
  inspectMcpRegistry,
  staticMcpDefinitions,
  validateMcpDefinition,
} from "../lib/mcp.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RESTART_LOCK_STALE_MS = 60_000;

function readRestartLock() {
  try {
    return JSON.parse(fs.readFileSync(RESTART_LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function restartLockIsStale(lock, now = Date.now()) {
  const startedAt = Number(lock?.startedAt) || 0;
  return !startedAt || now - startedAt > RESTART_LOCK_STALE_MS;
}

function removeRestartLock(token = "") {
  try {
    const lock = readRestartLock();
    if (token && lock?.token !== token) return false;
    fs.unlinkSync(RESTART_LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

async function waitForRestartCompletion(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(RESTART_LOCK_PATH)) {
    const lock = readRestartLock();
    if (restartLockIsStale(lock)) {
      removeRestartLock(lock?.token || "");
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error("ACP hub restart is still in progress; retry prefix+m in a moment");
    }
    await sleep(100);
  }
}

function claimRestartLock() {
  fs.mkdirSync(HUB_DIR, { recursive: true, mode: 0o700 });
  const inheritedToken = String(process.env.ACP_HUB_RESTART_TOKEN || "");
  const existing = readRestartLock();
  if (inheritedToken && existing?.token === inheritedToken) {
    fs.writeFileSync(
      RESTART_LOCK_PATH,
      JSON.stringify({ ...existing, token: inheritedToken, pid: process.pid, state: "running" }),
      { mode: 0o600 },
    );
    return inheritedToken;
  }
  if (existing && !restartLockIsStale(existing)) {
    throw new Error("ACP hub restart is already in progress");
  }
  if (existing) removeRestartLock(existing.token || "");

  const token = crypto.randomUUID();
  fs.writeFileSync(
    RESTART_LOCK_PATH,
    JSON.stringify({ token, pid: process.pid, state: "running", startedAt: Date.now() }),
    { flag: "wx", mode: 0o600 },
  );
  return token;
}

// Keep the daemon log bounded: past 1MB the old log rolls to daemon.log.1
// (one generation is enough to debug "what happened before the restart").
function rotateDaemonLog() {
  try {
    const { size } = fs.statSync(LOG_PATH);
    if (size > 1024 * 1024) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    // No log yet.
  }
}

async function ensureDaemon() {
  await mkdirp(HUB_DIR);
  await waitForRestartCompletion();

  try {
    return await connectHub(300);
  } catch {
    // Start below.
  }

  rotateDaemonLog();
  // The log can quote adapter stderr (paths, error context): private like the
  // rest of the state dir. `mode` only applies at creation; daemon start()
  // heals pre-existing 0644 logs.
  const logFd = fs.openSync(LOG_PATH, "a", 0o600);
  const child = spawn(process.execPath, [SCRIPT_PATH, "daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 5000) {
    try {
      return await connectHub(300);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error(
    `Could not start ACP hub daemon: ${lastError?.message || "unknown error"}. Log: ${LOG_PATH}`,
  );
}

async function runDaemon() {
  const config = await loadConfig();
  const daemon = new HubDaemon(config);
  await daemon.start();

  process.on("SIGINT", () => daemon.shutdown());
  process.on("SIGTERM", () => daemon.shutdown());

  await new Promise(() => {});
}

async function runUi(args) {
  const config = await loadConfig();
  if (args["default-agent"]) {
    config.defaultAgent = args["default-agent"];
  }
  const hub = await ensureDaemon();
  const cwd = path.resolve(args.cwd || process.cwd());
  const ui = new PopupUi(hub, config, cwd, args.mode || "menu", {
    agent: typeof args.agent === "string" ? args.agent : null,
    chatId: typeof args["chat-id"] === "string" ? args["chat-id"] : null,
    newChat: args.new === true,
  });
  await ui.run();
}

async function runTmuxMenu(args) {
  const config = await loadConfig();
  if (args["default-agent"]) {
    config.defaultAgent = args["default-agent"];
  }

  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;
  const hub = await ensureDaemon();
  const agents = (await hub.call("list_agents")).agents;
  const allChats = (await hub.call("list_chats", { cwd })).chats;
  const chats = allChats.slice(0, 20);
  hub.close();
  const acpPane = isAcpPane(context);
  const currentChatId = acpPane ? tmuxPaneFormat(context.pane, "#{@acp_hub_chat_id}") : "";
  const items = [];

  const add = (label, key, command) => {
    items.push({ label, key, command });
  };
  const sep = () => {
    items.push({ separator: true });
  };

  if (acpPane) {
    add("Command center", "?", tmuxPanelCommand(cwd, context, "control", currentChatId));
    add("Chats", "s", tmuxSubmitToPane(context.pane, "/chats"));
    add("Config", "g", tmuxPanelCommand(cwd, context, "config", currentChatId));
    add("Model", "l", tmuxPanelCommand(cwd, context, "model", currentChatId));
    add("Effort / reasoning", "f", tmuxPanelCommand(cwd, context, "effort", currentChatId));
    add("Access / permissions", "a", tmuxPanelCommand(cwd, context, "access", currentChatId));
    add("Workspace roots", "w", tmuxPanelCommand(cwd, context, "roots", currentChatId));
    add("Provider commands", "c", tmuxPanelCommand(cwd, context, "commands", currentChatId));
    add("Modes", "o", tmuxPanelCommand(cwd, context, "modes", currentChatId));
    add("Plan", "P", tmuxPanelCommand(cwd, context, "plan", currentChatId));
    add("New chat", "n", tmuxPanelCommand(cwd, context, "new", currentChatId));
    add("Activity display", "v", tmuxPanelCommand(cwd, context, "activity", currentChatId));
    sep();
  }

  add("Open default chat", "m", tmuxRunWorkspace(cwd, context, config.defaultAgent || "codex"));
  add("Full popup menu", "M", tmuxRunWorkspace(cwd, context, "", "", "menu"));
  sep();

  for (const [index, agent] of agents.entries()) {
    const key = index < 9 ? String(index + 1) : "";
    add(`Open ${agent.label || agent.id}`, key, tmuxRunWorkspace(cwd, context, agent.id));
  }

  sep();
  for (const agent of agents) {
    add(`New ${agent.label || agent.id}`, "", tmuxRunWorkspace(cwd, context, agent.id, "", "new"));
  }

  if (chats.length) {
    sep();
    for (const chat of orderProjectChats(chats)) {
      const status = chat.active ? ` · ${chat.status}` : "";
      const title = truncateText(chat.title || chat.id, 42);
      const age = formatRelativeAge(chat.updatedAt);
      add(
        `${providerIconFor(chat.provider, chat)} ${title}${status}${age ? ` · ${age}` : ""}`,
        "",
        tmuxRunWorkspace(cwd, context, chat.provider, chat.id),
      );
    }
  }

  const result = displayTmuxMenu(`ACP Hub: ${projectName(cwd)}`, items, context);
  if (!result.ok) {
    console.error(result.error || "tmux display-menu failed");
    process.exitCode = 1;
  }
}

// prefix+m lands here when the project has no live window and no saved chat.
// With no chats anywhere the answer is plain "create" (workspace.sh proceeds
// with the default provider, no prompt). Otherwise a native menu offers a new
// chat here or jumping to one of the chats open in other projects.
async function runTmuxToggleMenu(args) {
  const config = await loadConfig();
  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;

  const hub = await ensureDaemon();
  const agents = (await hub.call("list_agents")).agents;
  const chats = (await hub.call("list_chats", {})).chats;
  hub.close();

  // Truly empty hub, or headless (no tmux to draw a menu on): create directly.
  if (!chats.length || !process.env.TMUX) {
    process.stdout.write("create");
    return;
  }

  const items = [];
  const defaultAgent = config.defaultAgent || agents[0]?.id || "codex";

  const localChats = chats
    .filter((chat) => chat.cwd === cwd)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  for (const chat of localChats.slice(0, 4)) {
    const status = chat.active ? ` · ${chat.status || "idle"}` : "";
    const age = formatRelativeAge(chat.updatedAt);
    items.push({
      label: `${providerIconFor(chat.provider, chat)} ${truncateText(cleanInline(chat.title || chat.id), 32)}${status}${age ? ` · ${age}` : ""}`,
      key: "",
      command: tmuxRunWorkspace(cwd, context, chat.provider, chat.id, "open"),
    });
  }
  if (localChats.length) items.push({ separator: true });

  const orderedAgents = [...agents].sort(
    (a, b) => Number(b.id === defaultAgent) - Number(a.id === defaultAgent),
  );
  orderedAgents.forEach((agent, index) => {
    const suffix = agent.id === defaultAgent ? " · default" : "";
    items.push({
      label: `${agent.icon || providerIconFor(agent.id)} New ${agent.label || agent.id} chat here${suffix}`,
      key: index < 9 ? String(index + 1) : "",
      command: tmuxRunWorkspace(cwd, context, agent.id, "", "open"),
    });
  });

  const remoteChats = chats
    .filter((chat) => chat.cwd !== cwd)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 12);
  if (remoteChats.length) {
    items.push({ separator: true });
    for (const chat of remoteChats) {
      const status = chat.active ? ` · ${chat.status || "idle"}` : "";
      const age = formatRelativeAge(chat.updatedAt);
      items.push({
        label: `${providerIconFor(chat.provider, chat)} ${truncateText(cleanInline(chat.title || chat.id), 28)} · ${chat.projectName}${status}${age ? ` · ${age}` : ""}`,
        key: "",
        command: tmuxRunWorkspace(chat.cwd, context, chat.provider, chat.id, "open"),
      });
    }
  }

  const result = displayTmuxMenu(`ACP Hub: ${projectName(cwd)}`, items, context);
  if (!result.ok) {
    // Menu failed (odd tmux state): degrade to direct creation.
    process.stdout.write("create");
    return;
  }
  process.stdout.write("menu");
}

// prefix+x / prefix+& inside an ACP workspace: killing a window only closes
// the client view — the chat keeps running in the daemon. This menu makes
// those semantics explicit instead of letting tmux's kill prompts imply the
// chat is being destroyed.
async function runTmuxCloseMenu(args) {
  const context = {
    session: "",
    client: "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || "";

  const chatId = tmuxPaneFormat(context.pane, "#{@acp_hub_chat_id}");
  const title = tmuxPaneFormat(context.pane, "#{@acp_hub_title}") || "ACP window";
  const cwd = tmuxPaneFormat(context.pane, "#{@acp_hub_project_path}") || process.cwd();

  const items = [
    { label: "Close window · chat keeps running", key: "w", command: "kill-window" },
  ];

  if (chatId) {
    items.push({
      label: "Stop chat · adapter off, stays saved",
      key: "s",
      command: tmuxActionCommand(cwd, context, "close", chatId, ""),
    });
    items.push({ separator: true });
    items.push({
      label: "Delete chat · permanent",
      key: "D",
      command: tmuxConfirmActionCommand(cwd, context, "delete", chatId, "Delete this chat permanently? (y/n)"),
    });
  }

  items.push({ separator: true });
  items.push({ label: "Kill pane · tmux default", key: "x", command: "kill-pane" });

  const result = displayTmuxMenu(`Close · ${truncateText(cleanInline(title), 32)}`, items, context);
  if (!result.ok) {
    tmuxDisplayMessage(context, `acp-hub: close menu failed: ${result.error || "unknown error"}`);
    process.exitCode = 1;
  }
}

async function runTmuxPanel(args) {
  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;
  const panel = String(args.panel || args._?.[0] || "control");
  const hub = await ensureDaemon();
  const agents = (await hub.call("list_agents")).agents;
  const chats = (await hub.call("list_chats", { cwd })).chats;
  hub.close();

  const chat = selectPanelChat(chats, context, args);
  const view = buildTmuxPanelView(panel, chat, context, cwd, { agents });
  const result = displayTmuxMenu(view.title, view.items, context);
  if (!result.ok) {
    tmuxDisplayMessage(context, `acp-hub: tmux panel failed: ${result.error || "unknown error"}`);
    process.exitCode = 1;
  }
}

async function runTmuxAction(args) {
  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;

  const action = String(args.action || "");
  const chatId = args["chat-id"] || tmuxPaneFormat(context.pane, "#{@acp_hub_chat_id}");
  const value = typeof args.value === "string" ? args.value.trim() : "";
  const hub = await ensureDaemon();

  try {
    if (!chatId) throw new Error("No ACP chat is associated with this pane");

    switch (action) {
      case "config": {
        const payload = parseActionPayload(value);
        const configId = payload.configId || payload.id || "";
        if (!configId) throw new Error("Config id is empty");
        const result = await hub.call("set_config_option", {
          chatId,
          configId,
          value: payload.value,
        });
        syncTmuxChatMetadata(context, result.chat);
        tmuxDisplayMessage(
          context,
          `acp-hub: ${result.configId || configId}=${valueLabel(result.value) || String(payload.value ?? "")}`,
        );
        break;
      }

      case "mode": {
        if (!value) throw new Error("Mode is empty");
        const result = await hub.call("set_mode", { chatId, modeId: value });
        syncTmuxChatMetadata(context, result.chat);
        tmuxDisplayMessage(context, `acp-hub: mode=${result.modeId || value}`);
        break;
      }

      case "access": {
        if (!value) throw new Error("Access profile is empty");
        const chats = (await hub.call("list_chats", { cwd })).chats;
        const chat = selectPanelChat(chats, context, { "chat-id": chatId });
        const target = resolveAccessTarget(chat, value);
        if (!target) throw new Error(`No access mode matching ${value}`);

        let result;
        if (target.kind === "mode") {
          result = await hub.call("set_mode", { chatId, modeId: target.value });
          tmuxDisplayMessage(context, `acp-hub: mode=${result.modeId || target.value}`);
        } else {
          result = await hub.call("set_config_option", {
            chatId,
            configId: target.configId,
            value: target.value,
          });
          tmuxDisplayMessage(
            context,
            `acp-hub: ${result.configId || target.configId}=${valueLabel(result.value) || target.value}`,
          );
        }
        syncTmuxChatMetadata(context, result.chat);
        break;
      }

      case "roots-add":
      case "roots-remove":
      case "roots-clear": {
        const chats = (await hub.call("list_chats", { cwd })).chats;
        const chat = selectPanelChat(chats, context, { "chat-id": chatId });
        if (!chat) throw new Error("No ACP chat found");

        const current = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || cwd);
        let next = current;
        if (action === "roots-clear") {
          next = [];
        } else if (action === "roots-add") {
          if (!value) throw new Error("Directory is empty");
          next = normalizeAdditionalDirectories([...current, value], chat.cwd || cwd);
        } else {
          if (!value) throw new Error("Directory is empty");
          const number = Number(value);
          if (Number.isInteger(number) && number >= 1 && number <= current.length) {
            next = current.filter((_, index) => index !== number - 1);
          } else {
            const resolved = normalizeAdditionalDirectories([value], chat.cwd || cwd)[0];
            next = current.filter((root) => root !== resolved);
          }
        }

        const result = await hub.call("set_roots", { chatId, additionalDirectories: next });
        syncTmuxChatMetadata(context, result.chat);
        const suffix = result.requiresRestart ? " restart adapter to apply" : " saved";
        tmuxDisplayMessage(context, `acp-hub: roots${suffix}`);
        break;
      }

      case "auth": {
        if (!value) throw new Error("Auth method is empty");
        const result = await hub.call("authenticate", { chatId, methodId: value });
        syncTmuxChatMetadata(context, result.chat);
        tmuxDisplayMessage(context, "acp-hub: authenticated");
        break;
      }

      case "cancel":
        await hub.call("cancel", { chatId });
        tmuxDisplayMessage(context, "acp-hub: cancel requested");
        break;

      case "close":
        if (context.pane && submitCommandToTmuxPane(context.pane, "/close")) {
          tmuxDisplayMessage(context, "acp-hub: closing adapter");
          break;
        }
        await hub.call("close_chat", { chatId });
        tmuxDisplayMessage(context, "acp-hub: adapter closed");
        break;

      case "delete": {
        // The tmux menu already confirmed, so delete directly and send the popup
        // back to its menu instead of re-prompting through /delete.
        const result = await hub.call("delete_chat", { chatId });
        if (context.pane) submitCommandToTmuxPane(context.pane, "/menu");
        tmuxDisplayMessage(
          context,
          result.providerDeleted ? "acp-hub: chat deleted" : "acp-hub: chat removed locally",
        );
        break;
      }

      default:
        throw new Error(`Unknown tmux action: ${action}`);
    }
  } catch (error) {
    tmuxDisplayMessage(context, `acp-hub: ${error.message || String(error)}`);
    process.exitCode = 1;
  } finally {
    hub.close();
  }
}

function selectPanelChat(chats, context, args) {
  const chatId = args["chat-id"] || tmuxPaneFormat(context.pane, "#{@acp_hub_chat_id}");
  const provider = tmuxPaneFormat(context.pane, "#{@acp_hub_provider}");

  return (
    chats.find((chat) => chat.id === chatId) ||
    chats.find((chat) => chat.provider === provider && chat.active) ||
    chats.find((chat) => chat.provider === provider) ||
    chats.find((chat) => chat.active) ||
    chats[0] ||
    null
  );
}

function buildTmuxPanelView(panel, chat, context, cwd, extras = {}) {
  switch (panel) {
    case "model":
      return buildConfigOptionPanelView(chat, context, cwd, "model", "ACP Model");
    case "effort":
    case "reasoning":
      return buildConfigOptionPanelView(chat, context, cwd, "effort", "ACP Effort");
    case "config":
      return { title: "ACP Config", items: buildConfigPanelItems(chat, context, cwd) };
    case "access":
    case "permissions":
      return { title: "ACP Access", items: buildAccessPanelItems(chat, context, cwd) };
    case "commands":
      return { title: "Provider Commands", items: buildProviderCommandsPanelItems(chat, context) };
    case "modes":
      return { title: "ACP Modes", items: buildModesPanelItems(chat, context, cwd) };
    case "new":
      return { title: "New ACP Chat", items: buildNewChatPanelItems(extras.agents || [], context, cwd) };
    case "roots":
      return { title: "Workspace Roots", items: buildRootsPanelItems(chat, context, cwd) };
    case "plan":
      return { title: "ACP Plan", items: buildPlanPanelItems(chat, context) };
    case "auth":
      return { title: "ACP Authentication", items: buildAuthPanelItems(chat, context, cwd) };
    case "mcp":
      return { title: "MCP Servers", items: buildMcpPanelItems(chat, context) };
    case "activity":
      return { title: "Tool Activity", items: buildActivityPanelItems(context) };
    case "control":
    default:
      return { title: "ACP Command Center", items: buildCommandCenterPanelItems(chat, context, cwd) };
  }
}

function buildCommandCenterPanelItems(chat, context, cwd) {
  if (!chat) {
    return [{ label: "No active ACP chat found for this pane", disabled: true }];
  }

  const provider = chat.providerLabel || chat.provider || "Agent";
  const project = chat.projectName || projectName(cwd);
  const contextLabel = formatContextUsage(chat.usage);
  const subtitle = [chat.status, chat.mode, chatConfigLabel(chat), contextLabel]
    .filter(Boolean)
    .join("  ");

  return [
    { label: `${provider} - ${project}`, disabled: true },
    { label: subtitle || "ready", disabled: true },
    { separator: true },
    { label: "Chats", key: "s", command: tmuxSubmitToPane(context.pane, "/chats") },
    { label: "Refresh provider sessions", key: "r", command: tmuxSubmitToPane(context.pane, "/refresh") },
    { separator: true },
    { label: "Provider commands", key: "c", command: tmuxPanelCommand(cwd, context, "commands", chat.id) },
    { label: "Config", key: "g", command: tmuxPanelCommand(cwd, context, "config", chat.id) },
    { label: "Model", key: "l", command: tmuxPanelCommand(cwd, context, "model", chat.id) },
    { label: "Effort / reasoning", key: "f", command: tmuxPanelCommand(cwd, context, "effort", chat.id) },
    { label: "Modes", key: "o", command: tmuxPanelCommand(cwd, context, "modes", chat.id) },
    { label: "Plan", key: "P", command: tmuxPanelCommand(cwd, context, "plan", chat.id) },
    ...(chat.authMethods?.length
      ? [{ label: "Authenticate", key: "A", command: tmuxPanelCommand(cwd, context, "auth", chat.id) }]
      : []),
    {
      label: "MCP servers",
      key: "i",
      command: tmuxSubmitToPane(context.pane, "/mcp"),
    },
    { label: "Access / permissions", key: "a", command: tmuxPanelCommand(cwd, context, "access", chat.id) },
    { label: "Workspace roots", key: "w", command: tmuxPanelCommand(cwd, context, "roots", chat.id) },
    { label: "New chat", key: "n", command: tmuxPanelCommand(cwd, context, "new", chat.id) },
    { separator: true },
    { label: "Compose multiline prompt", key: "p", command: tmuxSubmitToPane(context.pane, "/compose") },
    { label: "Open editor prompt", key: "e", command: tmuxSubmitToPane(context.pane, "/edit") },
    { label: "File changes (diffs)", key: "D", command: tmuxSubmitToPane(context.pane, "/changes") },
    { label: "Attach file to next prompt", key: "t", command: tmuxSubmitToPane(context.pane, "/attach") },
    { label: "Rename chat", key: "R", command: tmuxSubmitToPane(context.pane, "/rename") },
    { label: "Activity display", key: "v", command: tmuxPanelCommand(cwd, context, "activity", chat.id) },
    { separator: true },
    { label: "Cancel current turn", key: "x", command: tmuxConfirmActionCommand(cwd, context, "cancel", chat.id, "Cancel current ACP turn?") },
    { label: "Close adapter", key: "k", command: tmuxConfirmCommand(context, "Close this ACP adapter?", tmuxSubmitToPane(context.pane, "/close")) },
    { label: "Delete chat", key: "d", command: tmuxConfirmActionCommand(cwd, context, "delete", chat.id, "Delete this chat permanently?") },
    { label: "Close popup", key: "q", command: tmuxSubmitToPane(context.pane, "/exit") },
  ];
}

function buildConfigPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const items = [
    { label: `provider  ${chat.providerLabel || chat.provider || "-"}`, disabled: true },
    { label: `mode      ${chat.mode || "-"}`, disabled: true },
    { separator: true },
  ];

  const options = (chat.configOptions || []).slice(0, 12);
  if (!options.length) {
    items.push({ label: "No config options reported by this adapter yet", disabled: true });
    return items;
  }

  for (const option of options) {
    const id = configOptionId(option);
    items.push({ label: stripAnsi(formatConfigOption(option)), disabled: true });

    const values = configOptionMenuValues(option);
    for (const entry of values.slice(0, 10)) {
      const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
      const label = entry.label && entry.label !== entry.value ? ` ${entry.label}` : "";
      items.push({
        label: `  ${marker} ${truncateText(`${entry.value}${label}`, 62)}`,
        command: tmuxActionCommand(cwd, context, "config", chat.id, actionPayload({ configId: id, value: entry.value })),
      });
    }
  }

  return items;
}

function buildConfigOptionPanelView(chat, context, cwd, configId, title) {
  if (!chat) {
    return {
      title,
      items: [{ label: "No active ACP chat found for this pane", disabled: true }],
    };
  }

  const option = resolveConfigOption(chat.configOptions || [], configId);
  if (!option) {
    return {
      title,
      items: [{ label: `No ${configId} option reported by this adapter yet`, disabled: true }],
    };
  }

  const id = configOptionId(option);
  const items = [
    { label: stripAnsi(formatConfigOption(option)), disabled: true },
    { separator: true },
  ];

  const values = configOptionMenuValues(option);
  if (!values.length) {
    items.push({ label: `No selectable values. Type /config ${id} <value>.`, disabled: true });
    return { title, items };
  }

  for (const entry of values.slice(0, 40)) {
    const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
    const detail = [entry.label !== entry.value ? entry.label : "", entry.description]
      .filter(Boolean)
      .join(" - ");
    items.push({
      label: `${marker} ${truncateText(`${entry.value}${detail ? ` ${detail}` : ""}`, 70)}`,
      command: tmuxActionCommand(cwd, context, "config", chat.id, actionPayload({ configId: id, value: entry.value })),
    });
  }

  return { title, items };
}

function buildAccessPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const profiles = [
    ["read-only", "Read-only / plan"],
    ["agent", "Agent / default"],
    ["full", "Full access / don't ask"],
    ["plan", "Plan"],
    ["auto", "Auto"],
  ];
  const items = [
    { label: `current  ${chat.mode || "-"}`, disabled: true },
    { separator: true },
  ];

  let enabled = 0;
  for (const [profile, label] of profiles) {
    const target = resolveAccessTarget(chat, profile);
    if (!target) {
      items.push({ label: `- ${label}`, disabled: true });
      continue;
    }

    enabled += 1;
    const targetLabel =
      target.kind === "mode" ? `mode=${target.value}` : `${target.configId}=${target.value}`;
    items.push({
      label: `${label}  ${targetLabel}`,
      command: tmuxActionCommand(cwd, context, "access", chat.id, profile),
    });
  }

  if (enabled === 0) {
    items.push({ separator: true });
    items.push({ label: "No matching access modes reported by this adapter", disabled: true });
  }

  const modes = modeEntries(chat.modes);
  if (modes.length) {
    items.push({ separator: true });
    items.push({ label: "Reported modes", disabled: true });
    for (const mode of modes.slice(0, 20)) {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      const marker = id === chat.mode ? "*" : " ";
      items.push({
        label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
        command: tmuxActionCommand(cwd, context, "mode", chat.id, id),
      });
    }
  }

  return items;
}

function buildProviderCommandsPanelItems(chat, context) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const commands = chat.availableCommands || [];
  if (!commands.length) {
    return [
      { label: "No provider commands reported by ACP yet", disabled: true },
      { label: "Use /agent /command to send raw slash text", disabled: true },
    ];
  }

  const items = [
    { label: "Select a command to insert it at the prompt", disabled: true },
    { separator: true },
  ];

  const visibleCommands = commands.slice(0, 24);
  for (const command of visibleCommands) {
    const name = command.name || command.command || command.id || command.title || "command";
    const text = `//${String(name).replace(/^\/+/, "")}`;
    items.push({
      label: stripAnsi(formatProviderCommand(command)),
      command: tmuxInsertToPane(context.pane, text),
    });
  }

  if (commands.length > visibleCommands.length) {
    items.push({ separator: true });
    items.push({
      label: `Showing ${visibleCommands.length} of ${commands.length} · use /commands for the full searchable catalog`,
      disabled: true,
    });
  }

  return items;
}

function buildModesPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const modes = chat.modes || null;
  const items = [{ label: `current  ${chat.mode || "-"}`, disabled: true }];

  if (!modes) {
    items.push({ separator: true });
    items.push({ label: "No modes reported by this adapter yet", disabled: true });
    return items;
  }

  const entries = modes.availableModes || modes.modes || modes.options || [];
  items.push({ separator: true });

  if (!Array.isArray(entries) || !entries.length) {
    items.push({ label: JSON.stringify(modes), disabled: true });
    return items;
  }

  for (const mode of entries.slice(0, 30)) {
    const id = mode.id || mode.modeId || mode.name || String(mode);
    const label = mode.label || mode.title || mode.name || id;
    const marker = id === chat.mode ? "*" : " ";
    items.push({
      label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
      command: tmuxActionCommand(cwd, context, "mode", chat.id, id),
    });
  }

  return items;
}

function buildNewChatPanelItems(agents, context, cwd) {
  if (!agents.length) return [{ label: "No ACP agents configured", disabled: true }];

  const items = [
    { label: `project  ${displayPath(cwd)}`, disabled: true },
    { separator: true },
  ];

  for (const [index, agent] of agents.entries()) {
    const key = index < 9 ? String(index + 1) : "";
    items.push({
      label: `New ${agent.label || agent.id}`,
      key,
      command: tmuxRunWorkspace(cwd, context, agent.id, "", "new"),
    });
  }

  return items;
}

function buildActivityPanelItems(context) {
  return [
    { label: "Controls tool/event rendering in this chat pane", disabled: true },
    { separator: true },
    { label: "Compact activity", key: "1", command: tmuxSubmitToPane(context.pane, "/activity compact") },
    { label: "Hide activity", key: "2", command: tmuxSubmitToPane(context.pane, "/activity hidden") },
    { label: "Debug activity", key: "3", command: tmuxSubmitToPane(context.pane, "/activity debug") },
  ];
}

function runHelp() {
  console.log(`tmux-acp-hub ${HUB_VERSION}

Usage:
  acp-hub <command> [options]

Commands:
  ui             open the popup UI (normally launched by tmux)
  health         check Node, tmux, state, config, and adapter pins
  status         show daemon and saved-chat status
  versions       show adapter, bundled runtime, and global CLI versions
  updates        check configured adapters for available updates
  update <agent> download, verify, and stage an adapter (or "all")
  rollback <id>  stage the previous verified adapter
  restart        restart the daemon and close disposable workspace views
  stop           stop the daemon without deleting saved chats
  reset [--yes]  delete every saved chat and local composer state
  help           show this help
  version        print the plugin version

Common options:
  --cwd <path>       project directory for UI/tmux commands
  --agent <id>       provider id for a chat
  --chat-id <id>     reopen a specific chat
  --new              create a fresh provider session

Inside tmux, install the plugin and use prefix+m. Run "acp-hub health"
when reporting a startup or adapter problem.`);
}

function printAdapterVersions(result) {
  console.log(`ACP protocol: v1 · channel: ${result.settings?.channel || "stable"}`);
  for (const state of result.providers || []) {
    console.log(formatVersionState(state));
    const selectedVersion = state.pendingVersion || state.activeVersion;
    const selected = (state.installed || []).find((entry) => entry.version === selectedVersion);
    for (const [name, version] of Object.entries(selected?.dependencies || {})) {
      console.log(`  runtime ${name}@${version}`);
    }
    if (state.globalCli) {
      console.log(
        `  global ${state.globalCli.command}@${state.globalCli.version || "unknown"} · ${state.globalCli.path}`,
      );
    }
    if (state.deprecated) console.log(`  DEPRECATED: ${state.deprecated}`);
    if (state.registryError) {
      console.log(`  registry unavailable${state.registryStale ? "; cached result shown" : ""}`);
    }
  }
}

async function versionBackend(config, method, params = {}, options = {}) {
  let hub = null;
  try {
    hub = await connectHub(250);
  } catch {
    // A stopped daemon is a supported maintenance state. Operate directly on
    // the same locked store; the next daemon start promotes pending versions.
  }
  if (hub) {
    if (options.onProgress) {
      hub.onEvent((message) => {
        if (message.type === "adapter_update_progress") options.onProgress(message.update || {});
      });
    }
    try {
      return await hub.call(method, params);
    } catch (error) {
      if (!/Unknown hub method: adapter_/i.test(String(error.message || error))) throw error;
      // A daemon from the previous plugin build cannot service version RPCs.
      // Falling through is safe: it has no version manager of its own, and the
      // shared store lock still protects direct maintenance.
    } finally {
      hub.close();
    }
  }
  const manager = new AdapterVersionManager({ config });
  if (method === "adapter_versions") return manager.versions(params);
  if (method === "adapter_update") {
    const updateOptions = {
      force: params.force === true,
      onProgress: options.onProgress,
    };
    return params.provider === "all"
      ? manager.updateAll(updateOptions)
      : manager.update(params.provider, updateOptions);
  }
  if (method === "adapter_rollback") return manager.rollback(params.provider);
  throw new Error(`unsupported version backend method: ${method}`);
}

async function runAdapterVersions(args, check = false) {
  const config = await loadConfig();
  const result = await versionBackend(config, "adapter_versions", {
    check,
    force: check,
    globals: true,
  });
  if (args.json === true) console.log(JSON.stringify(result, null, 2));
  else printAdapterVersions(result);
}

async function confirmCliMutation(args, prompt) {
  if (args.yes === true) return true;
  if (!process.stdin.isTTY) {
    console.error(`${prompt}; run interactively or pass --yes`);
    process.exitCode = 2;
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${prompt} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function printUpdateProgress(update) {
  const labels = {
    download: "downloading",
    verify: "verifying cached install",
    handshake: "testing ACP handshake",
    ready: "ready",
  };
  console.log(`${update.provider || "adapter"}@${update.version || "?"}: ${labels[update.phase] || update.phase}`);
}

async function runAdapterUpdate(args) {
  const config = await loadConfig();
  const provider = String(args._[0] || "").toLowerCase();
  if (!provider) {
    console.error("usage: acp-hub update <agent|all> [--yes] [--restart]");
    process.exitCode = 2;
    return;
  }
  if (provider !== "all" && !config.agents?.[provider]) {
    console.error(`unknown agent: ${provider}`);
    process.exitCode = 2;
    return;
  }
  if (!(await confirmCliMutation(args, `Download, verify, and stage ${provider}?`))) {
    console.log("aborted — nothing changed");
    return;
  }
  const result = await versionBackend(
    config,
    "adapter_update",
    { provider, force: true },
    { onProgress: args.json === true ? null : printUpdateProgress },
  );
  if (args.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.results || [result]) {
      const version = item.pendingVersion || item.activeVersion;
      console.log(item.alreadyCurrent
        ? `✓ ${item.provider}@${version} is already active`
        : item.alreadyPending
          ? `✓ ${item.provider}@${version} is already staged`
          : `✓ ${item.provider}@${version} verified and staged`);
    }
    for (const failure of result.errors || []) {
      console.error(`✗ ${failure.provider}: ${failure.error}`);
    }
    if (!result.requiresRestart && (result.results || [result]).every((item) => !item.requiresRestart)) {
      console.log("no restart required");
    } else if (result.busyChats?.length) {
      console.log(`restart deferred: ${result.busyChats.length} chat(s) are active`);
    } else {
      console.log("run acp-hub restart to activate the staged version");
    }
  }
  if (result.errors?.length) process.exitCode = 1;
  if (args.restart === true && result.requiresRestart !== false && !result.busyChats?.length) await runRestart();
}

async function runAdapterRollback(args) {
  const config = await loadConfig();
  const provider = String(args._[0] || "").toLowerCase();
  if (!provider || !config.agents?.[provider]) {
    console.error("usage: acp-hub rollback <agent> [--yes] [--restart]");
    process.exitCode = 2;
    return;
  }
  if (!(await confirmCliMutation(args, `Stage the previous verified ${provider} adapter?`))) {
    console.log("aborted — nothing changed");
    return;
  }
  const result = await versionBackend(config, "adapter_rollback", { provider });
  if (args.json === true) console.log(JSON.stringify(result, null, 2));
  else console.log(`✓ ${provider}@${result.pendingVersion} staged for rollback; restart to activate`);
  if (args.restart === true && !result.busyChats?.length) await runRestart();
}

function runVersion() {
  console.log(HUB_VERSION);
}

async function runStatus() {
  const state = await readJsonIfExists(STATE_PATH);
  if (!state) {
    console.log("ACP hub has no state yet");
    return;
  }

  const socket = state.socket || SOCKET_PATH;
  const active = await canConnectToSocket(socket);
  const daemonLabel = active ? state.pid || "unknown" : `stopped (last pid ${state.pid || "unknown"})`;
  console.log(`daemon: ${daemonLabel} ${socket}`);
  const chats = state.chats || [];
  for (const chat of chats.slice(0, 50)) {
    console.log(
      `${chat.id} ${chat.provider}/${chat.projectName} ${chat.status} ${chat.statusDetail || ""}`,
    );
  }
  if (chats.length > 50) {
    console.log(`... ${chats.length - 50} more chat(s)`);
  }
}

// Environment checkup for issue reports and first-run debugging.
async function runHealth() {
  const ok = (label, value) => console.log(`✓ ${label}: ${value}`);
  const bad = (label, value) => console.log(`✗ ${label}: ${value}`);
  const warn = (label, value) => console.log(`⚠ ${label}: ${value}`);

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeNote =
    nodeMajor < 18
      ? " (need >= 18)"
      : nodeMajor < 22
        ? " (plugin ok; bundled adapters need >= 22)"
        : "";
  (nodeMajor >= 18 ? ok : bad)("node", `${process.version}${nodeNote}`);

  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (tmux.status === 0) {
    const version = tmux.stdout.trim();
    const number = Number.parseFloat(version.replace(/^tmux\s+/i, ""));
    (Number.isFinite(number) && number >= 3.4 ? ok : bad)(
      "tmux",
      `${version}${Number.isFinite(number) && number < 3.4 ? " (need >= 3.4)" : ""}`,
    );
  } else {
    bad("tmux", "not found in PATH");
  }

  try {
    await mkdirp(HUB_DIR);
    fs.accessSync(HUB_DIR, fs.constants.W_OK);
    ok("state dir", HUB_DIR);
  } catch (error) {
    bad("state dir", `${HUB_DIR} not writable (${error.message})`);
  }

  const registry = await readJsonIfExists(REGISTRY_PATH);
  const chatCount = Array.isArray(registry?.chats) ? registry.chats.length : 0;
  ok("registry", `${chatCount} saved chat(s)`);

  const daemonUp = await canConnectToSocket(SOCKET_PATH);
  console.log(`${daemonUp ? "✓" : "·"} daemon: ${daemonUp ? "running" : "stopped (starts on demand)"} ${SOCKET_PATH}`);

  const config = await loadConfig();
  const managedMcp = inspectMcpRegistry(MCP_REGISTRY_PATH);
  if (!managedMcp.ok) {
    bad("MCP registry", `${managedMcp.file} is invalid (${managedMcp.error})`);
  } else if (managedMcp.exists) {
    const modeLabel = managedMcp.mode?.toString(8).padStart(3, "0") || "unknown";
    if (managedMcp.mode !== null && managedMcp.mode & 0o077) {
      warn(
        "MCP registry permissions",
        `${managedMcp.file} is ${modeLabel}; run chmod 600`,
      );
    } else {
      ok(
        "MCP registry",
        `${managedMcp.count} managed server(s) · ${managedMcp.file} · ${modeLabel}`,
      );
    }
  } else {
    ok("MCP registry", `not created · use /mcp to manage servers`);
  }
  const staticMcp = staticMcpDefinitions(config);
  const invalidStaticMcp = staticMcp
    .map((server) => ({
      name: server.name || "(unnamed)",
      validation: validateMcpDefinition(server, { source: "static", touch: false }),
    }))
    .filter((entry) => !entry.validation.ok);
  if (invalidStaticMcp.length) {
    bad(
      "static MCP config",
      invalidStaticMcp
        .map((entry) => `${entry.name}: ${entry.validation.errors.join("; ")}`)
        .join(" · "),
    );
  } else {
    ok("static MCP config", `${staticMcp.length} valid server(s)`);
  }
  const versionManager = new AdapterVersionManager({ config });
  const versionSnapshot = await versionManager.versions({ check: false });
  const versionStates = new Map(
    versionSnapshot.providers.map((state) => [state.provider, state]),
  );
  const userConfig = await readJsonIfExists(USER_CONFIG_PATH);
  const credentialNames = configCredentialEnvNames(userConfig);
  if (credentialNames.length) {
    try {
      const mode = fs.statSync(USER_CONFIG_PATH).mode & 0o777;
      const modeLabel = mode.toString(8).padStart(3, "0");
      if (mode & 0o077) {
        warn(
          "config permissions",
          `${USER_CONFIG_PATH} contains credential-like env values and is ${modeLabel}; run chmod 600`,
        );
      } else {
        ok("config permissions", `${USER_CONFIG_PATH} is ${modeLabel}`);
      }
    } catch (error) {
      warn("config permissions", `could not inspect ${USER_CONFIG_PATH}: ${error.message}`);
    }
  }
  for (const [name, agent] of Object.entries(config.agents || {})) {
    const command = agent?.command;
    if (!command) {
      bad(`agent ${name}`, "no command configured");
      continue;
    }
    const which = spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" });
    (which.status === 0 ? ok : bad)(
      `agent ${name}`,
      which.status === 0
        ? `${command} ${redactCommandArgs(agent.args).join(" ")}`.trim()
        : `${command} not found in PATH`,
    );
  }

  for (const state of versionSnapshot.providers) {
    if (!state.managed) continue;
    if (state.pendingVersion) {
      warn(
        `agent ${state.provider} activation`,
        `${state.pendingVersion} verified and pending; run acp-hub restart`,
      );
      continue;
    }
    if (state.activeVersion) {
      const resolved = versionManager.resolveAgent(
        state.provider,
        config.agents[state.provider],
        versionSnapshot.manifest,
      );
      if (resolved.managedAdapter) {
        const runtimes = Object.entries(resolved.managedAdapter.dependencies || {})
          .map(([pkg, version]) => `${pkg}@${version}`)
          .join(", ");
        ok(
          `agent ${state.provider} managed`,
          `${resolved.managedAdapter.package}@${state.activeVersion}${runtimes ? ` (${runtimes})` : ""}`,
        );
      } else {
        warn(
          `agent ${state.provider} managed`,
          `${state.activeVersion} is recorded but incomplete; falling back to configured command`,
        );
      }
    } else {
      ok(
        `agent ${state.provider} managed`,
        `not prepared; using exact npx pin ${state.configuredVersion}`,
      );
    }
  }

  for (const [provider, override] of Object.entries(userConfig?.agents || {})) {
    if (!Object.hasOwn(override || {}, "args") && !Object.hasOwn(override || {}, "command")) continue;
    const inheritedPin = npxAdapterPin(DEFAULT_CONFIG.agents?.[provider]);
    const effectivePin = npxAdapterPin(config.agents?.[provider]);
    if (
      inheritedPin &&
      (!effectivePin ||
        effectivePin.pkg !== inheritedPin.pkg ||
        effectivePin.version !== inheritedPin.version)
    ) {
      warn(
        `agent ${provider} override`,
        `${USER_CONFIG_PATH} owns this command/pin; plugin defaults will not replace it`,
      );
    }
  }

  // Adapter pin currency: compare npx-style pins against the npm registry.
  // Being offline is not a health failure — registry errors skip silently.
  for (const [name, agent] of Object.entries(config.agents || {})) {
    const pin = npxAdapterPin(agent);
    if (!pin) continue;
    const view = spawnSync("npm", ["view", pin.pkg, "version", "deprecated", "--json"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (view.status !== 0 || !view.stdout) continue;
    const info = parseNpmViewInfo(view.stdout);
    if (!info) continue;
    const state = versionStates.get(name);
    const effectiveVersion = state?.pendingVersion || state?.activeVersion || pin.version;
    if (info.deprecated) {
      warn(`agent ${name} pin`, `${pin.pkg} is DEPRECATED: ${info.deprecated}`);
    } else if (info.latest && compareSemver(effectiveVersion, info.latest) < 0) {
      warn(`agent ${name} pin`, `${pin.pkg} active ${effectiveVersion}, latest ${info.latest}`);
    } else if (info.latest) {
      ok(`agent ${name} pin`, `${pin.pkg}@${effectiveVersion} is latest`);
    }
  }
}

async function runProjectChat(args) {
  const cwd = resolveProjectRoot(args.cwd || process.cwd());
  const registry = await readJsonIfExists(REGISTRY_PATH);
  const chats = Array.isArray(registry?.chats) ? registry.chats : [];
  const currentIds = new Set(
    (Array.isArray(registry?.current) ? registry.current : [])
      .filter((entry) => entry?.chatId && entry?.cwd && path.resolve(entry.cwd) === cwd)
      .map((entry) => entry.chatId),
  );

  const candidates = chats
    .filter(
      (chat) =>
        chat?.id &&
        chat?.provider &&
        chat?.sessionId &&
        chat?.cwd &&
        path.resolve(chat.cwd) === cwd,
    )
    .sort((a, b) => {
      const currentDifference = Number(currentIds.has(b.id)) - Number(currentIds.has(a.id));
      if (currentDifference !== 0) return currentDifference;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });

  if (candidates[0]) {
    process.stdout.write(`${candidates[0].provider}|${candidates[0].id}`);
  }
}

async function runStop() {
  const hub = await connectHub(1000);
  await hub.call("shutdown");
  hub.close();
  console.log("ACP hub daemon stopped");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stop the daemon even when it is hung: graceful shutdown RPC first, then
// SIGTERM/SIGKILL via the pid file. Returns how it went for the summary line.
async function stopDaemonHard() {
  try {
    const hub = await connectHub(1000);
    await hub.call("shutdown");
    hub.close();
    // Give it a beat to unlink its socket and pid file.
    await sleep(300);
    return "stopped";
  } catch {
    // No usable socket — a crashed or hung daemon. Fall through to signals.
  }

  let pid = 0;
  try {
    pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
  } catch {
    // No pid file: nothing to signal.
  }

  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (pid > 0 && alive()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Raced with its own exit.
    }
    for (let i = 0; i < 20 && alive(); i += 1) await sleep(100);
    if (alive()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    return "killed (was hung)";
  }

  return "was not running";
}

function removeRuntimeFiles() {
  for (const file of [SOCKET_PATH, PID_PATH]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone — the daemon cleans up after a graceful shutdown.
    }
  }
}

// Kill the hidden acp-* workspace tmux sessions. They are only views onto
// daemon-owned chats; with the daemon down they are zombies that a reopened
// popup would attach to. Guarded by the hub metadata option so an unrelated
// session that merely shares the prefix is never touched.
function killWorkspaceSessions() {
  const list = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
    encoding: "utf8",
  });
  if (list.status !== 0) return 0;

  const opt = spawnSync("tmux", ["show-option", "-gqv", "@acp_hub_session_prefix"], {
    encoding: "utf8",
  });
  const prefix = (opt.stdout || "").trim() || "acp";

  let killed = 0;
  for (const name of (list.stdout || "").split("\n")) {
    if (!name || !name.startsWith(`${prefix}-`)) continue;
    const meta = spawnSync("tmux", ["show-option", "-t", name, "-qv", "@acp_hub_project_path"], {
      encoding: "utf8",
    });
    if (!(meta.stdout || "").trim()) continue;
    const result = spawnSync("tmux", ["kill-session", "-t", `=${name}`]);
    if (result.status === 0) killed += 1;
  }
  return killed;
}

// Soft recovery: bounce the daemon and clear the tmux views. Chats survive —
// they live in the registry, which the next daemon start reloads.
async function runRestart() {
  const token = claimRestartLock();
  try {
    const how = await stopDaemonHard();
    removeRuntimeFiles();
    const killed = killWorkspaceSessions();

    console.log(`daemon: ${how}`);
    console.log(`workspace sessions closed: ${killed}`);
    console.log(`chats kept in ${REGISTRY_PATH}`);
    console.log("reopen with prefix+m — the daemon restarts on demand");
  } finally {
    removeRestartLock(token);
  }
}

// Hard recovery: everything runRestart does, plus wiping all persisted chats
// and composer state. The user config (agents.json) is never touched.
async function runReset(args) {
  let chatCount = 0;
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    chatCount = Array.isArray(registry?.chats) ? registry.chats.length : 0;
  } catch {
    // Missing or corrupt registry — nothing countable to lose.
  }

  if (args.yes !== true) {
    if (!process.stdin.isTTY) {
      console.error("reset deletes ALL chats; run interactively or pass --yes");
      process.exitCode = 2;
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Delete ALL acp-hub state (${chatCount} saved chat(s), drafts, history) from ${HUB_DIR}? [y/N] `,
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("aborted — nothing deleted");
      return;
    }
  }

  const how = await stopDaemonHard();
  removeRuntimeFiles();
  const killed = killWorkspaceSessions();

  for (const file of [REGISTRY_PATH, STATE_PATH, DRAFTS_PATH, INPUT_HISTORY_PATH, LOG_PATH]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Absent is fine.
    }
  }
  try {
    fs.rmSync(PASTES_DIR, { recursive: true, force: true });
  } catch {
    // Absent is fine.
  }

  console.log(`daemon: ${how}`);
  console.log(`workspace sessions closed: ${killed}`);
  console.log(`wiped ${chatCount} chat(s) and composer state from ${HUB_DIR}`);
  console.log("agents.json (your config) was not touched");
}

async function runRenderMarkdown() {
  const input = fs.readFileSync(0, "utf8");
  const ui = Object.create(PopupUi.prototype);
  ui.markdownFence = false;
  process.stdout.write(ui.renderMarkdown(input));
}

// tmux-invoked subcommands must not exit non-zero: run-shell turns that into
// a blocking error banner over the pane. Surface failures as a status message.
function reportTmuxCommandFailure(args, error) {
  const context = {
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  try {
    tmuxDisplayMessage(context, `acp-hub: ${error.message || String(error)}`);
  } catch {
    // Nothing left to report to.
  }
}

async function main() {
  const [command = "ui", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      runHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      runVersion();
      break;
    case "daemon":
      await runDaemon();
      break;
    case "ui":
      await runUi(args);
      // The UI toggles raw mode and resumes stdin, which keeps the event loop
      // alive after run() returns; without an explicit exit the pane lingers
      // as a black zombie window that prefix+M keeps selecting.
      process.exit(process.exitCode || 0);
      break;
    case "health":
      await runHealth();
      break;
    case "status":
      await runStatus();
      break;
    case "versions":
      await runAdapterVersions(args, false);
      break;
    case "updates":
      await runAdapterVersions(args, true);
      break;
    case "update":
      await runAdapterUpdate(args);
      break;
    case "rollback":
      await runAdapterRollback(args);
      break;
    case "project-chat":
      await runProjectChat(args);
      break;
    case "tmux-menu":
      await runTmuxMenu(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-toggle-menu":
      await runTmuxToggleMenu(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-close-menu":
      await runTmuxCloseMenu(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-panel":
      await runTmuxPanel(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-action":
      await runTmuxAction(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "stop":
      await runStop();
      break;
    case "restart":
      await runRestart();
      break;
    case "reset":
      await runReset(args);
      break;
    case "_render-markdown":
      await runRenderMarkdown();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run acp-hub --help for usage.");
      process.exitCode = 2;
  }
}

function sameExecutablePath(candidate, target) {
  if (!candidate) return false;
  try {
    return fs.realpathSync(candidate) === fs.realpathSync(target);
  } catch {
    return path.resolve(candidate) === path.resolve(target);
  }
}

// npm exposes package binaries through a symlink in node_modules/.bin. Resolve
// both sides so the installed `acp-hub` command enters main just like calling
// bin/acp-hub.mjs directly.
const invokedDirectly = sameExecutablePath(process.argv[1], SCRIPT_PATH);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

export {
  PopupUi,
  renderMarkdownTable,
  hasPendingMarkdownTable,
  pickerFilterEntries,
  pickerNextIndex,
  formatRelativeAge,
  formatChatPreview,
  highlightCode,
};
