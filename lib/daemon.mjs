// The hub daemon: owns ACP adapter processes, chat state, and the registry.
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
// (no imports needed from ./render.mjs)
import {
  resolvedAgentIcon,
  nowIso,
  shortHash,
  mkdirp,
  readJsonIfExists,
  writeJsonFileSync,
  resolveProjectRoot,
  projectName,
  defaultChatTitle,
  newChatTitle,
  savedSessionTitle,
  projectKey,
  chatIdFor,
  agentEntries,
  agentMessageRoleFromUpdate,
  canMergeHistoryChunk,
  retainHistoryByTurns,
  TURN_SCOPED_EVENT_TYPES,
  cleanInline,
  loadTitleSettings,
  loadHistorySettings,
  loadPermissionSettings,
  sanitizeChatTitle,
  promptChatTitle,
  inferLegacyTitleState,
  applyChatTitleCandidate,
  chatTabTitle,
  normalizePlanState,
  updatePlanState,
  settlePlanState,
  advancePlanTurn,
  latestPlanFromHistory,
  mentionAttachmentsForText,
  normalizeAdditionalDirectories,
  configOptionId,
  resolveConfigOption,
  sanitizeConfigValues,
  agentDefaultConfigValues,
  sortConfigEntries,
  selectedConfigValues,
  chatModel,
  chatEffort,
  chatConfigLabel,
  resolveConfigOptionValue,
  buildSetConfigOptionRequest,
  applyLocalConfigOptionValue,
  configOptionValueMatches,
  syncChatModeFromConfig,
  chatModeConfigOption,
  chatModeEntries,
  resolveModeEntries,
  valueLabel,
  buildPromptContent,
  promptDisplayText,
  normalizeProviderCommands,
  resolveProviderCommand,
  orderChatsByActivity,
  contentText,
  toolContentText,
  toolContentDiffs,
  supportsSessionClose,
  supportsSessionLoad,
  supportsSessionResume,
  supportsSessionListCapabilities,
  supportsSessionDelete,
  isRestoreUnsupported,
  isMethodNotFound,
  tmuxWindowOptionValues,
  setTmuxWindowOptions,
  setTmuxGlobalOptions,
  acpStatusCountOptionValues,
  isActiveChatStatus,
  applyAcpStatusFormat,
  findTmuxWindowForChat,
  HUB_DIR,
  HUB_VERSION,
  acpProtocolMismatch,
  SOCKET_PATH,
  PID_PATH,
  STATE_PATH,
  REGISTRY_PATH,
  PERMISSION_TIMEOUT_MS,
} from "./core.mjs";
import {
  McpRegistry,
  materializeMcpDefinition,
  normalizeMcpDefinition,
  publicMcpDefinition,
  resolveEffectiveMcp,
  scopeMatches,
  staticMcpDefinitions,
} from "./mcp.mjs";
import {
  canConnectToSocket,
  LineConnection,
  AcpPeer,
} from "./rpc.mjs";
import { AdapterVersionManager } from "./versions.mjs";

function emptyPermissionState() {
  return {
    pending: null,
    activeOnce: null,
    sessionGrants: [],
    lastDecision: null,
  };
}

function permissionOptionId(option) {
  return String(option?.optionId || option?.id || "");
}

function permissionDecisionScope(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (normalized === "allow_once") return "once";
  if (normalized === "allow_always") return "session";
  if (normalized === "reject_once") return "reject_once";
  if (normalized === "reject_always") return "reject_session";
  return "selected";
}

function permissionToolSummary(toolCall = {}) {
  return {
    toolCallId: toolCall.toolCallId || toolCall.id || null,
    toolKind: toolCall.kind || null,
    toolTitle: cleanInline(toolCall.title || "") || null,
  };
}

function completedToolStatus(status) {
  return ["completed", "failed", "cancelled", "canceled"].includes(
    String(status || "").toLowerCase(),
  );
}

class HubDaemon {
  constructor(config) {
    this.config = config;
    this.mcpRegistry = new McpRegistry();
    this.adapterVersions = new AdapterVersionManager({ config });
    // Immutable for the lifetime of this daemon: an update may be downloaded
    // while chats are alive, but no newly-created chat switches runtime until
    // the daemon restarts and captures a fresh launch manifest.
    this.adapterLaunchManifest = null;
    this.adapterUpdateCheckTimer = null;
    this.shuttingDown = false;
    this.server = null;
    this.clients = new Set();
    this.chats = new Map();
    this.registry = new Map();
    this.currentByProject = new Map();
    this.pendingPermissions = new Map();
    // Adapter maintenance is daemon-owned, just like chats. A popup may close
    // during npm install/verification and recover the same operation later.
    this.adapterOperations = new Map();
    this.currentAdapterOperationId = null;
    this.persistTimer = null;
    this.registryTimer = null;
    this.latestState = null;
    this.stateDirty = false;
    this.tmuxSyncTimers = new Map();
    this.tmuxStatusCountsKey = "";
    this.titleSettings = loadTitleSettings();
    this.historyLimit = loadHistorySettings().eventLimit;
    this.permissionSettings = loadPermissionSettings();
    // provider -> boolean: whether the adapter advertises session/delete, so
    // bulk deletes don't spawn a probe adapter per chat.
    this.sessionDeleteSupport = new Map();
    // "provider\0sessionId" for sessions deleted locally but not provider-side;
    // keeps session/list refreshes from resurrecting them.
    this.sessionTombstones = new Set();
  }

  tombstoneKey(provider, sessionId) {
    return `${provider}\0${sessionId}`;
  }

  tombstoneSession(provider, sessionId) {
    if (!provider || !sessionId) return;
    this.sessionTombstones.add(this.tombstoneKey(provider, sessionId));
    this.saveRegistry();
  }

  isSessionTombstoned(provider, sessionId) {
    return Boolean(provider && sessionId && this.sessionTombstones.has(this.tombstoneKey(provider, sessionId)));
  }

  async start() {
    await mkdirp(HUB_DIR);
    // Transcripts, drafts, and pastes are plaintext; keep the state dir private
    // (fixes both fresh and pre-existing 0755 dirs on multi-user systems).
    await fsp.chmod(HUB_DIR, 0o700).catch(() => {});
    // Heal state files that predate the 0600 policy (writeFileSync's `mode`
    // only applies at creation, and the log was opened with the default 0644).
    try {
      for (const entry of await fsp.readdir(HUB_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        await fsp.chmod(path.join(HUB_DIR, entry.name), 0o600).catch(() => {});
      }
    } catch {
      // Best effort — the dir itself is already 0700.
    }
    try {
      const promoted = await this.adapterVersions.promotePending({ lockTimeoutMs: 2000 });
      this.adapterLaunchManifest = promoted.manifest;
    } catch {
      // An updater may still own the lock. Fast startup and the previous
      // known-good runtime are safer than blocking the popup; the pending
      // candidate will be promoted by the next restart.
      this.adapterLaunchManifest = await this.adapterVersions.readManifest();
    }
    await this.loadRegistry();
    await this.removeStaleSocket();

    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(SOCKET_PATH, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    await fsp.chmod(SOCKET_PATH, 0o600).catch(() => {});
    await fsp.writeFile(PID_PATH, String(process.pid), { encoding: "utf8", mode: 0o600 });
    this.persistState();
    this.scheduleAdapterUpdateCheck(1500);
  }

  scheduleAdapterUpdateCheck(delayMs = this.adapterVersions.settings.checkIntervalMs) {
    if (this.shuttingDown) return;
    if (this.adapterUpdateCheckTimer) clearTimeout(this.adapterUpdateCheckTimer);
    this.adapterUpdateCheckTimer = setTimeout(() => {
      this.adapterUpdateCheckTimer = null;
      this.checkAdapterUpdates()
        .catch(() => {})
        .finally(() => this.scheduleAdapterUpdateCheck());
    }, delayMs);
    this.adapterUpdateCheckTimer.unref?.();
  }

  publishAdapterUpdateNotice(result) {
    const updates = (result?.providers || []).filter(
      (state) => state.updateAvailable || state.state === "deprecated",
    );
    setTmuxGlobalOptions({
      "@acp_hub_update_count": updates.length,
      "@acp_hub_updates": updates
        .map((state) => `${state.provider}:${state.availableVersion || "deprecated"}`)
        .join(","),
    });
    if (updates.length && this.adapterVersions.settings.notify) {
      this.broadcastGlobal({
        type: "adapter_update_notice",
        updates: updates.map((state) => ({
          provider: state.provider,
          activeVersion: state.activeVersion || state.configuredVersion,
          availableVersion: state.availableVersion,
          deprecated: state.deprecated,
        })),
      });
    }
    return updates;
  }

  async checkAdapterUpdates(options = {}) {
    const result = await this.adapterVersions.versions({
      check: true,
      force: options.force === true,
      globals: false,
    });
    this.publishAdapterUpdateNotice(result);
    return result;
  }

  async removeStaleSocket() {
    if (!fs.existsSync(SOCKET_PATH)) return;

    if (await canConnectToSocket(SOCKET_PATH)) {
      throw new Error(`ACP hub socket is already active: ${SOCKET_PATH}`);
    }

    try {
      await fsp.unlink(SOCKET_PATH);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  handleConnection(socket) {
    const client = {
      id: shortHash(`${Date.now()}-${Math.random()}`),
      subscriptions: new Set(),
      conn: null,
    };

    client.conn = new LineConnection(
      socket,
      (message) => {
        this.handleClientMessage(client, message).catch((error) => {
          this.sendError(client, message.id, error);
        });
      },
      () => this.handleClientClose(client),
    );

    this.clients.add(client);
  }

  handleClientClose(client) {
    this.clients.delete(client);
    // Pending permission requests intentionally survive client disconnects so a
    // reopened popup can still answer them; the per-request timeout bounds them.
  }

  async handleClientMessage(client, message) {
    if (message.type !== "request") return;

    const { id, method, params = {} } = message;

    try {
      let result;
      switch (method) {
        case "list_agents":
          result = { defaultAgent: this.config.defaultAgent, agents: agentEntries(this.config) };
          break;
        case "list_chats":
          result = { chats: this.chatSummaries(params) };
          break;
        case "ensure_chat":
          result = this.chatSummary(
            await this.ensureChat(params.provider || this.config.defaultAgent, params.cwd),
          );
          break;
        case "new_chat":
          result = this.chatSummary(
            await this.createChat(params.provider || this.config.defaultAgent, params.cwd, {
              makeCurrent: true,
              newSession: true,
            }),
          );
          break;
        case "refresh_sessions":
          result = await this.refreshSessions(
            params.provider || null,
            params.cwd || null,
            params.includeAllProviders === true,
          );
          break;
        case "subscribe":
          result = await this.subscribe(client, params.chatId);
          break;
        case "retry_restore":
          result = await this.retryRestore(client, params.chatId);
          break;
        case "recover_chat_fresh":
          result = await this.recoverChatFresh(client, params.chatId);
          break;
        case "unsubscribe":
          result = this.unsubscribe(client, params.chatId);
          break;
        case "watch":
          client.watchAll = true;
          result = { ok: true };
          break;
        case "unwatch":
          client.watchAll = false;
          result = { ok: true };
          break;
        case "send_prompt":
          result = await this.sendPrompt(
            params.chatId,
            params.text,
            params.attachments || [],
            params.clientPromptId,
          );
          break;
        case "execute_provider_command":
          result = await this.executeProviderCommand(
            params.chatId,
            params.command,
            params.clientCommandId,
          );
          break;
        case "set_config_option":
          result = await this.setConfigOption(params.chatId, params.configId, params.value);
          break;
        case "set_mode":
          result = await this.setMode(params.chatId, params.modeId);
          break;
        case "set_roots":
          result = this.setRoots(params.chatId, params.additionalDirectories || []);
          break;
        case "mcp_list":
          result = this.mcpList(params.chatId);
          break;
        case "mcp_upsert":
          result = this.mcpUpsert(params.chatId, params.server || {});
          break;
        case "mcp_toggle":
          result = this.mcpToggle(params.chatId, params.id, params.enabled === true);
          break;
        case "mcp_remove":
          result = this.mcpRemove(params.chatId, params.id);
          break;
        case "mcp_test":
          result = this.mcpTest(params.chatId, params.id || null);
          break;
        case "mcp_apply":
          result = await this.applyMcp(params.chatId);
          break;
        case "cancel":
          result = this.cancel(params.chatId);
          break;
        case "permission_response":
          result = this.permissionResponse(params);
          break;
        case "close_chat":
          result = this.closeChat(params.chatId);
          break;
        case "delete_chat":
          result = await this.deleteChat(params.chatId);
          break;
        case "authenticate":
          result = await this.authenticate(params.chatId, params.methodId);
          break;
        case "rename_chat":
          result = this.renameChat(params.chatId, params.title);
          break;
        case "chat_preview":
          result = this.chatPreview(params.chatId);
          break;
        case "list_changes":
          result = this.chatChanges(params.chatId);
          break;
        case "adapter_versions":
          result = params.check === true
            ? await this.checkAdapterUpdates({ force: params.force === true })
            : await this.adapterVersions.versions({ globals: params.globals === true });
          if (params.globals === true && params.check === true) {
            const globals = await this.adapterVersions.versions({ globals: true });
            const byProvider = new Map(
              globals.providers.map((state) => [state.provider, state.globalCli]),
            );
            for (const state of result.providers) {
              state.globalCli = byProvider.get(state.provider) || null;
            }
          }
          break;
        case "adapter_operation_current":
          result = { operation: this.currentAdapterOperation() };
          break;
        case "adapter_operation_ack":
          result = this.ackAdapterOperation(params.operationId);
          break;
        case "adapter_update_start":
          result = {
            operation: await this.startAdapterOperation("update", params.provider, {
              force: params.force === true,
            }),
          };
          break;
        case "adapter_rollback_start":
          result = {
            operation: await this.startAdapterOperation("rollback", params.provider),
          };
          break;
        case "adapter_update": {
          const progress = (update) => this.broadcastGlobal({
            type: "adapter_update_progress",
            update,
          });
          result = params.provider === "all"
            ? await this.adapterVersions.updateAll({
                force: params.force === true,
                onProgress: progress,
              })
            : await this.adapterVersions.update(params.provider, {
                force: params.force === true,
                onProgress: progress,
              });
          result.busyChats = this.busyChatSummaries();
          break;
        }
        case "adapter_rollback":
          result = await this.adapterVersions.rollback(params.provider);
          result.busyChats = this.busyChatSummaries();
          break;
        case "shutdown":
          result = { ok: true };
          setTimeout(() => this.shutdown(), 20);
          break;
        default:
          throw new Error(`Unknown hub method: ${method}`);
      }

      client.conn.send({ type: "response", id, result });
    } catch (error) {
      this.sendError(client, id, error);
    }
  }

  sendError(client, id, error) {
    client.conn.send({
      type: "response",
      id,
      error: {
        message: error.message || String(error),
      },
    });
  }

  agentConfig(provider) {
    const agent = this.config.agents?.[provider];
    if (!agent) throw new Error(`Unknown ACP agent: ${provider}`);
    if (!agent.command) throw new Error(`ACP agent ${provider} has no command`);
    return this.adapterVersions.resolveAgent(provider, agent, this.adapterLaunchManifest);
  }

  busyChatSummaries() {
    return [...this.chats.values()]
      .filter((chat) => chat.turnActive || isActiveChatStatus(chat.status))
      .map((chat) => ({
        id: chat.id,
        provider: chat.provider,
        title: chat.title,
        status: chat.status,
      }));
  }

  broadcastGlobal(event) {
    for (const client of this.clients) {
      client.conn.send({ type: "event", ...event });
    }
  }

  adapterOperationSummary(operation) {
    if (!operation) return null;
    return {
      id: operation.id,
      action: operation.action,
      provider: operation.provider,
      providerLabel: operation.providerLabel,
      status: operation.status,
      phase: operation.phase,
      progressProvider: operation.progressProvider || null,
      version: operation.version || null,
      fromVersion: operation.fromVersion || null,
      configuredVersion: operation.configuredVersion || null,
      startedAt: operation.startedAt,
      updatedAt: operation.updatedAt,
      finishedAt: operation.finishedAt || null,
      error: operation.error || null,
      result: operation.result || null,
    };
  }

  currentAdapterOperation() {
    return this.adapterOperationSummary(
      this.adapterOperations.get(this.currentAdapterOperationId) || null,
    );
  }

  publishAdapterOperation(operation) {
    operation.updatedAt = nowIso();
    this.broadcastGlobal({
      type: "adapter_operation",
      operation: this.adapterOperationSummary(operation),
    });
  }

  adapterOperationResult(result) {
    const cleanItem = (item = {}) => ({
      ok: item.ok !== false,
      provider: item.provider || null,
      package: item.package || null,
      configuredVersion: item.configuredVersion || null,
      activeVersion: item.activeVersion || null,
      pendingVersion: item.pendingVersion || null,
      previousVersion: item.previousVersion || null,
      alreadyCurrent: item.alreadyCurrent === true,
      alreadyPending: item.alreadyPending === true,
      requiresRestart: item.requiresRestart === true,
      dependencies: item.dependencies || {},
    });
    const items = Array.isArray(result?.results)
      ? result.results.map(cleanItem)
      : result
        ? [cleanItem(result)]
        : [];
    return {
      ok: result?.ok !== false && !(result?.errors || []).length,
      items,
      errors: (result?.errors || []).map((entry) => ({
        provider: entry.provider || null,
        error: cleanInline(entry.error || "Adapter update failed").slice(0, 500),
      })),
      requiresRestart:
        result?.requiresRestart === true || items.some((item) => item.requiresRestart),
      busyChats: (result?.busyChats || []).map((chat) => ({
        id: chat.id,
        provider: chat.provider,
        title: chat.title,
        status: chat.status,
      })),
    };
  }

  async startAdapterOperation(action, provider, options = {}) {
    if (!["update", "rollback"].includes(action)) {
      throw new Error(`Unknown adapter operation: ${action || '-'}`);
    }
    if (action === "rollback" && provider === "all") {
      throw new Error("Rollback requires one adapter provider");
    }
    const current = this.adapterOperations.get(this.currentAdapterOperationId);
    if (current?.status === "running") {
      if (current.action === action && current.provider === provider) {
        return this.adapterOperationSummary(current);
      }
      throw new Error(
        `${current.action} ${current.provider} is already running; wait for it to finish`,
      );
    }
    if (current) this.adapterOperations.delete(current.id);

    if (provider === "all") {
      const states = (await this.adapterVersions.versions({ globals: false })).providers;
      if (!states.some((state) => state.managed)) {
        throw new Error("No managed ACP adapters are configured");
      }
    } else {
      const descriptor = this.adapterVersions.descriptor(provider);
      if (!descriptor.managed) {
        throw new Error(`${provider} uses a custom or unpinned command and is not managed by the Hub`);
      }
    }
    const snapshot = provider === "all"
      ? null
      : (await this.adapterVersions.versions({ globals: false })).providers
          .find((state) => state.provider === provider);
    const operation = {
      id: `adapter-${crypto.randomUUID()}`,
      action,
      provider,
      providerLabel: snapshot?.label || (provider === "all" ? "All adapters" : provider),
      status: "running",
      phase: action === "rollback" ? "staging" : "checking",
      version: action === "rollback" ? snapshot?.previousVersion || null : null,
      fromVersion: snapshot?.activeVersion || snapshot?.configuredVersion || null,
      configuredVersion: snapshot?.configuredVersion || null,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
      error: null,
      result: null,
    };
    this.adapterOperations.set(operation.id, operation);
    this.currentAdapterOperationId = operation.id;
    this.publishAdapterOperation(operation);

    // Detach the work from the request lifecycle. The caller receives the id
    // immediately; progress and completion arrive as recoverable snapshots.
    queueMicrotask(() => this.runAdapterOperation(operation, options));
    return this.adapterOperationSummary(operation);
  }

  async runAdapterOperation(operation, options = {}) {
    const progress = (update = {}) => {
      operation.phase = update.phase || operation.phase;
      operation.version = update.version || operation.version;
      operation.progressProvider = update.provider || operation.provider;
      this.publishAdapterOperation(operation);
      // Keep the legacy event for older popup clients connected to a newer
      // daemon; current clients consume adapter_operation instead.
      this.broadcastGlobal({ type: "adapter_update_progress", update });
    };

    try {
      let result;
      if (operation.action === "rollback") {
        result = await this.adapterVersions.rollback(operation.provider);
      } else {
        result = operation.provider === "all"
          ? await this.adapterVersions.updateAll({
              force: options.force === true,
              onProgress: progress,
            })
          : await this.adapterVersions.update(operation.provider, {
              force: options.force === true,
              onProgress: progress,
            });
      }
      result.busyChats = this.busyChatSummaries();
      operation.result = this.adapterOperationResult(result);
      const item = operation.result.items.find(
        (candidate) => candidate.provider === operation.provider,
      ) || operation.result.items[0];
      operation.version = item?.pendingVersion || item?.activeVersion || operation.version;
      operation.status = operation.result.ok ? "succeeded" : "failed";
      operation.phase = operation.result.ok
        ? operation.result.requiresRestart
          ? "staged"
          : "current"
        : "failed";
      if (!operation.result.ok) {
        operation.error = operation.result.errors
          .map((entry) => `${entry.provider || "adapter"}: ${entry.error}`)
          .join(" · ") || "Adapter operation failed";
      }
    } catch (error) {
      operation.status = "failed";
      operation.phase = "failed";
      operation.error = cleanInline(error.message || String(error)).slice(0, 500);
      operation.result = {
        ok: false,
        items: [],
        errors: [{ provider: operation.provider, error: operation.error }],
        requiresRestart: false,
        busyChats: [],
      };
    } finally {
      operation.finishedAt = nowIso();
      this.publishAdapterOperation(operation);
      this.logLifecycle(`adapter_${operation.action}_${operation.status}`, {
        id: operation.id,
        provider: operation.provider,
        sessionId: null,
        status: operation.phase,
      }, operation.error ? new Error(operation.error) : null);
    }
  }

  ackAdapterOperation(operationId) {
    const operation = this.adapterOperations.get(operationId);
    if (!operation) return { ok: true, operation: null };
    if (operation.status === "running") {
      throw new Error("An active adapter operation cannot be dismissed");
    }
    if (this.currentAdapterOperationId === operationId) {
      this.currentAdapterOperationId = null;
    }
    this.adapterOperations.delete(operationId);
    this.broadcastGlobal({ type: "adapter_operation", operation: null });
    return { ok: true, operation: null };
  }

  // Lifecycle diagnostics intentionally exclude prompts, environment values,
  // adapter arguments, and transcript contents. stderr is redirected to the
  // private, rotated daemon log by the CLI launcher.
  logLifecycle(event, chat, error = null) {
    const entry = {
      at: nowIso(),
      event,
      chatId: chat?.id || null,
      provider: chat?.provider || null,
      sessionId: chat?.sessionId || null,
      status: chat?.status || null,
      error: error ? cleanInline(error.message || String(error)).slice(0, 500) : null,
    };
    try {
      console.error(`[acp-hub] ${JSON.stringify(entry)}`);
    } catch {
      // Diagnostics must never change recovery behavior.
    }
  }

  async ensureChat(provider, rawCwd) {
    const cwd = resolveProjectRoot(rawCwd || process.cwd());
    const currentId = this.currentByProject.get(projectKey(provider, cwd));
    const current = currentId ? this.chats.get(currentId) : null;

    if (current && !["closed", "stopped", "error"].includes(current.status)) {
      return current;
    }

    if (currentId && this.registry.has(currentId)) {
      try {
        return await this.activateStoredChat(currentId);
      } catch (error) {
        this.chats.delete(currentId);
        if (!isRestoreUnsupported(error)) throw error;
      }
    }

    const saved = [...this.registry.values()]
      .filter((record) => record.provider === provider && record.cwd === cwd && record.sessionId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    if (saved[0]) {
      this.currentByProject.set(projectKey(provider, cwd), saved[0].id);
      try {
        return await this.activateStoredChat(saved[0].id);
      } catch (error) {
        this.chats.delete(saved[0].id);
        if (!isRestoreUnsupported(error)) throw error;
      }
    }

    return this.createChat(provider, cwd, { makeCurrent: true });
  }

  async createChat(provider, rawCwd, options = {}) {
    const cwd = resolveProjectRoot(rawCwd || process.cwd());
    const agent = this.agentConfig(provider);
    const providerLabel = agent.label || provider;
    const provisionalId = chatIdFor(provider, cwd, null, `${Date.now()}-${Math.random()}`);
    const title =
      options.title ||
      (options.newSession
        ? newChatTitle(providerLabel, cwd, this.nextProjectChatNumber(provider, cwd))
        : defaultChatTitle(providerLabel, cwd));
    const chat = this.createChatObject({
      id: provisionalId,
      provider,
      providerLabel,
      cwd,
      title,
      defaultTitle: title,
      titleSource: options.titleSource || "default",
      statusDetail: "Starting ACP adapter",
      configValues: {
        ...agentDefaultConfigValues(agent),
        ...this.projectConfigValues(provider, cwd),
        ...sanitizeConfigValues(options.configValues || {}),
      },
    });

    this.chats.set(chat.id, chat);
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Starting ${chat.providerLabel} in ${chat.cwd}`,
    });

    await this.startAcpAgent(chat, agent, { lifecycle: "new" });

    if (chat.sessionId) {
      this.rekeyChat(chat, chatIdFor(provider, cwd, chat.sessionId));
    }

    this.rememberChat(chat, { makeCurrent: options.makeCurrent === true });
    return chat;
  }

  async activateStoredChat(chatId) {
    const active = this.chats.get(chatId);
    // A failed restore is still a real, user-visible chat. Keep its identity
    // stable until the user explicitly retries or starts fresh; repeatedly
    // subscribing must not respawn adapters or silently adopt another chat.
    if (active?.restoreFailure) return active;
    if (active && !["closed", "stopped", "error"].includes(active.status)) return active;

    const record = this.registry.get(chatId);
    if (!record) throw new Error(`Unknown saved chat: ${chatId}`);
    if (!record.sessionId) throw new Error(`Saved chat has no ACP session id: ${chatId}`);

    const agent = this.agentConfig(record.provider);
    const chat = this.createChatObject({
      ...record,
      providerLabel: agent.label || record.provider,
      statusDetail: "Restoring ACP session",
      configValues: sanitizeConfigValues(record.configValues || {}),
    });

    this.chats.set(chat.id, chat);
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Restoring ${chat.providerLabel} session ${record.sessionId}`,
    });

    try {
      await this.startAcpAgent(chat, agent, {
        lifecycle: "restore",
        sessionId: record.sessionId,
        additionalDirectories: record.additionalDirectories || [],
      });
    } catch (error) {
      if (!isRestoreUnsupported(error)) {
        chat.restoreFailure = {
          kind: "restore",
          message: cleanInline(error.message || String(error)) || "ACP session restore failed",
          sessionId: record.sessionId,
          attemptedAt: nowIso(),
          retryable: true,
        };
        this.addEvent(chat, {
          type: "system",
          level: "warn",
          text: "The saved ACP session could not be restored. Choose Retry restore, Start fresh, or Chats; no replacement chat was created.",
        });
        this.logLifecycle("restore_failed", chat, error);
        this.rememberChat(chat, { makeCurrent: true });
        return chat;
      }

      // The saved session no longer exists on the provider side. Retrying it
      // forever just accumulates errors; tombstone the stale session and give
      // the user a fresh working session in the same chat instead.
      this.tombstoneSession(record.provider, record.sessionId);
      this.registry.delete(chatId);
      chat.sessionId = null;
      chat.history = chat.history.filter(
        (event) => !(event.type === "error" && /Failed to start ACP session/.test(event.text || "")),
      );
      this.addEvent(chat, {
        type: "system",
        level: "warn",
        text: "Saved session no longer exists on the provider — starting a fresh session",
      });

      await this.startAcpAgent(chat, agent, {
        lifecycle: "new",
        additionalDirectories: record.additionalDirectories || [],
      });

      if (chat.sessionId) {
        this.rekeyChat(chat, chatIdFor(chat.provider, chat.cwd, chat.sessionId));
      }
    }

    this.rememberChat(chat, { makeCurrent: true });
    return chat;
  }

  createChatObject(input) {
    const now = nowIso();
    const titleState = inferLegacyTitleState(
      input,
      input.title || defaultChatTitle(input.providerLabel || input.provider, input.cwd),
    );
    const chat = {
      id: input.id,
      provider: input.provider,
      providerLabel: input.providerLabel || input.provider,
      cwd: path.resolve(input.cwd),
      projectName: input.projectName || projectName(input.cwd),
      ...titleState,
      status: "starting",
      statusDetail: input.statusDetail || "Starting ACP adapter",
      mode: input.mode || null,
      pid: null,
      sessionId: input.sessionId || null,
      startedAt: input.startedAt || now,
      updatedAt: input.updatedAt || now,
      additionalDirectories: input.additionalDirectories || [],
      history: Array.isArray(input.history) ? [...input.history] : [],
      peer: null,
      process: null,
      turnActive: false,
      activeRequest: null,
      toolCalls: new Map(),
      modes: input.modes || null,
      availableCommands: normalizeProviderCommands(input.availableCommands || []),
      configOptions: input.configOptions || [],
      configValues: sanitizeConfigValues(input.configValues || {}),
      // Permission grants are runtime authority, not durable session config.
      // Requests/decisions remain auditable in history, while active grants
      // intentionally reset when the adapter/daemon is restarted.
      permissionState: emptyPermissionState(),
      mcpPayload: [],
      mcpServers: [],
      mcpAppliedIds: [],
      mcpAppliedSignature: "",
      mcpApplyPending: false,
      mcpApplyRunning: false,
      mcpLastApplyError: null,
      restoreFailure: input.restoreFailure || null,
      recoveryPreviousSessionId: null,
      usage: null,
      turnSequence: Math.max(0, Number.parseInt(input.turnSequence, 10) || 0),
      turnStartedAt: null,
      lastStopReason: input.lastStopReason || null,
      plan: Object.hasOwn(input, "plan")
        ? normalizePlanState(input.plan)
        : latestPlanFromHistory(input.history || [], {
            turnSequence: Math.max(0, Number.parseInt(input.turnSequence, 10) || 0),
          }),
      planSupported:
        input.planSupported === true ||
        Boolean(input.plan?.entries?.length) ||
        (input.history || []).some((event) => event?.type === "plan"),
      promptQueue: [],
      authMethods: input.authMethods || [],
      pendingAuthOptions: null,
      mcpServers: [],
      suppressExitEvent: false,
    };
    return chat;
  }

  applyTitle(chat, title, source) {
    const next = applyChatTitleCandidate(chat, { title, source }, this.titleSettings.policy);
    const changed =
      next.title !== chat.title ||
      next.titleSource !== chat.titleSource ||
      next.fallbackTitle !== chat.fallbackTitle ||
      next.defaultTitle !== chat.defaultTitle;
    if (!changed) return false;

    chat.title = next.title;
    chat.titleSource = next.titleSource;
    chat.fallbackTitle = next.fallbackTitle;
    chat.defaultTitle = next.defaultTitle;
    return true;
  }

  spawnAcpProcess(agent, cwd, onProtocolError) {
    const child = spawn(agent.command, Array.isArray(agent.args) ? agent.args : [], {
      cwd,
      env: { ...process.env, ...(agent.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const peer = new AcpPeer(child, onProtocolError);
    return { child, peer };
  }

  initializePeer(peer) {
    return peer.call(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
        },
        clientInfo: {
          name: "tmux-acp-hub",
          title: "tmux ACP Hub",
          version: HUB_VERSION,
        },
      },
      { timeoutMs: 30000 },
    );
  }

  async startAcpAgent(chat, agent, options = {}) {
    const { child, peer } = this.spawnAcpProcess(agent, chat.cwd, (message) => {
      this.addEvent(chat, { type: "error", text: message });
    });

    chat.suppressExitEvent = false;
    chat.process = child;
    chat.pid = child.pid;
    chat.peer = peer;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) this.addEvent(chat, { type: "adapter_log", text });
    });

    child.on("exit", (code, signal) => {
      if (chat.status === "closed") return;
      // A failed adapter may exit after an explicit recovery has already
      // installed a replacement process on the same chat object.
      if (chat.process !== child) return;
      if (chat.suppressExitEvent) {
        chat.suppressExitEvent = false;
        return;
      }

      this.cancelPendingPermissionsForChat(chat, "Adapter exited");
      chat.turnActive = false;
      chat.activeRequest = null;
      chat.promptQueue = [];
      this.setStatus(chat, "stopped", `Adapter exited: ${signal || code}`);
      this.addEvent(chat, {
        type: "system",
        level: code === 0 ? "info" : "error",
        text: `ACP adapter exited (${signal || code})`,
      });
      this.rememberChat(chat);
    });

    chat.peer.onNotification("session/update", (params) => this.handleSessionUpdate(chat, params));
    chat.peer.onRequest("session/request_permission", (params) =>
      this.handlePermissionRequest(chat, params),
    );

    try {
      this.setStatus(chat, "starting", "Initializing ACP");
      const init = await this.initializePeer(chat.peer);

      chat.agentInfo = init.agentInfo || null;
      chat.agentCapabilities = init.agentCapabilities || null;
      chat.authMethods = init.authMethods || [];

      // Warn-and-continue: the spec leaves the go/no-go call to the client,
      // and a loud message beats a silent hang when an adapter drops v1.
      const versionWarning = acpProtocolMismatch(init.protocolVersion);
      if (versionWarning) {
        this.addEvent(chat, { type: "system", level: "error", text: versionWarning });
      }

      await this.establishSession(chat, agent, options);
    } catch (error) {
      // The agent requires authentication before a session can be created. Keep
      // the adapter alive so the user can authenticate and retry instead of
      // tearing everything down with a cryptic error.
      if (error.code === -32000) {
        chat.pendingAuthOptions = options;
        this.setStatus(chat, "auth", "Authentication required");
        this.emitAuthRequired(chat);
        return;
      }

      this.setStatus(chat, "error", error.message || String(error));
      this.addEvent(chat, {
        type: "error",
        text: `Failed to start ACP session: ${error.message || String(error)}`,
      });
      this.cancelPendingPermissionsForChat(chat, "ACP session failed to start");
      chat.turnActive = false;
      chat.suppressExitEvent = true;

      if (chat.peer) {
        chat.peer.close();
      }

      if (chat.process && !chat.process.killed) {
        chat.process.kill("SIGTERM");
      }

      chat.peer = null;
      chat.process = null;
      chat.pid = null;
      throw error;
    }
  }

  async establishSession(chat, agent, options = {}) {
    let session;
    const restoreSessionId = options.sessionId || chat.sessionId;
    const additionalDirectories = Array.isArray(options.additionalDirectories)
      ? options.additionalDirectories
      : chat.additionalDirectories || [];
    chat.additionalDirectories = additionalDirectories;

    const resolution =
      options.mcpResolution ||
      this.resolveMcpForChat(chat, {
        agent,
        capabilities: chat.agentCapabilities,
      });
    const mcpServers = resolution.servers || [];
    const skippedMcp = resolution.skipped || [];
    chat.mcpPayload = mcpServers;
    chat.mcpServers = this.publicEffectiveMcpEntries(resolution, {
      applied: true,
    });
    chat.mcpAppliedIds = (resolution.entries || []).map((entry) => entry.id);
    chat.mcpAppliedSignature = this.mcpPayloadSignature(mcpServers);
    chat.mcpApplyPending = false;
    chat.mcpLastApplyError = null;
    if (skippedMcp.length) {
      this.addEvent(chat, {
        type: "system",
        level: "warn",
        text: `Skipped MCP servers: ${skippedMcp.map((s) => `${s.name} (${s.reason})`).join(", ")}`,
      });
    }

    if (options.lifecycle === "restore" && restoreSessionId) {
      if (supportsSessionResume(chat)) {
        this.setStatus(chat, "starting", "Resuming ACP session");
        session = await chat.peer.call(
          "session/resume",
          { sessionId: restoreSessionId, cwd: chat.cwd, additionalDirectories, mcpServers },
          { timeoutMs: 60000 },
        );
      } else if (supportsSessionLoad(chat)) {
        this.setStatus(chat, "starting", "Loading ACP session");
        session = await chat.peer.call(
          "session/load",
          { sessionId: restoreSessionId, cwd: chat.cwd, additionalDirectories, mcpServers },
          { timeoutMs: 60000 },
        );
      } else {
        throw new Error("Agent does not advertise session/resume or session/load");
      }
    } else {
      this.setStatus(chat, "starting", "Creating ACP session");
      session = await chat.peer.call(
        "session/new",
        { cwd: chat.cwd, additionalDirectories, mcpServers },
        { timeoutMs: 60000 },
      );
    }

    chat.sessionId = session.sessionId || restoreSessionId;
    if (session.title !== undefined && session.title !== null) {
      this.applyTitle(chat, session.title, "agent");
    }
    chat.modes = session.modes || null;
    chat.mode = session.modes?.currentModeId || null;
    if (Array.isArray(session.availableCommands)) {
      chat.availableCommands = normalizeProviderCommands(session.availableCommands);
    }
    chat.configOptions = session.configOptions || [];
    syncChatModeFromConfig(chat);
    await this.applyDesiredConfig(chat, agent);
    this.setStatus(chat, "idle", "Ready");
    chat.restoreFailure = null;
    this.addEvent(chat, {
      type: "system",
      level: "success",
      text: `ACP session ready: ${chat.sessionId}`,
    });
  }

  emitAuthRequired(chat) {
    const methods = chat.authMethods || [];
    const lines = methods.map((method, index) => {
      const id = method.id || method.methodId || `method-${index + 1}`;
      const name = method.name || id;
      const vars = Array.isArray(method.vars) ? method.vars.map((v) => v.name).filter(Boolean) : [];
      const hint =
        method.type === "env_var" && vars.length
          ? ` — set ${vars.join(", ")} and reopen the chat`
          : "";
      return `  ${index + 1}. ${name} [${id}]${hint}`;
    });
    this.addEvent(chat, {
      type: "auth_required",
      methods,
      text: methods.length
        ? `Authentication required for ${chat.providerLabel}.\nAvailable methods:\n${lines.join("\n")}\nUse /auth <id> to authenticate.`
        : `Authentication required for ${chat.providerLabel}, but the adapter advertised no methods.`,
    });
  }

  async authenticate(chatId, methodId) {
    const chat = this.requireChat(chatId);
    if (!chat.peer) throw new Error("ACP adapter is not running");

    const methods = chat.authMethods || [];
    const method =
      methods.find((candidate) => (candidate.id || candidate.methodId) === methodId) ||
      (methods.length === 1 ? methods[0] : null);
    if (!method) throw new Error(`Unknown auth method: ${methodId}`);

    const resolvedId = method.id || method.methodId || methodId;
    if (method.type === "env_var") {
      const vars = Array.isArray(method.vars) ? method.vars.map((v) => v.name).filter(Boolean) : [];
      throw new Error(
        `${method.name || resolvedId} is an environment-variable method. Set ${
          vars.join(", ") || "the required variables"
        } in your environment and reopen the chat; the adapter reads them at startup.`,
      );
    }

    this.setStatus(chat, "starting", `Authenticating: ${method.name || resolvedId}`);
    await chat.peer.call("authenticate", { methodId: resolvedId }, { timeoutMs: 120000 });
    this.addEvent(chat, {
      type: "system",
      level: "success",
      text: `Authenticated with ${method.name || resolvedId}`,
    });

    const agent = this.agentConfig(chat.provider);
    await this.establishSession(chat, agent, chat.pendingAuthOptions || { lifecycle: "new" });
    chat.pendingAuthOptions = null;

    if (chat.sessionId) {
      if (!this.finalizeFreshRecovery(chat)) {
        this.rekeyChat(chat, chatIdFor(chat.provider, chat.cwd, chat.sessionId));
        this.rememberChat(chat, { makeCurrent: true });
      }
    }
    return { ok: true, chat: this.chatSummary(chat) };
  }

  nextProjectChatNumber(provider, cwd) {
    const resolvedCwd = path.resolve(cwd);
    const ids = new Set();

    for (const record of this.registry.values()) {
      if (record.provider === provider && record.cwd === resolvedCwd) ids.add(record.id);
    }

    for (const chat of this.chats.values()) {
      if (chat.provider === provider && chat.cwd === resolvedCwd) ids.add(chat.id);
    }

    return ids.size + 1;
  }

  async subscribe(client, chatId) {
    const chat = this.chats.has(chatId)
      ? this.requireChat(chatId)
      : await this.activateStoredChat(chatId);

    // Subscribe to the chat's *current* id: activateStoredChat can rekey a
    // recovered chat (stale session → fresh session) to a new id, and broadcast
    // matches on chat.id — subscribing to the old param id would miss events.
    client.subscriptions.add(chat.id);
    this.markCurrentChat(chat);

    let pendingPermission = null;
    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.chatId === chat.id) {
        pendingPermission = {
          permissionId,
          options: pending.options || [],
          toolCall: pending.toolCall || null,
          requestedAt: pending.requestedAt || null,
        };
        break;
      }
    }

    return {
      chat: this.chatSummary(chat),
      history: chat.history,
      historyLimit: this.historyLimit,
      pendingPermission,
      adapterOperation: this.currentAdapterOperation(),
    };
  }

  recoveryPayload(chat) {
    return {
      chat: this.chatSummary(chat),
      history: chat.history,
      historyLimit: this.historyLimit,
      pendingPermission: null,
    };
  }

  moveClientSubscription(client, oldId, newId) {
    if (!client || !newId) return;
    client.subscriptions.delete(oldId);
    client.subscriptions.add(newId);
  }

  async retryRestore(client, chatId) {
    const failed = this.requireChat(chatId);
    if (!failed.restoreFailure || !failed.sessionId) {
      throw new Error("This chat has no failed ACP restore to retry");
    }

    const oldId = failed.id;
    this.logLifecycle("restore_retry", failed);
    this.chats.delete(oldId);
    const chat = await this.activateStoredChat(oldId);
    this.moveClientSubscription(client, oldId, chat.id);
    return this.recoveryPayload(chat);
  }

  async recoverChatFresh(client, chatId) {
    const chat = this.requireChat(chatId);
    if (!chat.restoreFailure || !chat.sessionId) {
      throw new Error("This chat has no failed ACP restore to recover");
    }

    const oldId = chat.id;
    const oldSessionId = chat.sessionId;
    const agent = this.agentConfig(chat.provider);
    const additionalDirectories = chat.additionalDirectories || [];
    this.logLifecycle("restore_fresh_requested", chat);
    chat.restoreFailure = null;
    chat.recoveryPreviousSessionId = oldSessionId;
    chat.sessionId = null;
    this.addEvent(chat, {
      type: "system",
      level: "warn",
      text: "Starting a fresh ACP session by user request; the local transcript is being preserved.",
    });

    try {
      await this.startAcpAgent(chat, agent, {
        lifecycle: "new",
        additionalDirectories,
      });
    } catch (error) {
      // The saved session remains the durable recovery point until a new ACP
      // session is actually ready. A failed fresh start never destroys it.
      chat.sessionId = oldSessionId;
      chat.recoveryPreviousSessionId = null;
      chat.restoreFailure = {
        kind: "fresh_start",
        message: cleanInline(error.message || String(error)) || "Fresh ACP session failed to start",
        sessionId: oldSessionId,
        attemptedAt: nowIso(),
        retryable: true,
      };
      this.logLifecycle("restore_fresh_failed", chat, error);
      this.rememberChat(chat, { makeCurrent: true });
      return this.recoveryPayload(chat);
    }

    if (chat.sessionId) this.finalizeFreshRecovery(chat);
    this.moveClientSubscription(client, oldId, chat.id);
    this.logLifecycle("restore_fresh_ready", chat);
    return this.recoveryPayload(chat);
  }

  finalizeFreshRecovery(chat) {
    const previousSessionId = chat.recoveryPreviousSessionId;
    if (!previousSessionId || !chat.sessionId) return false;
    this.tombstoneSession(chat.provider, previousSessionId);
    chat.recoveryPreviousSessionId = null;
    this.rekeyChat(chat, chatIdFor(chat.provider, chat.cwd, chat.sessionId));
    this.rememberChat(chat, { makeCurrent: true });
    return true;
  }

  unsubscribe(client, chatId) {
    client.subscriptions.delete(chatId);
    return { ok: true };
  }

  async sendPrompt(chatId, text, attachments = [], requestedClientPromptId = "") {
    const chat = this.requireChat(chatId);
    const clientPromptId = cleanInline(requestedClientPromptId).slice(0, 160) ||
      `prompt-${crypto.randomUUID()}`;
    const cleanText = String(text || "").trim();
    const allAttachments = [
      ...(Array.isArray(attachments) ? attachments : []),
      ...mentionAttachmentsForText(chat.cwd, cleanText, attachments),
    ];
    const prompt = await buildPromptContent(chat, cleanText, allAttachments);

    if (!prompt.length) throw new Error("Prompt is empty");
    if (!chat.sessionId || !chat.peer) throw new Error("ACP session is not ready");

    return this.enqueueRequest(chat, {
      kind: "prompt",
      text: cleanText,
      prompt,
      clientPromptId,
      clientRequestId: clientPromptId,
      presentation: "work",
      affectsPlan: true,
    });
  }

  async executeProviderCommand(chatId, input, requestedClientCommandId = "") {
    const chat = this.requireChat(chatId);
    if (!chat.sessionId || !chat.peer) throw new Error("ACP session is not ready");

    const resolved = resolveProviderCommand(input, chat.availableCommands || []);
    if (!resolved) {
      const token = String(input || "").trim().split(/\s+/, 1)[0] || "command";
      throw new Error(
        `Unknown provider command: ${token}. Use /commands to inspect the current ACP list or /agent ${token} to send it as raw text.`,
      );
    }

    const descriptor = resolved.descriptor;
    const clientCommandId = cleanInline(requestedClientCommandId).slice(0, 160) ||
      `command-${crypto.randomUUID()}`;
    const prompt = [{ type: "text", text: resolved.text }];
    const actionOption =
      !resolved.arguments && descriptor.action?.kind === "setConfigOption"
        ? resolveConfigOption(chat.configOptions, descriptor.action.configId)
        : null;
    const action = actionOption
      ? {
          ...descriptor.action,
          value:
            Object.hasOwn(descriptor.action, "resetValue") &&
            configOptionValueMatches(actionOption, descriptor.action.value)
              ? descriptor.action.resetValue
              : descriptor.action.value,
        }
      : null;

    return this.enqueueRequest(chat, {
      kind: "command",
      text: resolved.text,
      prompt,
      descriptor,
      arguments: resolved.arguments,
      action,
      clientCommandId,
      clientRequestId: clientCommandId,
      presentation: descriptor.presentation || "work",
      affectsPlan: descriptor.presentation === "work",
    });
  }

  enqueueRequest(chat, request) {
    // Hub-side serialization keeps both prompts and commands safe for every
    // adapter, whether or not it advertises native prompt queueing.
    if (chat.turnActive) {
      request.queuedAt = request.queuedAt || nowIso();
      chat.promptQueue.push(request);
      this.addEvent(chat, {
        type: "system",
        level: "info",
        text: `Queued ${request.kind} (${chat.promptQueue.length} pending)`,
      });
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
      return {
        accepted: true,
        queued: true,
        queueLength: chat.promptQueue.length,
        ...(request.clientPromptId ? { clientPromptId: request.clientPromptId } : {}),
        ...(request.clientCommandId ? { clientCommandId: request.clientCommandId } : {}),
        chat: this.chatSummary(chat),
      };
    }

    this.startRequestTurn(chat, request);
    return {
      accepted: true,
      queued: false,
      ...(request.clientPromptId ? { clientPromptId: request.clientPromptId } : {}),
      ...(request.clientCommandId ? { clientCommandId: request.clientCommandId } : {}),
      turnSequence: chat.turnSequence,
      chat: this.chatSummary(chat),
    };
  }

  startPromptTurn(chat, cleanText, prompt, clientPromptId = "") {
    return this.startRequestTurn(chat, {
      kind: "prompt",
      text: cleanText,
      prompt,
      clientPromptId,
      clientRequestId: clientPromptId,
      presentation: "work",
      affectsPlan: true,
    });
  }

  startRequestTurn(chat, request) {
    chat.turnActive = true;
    chat.activeRequest = request;
    chat.turnSequence = Math.max(0, Number(chat.turnSequence) || 0) + 1;
    chat.turnStartedAt = nowIso();
    chat.lastStopReason = null;
    if (request.affectsPlan !== false) {
      chat.plan = advancePlanTurn(chat.plan, chat.turnSequence);
    }
    // The first meaningful prompt is an immediate fallback only. In the
    // default agent-first policy ACP may replace it later; subsequent prompts
    // cannot churn a stable conversation title.
    if (request.kind === "prompt") {
      const provisional = promptChatTitle(request.text);
      if (provisional) this.applyTitle(chat, provisional, "prompt");
    }
    // Publish the durable user boundary before the status repaint. This keeps
    // the client timeline monotonic: no intermediate "thinking/cancelling"
    // frame can be newer than the prompt it belongs to.
    if (request.kind === "command") {
      this.addEvent(chat, {
        type: "command",
        text: request.text,
        name: request.descriptor?.command || "command",
        arguments: request.arguments || "",
        origin: request.descriptor?.origin || "provider",
        presentation: request.presentation || "work",
        clientCommandId: request.clientCommandId || `command-${crypto.randomUUID()}`,
        submissionState: "active",
        startedAt: chat.turnStartedAt,
      });
    } else {
      this.addEvent(chat, {
        type: "user",
        text: promptDisplayText(request.text, request.prompt),
        clientPromptId: request.clientPromptId || `prompt-${crypto.randomUUID()}`,
        submissionState: "active",
        startedAt: chat.turnStartedAt,
      });
    }
    // Nothing has streamed yet: the agent is thinking. "responding" arrives
    // with the first agent_message_chunk, "working" with tool calls.
    if (request.kind === "command") {
      const detail = request.descriptor?.command === "compact"
        ? "Compacting context"
        : `Running /${request.descriptor?.command || "command"}`;
      this.setStatus(chat, "working", detail);
    } else {
      this.setStatus(chat, "thinking", "Prompt submitted");
    }
    // Persist the new turn association (and an archived prior plan) before the
    // potentially long-running ACP call. A crash mid-turn must not revive the
    // previous plan as active.
    this.rememberChat(chat);

    const operation = request.action?.kind === "setConfigOption"
      ? this.applySessionConfigOption(
          chat,
          request.action.configId,
          request.action.value,
        ).then((applied) => {
          this.addEvent(chat, {
            type: "command_result",
            text: `${applied.configId} set to ${valueLabel(applied.value) || String(applied.value)}`,
            command: request.descriptor?.command || "",
          });
          return { stopReason: "end_turn" };
        })
      : chat.peer.call(
          "session/prompt",
          {
            sessionId: chat.sessionId,
            prompt: request.prompt,
          },
          { timeoutMs: 0 },
        );

    operation
      .then((result) => {
        const completedAt = nowIso();
        const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(chat.turnStartedAt));
        chat.turnActive = false;
        // `allow_once` cannot leak into the next turn even when an adapter
        // omits a terminal tool_call_update for the authorized tool.
        if (chat.permissionState?.activeOnce) chat.permissionState.activeOnce = null;
        const stopReason = result?.stopReason || "end_turn";
        chat.lastStopReason = stopReason;
        if (request.affectsPlan !== false) {
          chat.plan = settlePlanState(chat.plan, stopReason);
        }
        if (request.kind === "command") {
          const producedResult = chat.history.some(
            (event) =>
              event.turnSequence === chat.turnSequence &&
              (
                ["command_result", "error"].includes(event.type) ||
                (event.type === "agent_chunk" && event.messageRole !== "commentary")
              ),
          );
          if (!producedResult && request.presentation !== "work") {
            this.addEvent(chat, {
              type: "command_result",
              text: `Command /${request.descriptor?.command || "command"} completed`,
              command: request.descriptor?.command || "",
            });
          }
        }
        this.setStatus(chat, "idle", `Turn complete: ${stopReason}`);
        this.addEvent(chat, {
          type: "turn_done",
          stopReason,
          startedAt: chat.turnStartedAt,
          completedAt,
          durationMs: Number.isFinite(durationMs) ? durationMs : null,
          requestKind: request.kind,
          ...(request.kind === "command"
            ? { command: request.descriptor?.command || "command" }
            : {}),
        });
        chat.turnStartedAt = null;
        chat.activeRequest = null;
        this.rememberChat(chat);
        if (chat.mcpApplyPending) {
          void this.applyMcp(chat.id)
            .catch(() => {})
            .finally(() => this.drainPromptQueue(chat));
        } else {
          this.drainPromptQueue(chat);
        }
      })
      .catch((error) => {
        const completedAt = nowIso();
        const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(chat.turnStartedAt));
        chat.turnActive = false;
        if (chat.permissionState?.activeOnce) chat.permissionState.activeOnce = null;
        const droppedRequestIds = chat.promptQueue
          .map((item) => item.clientRequestId)
          .filter(Boolean);
        const droppedPromptIds = chat.promptQueue
          .map((item) => item.clientPromptId)
          .filter(Boolean);
        const droppedCommandIds = chat.promptQueue
          .map((item) => item.clientCommandId)
          .filter(Boolean);
        chat.promptQueue = [];
        chat.lastStopReason = "error";
        if (request.affectsPlan !== false) {
          chat.plan = settlePlanState(chat.plan, "error");
        }
        this.setStatus(chat, "error", error.message || String(error));
        this.addEvent(chat, {
          type: "error",
          text: `${request.kind === "command" ? "Command" : "Prompt"} failed: ${error.message || String(error)}`,
        });
        this.addEvent(chat, {
          type: "turn_done",
          stopReason: "error",
          startedAt: chat.turnStartedAt,
          completedAt,
          durationMs: Number.isFinite(durationMs) ? durationMs : null,
          requestKind: request.kind,
          ...(request.kind === "command"
            ? { command: request.descriptor?.command || "command" }
            : {}),
        });
        if (droppedRequestIds.length) {
          this.addEvent(chat, {
            type: "queue_dropped",
            clientRequestIds: droppedRequestIds,
            clientPromptIds: droppedPromptIds,
            clientCommandIds: droppedCommandIds,
            reason: "active_turn_failed",
          });
        }
        chat.turnStartedAt = null;
        chat.activeRequest = null;
        this.rememberChat(chat);
      });
  }

  drainPromptQueue(chat) {
    if (chat.turnActive) return;
    const next = chat.promptQueue.shift();
    if (!next) return;
    // startRequestTurn publishes the canonical user/command boundary with the
    // already-decremented queue in the same chat_event. Avoid an intermediate
    // queue-only frame where the fixed shelf disappears before the prompt is
    // visible in the transcript.
    this.startRequestTurn(chat, next);
  }

  async setConfigOption(chatId, configId, value) {
    const chat = this.requireChat(chatId);
    const applied = await this.applySessionConfigOption(chat, configId, value);
    this.rememberChat(chat, { makeCurrent: true });
    this.broadcast(chat, {
      type: "chat_state",
      chat: this.chatSummary(chat),
    });
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Config ${applied.configId} set to ${valueLabel(applied.value) || String(applied.value)}`,
    });

    return {
      ok: true,
      configId: applied.configId,
      value: applied.value,
      chat: this.chatSummary(chat),
    };
  }

  async applySessionConfigOption(chat, configId, value) {
    if (!chat.peer || !chat.sessionId) throw new Error("ACP session is not ready");

    const option = resolveConfigOption(chat.configOptions, configId);
    if (!option) throw new Error(`Unknown config option: ${configId}`);

    const request = buildSetConfigOptionRequest(chat.sessionId, option, value);
    const result = await chat.peer.call("session/set_config_option", request, { timeoutMs: 30000 });

    if (Array.isArray(result?.configOptions)) {
      chat.configOptions = result.configOptions;
    } else {
      chat.configOptions = applyLocalConfigOptionValue(chat.configOptions, option.id || option.optionId, request.value);
    }

    syncChatModeFromConfig(chat);
    chat.configValues = selectedConfigValues(chat, {
      ...chat.configValues,
      [request.configId]: request.value,
    });
    return {
      configId: request.configId,
      value: request.value,
    };
  }

  async applyDesiredConfig(chat, agent) {
    const desired = {
      ...agentDefaultConfigValues(agent),
      ...sanitizeConfigValues(chat.configValues || {}),
    };
    const entries = sortConfigEntries(Object.entries(desired));
    if (!entries.length || !chat.configOptions?.length) {
      chat.configValues = selectedConfigValues(chat, desired);
      return;
    }

    for (const [configId, value] of entries) {
      const option = resolveConfigOption(chat.configOptions, configId);
      if (!option) continue;

      let resolvedValue;
      try {
        resolvedValue = resolveConfigOptionValue(option, value);
      } catch (error) {
        this.addEvent(chat, {
          type: "system",
          level: "warn",
          text: `Skipped config ${configId}: ${error.message || String(error)}`,
        });
        continue;
      }

      if (configOptionValueMatches(option, resolvedValue)) continue;

      try {
        await this.applySessionConfigOption(chat, configOptionId(option), resolvedValue);
      } catch (error) {
        if (isMethodNotFound(error, "session/set_config_option")) return;
        this.addEvent(chat, {
          type: "system",
          level: "warn",
          text: `Could not apply config ${configId}: ${error.message || String(error)}`,
        });
      }
    }

    chat.configValues = selectedConfigValues(chat, desired);
  }

  async setMode(chatId, modeId) {
    const chat = this.requireChat(chatId);
    if (!chat.peer || !chat.sessionId) throw new Error("ACP session is not ready");

    const entries = chatModeEntries(chat);
    const mode = resolveModeEntries(entries, modeId);
    if (!mode) throw new Error(`Unknown or ambiguous session mode: ${modeId}`);
    const resolvedModeId = mode.id || mode.modeId || mode.value || mode.name;
    const configOption = chatModeConfigOption(chat);

    // ACP configOptions are the canonical surface. Use the legacy method only
    // when no mode config is advertised, or when an older adapter rejects the
    // modern method despite returning configOptions.
    if (configOption) {
      try {
        const result = await this.setConfigOption(
          chatId,
          configOptionId(configOption),
          String(resolvedModeId),
        );
        return {
          ok: true,
          modeId: result.value,
          chat: result.chat,
        };
      } catch (error) {
        if (!isMethodNotFound(error, "session/set_config_option") || !chat.modes) throw error;
      }
    }

    try {
      await chat.peer.call(
        "session/set_mode",
        {
          sessionId: chat.sessionId,
          modeId: String(resolvedModeId),
        },
        { timeoutMs: 30000 },
      );
    } catch (error) {
      if (!isMethodNotFound(error, "session/set_mode") || !configOption) {
        throw error;
      }

      const result = await this.setConfigOption(
        chatId,
        configOptionId(configOption),
        String(resolvedModeId),
      );
      return {
        ok: true,
        modeId: result.value,
        chat: result.chat,
      };
    }

    chat.mode = String(resolvedModeId);
    chat.configOptions = applyLocalConfigOptionValue(chat.configOptions, "mode", chat.mode);
    chat.configValues = selectedConfigValues(chat, {
      ...chat.configValues,
      mode: chat.mode,
    });
    this.rememberChat(chat, { makeCurrent: true });
    this.broadcast(chat, {
      type: "chat_state",
      chat: this.chatSummary(chat),
    });
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Mode set to ${chat.mode}`,
    });

    return {
      ok: true,
      modeId: chat.mode,
      chat: this.chatSummary(chat),
    };
  }

  mcpPayloadSignature(servers = []) {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(servers))
      .digest("hex");
  }

  resolveMcpForChat(chat, options = {}) {
    const agent = options.agent || this.agentConfig(chat.provider);
    return resolveEffectiveMcp(this.config, this.mcpRegistry.value, {
      provider: chat.provider,
      cwd: chat.cwd,
      capabilities: options.capabilities || chat.agentCapabilities || {},
      env: { ...process.env, ...(agent?.env || {}) },
    });
  }

  publicEffectiveMcpEntries(resolution, options = {}) {
    const diagnostics = new Map(
      (resolution.diagnostics || []).map((entry) => [entry.id, entry]),
    );
    return (resolution.entries || []).filter((entry) => {
      if (!options.applied) return true;
      return diagnostics.get(entry.id)?.ok === true;
    }).map((entry) => {
      const diagnostic = diagnostics.get(entry.id);
      const status = options.applied && diagnostic?.ok
        ? "applied"
        : diagnostic?.status || (entry.enabled ? "configured" : "disabled");
      return publicMcpDefinition(entry, {
        effective: true,
        applied: options.applied === true && diagnostic?.ok,
        status,
        statusDetail: diagnostic?.errors?.join("; ") || diagnostic?.warnings?.join("; ") || "",
      });
    });
  }

  mcpContext(chatId) {
    const chat = this.chats.get(chatId);
    if (chat) return { chat, provider: chat.provider, cwd: chat.cwd, capabilities: chat.agentCapabilities || {} };
    const record = this.registry.get(chatId);
    if (!record) throw new Error(`Unknown chat: ${chatId}`);
    return { chat: null, provider: record.provider, cwd: record.cwd, capabilities: {} };
  }

  mcpList(chatId) {
    const context = this.mcpContext(chatId);
    const all = [
      ...staticMcpDefinitions(this.config),
      ...this.mcpRegistry.list(),
    ];
    const resolution = resolveEffectiveMcp(this.config, this.mcpRegistry.value, {
      provider: context.provider,
      cwd: context.cwd,
      capabilities: context.capabilities,
      env: {
        ...process.env,
        ...(this.config.agents?.[context.provider]?.env || {}),
      },
    });
    const effectiveIds = new Set((resolution.entries || []).map((entry) => entry.id));
    const appliedIds = new Set(context.chat?.mcpAppliedIds || []);
    const diagnostics = new Map(
      (resolution.diagnostics || []).map((entry) => [entry.id, entry]),
    );
    const entries = all.map((server) => {
      const inScope = scopeMatches(server.scope, {
        provider: context.provider,
        cwd: context.cwd,
      });
      const effective = effectiveIds.has(server.id);
      const diagnostic = diagnostics.get(server.id);
      let status = "configured";
      let detail = "";
      if (!server.enabled) status = "disabled";
      else if (!inScope) status = "out-of-scope";
      else if (!effective) status = "overridden";
      else if (context.chat?.mcpApplyRunning) status = "applying";
      else if (context.chat?.mcpApplyPending) status = "pending";
      else if (diagnostic?.ok && appliedIds.has(server.id)) status = "applied";
      else status = diagnostic?.status || "configured";
      detail = diagnostic?.errors?.join("; ") || diagnostic?.warnings?.join("; ") || "";
      return publicMcpDefinition(server, {
        effective,
        applied: status === "applied",
        status,
        statusDetail: detail,
      });
    });
    return {
      schemaVersion: 1,
      provider: context.provider,
      cwd: context.cwd,
      entries,
      effective: this.publicEffectiveMcpEntries(resolution, {
        applied: !context.chat?.mcpApplyPending && !context.chat?.mcpApplyRunning,
      }),
      pending: context.chat?.mcpApplyPending === true,
      applying: context.chat?.mcpApplyRunning === true,
      lastError: context.chat?.mcpLastApplyError || null,
      capabilities: {
        stdio: true,
        http: context.capabilities?.mcpCapabilities?.http === true,
        sse: context.capabilities?.mcpCapabilities?.sse === true,
      },
      registry: this.mcpRegistry.status(),
    };
  }

  markMcpChangesPending() {
    for (const chat of this.chats.values()) {
      if (!chat.sessionId) continue;
      const resolution = this.resolveMcpForChat(chat);
      const nextSignature = this.mcpPayloadSignature(resolution.servers);
      chat.mcpApplyPending = nextSignature !== chat.mcpAppliedSignature;
      chat.mcpLastApplyError = null;
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
    }
  }

  mcpUpsert(chatId, input) {
    const context = this.mcpContext(chatId);
    const scope = input.scope || {};
    const server = this.mcpRegistry.upsert({
      ...input,
      scope: {
        provider:
          scope.provider === true || scope.provider === "current"
            ? context.provider
            : scope.provider || null,
        project:
          scope.project === true || scope.project === "current"
            ? context.cwd
            : scope.project || null,
      },
    });
    this.markMcpChangesPending();
    return {
      ok: true,
      server: publicMcpDefinition(server),
      inventory: this.mcpList(chatId),
    };
  }

  mcpToggle(chatId, id, enabled) {
    const server = this.mcpRegistry.toggle(id, enabled);
    this.markMcpChangesPending();
    return {
      ok: true,
      server: publicMcpDefinition(server),
      inventory: this.mcpList(chatId),
    };
  }

  mcpRemove(chatId, id) {
    const server = this.mcpRegistry.remove(id);
    this.markMcpChangesPending();
    return {
      ok: true,
      server: publicMcpDefinition(server),
      inventory: this.mcpList(chatId),
    };
  }

  mcpTest(chatId, id = null) {
    const context = this.mcpContext(chatId);
    const inventory = this.mcpList(chatId);
    const selected = id
      ? inventory.entries.filter((entry) => entry.id === id)
      : inventory.entries.filter((entry) => entry.effective);
    if (id && !selected.length) throw new Error(`Unknown MCP server: ${id}`);
    const raw = [
      ...staticMcpDefinitions(this.config),
      ...this.mcpRegistry.list(),
    ];
    const results = selected.map((entry) => {
      const server = raw.find((candidate) => candidate.id === entry.id);
      const result = materializeMcpDefinition(server, {
        capabilities: context.capabilities,
        env: {
          ...process.env,
          ...(this.config.agents?.[context.provider]?.env || {}),
        },
      });
      return {
        id: entry.id,
        name: entry.name,
        ok: result.ok,
        status: result.status,
        errors: result.errors || [],
        warnings: result.warnings || [],
        check: "configuration-and-executable",
      };
    });
    return { ok: results.every((entry) => entry.ok), results };
  }

  async stopAdapterForMcpReconnect(chat) {
    const child = chat.process;
    chat.suppressExitEvent = true;
    try {
      chat.peer?.close();
    } catch {}
    try {
      if (child && !child.killed) child.kill("SIGTERM");
    } catch {}
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    chat.peer = null;
    chat.process = null;
    chat.pid = null;
  }

  async applyMcp(chatId) {
    const chat = this.requireChat(chatId);
    if (!chat.sessionId || !chat.peer) throw new Error("ACP session is not ready");
    if (chat.mcpApplyRunning) return { ok: true, applying: true, chat: this.chatSummary(chat) };
    const hasPermission = [...this.pendingPermissions.values()].some(
      (pending) => pending.chatId === chat.id,
    );
    if (chat.turnActive || hasPermission) {
      chat.mcpApplyPending = true;
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
      return { ok: true, pending: true, reason: "active-turn", chat: this.chatSummary(chat) };
    }

    const agent = this.agentConfig(chat.provider);
    const next = this.resolveMcpForChat(chat, { agent });
    const fatalSkipped = next.skipped.filter((entry) => entry.status !== "unsupported");
    if (fatalSkipped.length) {
      chat.mcpLastApplyError = fatalSkipped.map((entry) => `${entry.name}: ${entry.reason}`).join("; ");
      chat.mcpApplyPending = true;
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
      return {
        ok: false,
        pending: true,
        error: chat.mcpLastApplyError,
        inventory: this.mcpList(chatId),
      };
    }
    const nextSignature = this.mcpPayloadSignature(next.servers);
    if (nextSignature === chat.mcpAppliedSignature) {
      chat.mcpApplyPending = false;
      chat.mcpServers = this.publicEffectiveMcpEntries(next, { applied: true });
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
      return { ok: true, changed: false, chat: this.chatSummary(chat) };
    }
    if (!supportsSessionResume(chat) && !supportsSessionLoad(chat)) {
      chat.mcpApplyPending = true;
      chat.mcpLastApplyError =
        "This adapter cannot reload the current ACP session; create a new chat to activate the pending MCP configuration";
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
      return {
        ok: false,
        pending: true,
        requiresNewSession: true,
        error: chat.mcpLastApplyError,
        chat: this.chatSummary(chat),
        inventory: this.mcpList(chatId),
      };
    }

    const previous = {
      servers: chat.mcpPayload || [],
      publicEntries: (chat.mcpServers || []).map((entry) => ({ ...entry })),
      entries: (chat.mcpServers || []).map((entry) =>
        normalizeMcpDefinition(entry, { source: entry.source || "managed", touch: false }),
      ),
      skipped: [],
      diagnostics: (chat.mcpServers || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        ok: true,
        status: "ready",
        errors: [],
        warnings: entry.warnings || [],
      })),
    };
    const sessionId = chat.sessionId;
    chat.mcpApplyRunning = true;
    chat.mcpApplyPending = true;
    chat.mcpLastApplyError = null;
    this.setStatus(chat, "starting", "Applying MCP configuration");

    try {
      await this.stopAdapterForMcpReconnect(chat);
      await this.startAcpAgent(chat, agent, {
        lifecycle: "restore",
        sessionId,
        additionalDirectories: chat.additionalDirectories || [],
        mcpResolution: next,
      });
      chat.mcpApplyRunning = false;
      chat.mcpApplyPending = false;
      chat.mcpLastApplyError = null;
      this.addEvent(chat, {
        type: "system",
        level: "success",
        text: `MCP configuration applied (${next.servers.length} server${next.servers.length === 1 ? "" : "s"})`,
      });
      this.rememberChat(chat, { makeCurrent: true });
      return { ok: true, changed: true, chat: this.chatSummary(chat), inventory: this.mcpList(chatId) };
    } catch (error) {
      chat.mcpLastApplyError = error.message || String(error);
      let rollbackRestored = false;
      try {
        await this.stopAdapterForMcpReconnect(chat);
        await this.startAcpAgent(chat, agent, {
          lifecycle: "restore",
          sessionId,
          additionalDirectories: chat.additionalDirectories || [],
          mcpResolution: previous,
        });
        chat.mcpPayload = previous.servers;
        chat.mcpServers = previous.publicEntries;
        chat.mcpAppliedIds = previous.publicEntries.map((entry) => entry.id);
        chat.mcpAppliedSignature = this.mcpPayloadSignature(previous.servers);
        rollbackRestored = true;
      } catch (rollbackError) {
        chat.mcpLastApplyError += `; rollback failed: ${rollbackError.message || rollbackError}`;
      }
      chat.mcpApplyRunning = false;
      chat.mcpApplyPending = true;
      this.addEvent(chat, {
        type: "system",
        level: "error",
        text: rollbackRestored
          ? `MCP apply failed; previous session configuration restored: ${chat.mcpLastApplyError}`
          : `MCP apply failed and the previous session could not be restored: ${chat.mcpLastApplyError}`,
      });
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
      return {
        ok: false,
        pending: true,
        rollbackRestored,
        error: chat.mcpLastApplyError,
        chat: this.chatSummary(chat),
        inventory: this.mcpList(chatId),
      };
    }
  }

  setRoots(chatId, additionalDirectories) {
    const roots = normalizeAdditionalDirectories(additionalDirectories, this.requireKnownChatCwd(chatId));
    const chat = this.chats.get(chatId);

    if (chat) {
      chat.additionalDirectories = roots;
      chat.updatedAt = nowIso();
      this.rememberChat(chat, { makeCurrent: true });
      this.broadcast(chat, {
        type: "chat_state",
        chat: this.chatSummary(chat),
      });
      return {
        ok: true,
        requiresRestart: Boolean(chat.peer && chat.sessionId),
        chat: this.chatSummary(chat),
      };
    }

    const record = this.registry.get(chatId);
    if (!record) throw new Error(`Unknown chat: ${chatId}`);
    record.additionalDirectories = roots;
    record.updatedAt = nowIso();
    this.registry.set(record.id, record);
    this.saveRegistry();
    return {
      ok: true,
      requiresRestart: false,
      chat: this.recordSummary(record),
    };
  }

  requireKnownChatCwd(chatId) {
    const chat = this.chats.get(chatId);
    if (chat) return chat.cwd;
    const record = this.registry.get(chatId);
    if (record) return record.cwd;
    throw new Error(`Unknown chat: ${chatId}`);
  }

  cancel(chatId) {
    const chat = this.requireChat(chatId);
    if (!chat.peer || !chat.sessionId) throw new Error("ACP session is not ready");

    const cancelledPermissions = this.cancelPendingPermissionsForChat(chat, "Cancel requested");
    const droppedPromptIds = chat.promptQueue
      .map((item) => item.clientPromptId)
      .filter(Boolean);
    const droppedCommandIds = chat.promptQueue
      .map((item) => item.clientCommandId)
      .filter(Boolean);
    const droppedQueue = chat.promptQueue.length;
    chat.promptQueue = [];
    chat.peer.notify("session/cancel", { sessionId: chat.sessionId });
    // Live feedback rides the status ("cancelling" in the composer) and the
    // UI's own notify; no transcript event here — the turn's closing
    // "[done] cancelled" is the single durable marker, instead of stacking
    // "Cancel requested" + "[done] cancelled" for every cancel.
    this.setStatus(chat, "cancelling", "Cancel requested");
    if (droppedQueue) {
      this.addEvent(chat, {
        type: "queue_dropped",
        clientRequestIds: [...droppedPromptIds, ...droppedCommandIds],
        clientPromptIds: droppedPromptIds,
        clientCommandIds: droppedCommandIds,
        reason: "cancelled",
      });
    }
    return {
      ok: true,
      cancelledPermissions,
      droppedQueue,
      droppedPromptIds,
      droppedCommandIds,
    };
  }

  permissionResponse(params) {
    const pending = this.pendingPermissions.get(params.permissionId);
    if (!pending) throw new Error("Permission request is no longer pending");

    const option = params.optionId
      ? pending.options.find((candidate) => permissionOptionId(candidate) === String(params.optionId))
      : null;
    if (params.optionId && !option) {
      // Never forward authority that the adapter did not explicitly offer.
      throw new Error(`Unknown permission option: ${params.optionId}`);
    }

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(params.permissionId);

    const chat = this.requireChat(pending.chatId);
    this.recordPermissionDecision(chat, pending, {
      outcome: option ? "selected" : "cancelled",
      option,
      source: "user",
    });

    if (option) {
      pending.resolve({
        outcome: {
          outcome: "selected",
          optionId: permissionOptionId(option),
        },
      });
    } else {
      pending.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
    }

    return { ok: true, chat: this.chatSummary(chat) };
  }

  recordPermissionDecision(chat, pending, { outcome, option = null, source = "system", reason = "" }) {
    const state = chat.permissionState || emptyPermissionState();
    const optionKind = option?.kind || null;
    const decision = {
      permissionId: pending.permissionId,
      outcome,
      optionId: option ? permissionOptionId(option) : null,
      optionName: option?.name || null,
      optionKind,
      scope: outcome === "selected" ? permissionDecisionScope(optionKind) : "cancelled",
      source,
      reason: cleanInline(reason) || null,
      decidedAt: nowIso(),
      ...permissionToolSummary(pending.toolCall || {}),
    };

    state.pending = null;
    state.lastDecision = decision;
    if (decision.scope === "once") state.activeOnce = decision;
    if (decision.scope === "session") {
      state.sessionGrants = [...(state.sessionGrants || []), decision].slice(-8);
    }
    chat.permissionState = state;

    if (chat.status === "permission") {
      const granted = decision.scope === "once" || decision.scope === "session";
      this.setStatus(
        chat,
        chat.turnActive ? "working" : "idle",
        granted ? "Permission granted" : "Permission declined",
        { quiet: true },
      );
    }

    this.addEvent(chat, {
      type: "permission_decision",
      ...decision,
    });
    return decision;
  }

  closeChat(chatId) {
    const chat = this.requireChat(chatId);
    chat.status = "closed";
    chat.updatedAt = nowIso();
    chat.turnActive = false;
    chat.activeRequest = null;
    chat.lastStopReason = "closed";
    chat.plan = settlePlanState(chat.plan, "interrupted");
    chat.promptQueue = [];
    this.cancelPendingPermissionsForChat(chat, "Chat closed");

    if (chat.peer && chat.sessionId && supportsSessionClose(chat)) {
      try {
        chat.peer.call("session/close", { sessionId: chat.sessionId }, { timeoutMs: 1000 }).catch(
          () => {},
        );
      } catch {
        // Closing is best effort.
      }
    }

    if (chat.process) {
      chat.process.kill("SIGTERM");
    }

    this.addEvent(chat, { type: "system", level: "info", text: "Chat closed" });
    this.rememberChat(chat);
    this.chats.delete(chat.id);
    this.persistState();
    return { ok: true };
  }

  async deleteChat(chatId) {
    const chat = this.chats.get(chatId);
    const record = this.registry.get(chatId);
    if (!chat && !record) throw new Error(`Unknown chat: ${chatId}`);

    const provider = chat?.provider || record?.provider;
    const cwd = chat?.cwd || record?.cwd;
    const sessionId = chat?.sessionId || record?.sessionId;

    let providerSupported = false;
    let providerDeleted = false;

    // Provider-side deletion is best effort: an adapter that fails to spawn
    // or lacks session/delete must never block the local removal (this used
    // to throw before the registry delete, so the chat "would not die").
    try {
      if (sessionId && provider) {
        if (chat?.peer && chat.sessionId) {
          // Active chat: delete through its live adapter when advertised.
          if (supportsSessionDelete(chat.agentCapabilities)) {
            providerSupported = true;
            await chat.peer.call("session/delete", { sessionId: chat.sessionId }, { timeoutMs: 30000 });
            providerDeleted = true;
          }
          this.sessionDeleteSupport.set(provider, supportsSessionDelete(chat.agentCapabilities));
        } else if (this.sessionDeleteSupport.get(provider) !== false) {
          // Saved chat with no live adapter: probe with a temporary adapter,
          // remembering the capability so bulk deletes probe at most once.
          const agent = this.agentConfig(provider);
          const temp = this.spawnAcpProcess(agent, cwd, () => {});
          try {
            const init = await this.initializePeer(temp.peer);
            const supported = supportsSessionDelete(init.agentCapabilities);
            this.sessionDeleteSupport.set(provider, supported);
            if (supported) {
              providerSupported = true;
              await temp.peer.call("session/delete", { sessionId }, { timeoutMs: 30000 });
              providerDeleted = true;
            }
          } finally {
            temp.peer.close();
            temp.child.kill("SIGTERM");
          }
        }
      }
    } catch {
      // Fall through to local removal; the tombstone keeps it deleted.
    }

    if (sessionId && provider && !providerDeleted) {
      this.tombstoneSession(provider, sessionId);
    }

    // Stop the live adapter and forget the chat locally.
    if (chat) {
      chat.status = "closed";
      chat.turnActive = false;
      chat.promptQueue = [];
      chat.suppressExitEvent = true;
      this.cancelPendingPermissionsForChat(chat, "Chat deleted");
      if (chat.process) chat.process.kill("SIGTERM");
      this.addEvent(chat, { type: "system", level: "info", text: "Chat deleted" });
      this.chats.delete(chat.id);
    }

    this.registry.delete(chatId);
    for (const [key, id] of this.currentByProject) {
      if (id === chatId) this.currentByProject.delete(key);
    }
    this.saveRegistry();
    this.persistState();
    this.killTmuxWindowForChat(chatId);

    return { ok: true, providerSupported, providerDeleted };
  }

  // Transcript tail for the picker preview pane. Works for live chats (in-
  // memory history) and saved ones (registry history) alike.
  chatPreview(chatId) {
    const chat = this.chats.get(chatId);
    const record = this.registry.get(chatId);
    if (!chat && !record) throw new Error(`Unknown chat: ${chatId}`);

    const events = chat?.history || record?.history || [];
    return {
      chatId,
      title: cleanInline(chat?.title || record?.title || ""),
      provider: chat?.provider || record?.provider,
      active: Boolean(chat),
      status: chat ? chat.status : "saved",
      updatedAt: chat?.updatedAt || record?.updatedAt || null,
      events: events.slice(-160),
    };
  }

  // The files edited in a chat, each with its latest diff, most-recently-edited
  // first — powers the /changes picker. Works for a live chat or a saved record.
  chatChanges(chatId) {
    const chat = this.chats.get(chatId);
    const record = this.registry.get(chatId);
    if (!chat && !record) throw new Error(`Unknown chat: ${chatId}`);

    const events = chat?.history || record?.history || [];
    const byPath = new Map();
    for (const event of events) {
      if (!Array.isArray(event.diffs)) continue;
      for (const diff of event.diffs) {
        if (!diff?.path) continue;
        // Re-insert so a re-edited file moves to the most-recent position.
        byPath.delete(diff.path);
        byPath.set(diff.path, { ...diff, at: event.at });
      }
    }
    return { chatId, files: [...byPath.values()].reverse() };
  }

  // The chat is gone, so its view goes too — for whichever pane triggered the
  // delete, including the current one. Windows are disposable views over
  // daemon-held chats, so killing one never loses data; leaving the requester's
  // own window behind (the old keepPane path) turned it into a stale "menu" tab
  // with the deleted chat's UI still running.
  killTmuxWindowForChat(chatId) {
    if (!process.env.TMUX || !chatId) return;
    findTmuxWindowForChat(chatId)
      .then((windowId) => {
        if (!windowId) return;
        const child = spawn("tmux", ["kill-window", "-t", windowId], { stdio: "ignore" });
        child.on("error", () => {});
      })
      .catch(() => {});
  }

  renameChat(chatId, title) {
    const cleanTitle = sanitizeChatTitle(title);
    if (!cleanTitle) throw new Error("Title is empty");

    const chat = this.chats.get(chatId);
    if (chat) {
      this.applyTitle(chat, cleanTitle, "manual");
      chat.updatedAt = nowIso();
      this.rememberChat(chat, { makeCurrent: true });
      this.persistState();
      this.broadcast(chat, {
        type: "chat_state",
        chat: this.chatSummary(chat),
      });
      return this.chatSummary(chat);
    }

    const record = this.registry.get(chatId);
    if (!record) throw new Error(`Unknown chat: ${chatId}`);

    const next = applyChatTitleCandidate(record, { title: cleanTitle, source: "manual" }, this.titleSettings.policy);
    record.title = next.title;
    record.titleSource = next.titleSource;
    record.fallbackTitle = next.fallbackTitle;
    record.defaultTitle = next.defaultTitle;
    record.updatedAt = nowIso();
    this.registry.set(record.id, record);
    this.currentByProject.set(projectKey(record.provider, record.cwd), record.id);
    this.saveRegistry();
    return this.recordSummary(record);
  }

  cancelPendingPermissionsForChat(chat, reason) {
    let count = 0;

    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.chatId !== chat.id) continue;

      clearTimeout(pending.timer);
      this.pendingPermissions.delete(permissionId);
      this.recordPermissionDecision(chat, pending, {
        outcome: "cancelled",
        source: "system",
        reason,
      });
      pending.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
      count += 1;
    }

    if (count > 0) {
      this.addEvent(chat, {
        type: "system",
        level: "warn",
        text: `${reason}; cancelled ${count} pending permission request(s)`,
      });
    }

    return count;
  }

  async loadRegistry() {
    const registry = await readJsonIfExists(REGISTRY_PATH);
    if (!registry) return;

    for (const raw of registry.tombstones || []) {
      if (raw?.provider && raw?.sessionId) {
        this.sessionTombstones.add(this.tombstoneKey(raw.provider, raw.sessionId));
      }
    }

    for (const raw of registry.chats || []) {
      const record = this.normalizeRecord(raw);
      if (record && !this.isSessionTombstoned(record.provider, record.sessionId)) {
        // A daemon restart cannot resume an in-flight session/prompt request.
        // Retain its last plan for inspection, but never present it as live.
        if (record.plan?.lifecycle === "active") {
          record.plan = settlePlanState(record.plan, "interrupted", record.updatedAt);
        }
        this.registry.set(record.id, record);
      }
    }

    for (const current of registry.current || []) {
      if (!current.provider || !current.cwd || !current.chatId) continue;
      if (!this.registry.has(current.chatId)) continue;
      this.currentByProject.set(projectKey(current.provider, current.cwd), current.chatId);
    }
  }

  normalizeRecord(raw) {
    if (!raw || !raw.provider || !raw.cwd) return null;
    const cwd = path.resolve(raw.cwd);
    const sessionId = raw.sessionId || null;
    const id = raw.id || chatIdFor(raw.provider, cwd, sessionId, raw.updatedAt || raw.title || cwd);
    const providerLabel = raw.providerLabel || this.config.agents?.[raw.provider]?.label || raw.provider;
    const resolvedTitle =
      raw.title ||
      (raw.source === "agent-list"
        ? savedSessionTitle(providerLabel, cwd)
        : defaultChatTitle(providerLabel, cwd));
    const titleState = inferLegacyTitleState(raw, resolvedTitle);
    const history = retainHistoryByTurns(raw.history || [], this.historyLimit);
    const turnSequence = Math.max(0, Number.parseInt(raw.turnSequence, 10) || 0);
    const plan = Object.hasOwn(raw, "plan")
      ? normalizePlanState(raw.plan)
      : latestPlanFromHistory(history, { turnSequence });

    return {
      id,
      provider: raw.provider,
      providerLabel,
      cwd,
      projectName: raw.projectName || projectName(cwd),
      ...titleState,
      status: "saved",
      statusDetail: raw.statusDetail || "Saved ACP session",
      mode: raw.mode || null,
      pid: null,
      sessionId,
      startedAt: raw.startedAt || raw.createdAt || raw.updatedAt || nowIso(),
      updatedAt: raw.updatedAt || nowIso(),
      additionalDirectories: raw.additionalDirectories || [],
      configValues: sanitizeConfigValues(raw.configValues || {}),
      model: raw.model || raw.configValues?.model || null,
      effort: raw.effort || raw.configValues?.effort || raw.configValues?.reasoning || null,
      source: raw.source || "local",
      usage: raw.usage || null,
      availableCommands: normalizeProviderCommands(raw.availableCommands || []),
      turnSequence,
      lastStopReason: raw.lastStopReason || null,
      plan,
      planSupported:
        raw.planSupported === true ||
        Boolean(plan?.entries?.length) ||
        history.some((event) => event?.type === "plan"),
      // Transcript events survive daemon restarts; without this a restart
      // "lost" every conversation even though the session itself restored.
      history,
    };
  }

  rememberChat(chat, options = {}) {
    if (!chat.sessionId) return null;

    const record = this.normalizeRecord({
      id: chat.id,
      provider: chat.provider,
      providerLabel: chat.providerLabel,
      cwd: chat.cwd,
      projectName: chat.projectName,
      title: chat.title,
      titleSource: chat.titleSource,
      fallbackTitle: chat.fallbackTitle,
      defaultTitle: chat.defaultTitle,
      statusDetail: "Saved ACP session",
      mode: chat.mode,
      sessionId: chat.sessionId,
      startedAt: chat.startedAt,
      updatedAt: chat.updatedAt || nowIso(),
      additionalDirectories: chat.additionalDirectories || [],
      configValues: selectedConfigValues(chat),
      model: chatModel(chat),
      effort: chatEffort(chat),
      source: options.source || "local",
      usage: chat.usage || null,
      availableCommands: chat.availableCommands || [],
      turnSequence: chat.turnSequence || 0,
      lastStopReason: chat.lastStopReason || null,
      plan: chat.plan || null,
      planSupported: chat.planSupported === true,
      history: retainHistoryByTurns(chat.history || [], this.historyLimit),
    });

    this.registry.set(record.id, record);
    if (options.makeCurrent === true) {
      this.currentByProject.set(projectKey(record.provider, record.cwd), record.id);
    }

    this.saveRegistry();
    return record;
  }

  projectConfigValues(provider, cwd) {
    const resolvedCwd = path.resolve(cwd);
    const candidates = [];

    for (const chat of this.chats.values()) {
      if (chat.provider !== provider || chat.cwd !== resolvedCwd) continue;
      const values = selectedConfigValues(chat);
      if (Object.keys(values).length) {
        candidates.push({ updatedAt: chat.updatedAt || "", values });
      }
    }

    for (const record of this.registry.values()) {
      if (record.provider !== provider || record.cwd !== resolvedCwd) continue;
      const values = sanitizeConfigValues(record.configValues || {});
      if (Object.keys(values).length) {
        candidates.push({ updatedAt: record.updatedAt || "", values });
      }
    }

    candidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return candidates[0]?.values || {};
  }

  markCurrentChat(chat) {
    if (!chat?.provider || !chat.cwd) return;

    chat.updatedAt = nowIso();
    this.currentByProject.set(projectKey(chat.provider, chat.cwd), chat.id);
    if (chat.sessionId) {
      this.rememberChat(chat, { makeCurrent: true });
    } else {
      this.saveRegistry();
    }
  }

  rememberSessionInfo(provider, session, fallbackCwd, options = {}) {
    if (!session || !session.sessionId) return null;
    // Locally deleted sessions stay deleted even when the provider still
    // lists them (no session/delete support on the adapter).
    if (this.isSessionTombstoned(provider, session.sessionId)) return null;

    const agent = this.agentConfig(provider);
    const cwd = path.resolve(session.cwd || fallbackCwd || process.cwd());
    const id = chatIdFor(provider, cwd, session.sessionId);
    const existing = this.registry.get(id);
    const initialTitleState = inferLegacyTitleState(
      existing || {
        title: savedSessionTitle(agent.label || provider, cwd),
        titleSource: "default",
        source: options.source || "agent-list",
      },
    );
    const titleState = session.title !== undefined && session.title !== null
      ? applyChatTitleCandidate(
          initialTitleState,
          { title: session.title, source: "agent" },
          this.titleSettings.policy,
        )
      : initialTitleState;
    const record = this.normalizeRecord({
      id,
      provider,
      providerLabel: agent.label || provider,
      cwd,
      ...titleState,
      sessionId: session.sessionId,
      mode: session.modes?.currentModeId || session.mode || null,
      configValues: session.configOptions
        ? selectedConfigValues({ configOptions: session.configOptions, mode: session.modes?.currentModeId || session.mode })
        : sanitizeConfigValues(session.configValues || {}),
      updatedAt: session.updatedAt || nowIso(),
      additionalDirectories: session.additionalDirectories || [],
      source: options.source || "agent-list",
      // A provider-side listing knows nothing about our transcript; keep it.
      history: existing?.history || [],
      turnSequence: existing?.turnSequence || 0,
      lastStopReason: existing?.lastStopReason || null,
      plan: existing?.plan || null,
      planSupported: existing?.planSupported === true,
    });

    this.registry.set(record.id, record);
    if (options.makeCurrent === true) {
      this.currentByProject.set(projectKey(record.provider, record.cwd), record.id);
    }
    this.saveRegistry();
    return record;
  }

  saveRegistry() {
    if (this.registryTimer) return;

    this.registryTimer = setTimeout(() => {
      this.registryTimer = null;
      this.writeRegistryNow();
    }, 100);
  }

  writeRegistryNow() {
    const current = [...this.currentByProject.entries()].map(([key, chatId]) => {
      const [provider, cwd] = key.split("\0");
      return { provider, cwd, chatId };
    });

    const data = {
      version: 3,
      updatedAt: nowIso(),
      current,
      tombstones: [...this.sessionTombstones].slice(-500).map((key) => {
        const [provider, sessionId] = key.split("\0");
        return { provider, sessionId };
      }),
      chats: [...this.registry.values()].sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
      ),
    };

    try {
      writeJsonFileSync(REGISTRY_PATH, data);
    } catch {
      // Registry persistence is best effort.
    }
  }

  rekeyChat(chat, newId) {
    if (!newId || chat.id === newId) return;

    const oldId = chat.id;
    this.chats.delete(oldId);
    this.registry.delete(oldId);
    chat.id = newId;
    this.chats.set(chat.id, chat);

    // Move any client subscriptions to the new id so live events keep flowing
    // to whoever was watching the chat before it was rekeyed.
    for (const client of this.clients) {
      if (client.subscriptions.delete(oldId)) client.subscriptions.add(newId);
    }
  }

  async refreshSessions(provider, rawCwd, includeAllProviders = false) {
    const cwd = rawCwd ? resolveProjectRoot(rawCwd) : process.cwd();
    const providers = provider
      ? [provider]
      : includeAllProviders
        ? Object.keys(this.config.agents || {})
        : [this.config.defaultAgent || "codex"];

    const results = [];
    for (const providerId of providers) {
      // One broken/unauthenticated adapter must not sink the whole refresh:
      // report it as failed and keep importing the others.
      try {
        results.push(await this.refreshProviderSessions(providerId, cwd));
      } catch (error) {
        results.push({
          provider: providerId,
          supported: false,
          sessionCount: 0,
          sessions: [],
          error: error.message || String(error),
        });
      }
    }

    return {
      providers: results,
      chats: this.chatSummaries({ cwd, limit: 80 }),
    };
  }

  async refreshProviderSessions(provider, cwd) {
    const agent = this.agentConfig(provider);
    const temp = this.spawnAcpProcess(agent, cwd, () => {});

    try {
      const init = await this.initializePeer(temp.peer);
      const capabilities = init.agentCapabilities || {};

      if (!supportsSessionListCapabilities(capabilities)) {
        return { provider, supported: false, sessionCount: 0, sessions: [] };
      }

      const sessions = [];
      let cursor = null;

      do {
        const params = { cwd };
        if (cursor) params.cursor = cursor;
        const response = await temp.peer.call("session/list", params, { timeoutMs: 60000 });
        const items = response.sessions || response.items || [];
        for (const session of items) {
          const record = this.rememberSessionInfo(provider, session, cwd, { source: "agent-list" });
          if (record) sessions.push(record);
        }
        cursor = response.nextCursor || null;
      } while (cursor);

      return {
        provider,
        supported: true,
        sessionCount: sessions.length,
        sessions: sessions.slice(0, 50),
      };
    } finally {
      temp.peer.close();
      temp.child.kill("SIGTERM");
    }
  }

  requireChat(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    return chat;
  }

  handleSessionUpdate(chat, params) {
    const update = params.update || params;
    const type = update.sessionUpdate;

    switch (type) {
      case "agent_message_chunk":
        this.setStatus(chat, "responding", "Streaming response", { quiet: true });
        this.addEvent(chat, {
          type: "agent_chunk",
          text: contentText(update.content),
          messageId: update.messageId || null,
          messageRole: agentMessageRoleFromUpdate(update),
        });
        break;
      case "agent_thought_chunk":
        this.setStatus(chat, "thinking", "Streaming reasoning", { quiet: true });
        this.addEvent(chat, {
          type: "thought_chunk",
          text: contentText(update.content),
          messageId: update.messageId || null,
        });
        break;
      case "tool_call":
        chat.toolCalls.set(update.toolCallId, update);
        this.setStatus(chat, "working", update.title || update.kind || "Tool call");
        this.addEvent(chat, {
          type: "tool_call",
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status || "pending",
          summary: toolContentText(update.content),
          diffs: toolContentDiffs(update.content),
        });
        break;
      case "tool_call_update": {
        const previous = chat.toolCalls.get(update.toolCallId) || {};
        const merged = { ...previous, ...update };
        chat.toolCalls.set(update.toolCallId, merged);
        if (
          completedToolStatus(update.status || merged.status) &&
          chat.permissionState?.activeOnce?.toolCallId === update.toolCallId
        ) {
          chat.permissionState.activeOnce = null;
        }
        this.setStatus(chat, "working", merged.title || merged.kind || "Tool update");
        this.addEvent(chat, {
          type: "tool_update",
          toolCallId: update.toolCallId,
          title: merged.title,
          kind: merged.kind,
          status: update.status || merged.status,
          summary: toolContentText(update.content),
          diffs: toolContentDiffs(update.content),
        });
        break;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        chat.planSupported = true;
        if (chat.activeRequest?.affectsPlan === false) {
          this.addEvent(chat, {
            type: "system",
            level: "info",
            text: `Ignored an out-of-scope plan update while running /${chat.activeRequest.descriptor?.command || "command"}`,
          });
          break;
        }
        chat.plan = updatePlanState(chat.plan, entries, {
          turnSequence: chat.turnSequence || 0,
          updatedAt: nowIso(),
        });
        this.setStatus(chat, "planning", "Plan updated");
        this.addEvent(chat, {
          type: "plan",
          entries,
        });
        // Unlike transcript writes, the canonical plan is not derivable from a
        // partial registry record after a crash. Persist the replacement now.
        this.rememberChat(chat);
        break;
      }
      case "available_commands_update":
        chat.availableCommands = normalizeProviderCommands(update.availableCommands || []);
        this.rememberChat(chat);
        this.addEvent(chat, {
          type: "system",
          level: "info",
          text: `Commands available: ${chat.availableCommands.length}`,
        });
        break;
      case "current_mode_update":
        if (update.modes) chat.modes = update.modes;
        {
          const legacyMode = update.modeId || update.currentModeId || null;
          if (legacyMode && chat.modes && !update.modes) {
            chat.modes = { ...chat.modes, currentModeId: legacyMode };
          }
          // A modern mode config remains authoritative when both transition
          // surfaces are present, as required by ACP.
          if (!chatModeConfigOption(chat)) chat.mode = legacyMode;
          else syncChatModeFromConfig(chat);
        }
        chat.configValues = selectedConfigValues(chat, {
          ...chat.configValues,
          mode: chat.mode,
        });
        this.rememberChat(chat);
        this.addEvent(chat, {
          type: "system",
          level: "info",
          text: `Mode: ${chat.mode}`,
        });
        break;
      case "config_option_update":
        chat.configOptions = update.configOptions || [];
        syncChatModeFromConfig(chat);
        chat.configValues = selectedConfigValues(chat, chat.configValues);
        this.rememberChat(chat);
        this.addEvent(chat, {
          type: "system",
          level: "info",
          text: "Session config updated",
        });
        break;
      case "session_info_update":
        if (update.title !== undefined && chat.activeRequest?.kind !== "command") {
          this.applyTitle(chat, update.title, "agent");
        }
        chat.updatedAt = update.updatedAt || nowIso();
        this.rememberChat(chat);
        this.persistState();
        this.broadcast(chat, {
          type: "chat_state",
          chat: this.chatSummary(chat),
        });
        break;
      case "usage_update":
        chat.usage = {
          used: typeof update.used === "number" ? update.used : null,
          size: typeof update.size === "number" ? update.size : null,
          cost: update.cost || null,
        };
        chat.updatedAt = nowIso();
        this.rememberChat(chat);
        this.persistState();
        this.broadcast(chat, {
          type: "chat_state",
          chat: this.chatSummary(chat),
        });
        break;
      default:
        this.addEvent(chat, {
          type: "raw_update",
          update,
        });
    }
  }

  async handlePermissionRequest(chat, params) {
    const permissionId = `perm-${shortHash(`${Date.now()}-${Math.random()}`)}`;
    const options = params.options || [];
    const requestedAt = nowIso();
    const pendingSummary = {
      permissionId,
      requestedAt,
      options,
      ...permissionToolSummary(params.toolCall || {}),
    };

    chat.permissionState = chat.permissionState || emptyPermissionState();
    chat.permissionState.pending = pendingSummary;

    this.setStatus(chat, "permission", params.toolCall?.title || "Permission required");
    this.addEvent(chat, {
      type: "permission",
      permissionId,
      toolCall: params.toolCall || {},
      options,
    });

    // A malformed request with no choices must never leave an agent blocked
    // for five minutes or manufacture an authority the adapter did not offer.
    if (!options.length) {
      const pending = {
        permissionId,
        chatId: chat.id,
        options,
        toolCall: params.toolCall || null,
        requestedAt,
      };
      this.recordPermissionDecision(chat, pending, {
        outcome: "cancelled",
        source: "system",
        reason: "Adapter supplied no permission options",
      });
      return { outcome: { outcome: "cancelled" } };
    }

    const policy = this.permissionSettings.policy;
    if (policy === "deny") {
      const rejected =
        options.find((option) => String(option?.kind || "").startsWith("reject")) || null;
      const pending = {
        permissionId,
        chatId: chat.id,
        options,
        toolCall: params.toolCall || null,
        requestedAt,
      };
      this.recordPermissionDecision(chat, pending, {
        outcome: rejected ? "selected" : "cancelled",
        option: rejected,
        source: "policy",
        reason: "Hub permission policy is deny",
      });
      return rejected
        ? { outcome: { outcome: "selected", optionId: permissionOptionId(rejected) } }
        : { outcome: { outcome: "cancelled" } };
    }

    return new Promise((resolve) => {
      const pending = {
        permissionId,
        chatId: chat.id,
        options,
        toolCall: params.toolCall || null,
        requestedAt,
        resolve,
        timer: null,
      };
      pending.timer = setTimeout(() => {
        if (this.pendingPermissions.get(permissionId) !== pending) return;
        this.pendingPermissions.delete(permissionId);
        this.recordPermissionDecision(chat, pending, {
          outcome: "cancelled",
          source: "timeout",
          reason: "Permission request timed out",
        });
        resolve({
          outcome: {
            outcome: "cancelled",
          },
        });
      }, PERMISSION_TIMEOUT_MS);

      this.pendingPermissions.set(permissionId, pending);

      // Deliver to any subscribed client. If none is connected (popup closed),
      // the request stays pending until a reopened popup answers it or it times
      // out; the chat status shows "permission" so tmux badges flag it.
      for (const client of this.clients) {
        if (!client.subscriptions.has(chat.id)) continue;
        client.conn.send({
          type: "event",
          event: "permission_request",
          chatId: chat.id,
          permissionId,
          params,
        });
      }
    });
  }

  setStatus(chat, status, detail, options = {}) {
    let planSettled = false;
    if (
      status === "error" &&
      chat.plan?.lifecycle === "active" &&
      chat.activeRequest?.affectsPlan !== false
    ) {
      chat.plan = settlePlanState(chat.plan, "error");
      planSettled = true;
    }
    chat.status = status;
    chat.statusDetail = detail || "";
    chat.updatedAt = nowIso();
    this.persistState();
    this.scheduleTmuxSync(chat);

    if (!options.quiet) {
      this.broadcast(chat, {
        type: "chat_state",
        chat: this.chatSummary(chat),
      });
    }
    if (planSettled && chat.sessionId) this.rememberChat(chat);
  }

  addEvent(chat, event) {
    const inheritTurn =
      !event.turnSequence &&
      TURN_SCOPED_EVENT_TYPES.has(event.type) &&
      (chat.turnActive || chat.turnStartedAt || event.type === "user");
    const enriched = {
      ...event,
      ...(inheritTurn ? { turnSequence: chat.turnSequence || 0 } : {}),
      at: nowIso(),
    };

    if (canMergeHistoryChunk(chat.history.at(-1), enriched)) {
      const previous = chat.history.at(-1);
      previous.text = `${previous.text || ""}${enriched.text || ""}`;
      previous.at = enriched.at;
    } else {
      chat.history.push(enriched);
    }

    chat.history = retainHistoryByTurns(chat.history, this.historyLimit);
    chat.updatedAt = enriched.at;

    // Keep the persisted transcript current (registry writes are debounced).
    const record = this.registry.get(chat.id);
    if (record) {
      record.history = retainHistoryByTurns(chat.history, this.historyLimit);
      record.updatedAt = enriched.at;
      this.saveRegistry();
    }

    this.persistState();
    this.broadcast(chat, {
      type: "chat_event",
      chatId: chat.id,
      event: enriched,
      chat: this.chatSummary(chat),
    });
  }

  broadcast(chat, event) {
    this.scheduleTmuxSync(chat);
    for (const client of this.clients) {
      // Watchers (e.g. the interactive menu) get every chat's events so their
      // list stays live without subscribing to each chat.
      if (!client.watchAll && !client.subscriptions.has(chat.id)) continue;
      client.conn.send({ type: "event", ...event });
    }
  }

  // The daemon owns ongoing tmux window metadata: it sees every chat change
  // whether or not a popup is attached, so status glyphs in the status bar and
  // the prefix+s switcher no longer freeze when the popup closes mid-turn.
  // Trailing-edge throttle per chat; the window is found by @acp_hub_chat_id
  // (seeded by the popup when the chat is first opened).
  scheduleTmuxSync(chat) {
    if (!process.env.TMUX || !chat?.id) return;
    if (this.tmuxSyncTimers.has(chat.id)) return;

    const timer = setTimeout(() => {
      this.tmuxSyncTimers.delete(chat.id);
      this.syncTmuxWindowForChat(chat.id).catch(() => {});
    }, 500);
    timer.unref?.();
    this.tmuxSyncTimers.set(chat.id, timer);
  }

  async syncTmuxWindowForChat(chatId) {
    const windowId = await findTmuxWindowForChat(chatId);
    if (!windowId) return;

    const chat = this.chats.get(chatId);
    const summary = chat ? this.chatSummary(chat) : this.registryRecordSummary(chatId);
    if (!summary) return;

    setTmuxWindowOptions(tmuxWindowOptionValues(summary), windowId);
    // Heal the session's window-status-format if the boot race reverted it, so
    // the tab keeps showing the chat title rather than the raw window name.
    applyAcpStatusFormat(windowId);
  }

  registryRecordSummary(chatId) {
    const record = this.registry.get(chatId);
    return record ? this.recordSummary(record) : null;
  }

  chatSummaries(filters = {}) {
    const summaries = new Map();

    for (const record of this.registry.values()) {
      summaries.set(record.id, this.recordSummary(record));
    }

    for (const chat of this.chats.values()) {
      summaries.set(chat.id, this.chatSummary(chat));
    }

    let result = [...summaries.values()];

    if (filters.provider) {
      result = result.filter((chat) => chat.provider === filters.provider);
    }

    if (filters.cwd) {
      const cwd = resolveProjectRoot(filters.cwd);
      result = result.filter((chat) => chat.cwd === cwd);
    }

    if (filters.sessionId) {
      result = result.filter((chat) => chat.sessionId === filters.sessionId);
    }

    if (filters.query) {
      const query = String(filters.query).toLowerCase();
      result = result.filter((chat) =>
        [
          chat.provider,
          chat.providerLabel,
          chat.projectName,
          chat.title,
          chat.cwd,
          chat.sessionId,
          chat.status,
          chat.source,
          chat.model,
          chat.effort,
          chatConfigLabel(chat),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }

    // Ordering belongs before pagination. In particular, an oldest-first
    // request must not reverse an already-truncated page of recent chats.
    result = orderChatsByActivity(result, filters.order === "oldest" ? "oldest" : "recent");

    const limit = Number(filters.limit || 0);
    if (Number.isInteger(limit) && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  recordSummary(record) {
    return {
      id: record.id,
      provider: record.provider,
      providerLabel: record.providerLabel,
      providerIcon: resolvedAgentIcon(this.config, record.provider),
      cwd: record.cwd,
      projectName: record.projectName,
      title: record.title,
      titleSource: record.titleSource,
      tabTitle: chatTabTitle(record.title, this.titleSettings.tabMaxWidth),
      status: "saved",
      statusDetail: record.statusDetail || "Saved ACP session",
      mode: record.mode || null,
      modes: null,
      availableCommands: record.availableCommands || [],
      configOptions: [],
      configValues: sanitizeConfigValues(record.configValues || {}),
      permissionPolicy: this.permissionSettings.policy,
      permissionState: null,
      model: record.model || record.configValues?.model || null,
      effort: record.effort || record.configValues?.effort || record.configValues?.reasoning || null,
      pid: null,
      sessionId: record.sessionId,
      additionalDirectories: record.additionalDirectories || [],
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      usage: record.usage || null,
      turnActive: false,
      turnSequence: record.turnSequence || 0,
      lastStopReason: record.lastStopReason || null,
      plan: record.plan || null,
      planSupported: record.planSupported === true,
      queued: 0,
      queuedRequests: [],
      authMethods: [],
      mcpServers: [],
      mcpApplyPending: false,
      mcpApplyRunning: false,
      mcpLastApplyError: null,
      restoreFailure: null,
      active: false,
      source: record.source || "local",
    };
  }

  chatSummary(chat) {
    return {
      id: chat.id,
      provider: chat.provider,
      providerLabel: chat.providerLabel,
      providerIcon: resolvedAgentIcon(this.config, chat.provider),
      cwd: chat.cwd,
      projectName: chat.projectName,
      title: chat.title,
      titleSource: chat.titleSource,
      tabTitle: chatTabTitle(chat.title, this.titleSettings.tabMaxWidth),
      status: chat.status,
      statusDetail: chat.statusDetail,
      mode: chat.mode,
      modes: chat.modes || null,
      availableCommands: chat.availableCommands || [],
      configOptions: chat.configOptions || [],
      configValues: selectedConfigValues(chat),
      permissionPolicy: this.permissionSettings.policy,
      permissionState: chat.permissionState || emptyPermissionState(),
      model: chatModel(chat),
      effort: chatEffort(chat),
      pid: chat.pid,
      sessionId: chat.sessionId,
      additionalDirectories: chat.additionalDirectories || [],
      startedAt: chat.startedAt,
      updatedAt: chat.updatedAt,
      usage: chat.usage || null,
      turnActive: chat.turnActive === true,
      turnSequence: chat.turnSequence || 0,
      lastStopReason: chat.lastStopReason || null,
      plan: chat.plan || null,
      planSupported: chat.planSupported === true,
      queued: chat.promptQueue?.length || 0,
      queuedRequests: (chat.promptQueue || []).map((request, index) => ({
        id:
          request.clientRequestId ||
          request.clientPromptId ||
          request.clientCommandId ||
          `queued-${index + 1}`,
        kind: request.kind || "prompt",
        preview: cleanInline(request.text || "").slice(0, 160),
        position: index + 1,
        queuedAt: request.queuedAt || null,
      })),
      activeCommand:
        chat.activeRequest?.kind === "command"
          ? {
              name: chat.activeRequest.descriptor?.command || "command",
              presentation: chat.activeRequest.presentation || "work",
            }
          : null,
      authMethods: chat.authMethods || [],
      mcpServers: chat.mcpServers || [],
      mcpApplyPending: chat.mcpApplyPending === true,
      mcpApplyRunning: chat.mcpApplyRunning === true,
      mcpLastApplyError: chat.mcpLastApplyError || null,
      restoreFailure: chat.restoreFailure || null,
      active: true,
      source: "active",
    };
  }

  buildState() {
    return {
      updatedAt: nowIso(),
      pid: process.pid,
      socket: SOCKET_PATH,
      chats: this.chatSummaries(),
    };
  }

  publishTmuxStatusCounts(chats = []) {
    const values = acpStatusCountOptionValues(chats);
    const key = Object.values(values).join(":");
    if (key === this.tmuxStatusCountsKey) return;

    this.tmuxStatusCountsKey = key;
    setTmuxGlobalOptions(values);
  }

  persistState() {
    // Mark dirty only; building chatSummaries() is expensive and this is called
    // on every streamed chunk/status change. Defer the build to the debounced flush.
    this.stateDirty = true;
    if (this.persistTimer) return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.stateDirty) return;
      this.stateDirty = false;
      this.latestState = this.buildState();
      this.publishTmuxStatusCounts(this.latestState.chats);
      fsp
        .writeFile(STATE_PATH, `${JSON.stringify(this.latestState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
        .catch(() => {});
    }, 200);
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.adapterUpdateCheckTimer) clearTimeout(this.adapterUpdateCheckTimer);
    this.adapterUpdateCheckTimer = null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (this.registryTimer) {
      clearTimeout(this.registryTimer);
      this.registryTimer = null;
      this.writeRegistryNow();
    }

    for (const timer of this.tmuxSyncTimers.values()) clearTimeout(timer);
    this.tmuxSyncTimers.clear();

    // Never leave a status bar claiming agents are active after the daemon is
    // gone. A future daemon start republishes the live values.
    this.tmuxStatusCountsKey = "";
    this.publishTmuxStatusCounts([]);

    try {
      writeJsonFileSync(STATE_PATH, this.buildState());
    } catch {
      // Best effort on shutdown.
    }

    for (const chat of this.chats.values()) {
      this.cancelPendingPermissionsForChat(chat, "Daemon stopped");
      if (chat.process) chat.process.kill("SIGTERM");
    }

    for (const client of this.clients) {
      client.conn.send({ type: "event", event: "shutdown" });
      client.conn.close();
    }

    if (this.server) this.server.close();

    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Already gone.
    }

    try {
      fs.unlinkSync(PID_PATH);
    } catch {
      // Already gone.
    }

    process.exit(0);
  }
}

export { HubDaemon };
