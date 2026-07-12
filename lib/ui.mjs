// The popup client: frame painting, pickers, composer, transcript renderer.
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
import {
  stringDisplayWidth,
  wrapAnsiLine,
  padAnsiToWidth,
} from "./render.mjs";
import {
  providerIconFor,
  coloredProviderIcon,
  formatChatPreview,
  formatRelativeAge,
  providerAccentSeq,
  hubAccentSeq,
  codeBlockLine,
  codeFenceHeader,
  highlightCode,
  applyAcpStatusFormat,
  HUB_CLI_PATH,
  buildMcpPanelItems,
  buildAuthPanelItems,
  buildPlanPanelItems,
  buildRootsPanelItems,
  c,
  draftKey,
  loadDraft,
  saveDraft,
  clearDraft,
  loadInputHistory,
  loadUiSettings,
  saveUiSettings,
  saveInputHistory,
  flushLocalInputStateSync,
  resolveProjectRoot,
  projectName,
  pickerFilterEntries,
  pickerNextIndex,
  pickerValueEquals,
  statusGlyph,
  statusColorName,
  statusIndicator,
  isSettledChatStatus,
  isActiveChatStatus,
  cleanInline,
  normalizePastedText,
  shouldStorePasteAsAttachment,
  pastedTextSummary,
  pastedAttachmentSummary,
  createPastedTextAttachment,
  attachmentsFromPathOnlyText,
  looksLikePathInput,
  rawInputVisualLines,
  rawVisualLineIndexAtCursor,
  rawPreviousWord,
  rawNextWord,
  listProjectFiles,
  normalizeMentionQuery,
  fileMentionScore,
  commonPathPrefix,
  escapeMentionPath,
  unescapeMentionPath,
  stripAnsi,
  visibleLength,
  sameRawInputLayout,
  renderInlineMarkdown,
  isMarkdownTableStart,
  isMarkdownTableRow,
  isMarkdownTableSeparator,
  hasPendingMarkdownTable,
  renderMarkdownTable,
  truncateText,
  fitPlainLine,
  inputComposerLine,
  fitAnsiLine,
  truncateAnsiText,
  horizontalRuleLine,
  activityDividerLine,
  isCompletedToolStatus,
  activityGroupFor,
  cleanActivitySummary,
  displayPath,
  normalizeAdditionalDirectories,
  normalizeToken,
  splitCommandWords,
  configOptionId,
  resolveConfigOption,
  chatModel,
  compactProviderLabel,
  providerColorName,
  coloredProviderLabel,
  chatEffort,
  chatAccessLabel,
  chatConfigLabel,
  footerParts,
  attachmentChip,
  attachmentToken,
  ATTACHMENT_TOKEN_BEFORE_CURSOR,
  wrapAttachmentChips,
  configOptionValues,
  configOptionMenuValues,
  isBooleanConfigOption,
  configOptionValueMatches,
  modeEntries,
  resolveAccessTarget,
  valueLabel,
  formatConfigOption,
  formatProviderCommand,
  planMarker,
  resolvePromptAttachment,
  formatBytes,
  formatTokenCount,
  estimateDraftTokens,
  formatTokenEstimate,
  mentionAttachmentsForText,
  formatCost,
  formatContextUsage,
  mcpServerLabel,
  chatAttentionRank,
  shellQuote,
  tmuxDoubleQuote,
  displayTmuxMenu,
  tmuxWindowOptionValues,
  setTmuxWindowOptions,
  tmuxSubmitToPane,
  tmuxConfirmCommand,
  tmuxPanelCommand,
  actionPayload,
  tmuxActionCommand,
  tmuxConfirmActionCommand,
  tmuxWorkspaceShellCommand,
  tmuxRunWorkspace,
  INPUT_HISTORY_LIMIT,
  TRANSCRIPT_SCREEN_LINE_LIMIT,
  MAX_COMPOSER_INPUT_ROWS,
  MIN_COMPOSER_INPUT_ROWS,
  COMPOSER_INPUT_SIDE_PADDING,
  COMPOSER_META_SIDE_PADDING,
  COMPOSER_MARKER_WIDTH,
  COMPOSER_INPUT_VERTICAL_PADDING,
  COMPOSER_BOX_SIDE_WIDTH,
  COMPOSER_SPINNER_INTERVAL_MS,
  LIVE_TABLE_PAINT_MS,
  COMPOSER_PLACEHOLDER,
  FILE_MENTION_LIMIT,
  FILE_MENTION_CACHE_MS,
  KILL_RING_LIMIT,
  COMPOSER_SPINNER_FRAMES,
  colors,
} from "./core.mjs";

const VIM_UNDO_LIMIT = 100;

function vimLineBounds(line, cursor) {
  const start = line.slice(0, cursor).lastIndexOf("\n") + 1;
  const endIndex = line.indexOf("\n", cursor);
  return { start, end: endIndex === -1 ? line.length : endIndex };
}

function vimFirstNonBlank(line, bounds) {
  let i = bounds.start;
  while (i < bounds.end && /[ \t]/.test(line[i])) i += 1;
  return i;
}

// End of the current/next word (vim `e`), staying on the last char.
function vimWordEnd(line, cursor) {
  if (!line.length) return 0;
  let i = Math.min(cursor + 1, line.length - 1);
  while (i < line.length - 1 && /\s/.test(line[i])) i += 1;
  while (i + 1 < line.length && !/\s/.test(line[i + 1])) i += 1;
  return i;
}

function vimHasPending(session) {
  return Boolean(
    session.vimOp || session.vimCount || session.vimFind || session.vimReplace || session.vimGPending,
  );
}

function vimClearPending(session) {
  session.vimOp = "";
  session.vimCount = "";
  session.vimFind = "";
  session.vimReplace = false;
  session.vimGPending = false;
}

function vimTakeCount(session) {
  const count = Number(session.vimCount || "1");
  session.vimCount = "";
  return Number.isFinite(count) && count > 0 ? count : 1;
}

// Cursor index for f/F/t/T within the current line, or null when the char
// isn't there (vim: the whole motion fails, nothing moves).
function vimFindTarget(line, cursor, spec, ch) {
  const bounds = vimLineBounds(line, cursor);
  if (spec === "f" || spec === "t") {
    const idx = line.indexOf(ch, cursor + (spec === "t" ? 2 : 1));
    if (idx === -1 || idx >= bounds.end) return null;
    return spec === "f" ? idx : idx - 1;
  }
  const idx = line.lastIndexOf(ch, cursor - (spec === "T" ? 2 : 1));
  if (idx === -1 || idx < bounds.start) return null;
  return spec === "F" ? idx : idx + 1;
}

// Target index for a bare motion (no operator); null = motion failed.
function vimMotionTarget(line, cursor, motion, findChar = "") {
  const bounds = vimLineBounds(line, cursor);
  switch (motion) {
    case "h":
      return Math.max(bounds.start, cursor - 1);
    case "l":
      // Normal mode caps at the last char, never on the newline itself.
      return cursor + 1 < bounds.end ? cursor + 1 : cursor;
    case "w":
      return rawNextWord(line, cursor);
    case "b":
      return rawPreviousWord(line, cursor);
    case "e":
      return vimWordEnd(line, cursor);
    case "0":
      return bounds.start;
    case "^":
      return vimFirstNonBlank(line, bounds);
    case "$":
      return Math.max(bounds.start, bounds.end - (bounds.end > bounds.start ? 1 : 0));
    case "G":
      return line.length;
    case "gg":
      return 0;
    case "f":
    case "F":
    case "t":
    case "T":
      return vimFindTarget(line, cursor, motion, findChar);
    case "%":
      return vimMatchPairTarget(line, cursor);
    default:
      return null;
  }
}

// Vim %: from (or scanning forward on the line to) a bracket, jump to its
// match anywhere in the buffer; null when unmatched.
function vimMatchPairTarget(line, cursor) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const closers = { ")": "(", "]": "[", "}": "{" };
  const bounds = vimLineBounds(line, cursor);

  let i = cursor;
  while (i < bounds.end && !(line[i] in pairs) && !(line[i] in closers)) i += 1;
  if (i >= bounds.end) return null;

  if (line[i] in pairs) {
    const open = line[i];
    const close = pairs[open];
    let depth = 0;
    for (let j = i; j < line.length; j += 1) {
      if (line[j] === open) depth += 1;
      else if (line[j] === close && !(depth -= 1)) return j;
    }
    return null;
  }

  const close = line[i];
  const open = closers[close];
  let depth = 0;
  for (let j = i; j >= 0; j -= 1) {
    if (line[j] === close) depth += 1;
    else if (line[j] === open && !(depth -= 1)) return j;
  }
  return null;
}

// [start, end) for an operator+motion pair. Count applies to repeatable
// motions (w/b/e/f/t and linewise); cw uses ce semantics like vim.
function vimOperatorRange(line, cursor, op, motion, count, findChar = "") {
  const bounds = vimLineBounds(line, cursor);

  if (motion === "line") {
    let end = bounds.end;
    for (let n = 1; n < count && end < line.length; n += 1) {
      end = vimLineBounds(line, end + 1).end;
    }
    if (op === "c") return { start: bounds.start, end };
    if (end < line.length) return { start: bounds.start, end: end + 1 };
    // Last line: take the preceding newline so no empty line is left behind.
    return { start: Math.max(0, bounds.start - 1), end };
  }

  let target = cursor;
  const effectiveMotion = op === "c" && motion === "w" ? "e" : motion;
  for (let n = 0; n < count; n += 1) {
    const next = vimMotionTarget(line, target, effectiveMotion, findChar);
    if (next === null) return null;
    if (next === target) break;
    target = next;
  }

  if (motion === "$") return { start: cursor, end: bounds.end };
  // Inclusive motions take the char under the target too.
  if (["e", "f", "t"].includes(effectiveMotion)) return { start: cursor, end: target + 1 };
  if (["F", "T"].includes(effectiveMotion)) return { start: target, end: cursor };
  if (effectiveMotion === "%") {
    return target >= cursor
      ? { start: cursor, end: target + 1 }
      : { start: target, end: cursor + 1 };
  }

  return target >= cursor ? { start: cursor, end: target } : { start: target, end: cursor };
}

// Charwise selections are cursor-inclusive; linewise ones span whole lines
// (taking the trailing newline, or the preceding one at the buffer's end).
function vimSelectionRange(session) {
  const line = session.line;
  const from = Math.min(session.vimAnchor, session.cursor);
  const to = Math.max(session.vimAnchor, session.cursor);

  if (!session.vimVisualLine) return { start: from, end: Math.min(line.length, to + 1) };

  const startBounds = vimLineBounds(line, Math.min(from, line.length));
  const endBounds = vimLineBounds(line, Math.min(to, line.length));
  if (endBounds.end < line.length) return { start: startBounds.start, end: endBounds.end + 1 };
  return { start: Math.max(0, startBounds.start - 1), end: endBounds.end };
}

class FramePainter {
  constructor() {
    this.parts = [];
  }

  to(column, row) {
    this.parts.push(`\x1b[${row + 1};${column + 1}H`);
    return this;
  }

  clearLine() {
    this.parts.push("\x1b[2K");
    return this;
  }

  text(value) {
    if (value) this.parts.push(value);
    return this;
  }

  flush() {
    if (this.parts.length) {
      // Synchronized-output brackets (DECSET 2026, tmux ≥3.4 honours them;
      // others ignore them) plus hiding the cursor for the frame's duration:
      // the terminal applies the whole repaint at once instead of tearing
      // through intermediate states — the visible "flicker" while typing.
      process.stdout.write(`\x1b[?2026h\x1b[?25l${this.parts.join("")}\x1b[?25h\x1b[?2026l`);
    }
    this.parts = [];
  }
}

class PopupUi {
  constructor(hub, config, cwd, mode, options = {}) {
    this.hub = hub;
    this.config = config;
    this.cwd = resolveProjectRoot(cwd || process.cwd());
    this.mode = mode;
    this.options = options;
    this.rl = null;
    this.currentChat = null;
    this.pendingPermission = null;
    // The permission id whose picker we already auto-opened, so Esc (which keeps
    // the request pending) drops back to the composer instead of re-trapping.
    this.autoShownPermissionId = null;
    this.closed = false;
    this.questionActive = false;
    this.currentPrompt = "";
    this.rawInput = null;
    this.lastRawInputLayout = null;
    this.lastRawScrollBottom = null;
    this.inputHistory = loadInputHistory();
    this.uiSettings = loadUiSettings();
    this.vimEnabled = process.env.ACP_HUB_VIM === "1" || this.uiSettings.vim === true;
    this.pendingAttachments = [];
    this.attachmentSeq = 0;
    this.fileMentionCache = new Map();
    this.killRing = [];
    this.lastEscapeAt = 0;
    this.composerSpinnerFrame = 0;
    this.composerSpinnerTimer = null;
    this.chunkBuffer = "";
    this.chunkBufferMarkdown = false;
    this.chunkBufferDim = false;
    this.markdownFence = false;
    this.markdownFenceLang = "";
    this.lastTmuxMetadataAt = 0;
    this.showInternalEvents = options.debug === true || process.env.ACP_HUB_DEBUG_UI === "1";
    this.activityMode = process.env.ACP_HUB_ACTIVITY || "compact";
    this.lastActivityGroup = "";
    this.activityGroupLineCount = 0;
    this.pendingResponseBreak = false;
    this.lastStreamEventKey = "";
    this.lastPlanSignature = "";
    this.transcriptLines = [""];
    this.scrollOffsetRows = 0;
    this.scrollNewRows = 0;
    this.mdHeldLine = null;
    this.liveTable = null;
    this.liveTablePaintTimer = null;
    this.liveTablePaintPending = false;
    this.activePicker = null;
    this.inlinePicker = null;
    this.menuTextActive = false;
    this.menuFilters = {
      provider: "all",
      scope: "project",
      query: "",
      limit: 80,
    };

    this.hub.onEvent((message) => this.handleHubEvent(message));
    // Socket-level loss (crash, kill -9 — no shutdown event arrives): exit
    // instead of sitting deaf on a dead connection.
    this.hub.onClose?.(() => this.exitOnDaemonLoss("connection lost"));
  }

  // The daemon is gone. The composer traps raw stdin, so without an explicit
  // exit the process (and its tmux window) lingers as an unresponsive zombie
  // that prefix+m keeps reattaching to. Save local state, say why, and leave —
  // the window closes with us, and the next prefix+m starts a fresh daemon
  // that restores every chat from the registry.
  exitOnDaemonLoss(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      flushLocalInputStateSync();
    } catch {
      // Draft persistence is best-effort on the way out.
    }
    try {
      this.disableRawInputLayout();
    } catch {
      // Terminal restore is best-effort too.
    }
    process.stdout.write(
      `\n${c("yellow", `ACP hub daemon ${reason} — reopen with prefix+m (chats are kept)`)}\n`,
    );
    setTimeout(() => process.exit(0), 1500);
  }

  async run() {
    try {
      let action;
      if (this.mode === "chat") {
        if (this.options.chatId) {
          try {
            action = await this.openChat(this.options.chatId);
          } catch (error) {
            // Stale window pointing at a deleted/broken chat: fall back to the
            // project's provider flow instead of dying with a stack trace.
            this.logLine(c("red", `✗ ${error.message || String(error)}`));
            const provider = this.options.agent || this.config.defaultAgent || "codex";
            action = await this.openProvider(provider, this.cwd);
          }
        } else if (this.options.newChat) {
          const provider = this.options.agent || this.config.defaultAgent || "codex";
          action = await this.newProvider(provider, this.cwd);
        } else {
          const provider = this.options.agent || this.config.defaultAgent || "codex";
          action = await this.openProvider(provider, this.cwd);
        }
      } else {
        action = await this.menuLoop();
      }

      while (action === "menu") {
        action = await this.menuLoop();
      }
    } finally {
      this.closed = true;
      this.flushChunkBuffer({ force: true });
      this.resetStreamRenderState();
      this.disableRawInputLayout();
      this.stopComposerSpinner();
      flushLocalInputStateSync();
      if (this.rl) this.rl.close();
      this.hub.close();
    }
  }

  printHeader() {
    this.logLine(c("bold", `tmux ACP Hub :: ${projectName(this.cwd)}`));
    this.logLine(c("dim", this.cwd));
    this.logLine("");
  }

  // Single-shot: the menu is an ephemeral window. Every outcome (pick a chat,
  // create one, back out) routes to a dedicated chat window and returns, so
  // the menu process exits and its window auto-closes (remain-on-exit off) —
  // no lingering "ACP menu" pane, only chat windows remain. Off tmux there is
  // no workspace, so selections render inline and the loop continues.
  async menuLoop() {
    if (!this.pickerSupported()) return this.menuLoopText();

    let selection;
    try {
      selection = await this.runMenuPicker();
    } catch (error) {
      this.logLine(c("red", error.message || String(error)));
      return this.menuLoopText();
    }

    if (!selection) {
      // Esc/Ctrl+C: back out — reveal the open chat if there is one, else
      // minimize — then let the menu window close by exiting.
      this.returnFromMenuOrMinimize();
      return "closed";
    }

    if (!process.env.TMUX) {
      // No workspace to switch into: render the selection inline and keep the
      // menu loop going (legacy non-tmux path).
      try {
        if (selection.type === "chat") return await this.openChat(selection.chatId);
        if (selection.type === "new") return await this.newProvider(selection.provider, this.cwd);
      } catch (error) {
        this.notify(`acp-hub: ${error.message || String(error)}`);
      }
      return "menu";
    }

    try {
      if (selection.type === "chat") {
        // Already open in another window → focus it and let this host close.
        // Otherwise adopt the chat into this pane instead of spawning a window.
        if (this.hasChatWindow(selection.chatId)) {
          this.switchToChatWindow(selection);
          return "closed";
        }
        return await this.adoptChatInPane(() => this.openChat(selection.chatId));
      }
      if (selection.type === "new") {
        return await this.adoptChatInPane(() =>
          this.newProvider(selection.provider, this.cwd),
        );
      }
    } catch (error) {
      this.notify(`acp-hub: ${error.message || String(error)}`);
    }
    return "closed";
  }

  // Is a live tmux pane (other than this one) already hosting the chat?
  hasChatWindow(chatId) {
    if (!chatId || !process.env.TMUX) return false;
    const own = process.env.TMUX_PANE || "";
    const res = spawnSync(
      "tmux",
      ["list-panes", "-a", "-F", "#{pane_id}\t#{@acp_hub_chat_id}\t#{pane_dead}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (res.error || res.status !== 0) return false;
    return String(res.stdout || "")
      .split("\n")
      .some((line) => {
        const [paneId, cid, dead] = line.split("\t");
        return cid === chatId && dead === "0" && paneId && paneId !== own;
      });
  }

  // The cold-start menu-host pane is becoming a chat: drop the menu action so
  // prefix+M treats it as a chat pane, then render the chat here in-process.
  // openFn (openChat/newProvider) enters chatLoop and returns its result.
  async adoptChatInPane(openFn) {
    if (process.env.TMUX_PANE) {
      spawnSync(
        "tmux",
        ["set-window-option", "-t", process.env.TMUX_PANE, "-q", "@acp_hub_action", "open"],
        { stdio: "ignore" },
      );
    }
    return openFn();
  }

  async runMenuPicker(options = {}) {
    this.menuFilters.query = "";
    const menu = await this.buildMenu();

    let watched = false;
    try {
      await this.hub.call("watch");
      watched = true;
    } catch {
      // Older daemon without watch support: menu still works, just not live.
    }

    let refreshTimer = null;
    const scheduleRefresh = (controls) => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(async () => {
        refreshTimer = null;
        try {
          const fresh = await this.buildMenu();
          const keep = controls.state.done
            ? null
            : pickerFilterEntries(controls.state.items, controls.state.query)[controls.state.index]?.value ?? null;
          controls.replaceItems(this.buildMenuPickerItems(fresh), keep);
        } catch {
          // Menu refresh is best effort.
        }
      }, 200);
      refreshTimer.unref?.();
    };

    try {
      return await this.interactivePick({
        title: `ACP Hub · ${projectName(this.cwd)}`,
        hint: "j/k move · Enter/l open · / filter · Tab scope · ^S reply · ^E rename · ^D delete · Esc",
        emptyText: "No chats match — Esc clears the filter",
        deferBackdrop: options.deferBackdrop === true,
        // Land on the chat this popup was just in, not the top of the list.
        initialValue: this.currentChat?.id
          ? {
              type: "chat",
              chatId: this.currentChat.id,
              cwd: this.currentChat.cwd,
              provider: this.currentChat.provider,
            }
          : null,
        items: this.buildMenuPickerItems(menu),
        onReply: (entry, text) =>
          entry.value?.type === "chat" ? this.replyToChatFromPicker(entry, text) : null,
        onTab: async () => {
          this.menuFilters.scope = this.menuFilters.scope === "project" ? "all" : "project";
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onRefresh: async () => {
          await this.refreshSessions().catch(() => {});
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onRename: async (entry, title) => {
          if (entry.value?.type !== "chat") return null;
          try {
            await this.hub.call("rename_chat", { chatId: entry.value.chatId, title });
          } catch (error) {
            this.notify(`acp-hub: rename failed: ${error.message || String(error)}`);
          }
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onDelete: async (entry) => {
          if (entry.value?.type !== "chat") return null;
          try {
            await this.hub.call("delete_chat", {
              chatId: entry.value.chatId,
              keepPane: process.env.TMUX_PANE || "",
            });
          } catch (error) {
            this.notify(`acp-hub: delete failed: ${error.message || String(error)}`);
          }
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onPreview: async (entry) => {
          const chatId = entry.value?.chatId;
          if (!chatId) return null;
          return this.hub.call("chat_preview", { chatId });
        },
        onEvent: (message, controls) => {
          if (message.type !== "chat_state" && message.type !== "chat_event") return;
          scheduleRefresh(controls);
        },
      });
    } finally {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (watched) this.hub.call("unwatch").catch(() => {});
    }
  }

  buildMenuPickerItems(menu) {
    const items = [];
    const chats = menu.visibleChats;
    const local = chats.filter((chat) => chat.cwd === this.cwd);
    const remote = chats.filter((chat) => chat.cwd !== this.cwd);

    const chatEntry = (chat) => {
      const title = truncateText(cleanInline(chat.title || chat.id), 48);
      const meta = [formatRelativeAge(chat.updatedAt), chat.mode, chatConfigLabel(chat)]
        .filter(Boolean)
        .join(" · ");
      // Saved is the default state of every stored chat; showing it on each
      // row is noise. Status appears only for live chats.
      const status = chat.active ? `  ${statusIndicator(chat.status)}` : "";
      return {
        label: `${coloredProviderIcon(chat)} ${c("bold", title)}${status}${
          meta ? `  ${c("dim", meta)}` : ""
        }`,
        searchText: [
          chat.provider,
          chat.providerLabel,
          chat.projectName,
          chat.title,
          chat.status,
          chat.cwd,
          chat.sessionId,
        ]
          .filter(Boolean)
          .join(" "),
        value: { type: "chat", chatId: chat.id, cwd: chat.cwd, provider: chat.provider },
        canRename: true,
        canDelete: true,
        canReply: Boolean(chat.active),
        renameInitial: cleanInline(chat.title || ""),
      };
    };

    if (local.length) {
      items.push({ label: c("bold", `${projectName(this.cwd)} · current project`), disabled: true });
      for (const chat of local) items.push(chatEntry(chat));
    }

    items.push({ label: c("bold", "New chat"), disabled: true });
    for (const agent of menu.agents) {
      const isDefault = agent.id === this.config.defaultAgent;
      const icon = coloredProviderIcon({ provider: agent.id, providerIcon: agent.icon });
      items.push({
        label: `${icon} New ${agent.label || agent.id} chat${isDefault ? c("dim", " · default") : ""}`,
        searchText: `new ${agent.id} ${agent.label || ""}`,
        value: { type: "new", provider: agent.id },
      });
    }

    const groups = new Map();
    for (const chat of remote) {
      if (!groups.has(chat.projectName)) groups.set(chat.projectName, []);
      groups.get(chat.projectName).push(chat);
    }
    for (const [group, groupChats] of groups) {
      items.push({ label: c("bold", group), disabled: true });
      for (const chat of groupChats) items.push(chatEntry(chat));
    }

    if (this.menuFilters.scope === "project" && !remote.length) {
      items.push({ label: c("dim", "Tab shows chats from all projects"), disabled: true });
    }

    return items;
  }

  // The text menu keeps a plain readline prompt even when a chat was opened
  // earlier in this process (currentChat set); the flag scopes only the menu's
  // own prompt, never nested chat loops.
  async menuQuestion(prompt) {
    this.menuTextActive = true;
    try {
      return await this.question(prompt);
    } finally {
      this.menuTextActive = false;
    }
  }

  async menuLoopText() {
    for (;;) {
      const menu = await this.buildMenu();
      this.renderMenu(menu);
      const answer = (await this.menuQuestion("open> ")).trim();
      if (!answer) continue;
      if (["q", "quit", "exit", "/exit"].includes(answer)) {
        this.closePopupClient();
        return "exit";
      }
      if (answer === "/help" || answer === "help") {
        this.printMenuHelp();
        continue;
      }
      if (answer === "/refresh" || answer === "refresh") {
        await this.refreshSessions();
        continue;
      }
      if (answer === "/clear" || answer === "clear") {
        this.menuFilters = { provider: "all", scope: "project", query: "", limit: 80 };
        continue;
      }
      if (answer.startsWith("/q ") || answer.startsWith("?")) {
        this.menuFilters.query = answer.startsWith("?")
          ? answer.slice(1).trim()
          : answer.slice(3).trim();
        continue;
      }
      if (answer === "/q") {
        this.menuFilters.query = "";
        continue;
      }
      if (answer.startsWith("/p ") || answer.startsWith("/provider ")) {
        const provider = answer.split(/\s+/)[1] || "all";
        if (provider !== "all" && !this.config.agents?.[provider]) {
          this.logLine(c("yellow", `Unknown provider: ${provider}`));
          continue;
        }
        this.menuFilters.provider = provider;
        continue;
      }
      if (answer.startsWith("/s ") || answer.startsWith("/scope ")) {
        const scope = answer.split(/\s+/)[1] || "project";
        if (!["project", "all"].includes(scope)) {
          this.logLine(c("yellow", "Scope must be project or all"));
          continue;
        }
        this.menuFilters.scope = scope;
        continue;
      }
      if (answer.startsWith("/new ")) {
        const provider = answer.slice(5).trim();
        if (!this.config.agents?.[provider]) {
          this.logLine(c("yellow", `Unknown agent: ${provider}`));
          continue;
        }
        return this.newProvider(provider, this.cwd);
      }

      const agentByNumber = Number(answer);
      if (Number.isInteger(agentByNumber) && agentByNumber >= 1 && agentByNumber <= menu.agents.length) {
        const action = await this.openProvider(menu.agents[agentByNumber - 1].id, this.cwd);
        if (action === "exit") return action;
        continue;
      }

      if (answer.startsWith("c")) {
        const chatNumber = Number(answer.slice(1));
        if (Number.isInteger(chatNumber) && chatNumber >= 1 && chatNumber <= menu.visibleChats.length) {
          // Switch to the chat's own window (deduped by chat id) rather than
          // rendering it inside the menu window; fall back to inline off tmux.
          const chat = menu.visibleChats[chatNumber - 1];
          if (process.env.TMUX) {
            this.switchToChatWindow({ cwd: chat.cwd, provider: chat.provider, chatId: chat.id });
            continue;
          }
          const action = await this.openChat(chat.id);
          if (action === "exit") return action;
          continue;
        }
      }

      if (this.config.agents?.[answer]) {
        const action = await this.openProvider(answer, this.cwd);
        if (action === "exit") return action;
        continue;
      }

      this.logLine(c("yellow", "Unknown option"));
    }
  }

  async buildMenu() {
    const agents = (await this.hub.call("list_agents")).agents;
    const params = {
      limit: this.menuFilters.limit,
      query: this.menuFilters.query || undefined,
    };

    if (this.menuFilters.provider !== "all") {
      params.provider = this.menuFilters.provider;
    }

    if (this.menuFilters.scope === "project") {
      params.cwd = this.cwd;
    }

    const chats = (await this.hub.call("list_chats", params)).chats;
    return {
      agents,
      chats,
      visibleChats: this.orderChatsForDisplay(chats.slice(0, this.menuFilters.limit)),
    };
  }

  orderChatsForDisplay(chats) {
    return [...chats].sort((a, b) => {
      const currentProjectA = a.cwd === this.cwd ? 0 : 1;
      const currentProjectB = b.cwd === this.cwd ? 0 : 1;
      if (currentProjectA !== currentProjectB) return currentProjectA - currentProjectB;

      const groupA = `${a.projectName}\0${a.provider}`;
      const groupB = `${b.projectName}\0${b.provider}`;
      if (groupA !== groupB) return groupA.localeCompare(groupB);
      const rank = chatAttentionRank(a) - chatAttentionRank(b);
      if (rank !== 0) return rank;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
  }

  renderMenu(menu) {
    this.clearScreen();
    this.printHeader();
    this.logLine(
      `${c("bold", "Filters")} provider=${this.menuFilters.provider} scope=${this.menuFilters.scope} query=${
        this.menuFilters.query ? JSON.stringify(this.menuFilters.query) : "-"
      }`,
    );
    this.logLine("");
    this.logLine(c("bold", "Agents"));
    menu.agents.forEach((agent, index) => {
      const marker = agent.id === this.config.defaultAgent ? "*" : " ";
      this.logLine(`${index + 1}. ${marker} ${agent.id} - ${agent.label}`);
    });

    this.logLine("");
    this.logLine(c("bold", `Chats (${menu.visibleChats.length})`));
    if (!menu.visibleChats.length) {
      this.logLine(c("dim", "No chats match current filters"));
    } else {
      this.renderGroupedChats(menu.visibleChats);
    }

    this.logLine("");
    this.logLine(c("dim", "cN open | /q text | /p codex|claude|all | /s project|all | /new <agent> | /refresh | /help"));
  }

  renderGroupedChats(chats) {
    const groups = new Map();
    for (const chat of chats) {
      const group = chat.cwd === this.cwd ? `${chat.projectName} / current project` : chat.projectName;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(chat);
    }

    let index = 1;
    for (const [group, groupChats] of groups) {
      this.logLine(c("bold", group));

      for (const chat of groupChats) {
        const status = chat.active ? `  ${statusIndicator(chat.status)}` : "";
        const title = truncateText(cleanInline(chat.title || chat.id), 60);
        const meta = [formatRelativeAge(chat.updatedAt), chat.mode, chatConfigLabel(chat)]
          .filter(Boolean)
          .join(" · ");
        this.logLine(
          `  ${c("dim", `c${index}`)}  ${coloredProviderIcon(chat)} ${c("bold", title)}${status}${
            meta ? `  ${c("dim", meta)}` : ""
          }`,
        );
        index += 1;
      }
    }
  }

  printMenuHelp() {
    this.logLine("");
    this.logLine(c("bold", "Menu commands"));
    this.logLine("cN                  open chat number N");
    this.logLine("1..N                open default/current chat for an agent");
    this.logLine("/q text or ?text    filter by title, project, path, provider, session id");
    this.logLine("/q                  clear search text");
    this.logLine("/p provider         provider filter: codex, claude, all");
    this.logLine("/s scope            scope filter: project or all");
    this.logLine("/new <agent>        create a new ACP session");
    this.logLine("/refresh            import provider sessions with session/list");
    this.logLine("/clear              reset filters");
    this.logLine("/exit               close popup client");
  }

  providerLabelFor(provider) {
    return compactProviderLabel(this.config.agents?.[provider]?.label || provider);
  }

  async openProvider(provider, cwd) {
    const result = await this.withStartupIndicator(
      () => this.hub.call("ensure_chat", { provider, cwd }),
      this.providerLabelFor(provider),
    );
    return this.openChat(result.id);
  }

  async newProvider(provider, cwd) {
    const result = await this.withStartupIndicator(
      () => this.hub.call("new_chat", { provider, cwd }),
      this.providerLabelFor(provider),
    );
    return this.openChat(result.id);
  }

  async withStartupIndicator(fn, label = "") {
    const promise = Promise.resolve().then(fn);
    if (!process.stdout.isTTY) return promise;

    const target = label ? `Connecting to ${c("bold", label)}…` : "Connecting…";
    let shown = false;
    let frame = 0;

    // Single-line spinner instead of wiping the screen: on the last row of the
    // pinned output region when the composer layout is active, otherwise in
    // place on the current line.
    const spinnerRow = () => (this.canPaintPinned() ? this.pinnedOutputRows() - 1 : null);
    const render = () => {
      shown = true;
      const glyph = COMPOSER_SPINNER_FRAMES[frame++ % COMPOSER_SPINNER_FRAMES.length];
      const line = `  ${c("cyan", glyph)} ${target}`;
      const row = spinnerRow();
      const painter = new FramePainter();
      if (row !== null) painter.to(0, row);
      else painter.text("\r");
      painter.clearLine().text(line);
      painter.flush();
    };
    // Only surface the indicator when the call is actually slow (adapter spawn),
    // so fast already-running chats don't flash a connecting line.
    const delay = setTimeout(render, 150);
    const timer = setInterval(() => {
      if (shown) render();
    }, COMPOSER_SPINNER_INTERVAL_MS);
    timer.unref?.();

    try {
      return await promise;
    } finally {
      clearTimeout(delay);
      clearInterval(timer);
      if (shown) {
        const row = spinnerRow();
        const painter = new FramePainter();
        if (row !== null) painter.to(0, row);
        else painter.text("\r");
        painter.clearLine();
        painter.flush();
      }
    }
  }

  async openChat(chatId) {
    if (this.currentChat?.id) {
      await this.hub.call("unsubscribe", { chatId: this.currentChat.id }).catch(() => {});
    }

    const result = await this.withStartupIndicator(() =>
      this.hub.call("subscribe", { chatId }),
    );
    this.currentChat = result.chat;
    this.pendingPermission = null;
    this.syncTmuxWindow(this.currentChat, { force: true });

    this.disableRawInputLayout();
    this.markdownFence = false;
    this.markdownFenceLang = "";
    this.lastActivityGroup = "";
    this.activityGroupLineCount = 0;
    this.lastPlanSignature = "";
    this.resetStreamRenderState();
    this.clearScreen();
    this.resetTranscriptBuffer();
    this.printChatTitle(this.currentChat);

    this.renderHistory(result.history || []);
    this.flushChunkBuffer({ force: true });

    this.pendingPermission = result.pendingPermission || null;
    if (this.pendingPermission) {
      const count = (this.pendingPermission.options || []).length;
      const span = count > 1 ? `1-${count}` : "the number";
      this.logLine(
        `${c("yellow", "▎")} ${c("yellow", "⏸ Pending permission request")}  ${c("dim", `Type ${span} + Enter · Enter opens menu · /deny`)}`,
      );
    }

    return this.chatLoop();
  }

  renderHistory(events) {
    let pendingChunk = null;

    const flushPendingChunk = () => {
      if (!pendingChunk) return;
      this.renderEvent(pendingChunk, { replay: true });
      pendingChunk = null;
    };

    for (const event of events) {
      if (event.type === "agent_chunk" || event.type === "thought_chunk") {
        if (
          pendingChunk &&
          pendingChunk.type === event.type &&
          (pendingChunk.messageId || null) === (event.messageId || null)
        ) {
          pendingChunk.text = `${pendingChunk.text || ""}${event.text || ""}`;
        } else {
          flushPendingChunk();
          pendingChunk = { ...event };
        }
        continue;
      }

      flushPendingChunk();
      this.renderEvent(event, { replay: true });
    }

    flushPendingChunk();
  }

  printChatTitle(chat) {
    const dot = c("dim", "·");
    const title = chat.title && chat.title !== chat.id ? cleanInline(chat.title) : "";
    const status =
      chat.status && chat.status !== "idle" ? c(statusColorName(chat.status), chat.status) : "";
    const parts = [
      `${coloredProviderIcon(chat)} ${coloredProviderLabel(chat)}`,
      c("bold", chat.projectName),
      title ? c("bold", title) : "",
      chat.mode ? c("dim", chat.mode) : "",
      status,
    ].filter(Boolean);
    this.logLine(parts.join(` ${dot} `), { recordTranscript: false });
    if (this.showInternalEvents) this.logLine(c("dim", chat.cwd), { recordTranscript: false });
    this.logLine("", { recordTranscript: false });
  }

  async chatLoop() {
    try {
      for (;;) {
        // A reopened chat may already carry a pending permission: open its
        // picker once before prompting. Esc then drops to the composer.
        if (await this.maybeAutoOpenPermission()) continue;

        const prompt = this.inputPrompt();
        const line = (await this.question(prompt, { draft: true })).trim();

        // ← on an empty composer backs out to the menu overlay in this pane.
        if (this.pendingComposerAction === "menu") {
          this.pendingComposerAction = null;
          if (await this.showMenuOverlay()) continue;
        }

        // Ctrl+T (and prefix+, / the panel action) requests a rename prompt.
        if (this.pendingComposerAction === "rename") {
          this.pendingComposerAction = null;
          await this.renameChatInteractive();
          continue;
        }

        // A permission arrived mid-turn and broke out of the composer: open it.
        if (this.pendingComposerAction === "permission") {
          this.pendingComposerAction = null;
          await this.maybeAutoOpenPermission();
          continue;
        }

        if (!line) {
          // Empty Enter with a pending permission opens the option picker —
          // the plan-mode "ready to code?" flow answers without typing.
          if (this.pendingPermission && (await this.showPermissionPicker())) continue;
          if (this.pendingAttachments.length) await this.sendAgentText("");
          continue;
        }
        if (this.attachPathInput(line)) continue;
        if (line.startsWith("//")) {
          await this.sendAgentText(line.slice(1));
          continue;
        }
        if (line.startsWith("/agent ")) {
          await this.sendAgentText(line.slice(7).trim());
          continue;
        }
        // While a permission is pending, a bare option number answers it (the
        // 1/2/3 the card shows) instead of going to the agent. Send a literal
        // number to the agent with "/agent 2".
        if (this.pendingPermission && /^\d+$/.test(line)) {
          const choice = Number(line);
          if (choice >= 1 && choice <= (this.pendingPermission.options || []).length) {
            await this.answerPermission(`/allow ${choice}`, "allow");
            continue;
          }
        }
        if (line === "/exit" || line === "/quit") {
          this.closePopupClient();
          return "exit";
        }
        if (line === "/menu") {
          // Overlay in this pane when possible; fall back to the native tmux
          // menu only when the pinned layout is unavailable.
          if (await this.showMenuOverlay()) continue;
          if (await this.showAgentMenu()) continue;
          return "menu";
        }
        if (line === "/chats") {
          if (await this.showChatsPicker()) continue;
          if (await this.showChatsMenu()) continue;
          await this.printChats();
          continue;
        }
        if (line === "/refresh") {
          await this.refreshSessions();
          continue;
        }
        if (line === "/control" || line === "/cmd" || line === "/panel") {
          if (this.showCommandCenterPanel()) continue;
          this.printHelp();
          continue;
        }
        if (line === "/config" || line.startsWith("/config ")) {
          const handled = await this.handleConfigCommand(line);
          if (!handled && this.showConfigPanel()) continue;
          if (!handled) this.textFallback("ACP config menu unavailable", () => this.printConfig());
          continue;
        }
        if (line === "/commands") {
          if (this.showProviderCommandsPanel()) continue;
          this.textFallback("Provider commands menu unavailable", () => this.printProviderCommands());
          continue;
        }
        if (line === "/modes" || line === "/mode") {
          if (await this.showModesPicker()) continue;
          if (this.showModesPanel()) continue;
          this.textFallback("ACP modes menu unavailable", () => this.printModes());
          continue;
        }
        if (line.startsWith("/mode ")) {
          await this.applyMode(line.slice(6).trim());
          continue;
        }
        if (line === "/access" || line === "/permissions") {
          if (await this.showAccessPicker()) continue;
          if (this.showAccessPanel()) continue;
          this.textFallback("Access menu unavailable", () => this.printAccessHelp());
          continue;
        }
        if (line.startsWith("/access ") || line.startsWith("/permissions ")) {
          await this.applyAccess(line.replace(/^\/(?:access|permissions)\s+/, "").trim());
          continue;
        }
        if (line === "/roots" || line.startsWith("/roots ")) {
          await this.handleRootsCommand(line);
          continue;
        }
        if (line === "/changes" || line === "/diff" || line === "/edits") {
          await this.showChangesPicker();
          continue;
        }
        if (line === "/attach" || line.startsWith("/attach ")) {
          await this.handleAttachCommand(line);
          continue;
        }
        if (line === "/attachments" || line === "/files") {
          this.printAttachments();
          continue;
        }
        if (line === "/detach" || line.startsWith("/detach ")) {
          this.detachAttachments(line);
          continue;
        }
        if (line === "/model") {
          if (await this.showConfigOptionPicker("model", "Model")) continue;
          if (this.showConfigOptionPanel("model", "ACP Model")) continue;
          this.textFallback("ACP model menu unavailable", () => this.printConfigOption("model"));
          continue;
        }
        if (line.startsWith("/model ")) {
          await this.handleShortcutConfigCommand("model", line.slice(6).trim());
          continue;
        }
        if (line === "/effort") {
          if (await this.showConfigOptionPicker("effort", "Effort")) continue;
          if (this.showConfigOptionPanel("effort", "ACP Effort")) continue;
          this.textFallback("ACP effort menu unavailable", () => this.printConfigOption("effort"));
          continue;
        }
        if (line.startsWith("/effort ")) {
          await this.handleShortcutConfigCommand("effort", line.slice(7).trim());
          continue;
        }
        if (line.startsWith("/new ")) {
          const provider = line.slice(5).trim();
          if (!this.config.agents?.[provider]) {
            this.logLine(c("yellow", `Unknown agent: ${provider}`));
            continue;
          }
          return this.newProvider(provider, this.cwd);
        }
        if (line === "/vim") {
          this.vimEnabled = !this.vimEnabled;
          this.uiSettings.vim = this.vimEnabled;
          saveUiSettings(this.uiSettings);
          this.notify(
            this.vimEnabled
              ? "vim mode on — Esc for normal mode; Ctrl+C cancels the turn"
              : "vim mode off",
          );
          continue;
        }
        if (line === "/restart") {
          // Soft recovery from inside the popup: spawn the CLI restart
          // detached and let the daemon shutdown reach us — exitOnDaemonLoss
          // closes this popup cleanly, and the next prefix+m starts a fresh
          // daemon with every chat restored from the registry.
          this.logLine(
            c("yellow", "restarting the hub — reopen with prefix+m (chats are kept)"),
          );
          try {
            const child = spawn(process.execPath, [HUB_CLI_PATH, "restart"], {
              detached: true,
              stdio: "ignore",
            });
            child.unref();
          } catch (error) {
            this.logLine(c("red", `restart failed: ${error.message || error}`));
          }
          continue;
        }
        if (line === "/cancel") {
          await this.hub.call("cancel", { chatId: this.currentChat.id }).catch((error) => {
            this.logLine(c("red", error.message));
          });
          continue;
        }
        if (line === "/plan") {
          if (this.showPlanPanel()) continue;
          this.showPlan();
          continue;
        }
        if (line === "/auth") {
          if (this.showAuthPanel()) continue;
          this.printAuthMethods();
          continue;
        }
        if (line.startsWith("/auth ")) {
          await this.authenticateCurrentChat(line.slice(6).trim());
          continue;
        }
        if (line === "/mcp") {
          if (this.showMcpPanel()) continue;
          this.printMcpServers();
          continue;
        }
        if (line === "/allow") {
          if (await this.showPermissionPicker()) continue;
          await this.answerPermission(line, "allow");
          continue;
        }
        if (line.startsWith("/allow ")) {
          await this.answerPermission(line, "allow");
          continue;
        }
        if (line === "/deny" || line.startsWith("/deny ")) {
          await this.answerPermission(line, "deny");
          continue;
        }
        if (line === "/rename" || line === "/title") {
          await this.renameChatInteractive();
          continue;
        }
        if (line.startsWith("/rename ") || line.startsWith("/title ")) {
          await this.renameCurrentChat(line.replace(/^\/(?:rename|title)\s+/, ""));
          continue;
        }
        if (line === "/close") {
          await this.hub.call("close_chat", { chatId: this.currentChat.id });
          return "menu";
        }
        if (line === "/delete") {
          if (await this.deleteCurrentChat()) return "menu";
          continue;
        }
        if (line === "/help") {
          if (this.showCommandCenterPanel()) continue;
          this.printHelp();
          continue;
        }
        if (line === "/compose" || line === "/multiline") {
          const composed = await this.composeInput();
          if (composed) await this.sendAgentText(composed);
          continue;
        }
        if (line === "/edit" || line === "/editor") {
          const edited = await this.editorInput();
          if (edited) await this.sendAgentText(edited);
          continue;
        }
        if (line === "/debug") {
          this.showInternalEvents = !this.showInternalEvents;
          this.notify(`acp-hub debug UI ${this.showInternalEvents ? "on" : "off"}`);
          continue;
        }
        if (line === "/activity" || line.startsWith("/activity ")) {
          this.setActivityMode(line);
          continue;
        }

        await this.sendAgentText(line);
      }
    } finally {
      this.disableRawInputLayout();
    }
  }

  inputPrompt() {
    const chat = this.currentChat || {};
    const provider = truncateText(chat.provider || "agent", 12);
    const project = truncateText(chat.projectName || projectName(this.cwd), 28);
    const status = chat.status && chat.status !== "idle" ? ` ${chat.status}` : "";
    const mode = chat.mode ? ` [${truncateText(chat.mode, 12)}]` : "";
    return `${provider}:${project}${status}${mode}> `;
  }

  async composeInput() {
    this.logLine(c("dim", "compose mode: finish with a single '.'; cancel with /cancel"));
    const lines = [];

    for (;;) {
      const prompt = lines.length ? "... " : ">>> ";
      const line = await this.question(prompt);
      const trimmed = line.trim();

      if (trimmed === ".") break;
      if (trimmed === "/cancel") {
        this.notify("compose cancelled");
        return "";
      }

      lines.push(line);
    }

    return lines.join("\n").trim();
  }

  async editorInput() {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tmux-acp-hub-prompt-"));
    const filePath = path.join(tempDir, "prompt.md");

    try {
      await fsp.writeFile(filePath, "", "utf8");
      this.notify(`opening ${editor}; save and quit to send, leave empty to cancel`);

      const result = spawnSync("sh", ["-lc", `${editor} ${shellQuote(filePath)}`], {
        stdio: "inherit",
      });

      if (result.error) {
        this.logLine(c("red", result.error.message));
        return "";
      }

      if (result.status) {
        this.notify("editor cancelled");
        return "";
      }

      return (await fsp.readFile(filePath, "utf8")).trim();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async sendAgentText(text) {
    const cleanText = String(text || "").trim();
    const attachments = this.pendingAttachments;
    if (!cleanText && !attachments.length) return;

    try {
      const result = await this.hub.call("send_prompt", {
        chatId: this.currentChat.id,
        text: cleanText,
        attachments,
      });
      // Remembered for cancel-to-edit: cancelling the turn puts this text
      // back into the empty composer for a quick tweak-and-resend.
      this.lastSentPrompt = { chatId: this.currentChat.id, text: cleanText };
      if (result?.queued) {
        this.notify(`queued (${result.queueLength} pending) — sends when the current turn finishes`);
      }
      this.pendingAttachments = [];
      this.refreshRawInputPrompt();
    } catch (error) {
      this.logLine(c("red", error.message));
    }
  }

  attachPathInput(text) {
    const attachments = attachmentsFromPathOnlyText(text, this.currentChat?.cwd || this.cwd);
    if (!attachments.length) return false;

    const added = this.addPendingAttachments(attachments);
    this.refreshRawInputPrompt();
    this.notifyAttachmentResult(added, attachments.length, "path");
    return true;
  }

  addPendingAttachments(attachments) {
    const added = [];
    for (const attachment of attachments || []) {
      if (!attachment?.path) continue;
      const exists = this.pendingAttachments.some((item) => item.path === attachment.path);
      if (exists) continue;
      // Stable per-batch number: chips and inline [Kind #n] tokens must keep
      // matching after a /detach, so it never reuses a live number.
      if (!this.pendingAttachments.length) this.attachmentSeq = 0;
      attachment.n = ++this.attachmentSeq;
      this.pendingAttachments.push(attachment);
      added.push(attachment);
    }
    return added;
  }

  notifyAttachmentResult(added, requested, source = "attach") {
    if (added.length) {
      const imageCount = added.filter((attachment) => attachment.kind === "image").length;
      const fileCount = added.length - imageCount;
      const parts = [
        imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "",
        fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      this.notify(`attached ${parts.join(", ")} from ${source}; Enter sends`);
      return;
    }

    this.notify(`${requested} file${requested === 1 ? "" : "s"} already attached`);
  }

  async renameCurrentChat(title) {
    const cleanTitle = cleanInline(title);
    if (!cleanTitle) {
      this.notify("usage: /rename <title>");
      return;
    }

    const chat = await this.hub.call("rename_chat", {
      chatId: this.currentChat.id,
      title: cleanTitle,
    });
    this.currentChat = chat;
    this.syncTmuxWindow(this.currentChat, { force: true });
    this.notify(`renamed: ${cleanTitle}`);
  }

  async deleteCurrentChat() {
    const chatId = this.currentChat?.id;
    if (!chatId) return false;

    const answer = (await this.question("Delete this chat permanently? (y/N) ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      this.notify("delete cancelled");
      return false;
    }

    try {
      // Deleting the current chat closes its window; the popup then falls back
      // to the menu (or another chat). The daemon kills the tab for us.
      const result = await this.hub.call("delete_chat", { chatId });
      this.notify(
        result.providerDeleted
          ? "chat deleted"
          : "chat removed locally (provider keeps the saved session)",
      );
      return true;
    } catch (error) {
      this.logLine(c("red", `Delete failed: ${error.message}`));
      return false;
    }
  }

  async printChats() {
    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    if (!chats.length) {
      this.logLine(c("dim", "No chats yet"));
      return;
    }

    this.renderGroupedChats(this.orderChatsForDisplay(chats));
  }

  printHelp() {
    this.logLine("/menu              open agent/chat menu");
    this.logLine("/control           open tmux command center");
    this.logLine("/chats             list daemon chats");
    this.logLine("/compose           write a multiline prompt; finish with a single .");
    this.logLine("/edit              write a prompt in $VISUAL or $EDITOR");
    this.logLine("/new <agent>       create a new provider chat for this project");
    this.logLine("/refresh           discover saved ACP sessions from providers");
    this.logLine("/config [id value] show or set ACP session config options");
    this.logLine("/model <value>     set model config option when available");
    this.logLine("/effort <value>    set effort/reasoning config when available");
    this.logLine("/commands          show provider commands reported by ACP");
    this.logLine("/modes             show ACP modes reported by the provider");
    this.logLine("/mode <value>      set ACP session mode");
    this.logLine("/access <profile>  set read-only/agent/full/plan/auto access alias");
    this.logLine("/roots             show additional workspace directories");
    this.logLine("/roots add <path>  add an extra workspace directory for next restore");
    this.logLine("/changes           browse files edited in this chat as git-style diffs");
    this.logLine("/attach <path>     attach file(s) to the next prompt");
    this.logLine("/attachments       show pending prompt attachments");
    this.logLine("/detach <n>|all    remove pending prompt attachments");
    this.logLine("@file              mention and attach a project file; Tab completes");
    this.logLine("//command          send a slash command directly to the provider");
    this.logLine("/agent <text>      send raw text directly to the provider");
    this.logLine("/cancel            cancel current ACP turn (Esc while responding too)");
    this.logLine("/allow <n>         choose a pending permission option");
    this.logLine("/deny              reject or cancel a pending permission");
    this.logLine("/rename <title>    rename this chat for menus/search");
    this.logLine("/close             close this chat and stop its ACP adapter");
    this.logLine("/activity <mode>   tool activity: compact, hidden, debug");
    this.logLine("/vim               toggle vim editing mode in the composer");
    this.logLine("/debug             toggle internal ACP hub logs in the chat pane");
    this.logLine("/restart           restart the hub daemon (chats kept; reopen with prefix+m)");
    this.logLine("/exit              close popup client only");
  }

  printConfig() {
    const chat = this.currentChat || {};
    this.logLine("");
    this.logLine(c("bold", "ACP Config"));
    this.logLine(`provider           ${chat.providerLabel || chat.provider}`);
    this.logLine(`mode               ${chat.mode || "-"}`);

    const options = chat.configOptions || [];
    if (!options.length) {
      this.logLine(c("dim", "No config options reported by this adapter yet."));
      return;
    }

    for (const option of options) {
      this.logLine(formatConfigOption(option));
    }
  }

  async handleConfigCommand(line) {
    const rest = line === "/config" ? "" : line.slice(8).trim();
    if (!rest) return false;

    const parts = splitCommandWords(rest);
    const configId = parts.shift() || "";
    const value = parts.join(" ").trim();

    if (!configId) return false;
    if (!value) {
      if (this.showConfigOptionPanel(configId)) return true;
      this.textFallback("ACP config option menu unavailable", () => this.printConfigOption(configId));
      return true;
    }

    await this.applyConfigOption(configId, value);
    return true;
  }

  async handleShortcutConfigCommand(configId, value) {
    if (!value) {
      if (this.showConfigOptionPanel(configId)) return;
      this.textFallback("ACP config option menu unavailable", () => this.printConfigOption(configId));
      return;
    }

    await this.applyConfigOption(configId, value);
  }

  printConfigOption(configId) {
    const option = resolveConfigOption(this.currentChat?.configOptions || [], configId);
    this.logLine("");

    if (!option) {
      this.logLine(c("yellow", `No ACP config option found for ${configId}.`));
      this.logLine(c("dim", "Use /config to inspect the options reported by this adapter."));
      return;
    }

    const id = configOptionId(option);
    this.logLine(c("bold", `ACP Config: ${id}`));
    this.logLine(formatConfigOption(option));

    const values = configOptionValues(option);
    if (!values.length && !isBooleanConfigOption(option)) {
      this.logLine(c("dim", `Use /config ${id} <value>.`));
      return;
    }

    if (isBooleanConfigOption(option)) {
      this.logLine(`${c("dim", "values")} true, false`);
      return;
    }

    this.logLine(c("dim", "values"));
    for (const entry of values.slice(0, 80)) {
      const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
      const label = entry.label && entry.label !== entry.value ? ` ${c("dim", entry.label)}` : "";
      this.logLine(`${marker} ${entry.value}${label}`);
    }
  }

  async applyConfigOption(configId, value) {
    if (!this.currentChat?.id) return;

    try {
      const result = await this.hub.call("set_config_option", {
        chatId: this.currentChat.id,
        configId,
        value,
      });
      this.currentChat = result.chat || this.currentChat;
      this.syncTmuxWindow(this.currentChat, { force: true });
      this.refreshRawInputPrompt();
      this.notify(`ACP config ${result.configId || configId}=${valueLabel(result.value) || value}`);
    } catch (error) {
      this.logLine(c("red", error.message || String(error)));
      if (this.showConfigOptionPanel(configId)) return;
      this.textFallback("ACP config options unavailable", () => this.printConfigOption(configId));
    }
  }

  // Tab (+1) / Shift+Tab (-1) step through the adapter's advertised modes,
  // wrapping around. Modes are a behavior axis (Claude plan/default/…),
  // independent of the model (/model); the footer's access label reflects the
  // new mode, so the change is visible without opening the picker.
  async cycleMode(direction) {
    if (this.cyclingMode) return;
    const modes = modeEntries(this.currentChat?.modes);
    if (modes.length < 2) {
      this.notify(modes.length ? "only one mode available" : "no modes for this adapter");
      return;
    }

    const idOf = (mode) => String(mode.id || mode.modeId || mode.name || mode);
    const current = String(this.currentChat?.mode ?? "");
    let index = modes.findIndex((mode) =>
      [mode?.id, mode?.modeId, mode?.name, mode?.label, mode?.title]
        .filter(Boolean)
        .map(String)
        .includes(current),
    );
    if (index === -1) index = 0;

    const nextId = idOf(modes[(index + direction + modes.length) % modes.length]);
    if (!nextId || nextId === current) return;

    this.cyclingMode = true;
    try {
      await this.applyMode(nextId, { silent: true });
    } finally {
      this.cyclingMode = false;
    }
  }

  async applyMode(modeId, { silent = false } = {}) {
    if (!modeId) {
      this.printModes();
      return;
    }
    if (!this.currentChat?.id) return;

    try {
      const result = await this.hub.call("set_mode", {
        chatId: this.currentChat.id,
        modeId,
      });
      this.currentChat = result.chat || this.currentChat;
      this.syncTmuxWindow(this.currentChat, { force: true });
      this.refreshRawInputPrompt();
      // Tab-cycling already shows the mode live in the hint and footer, so it
      // suppresses this toast — otherwise the same value shows up three times.
      if (!silent) this.notify(`ACP mode=${result.modeId || modeId}`);
    } catch (error) {
      this.logLine(c("red", error.message || String(error)));
      if (this.showModesPanel()) return;
      this.textFallback("ACP modes menu unavailable", () => this.printModes());
    }
  }

  printAccessHelp() {
    this.logLine("");
    this.logLine(c("bold", "Access / Permission Modes"));
    this.logLine(`provider           ${this.currentChat?.providerLabel || this.currentChat?.provider || "-"}`);
    this.logLine(`current            ${this.currentChat?.mode || "-"}`);
    this.logLine("");
    this.logLine("/access read-only  read/plan mode when available");
    this.logLine("/access agent      normal/default agent mode");
    this.logLine("/access full       bypass/don't-ask/full access when available");
    this.logLine("/access plan       planning mode when available");
    this.logLine("/access auto       provider auto permission mode when available");
    this.logLine("");
    this.printModes();
  }

  async applyAccess(value) {
    if (!value) {
      this.printAccessHelp();
      return;
    }

    const target = resolveAccessTarget(this.currentChat, value);
    if (!target) {
      this.logLine(c("yellow", `No access mode matching ${value}.`));
      if (this.showAccessPanel()) return;
      this.textFallback("Access menu unavailable", () => this.printAccessHelp());
      return;
    }

    if (target.kind === "mode") {
      await this.applyMode(target.value);
    } else {
      await this.applyConfigOption(target.configId, target.value);
    }
  }

  async handleRootsCommand(line) {
    const rest = line === "/roots" ? "" : line.slice(7).trim();
    const parts = splitCommandWords(rest);
    const action = parts.shift() || "list";

    if (["list", "ls", "show"].includes(action)) {
      if (this.showRootsPanel()) return;
      this.textFallback("Workspace roots panel unavailable", () => this.printRoots());
      return;
    }

    if (["add", "+", "remove", "rm", "delete", "del", "clear"].includes(action)) {
      await this.updateRoots(action, parts);
      return;
    }

    this.logLine(c("yellow", "Usage: /roots, /roots add <path>, /roots remove <path>, /roots clear"));
  }

  printRoots() {
    const chat = this.currentChat || {};
    const roots = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || this.cwd);
    this.logLine("");
    this.logLine(c("bold", "Workspace Roots"));
    this.logLine(`main               ${displayPath(chat.cwd || this.cwd)}`);
    if (!roots.length) {
      this.logLine(c("dim", "No additional directories configured."));
      this.logLine(c("dim", "Use /roots add <path>; active sessions apply changes after /close and reopen."));
      return;
    }

    roots.forEach((root, index) => {
      this.logLine(`${index + 1}. ${displayPath(root)}`);
    });
  }

  async updateRoots(action, args) {
    if (!this.currentChat?.id) return;

    const current = normalizeAdditionalDirectories(
      this.currentChat.additionalDirectories || [],
      this.currentChat.cwd || this.cwd,
    );
    let next = current;

    if (action === "clear") {
      next = [];
    } else if (["add", "+"].includes(action)) {
      let dir = args.join(" ").trim();
      if (!dir) {
        // Bare /roots add (typed, or submitted by the panel) prompts here so the
        // path is read in-process, never through a tmux/shell command string.
        dir = (await this.question("Add workspace directory: ")).trim();
        if (!dir) {
          this.notify("cancelled");
          return;
        }
      }
      next = normalizeAdditionalDirectories([...current, dir], this.currentChat.cwd || this.cwd);
    } else {
      if (!args.length) {
        this.logLine(c("yellow", "Usage: /roots remove <path-or-number>"));
        return;
      }
      const query = args.join(" ");
      const number = Number(query);
      if (Number.isInteger(number) && number >= 1 && number <= current.length) {
        next = current.filter((_, index) => index !== number - 1);
      } else {
        const resolved = normalizeAdditionalDirectories([query], this.currentChat.cwd || this.cwd)[0];
        next = current.filter((root) => root !== resolved);
      }
    }

    const result = await this.hub.call("set_roots", {
      chatId: this.currentChat.id,
      additionalDirectories: next,
    });
    this.currentChat = result.chat || this.currentChat;
    this.syncTmuxWindow(this.currentChat, { force: true });
    if (this.tmuxPane() && !this.showInternalEvents) {
      this.notify(`workspace roots saved${result.requiresRestart ? "; restart adapter to apply" : ""}`);
    } else {
      this.printRoots();
      if (result.requiresRestart) {
        this.logLine(c("dim", "Root changes are saved; use /close and reopen this chat to pass them to ACP."));
      }
    }
  }

  async handleAttachCommand(line) {
    const rest = line === "/attach" ? "" : line.slice(8).trim();
    let files = splitCommandWords(rest);

    if (!files.length) {
      // Bare /attach (typed, or submitted by the panel action) prompts here so
      // the path is read in-process — it never passes through a tmux/shell
      // command string, so quotes or spaces in a path can't break or inject.
      const answer = (await this.question("Attach file: ")).trim();
      files = splitCommandWords(answer);
      if (!files.length) {
        this.notify("attach cancelled");
        return;
      }
    }

    const added = [];
    for (const file of files) {
      try {
        const attachment = await resolvePromptAttachment(file, this.currentChat?.cwd || this.cwd);
        added.push(...this.addPendingAttachments([attachment]));
      } catch (error) {
        this.logLine(c("red", `attach failed: ${file}: ${error.message || String(error)}`));
      }
    }

    if (added.length) {
      this.notify(`attached ${added.length} file(s) for next prompt`);
      this.refreshRawInputPrompt();
    }
  }

  printAttachments() {
    this.logLine("");
    this.logLine(c("bold", "Pending Attachments"));
    if (!this.pendingAttachments.length) {
      this.logLine(c("dim", "No files attached. Use /attach <path>."));
      return;
    }

    this.pendingAttachments.forEach((attachment, index) => {
      this.logLine(
        `${attachmentChip(attachment, index)} ${c("dim", attachment.mimeType)} ${c(
          "dim",
          formatBytes(attachment.size),
        )} ${c(
          "dim",
          displayPath(attachment.path),
        )}`,
      );
    });
    this.logLine(c("dim", "Use /detach <n>, /detach last, or /detach all to remove pending attachments."));
  }

  detachAttachments(line) {
    const rest = line === "/detach" ? "all" : line.slice(8).trim();
    if (!this.pendingAttachments.length) {
      this.notify("no pending attachments");
      return;
    }

    if (!rest || rest === "all" || rest === "clear") {
      const count = this.pendingAttachments.length;
      this.pendingAttachments = [];
      this.notify(`detached ${count} file(s)`);
      this.refreshRawInputPrompt();
      return;
    }

    if (["last", "-1"].includes(rest)) {
      const removed = this.pendingAttachments.pop();
      this.notify(`detached ${removed.name}`);
      this.refreshRawInputPrompt();
      return;
    }

    const number = Number(rest);
    // Chips display the stable #n, so /detach matches on it (not position).
    const index = this.pendingAttachments.findIndex((item) => item.n === number);
    if (!Number.isInteger(number) || index === -1) {
      this.notify("usage: /detach <n>|last|all");
      return;
    }

    const [removed] = this.pendingAttachments.splice(index, 1);
    this.notify(`detached ${removed.name}`);
    this.refreshRawInputPrompt();
  }

  detachLastAttachmentFromComposer(session) {
    const removed = this.pendingAttachments.pop();
    if (!removed) return;
    session.lastPasteSummary = `removed ${removed.name || path.basename(removed.path || "") || "attachment"}`;
    this.refreshRawInputPrompt({ render: false });
  }

  printProviderCommands() {
    const commands = this.currentChat?.availableCommands || [];
    this.logLine("");
    this.logLine(c("bold", "Provider Commands"));

    if (!commands.length) {
      this.logLine(c("dim", "No provider commands reported by ACP yet."));
      this.logLine(c("dim", "Provider slash commands can still be sent with //command."));
      return;
    }

    for (const command of commands) {
      this.logLine(formatProviderCommand(command));
    }

    this.logLine(c("dim", "Use //command or /agent <text> to send provider-specific slash commands."));
  }

  printModes() {
    const modes = this.currentChat?.modes || null;
    this.logLine("");
    this.logLine(c("bold", "ACP Modes"));
    this.logLine(`current            ${this.currentChat?.mode || "-"}`);

    if (!modes) {
      this.logLine(c("dim", "No modes reported by this adapter yet."));
      return;
    }

    const entries = modes.availableModes || modes.modes || modes.options || [];
    if (!Array.isArray(entries) || !entries.length) {
      this.logLine(c("dim", JSON.stringify(modes)));
      return;
    }

    for (const mode of entries) {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      const marker = id === this.currentChat?.mode ? "*" : " ";
      this.logLine(`${marker} ${id} ${c("dim", label === id ? "" : label)}`);
    }
  }

  async showAgentMenu() {
    if (!this.tmuxPane()) return false;

    // Run the tmux-menu subcommand out of process: it lives in the CLI entry
    // point, which imports this module — calling it directly would need a
    // circular import.
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            HUB_CLI_PATH,
            "tmux-menu",
            "--cwd", this.cwd,
            "--session", this.tmuxFormat("#{session_name}"),
            "--client", this.tmuxFormat("#{client_name}"),
            "--pane", this.tmuxPane(),
          ],
          { stdio: "ignore" },
        );
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`tmux-menu exited ${code}`)),
        );
      });
      return true;
    } catch (error) {
      this.notify(`acp-hub menu failed: ${error.message || String(error)}`);
      return false;
    }
  }

  async buildChatsPickerItems() {
    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    const visibleChats = this.orderChatsForDisplay(chats).slice(0, 40);

    const items = [];
    let currentGroup = "";
    for (const chat of visibleChats) {
      const group =
        chat.cwd === this.cwd ? `${chat.projectName} · current project` : chat.projectName;
      if (group !== currentGroup) {
        items.push({ label: c("bold", group), disabled: true });
        currentGroup = group;
      }

      const isCurrent = chat.id === this.currentChat?.id;
      const title = truncateText(cleanInline(chat.title || chat.id), 44);
      const meta = [formatRelativeAge(chat.updatedAt), chat.mode, chatConfigLabel(chat)]
        .filter(Boolean)
        .join(" · ");
      const status = chat.active ? `  ${statusIndicator(chat.status)}` : "";
      items.push({
        label: `${coloredProviderIcon(chat)} ${c("bold", title)}${status}${
          meta ? `  ${c("dim", meta)}` : ""
        }`,
        searchText: [chat.provider, chat.projectName, chat.title, chat.status, chat.cwd]
          .filter(Boolean)
          .join(" "),
        current: isCurrent,
        canRename: true,
        // The open chat is deleted with /delete (it needs the return-to-menu
        // flow); everything else can be pruned right from the list.
        canDelete: !isCurrent,
        // Only live chats have an adapter to receive a prompt.
        canReply: Boolean(chat.active),
        renameInitial: cleanInline(chat.title || ""),
        value: { cwd: chat.cwd, provider: chat.provider, chatId: chat.id },
      });
    }

    return items;
  }

  async showChatsPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const items = await this.buildChatsPickerItems();
    if (!items.length) return false;

    const picked = await this.interactivePick({
      title: "ACP Chats",
      hint: "j/k move · Enter/l switch · / filter · ^S reply · ^E rename · ^D delete · Esc",
      items,
      // Same sticky behavior as the menu: land on the chat we're in.
      initialValue: this.currentChat?.id
        ? { cwd: this.currentChat.cwd, provider: this.currentChat.provider, chatId: this.currentChat.id }
        : null,
      onReply: (entry, text) => this.replyToChatFromPicker(entry, text),
      onRename: async (entry, title) => {
        try {
          await this.hub.call("rename_chat", { chatId: entry.value.chatId, title });
          if (entry.value.chatId === this.currentChat?.id) {
            this.currentChat = { ...this.currentChat, title };
            this.syncTmuxWindow(this.currentChat, { force: true });
          }
        } catch (error) {
          this.notify(`acp-hub: rename failed: ${error.message || String(error)}`);
        }
        return this.buildChatsPickerItems();
      },
      onDelete: async (entry) => {
        try {
          await this.hub.call("delete_chat", { chatId: entry.value.chatId });
        } catch (error) {
          this.notify(`acp-hub: delete failed: ${error.message || String(error)}`);
        }
        return this.buildChatsPickerItems();
      },
      onPreview: async (entry) => {
        const chatId = entry.value?.chatId;
        if (!chatId) return null;
        return this.hub.call("chat_preview", { chatId });
      },
    });

    if (picked && picked.chatId !== this.currentChat?.id) {
      this.switchToChatWindow(picked);
    }
    return true;
  }

  // The full ACP Hub menu as an overlay in the current chat's pane (← or
  // prefix+M inside a chat) instead of a separate window. Reuses the same
  // picker as the menu-host process; a selection focuses the target chat's
  // window (or creates one), leaving this pane on its own chat. Returns false
  // when the popup can't paint pinned so callers fall back.
  // Back out of the composer to the menu overlay: save the current input as a
  // draft (restored on return), close the input resolving empty, and flag the
  // chat loop to open the overlay. Shared by ← (empty) and Ctrl+O (any input).
  triggerMenuFromComposer(session, finish) {
    if (
      !this.currentChat?.id ||
      this.scrollOffsetRows !== 0 ||
      !this.pickerSupported() ||
      !this.canPaintPinned()
    ) {
      return false;
    }
    this.saveRawDraft(session);
    this.pendingComposerAction = "menu";
    finish("");
    return true;
  }

  // Ctrl+T (and prefix+, / the panel "Rename chat" action, which route here)
  // rename via the in-process prompt below — the title never touches a shell or
  // tmux command string, so quotes/apostrophes in a title can't break or inject.
  triggerRenameFromComposer(session, finish) {
    if (!this.currentChat?.id) return false;
    this.saveRawDraft(session);
    this.pendingComposerAction = "rename";
    finish("");
    return true;
  }

  async renameChatInteractive() {
    if (!this.currentChat?.id) {
      this.notify("open a chat first");
      return;
    }
    const current = this.currentChat.title || "";
    const answer = (await this.question("Rename chat: ", { initial: current })).trim();
    if (!answer) {
      this.notify("rename cancelled");
      return;
    }
    await this.renameCurrentChat(answer);
  }

  async showMenuOverlay() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    // deferBackdrop: the picker leaves the pane on the menu frame instead of
    // repainting this chat. When we navigate to another window we switch first
    // (so the new chat shows immediately, no flash of this one) and only then
    // repaint this chat in the now-background pane; when we stay, we repaint it.
    const selection = await this.runMenuPicker({ deferBackdrop: true });

    const navigates =
      (selection?.type === "chat" && selection.chatId !== this.currentChat?.id) ||
      selection?.type === "new";

    if (navigates) {
      if (selection.type === "chat") {
        this.switchToChatWindow(selection);
      } else {
        this.switchToChatWindow({ cwd: this.cwd, provider: selection.provider, action: "new" });
      }
    }
    // Repaint this chat: hidden underneath the switched-to window when we
    // navigated, visible again when we stayed (Esc or the current chat).
    this.restorePickerBackdrop();
    return true;
  }

  // Send a one-line prompt to a live chat straight from a picker, without
  // switching to its window. Only offered for active chats (canReply), so the
  // adapter is running; an idle chat starts a turn, a busy one queues it.
  async replyToChatFromPicker(entry, text) {
    const chatId = entry?.value?.chatId;
    if (!chatId) return;
    try {
      await this.hub.call("send_prompt", { chatId, text });
    } catch (error) {
      this.notify(`acp-hub: reply failed: ${error.message || String(error)}`);
    }
  }

  // Switching chats means selecting (or creating) that chat's tmux window;
  // workspace.sh owns that logic, so run it through tmux.
  // Runs synchronously (run-shell blocks until workspace.sh finishes) so the
  // target chat window exists before the caller — the menu process — exits;
  // otherwise auto-closing the menu window could leave the session empty and
  // tear it down before the chat window is created.
  switchToChatWindow({ cwd, provider, chatId = "", action = "open" }) {
    const command = tmuxWorkspaceShellCommand(cwd, this.tmuxContext(), provider, chatId, action);
    try {
      const res = spawnSync("tmux", ["run-shell", command], { stdio: "ignore" });
      return !res.error && res.status === 0;
    } catch {
      this.notify("acp-hub: failed to switch chat window");
      return false;
    }
  }

  // Inline picker: /model, /effort, /modes, /access (and every quickSelect
  // while the composer is live, permissions included) render in the dropdown
  // zone below the input — the composer stays on screen but is NOT focused:
  // the picker captures every key until a choice is made or it's dismissed.
  inlinePickerSpecFor(line) {
    switch (line) {
      case "/model":
        return this.configPickerSpec("model", "Model");
      case "/effort":
      case "/reasoning":
        return this.configPickerSpec("effort", "Effort");
      case "/mode":
      case "/modes":
        return this.modesPickerSpec();
      case "/access":
      case "/permissions":
        return this.accessPickerSpec();
      default:
        return null;
    }
  }

  // The composer can host an inline picker only when its boxed, pinned layout
  // (the dropdown zone) is on screen.
  canHostInlinePicker(session = this.rawInput) {
    return Boolean(
      session &&
        !session.done &&
        this.shouldUseBoxedComposer() &&
        session.pinned !== false &&
        process.stdout.isTTY,
    );
  }

  // Open the list and resolve with the chosen value (null = dismissed).
  openInlinePicker({ title, items, index = 0 }) {
    if (this.inlinePicker || !this.canHostInlinePicker()) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      this.inlinePicker = {
        title,
        hint: `1-${Math.min(items.length, 9)} pick · j/k move · Enter/l · Esc/h`,
        items,
        index: Math.max(0, index),
        resolve,
      };
      this.renderRawInput();
    });
  }

  closeInlinePicker(value = null) {
    const picker = this.inlinePicker;
    this.inlinePicker = null;
    if (this.rawInput) this.renderRawInput();
    picker?.resolve?.(value);
  }

  maybeOpenInlinePicker(session) {
    if (this.inlinePicker) return false;
    if (!this.canHostInlinePicker(session)) return false;
    if (!this.currentChat?.id) return false;

    const spec = this.inlinePickerSpecFor(session.line.trim());
    if (!spec || !spec.items.length) return false;

    session.line = "";
    session.cursor = 0;
    this.saveRawDraft(session);

    const index = Math.max(0, spec.items.findIndex((item) => item.current));
    this.openInlinePicker({ title: spec.title, items: spec.items, index })
      .then((value) => {
        if (value !== null && value !== undefined) return spec.apply(value);
        return null;
      })
      .catch((error) => this.logLine(c("red", error.message || String(error))));
    return true;
  }

  handleInlinePickerKey(session, input, key) {
    const picker = this.inlinePicker;
    if (!picker) return false;

    const move = (delta) => {
      picker.index = (picker.index + delta + picker.items.length) % picker.items.length;
      this.renderRawInput();
    };

    if (key.name === "escape" || input === "h" || (key.ctrl && key.name === "c")) {
      this.closeInlinePicker(null);
      return true;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p") || input === "k") {
      move(-1);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "tab" || input === "j") {
      move(1);
      return true;
    }
    if (input === "g") {
      picker.index = 0;
      this.renderRawInput();
      return true;
    }
    if (input === "G") {
      picker.index = picker.items.length - 1;
      this.renderRawInput();
      return true;
    }
    if (key.name === "return" || key.name === "enter" || input === "l") {
      this.closeInlinePicker(picker.items[picker.index]?.value ?? null);
      return true;
    }
    if (input && /^[1-9]$/.test(input)) {
      const n = Number(input) - 1;
      if (n < picker.items.length) this.closeInlinePicker(picker.items[n].value);
      return true;
    }

    // The picker owns the keyboard: everything else is swallowed until the
    // user picks or backs out — nothing leaks into the composer.
    return true;
  }

  // Spec builders shared by the inline (composer dropdown) and full-screen
  // quick-select paths: {title, items, apply(value)} or null when the chat
  // doesn't expose that option.
  configPickerSpec(configId, title) {
    const option = resolveConfigOption(this.currentChat?.configOptions || [], configId);
    if (!option) return null;

    const id = configOptionId(option);
    const values = configOptionMenuValues(option);
    if (!values.length) return null;

    const items = values.map((entry) => ({
      label: `${entry.value}${
        entry.label && entry.label !== entry.value ? c("dim", ` · ${entry.label}`) : ""
      }`,
      searchText: `${entry.value} ${entry.label || ""}`,
      current: configOptionValueMatches(option, entry.value),
      value: entry.value,
    }));

    return {
      title: `${title} · ${this.currentChat?.providerLabel || this.currentChat?.provider || ""}`,
      items,
      apply: (value) => this.applyConfigOption(id, value),
    };
  }

  async showConfigOptionPicker(configId, title) {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const spec = this.configPickerSpec(configId, title);
    if (!spec) return false;

    const picked = await this.quickSelect({ title: spec.title, items: spec.items });
    if (picked !== null) await spec.apply(picked);
    return true;
  }

  // Interactive picker over the pending permission's options (the plan-mode
  // approval submenu). ACP carries flat options ({optionId, name, kind}) — no
  // per-option previews or free-text notes exist at the protocol level.
  // A permission arrived while the composer was blocked waiting for input.
  // Break out of that prompt (saving the draft) and flag the chat loop to open
  // the picker. Guarded so it fires once per request and never over a picker.
  maybeInterruptForPermission() {
    const session = this.rawInput;
    if (!session || session.done) return;
    // Only the main draft-backed composer; never cancel a nested prompt
    // (rename, delete y/N, attach) — those resolve first, then the top-of-loop
    // check opens the picker.
    if (!session.draftKey) return;
    if (this.activePicker) return;
    if (!this.pendingPermission) return;
    if (this.autoShownPermissionId === this.pendingPermission.permissionId) return;
    if (!this.pickerSupported() || !this.canPaintPinned()) return;
    this.saveRawDraft(session);
    this.pendingComposerAction = "permission";
    session.finish("");
  }

  // Open the pending permission's picker once. Returns true if it was shown, so
  // the caller can `continue`. After Esc keeps the request pending, the id guard
  // stops it from reopening — the composer takes over (numbers still answer).
  async maybeAutoOpenPermission() {
    const pending = this.pendingPermission;
    if (!pending) return false;
    if (this.autoShownPermissionId === pending.permissionId) return false;
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;
    this.autoShownPermissionId = pending.permissionId;
    return this.showPermissionPicker();
  }

  async showPermissionPicker() {
    const pending = this.pendingPermission;
    if (!pending) return false;
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const options = pending.options || [];
    if (!options.length) return false;

    const kindHints = {
      allow_once: "allow once",
      allow_always: "always allow",
      reject_once: "reject once",
      reject_always: "always reject",
    };
    const items = options.map((option, index) => {
      const name = option.name || option.optionId || `option ${index + 1}`;
      const kind = option.kind ? kindHints[option.kind] || option.kind : "";
      return {
        label: `${name}${kind ? c("dim", ` · ${kind}`) : ""}`,
        searchText: `${name} ${kind}`,
        current: index === 0,
        value: option.optionId || String(index),
      };
    });

    const tool = pending.toolCall || {};
    const picked = await this.quickSelect({
      title: `⏸ Permission · ${cleanInline(tool.title || "Agent request")}`,
      hint: `1-${Math.min(items.length, 9)} pick · ↑↓/jk move · Enter/l · Esc/h keeps pending`,
      items,
    });

    // Esc keeps the request pending (/allow <n> still works); a response that
    // raced another client is dropped silently.
    if (picked === null) return true;
    if (this.pendingPermission !== pending) return true;

    try {
      await this.hub.call("permission_response", {
        permissionId: pending.permissionId,
        optionId: picked,
      });
      this.pendingPermission = null;
    } catch (error) {
      this.logLine(c("red", `Permission response failed: ${error.message}`));
    }
    return true;
  }

  modesPickerSpec() {
    const modes = modeEntries(this.currentChat?.modes);
    if (!modes.length) return null;

    const items = modes.map((mode) => {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      return {
        label: `${id}${label === id ? "" : c("dim", ` · ${label}`)}`,
        searchText: `${id} ${label}`,
        current: id === this.currentChat?.mode,
        value: id,
      };
    });

    return {
      title: `Mode · ${this.currentChat?.providerLabel || this.currentChat?.provider || ""}`,
      items,
      apply: (value) => this.applyMode(value),
    };
  }

  async showModesPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const spec = this.modesPickerSpec();
    if (!spec) return false;

    const picked = await this.quickSelect({ title: spec.title, items: spec.items });
    if (picked !== null) await spec.apply(picked);
    return true;
  }

  accessPickerSpec() {
    const chat = this.currentChat;
    if (!chat) return null;

    const profiles = [
      ["read-only", "Read-only / plan"],
      ["agent", "Agent / default"],
      ["full", "Full access / don't ask"],
      ["plan", "Plan"],
      ["auto", "Auto"],
    ];

    const items = [];
    for (const [profile, label] of profiles) {
      const target = resolveAccessTarget(chat, profile);
      if (!target) continue;
      const targetLabel =
        target.kind === "mode" ? `mode=${target.value}` : `${target.configId}=${target.value}`;
      const option =
        target.kind === "mode" ? null : resolveConfigOption(chat.configOptions || [], target.configId);
      const isCurrent =
        target.kind === "mode"
          ? target.value === chat.mode
          : Boolean(option && configOptionValueMatches(option, target.value));
      items.push({
        label: `${label}  ${c("dim", targetLabel)}`,
        searchText: `${profile} ${label} ${targetLabel}`,
        current: isCurrent,
        value: profile,
      });
    }
    if (!items.length) return null;

    return {
      title: `Access · ${chat.providerLabel || chat.provider || ""}`,
      items,
      apply: (value) => this.applyAccess(value),
    };
  }

  async showAccessPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const spec = this.accessPickerSpec();
    if (!spec) return false;

    const picked = await this.quickSelect({ title: spec.title, items: spec.items });
    if (picked !== null) await spec.apply(picked);
    return true;
  }

  async showChatsMenu() {
    if (!this.tmuxPane()) return false;

    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    const visibleChats = this.orderChatsForDisplay(chats).slice(0, 30);
    const context = this.tmuxContext();
    const items = [];

    if (!visibleChats.length) {
      items.push({ label: "No chats yet", disabled: true });
      return this.showTmuxMenu("ACP Chats", items);
    }

    let currentGroup = "";
    for (const chat of visibleChats) {
      const group = chat.cwd === this.cwd ? `${chat.projectName} / current project` : chat.projectName;
      if (group !== currentGroup) {
        if (currentGroup) items.push({ separator: true });
        items.push({ label: group, disabled: true });
        currentGroup = group;
      }

      const status = chat.active ? ` · ${chat.status}` : "";
      const title = truncateText(cleanInline(chat.title || chat.id), 46);
      const config = chatConfigLabel(chat);
      const age = formatRelativeAge(chat.updatedAt);
      items.push({
        label: `${providerIconFor(chat.provider, chat)} ${title}${status}${config ? ` · ${config}` : ""}${age ? ` · ${age}` : ""}`,
        command: tmuxRunWorkspace(chat.cwd, context, chat.provider, chat.id),
      });
    }

    if (chats.length > visibleChats.length) {
      items.push({ separator: true });
      items.push({ label: `${chats.length - visibleChats.length} more hidden; use /q in full menu`, disabled: true });
    }

    return this.showTmuxMenu("ACP Chats", items);
  }

  showCommandCenterPanel() {
    const chat = this.currentChat || {};
    const provider = chat.providerLabel || chat.provider || "Agent";
    const project = chat.projectName || projectName(this.cwd);
    const status = chat.status || "unknown";
    const config = chatConfigLabel(chat);
    const subtitle = [status, chat.mode, config].filter(Boolean).join("  ");
    const context = this.tmuxContext();
    const chatId = chat.id || "";

    return this.showTmuxMenu("ACP Command Center", [
      { label: `${provider} - ${project}`, disabled: true },
      { label: subtitle || "ready", disabled: true },
      { separator: true },
      { label: "Chats", key: "s", command: this.tmuxSubmitCommand("/chats") },
      { label: "Full agent menu", key: "m", command: this.tmuxSubmitCommand("/menu") },
      { label: "Refresh provider sessions", key: "r", command: this.tmuxSubmitCommand("/refresh") },
      { separator: true },
      { label: "Provider commands", key: "c", command: tmuxPanelCommand(this.cwd, context, "commands", chatId) },
      { label: "Config", key: "g", command: tmuxPanelCommand(this.cwd, context, "config", chatId) },
      { label: "Model", key: "l", command: tmuxPanelCommand(this.cwd, context, "model", chatId) },
      { label: "Effort / reasoning", key: "f", command: tmuxPanelCommand(this.cwd, context, "effort", chatId) },
      { label: "Modes", key: "o", command: tmuxPanelCommand(this.cwd, context, "modes", chatId) },
      { label: "Plan", key: "P", command: tmuxPanelCommand(this.cwd, context, "plan", chatId) },
      { label: "Access / permissions", key: "a", command: tmuxPanelCommand(this.cwd, context, "access", chatId) },
      { label: "Workspace roots", key: "w", command: tmuxPanelCommand(this.cwd, context, "roots", chatId) },
      { label: "New chat", key: "n", command: tmuxPanelCommand(this.cwd, context, "new", chatId) },
      { separator: true },
      { label: "Compose multiline prompt", key: "p", command: this.tmuxSubmitCommand("/compose") },
      { label: "Open editor prompt", key: "e", command: this.tmuxSubmitCommand("/edit") },
      { label: "File changes (diffs)", key: "D", command: this.tmuxSubmitCommand("/changes") },
      { label: "Attach file to next prompt", key: "t", command: this.tmuxSubmitCommand("/attach") },
      { label: "Rename chat", key: "R", command: this.tmuxSubmitCommand("/rename") },
      { label: "Activity display", key: "v", command: tmuxPanelCommand(this.cwd, context, "activity", chatId) },
      { separator: true },
      { label: "Cancel current turn", key: "x", command: tmuxConfirmActionCommand(this.cwd, context, "cancel", chatId, "Cancel current ACP turn?") },
      { label: "Close adapter", key: "k", command: tmuxConfirmCommand(context, "Close this ACP adapter?", this.tmuxSubmitCommand("/close")) },
      { label: "Close popup", key: "q", command: this.tmuxSubmitCommand("/exit") },
    ]);
  }

  showConfigPanel() {
    const chat = this.currentChat || {};
    const context = this.tmuxContext();
    const chatId = chat.id || "";
    const items = [
      { label: `provider  ${chat.providerLabel || chat.provider || "-"}`, disabled: true },
      { label: `mode      ${chat.mode || "-"}`, disabled: true },
      { separator: true },
    ];

    const options = (chat.configOptions || []).slice(0, 12);
    if (!options.length) {
      items.push({ label: "No config options reported by this adapter yet", disabled: true });
    } else {
      for (const option of options) {
        const id = configOptionId(option);
        items.push({ label: stripAnsi(formatConfigOption(option)), disabled: true });

        const values = configOptionMenuValues(option);
        for (const entry of values.slice(0, 10)) {
          const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
          const label = entry.label && entry.label !== entry.value ? ` ${entry.label}` : "";
          items.push({
            label: `  ${marker} ${truncateText(`${entry.value}${label}`, 62)}`,
            command: tmuxActionCommand(this.cwd, context, "config", chatId, actionPayload({ configId: id, value: entry.value })),
          });
        }
      }
    }

    return this.showTmuxMenu("ACP Config", items);
  }

  showConfigOptionPanel(configId, title = "ACP Config") {
    const option = resolveConfigOption(this.currentChat?.configOptions || [], configId);
    if (!option) return false;

    const context = this.tmuxContext();
    const chatId = this.currentChat?.id || "";
    const id = configOptionId(option);
    const items = [
      { label: stripAnsi(formatConfigOption(option)), disabled: true },
      { separator: true },
    ];

    const values = configOptionMenuValues(option);
    if (!values.length) {
      items.push({ label: `No selectable values. Type /config ${id} <value>.`, disabled: true });
    } else {
      for (const entry of values.slice(0, 40)) {
        const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
        const detail = [entry.label !== entry.value ? entry.label : "", entry.description]
          .filter(Boolean)
          .join(" - ");
        items.push({
          label: `${marker} ${truncateText(`${entry.value}${detail ? ` ${detail}` : ""}`, 70)}`,
          command: tmuxActionCommand(this.cwd, context, "config", chatId, actionPayload({ configId: id, value: entry.value })),
        });
      }
    }

    return this.showTmuxMenu(title, items);
  }

  showAccessPanel() {
    const context = this.tmuxContext();
    const chatId = this.currentChat?.id || "";
    const profiles = [
      ["read-only", "Read-only / plan"],
      ["agent", "Agent / default"],
      ["full", "Full access / don't ask"],
      ["plan", "Plan"],
      ["auto", "Auto"],
    ];
    const items = [
      { label: `current  ${this.currentChat?.mode || "-"}`, disabled: true },
      { separator: true },
    ];

    let enabled = 0;
    for (const [profile, label] of profiles) {
      const target = resolveAccessTarget(this.currentChat, profile);
      if (!target) {
        items.push({ label: `- ${label}`, disabled: true });
        continue;
      }

      enabled += 1;
      const targetLabel =
        target.kind === "mode" ? `mode=${target.value}` : `${target.configId}=${target.value}`;
      items.push({
        label: `${label}  ${targetLabel}`,
        command: tmuxActionCommand(this.cwd, context, "access", chatId, profile),
      });
    }

    if (enabled === 0) {
      items.push({ separator: true });
      items.push({ label: "No matching access modes reported by this adapter", disabled: true });
    }

    const modes = modeEntries(this.currentChat?.modes);
    if (modes.length) {
      items.push({ separator: true });
      items.push({ label: "Reported modes", disabled: true });
      for (const mode of modes.slice(0, 20)) {
        const id = mode.id || mode.modeId || mode.name || String(mode);
        const label = mode.label || mode.title || mode.name || id;
        const marker = id === this.currentChat?.mode ? "*" : " ";
        items.push({
          label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
          command: tmuxActionCommand(this.cwd, context, "mode", chatId, id),
        });
      }
    }

    return this.showTmuxMenu("ACP Access", items);
  }

  showProviderCommandsPanel() {
    const commands = this.currentChat?.availableCommands || [];
    const items = [];

    if (!commands.length) {
      return this.showTmuxMenu("Provider Commands", [
        { label: "No provider commands reported by ACP yet", disabled: true },
        { label: "You can still type //command manually", disabled: true },
      ]);
    }

    items.push({ label: "Select a command to insert it at the prompt", disabled: true });
    items.push({ separator: true });

    for (const command of commands.slice(0, 30)) {
      const name = command.name || command.command || command.id || command.title || "command";
      const text = `//${String(name).replace(/^\/+/, "")}`;
      items.push({
        label: stripAnsi(formatProviderCommand(command)),
        command: this.tmuxInsertCommand(text),
      });
    }

    return this.showTmuxMenu("Provider Commands", items);
  }

  showModesPanel() {
    const modes = this.currentChat?.modes || null;
    const context = this.tmuxContext();
    const chatId = this.currentChat?.id || "";
    const items = [{ label: `current  ${this.currentChat?.mode || "-"}`, disabled: true }];

    if (!modes) {
      items.push({ separator: true });
      items.push({ label: "No modes reported by this adapter yet", disabled: true });
      return this.showTmuxMenu("ACP Modes", items);
    }

    const entries = modes.availableModes || modes.modes || modes.options || [];
    items.push({ separator: true });

    if (!Array.isArray(entries) || !entries.length) {
      items.push({ label: JSON.stringify(modes), disabled: true });
    } else {
      for (const mode of entries.slice(0, 30)) {
        const id = mode.id || mode.modeId || mode.name || String(mode);
        const label = mode.label || mode.title || mode.name || id;
        const marker = id === this.currentChat?.mode ? "*" : " ";
        items.push({
          label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
          command: tmuxActionCommand(this.cwd, context, "mode", chatId, id),
        });
      }
    }

    return this.showTmuxMenu("ACP Modes", items);
  }

  showRootsPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("Workspace Roots", buildRootsPanelItems(this.currentChat, context, this.cwd));
  }

  showPlanPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("ACP Plan", buildPlanPanelItems(this.currentChat, context));
  }

  showTmuxMenu(title, items) {
    const result = displayTmuxMenu(title, items, {
      client: this.tmuxClient(),
      pane: this.tmuxPane(),
    });
    if (!result.ok && this.showInternalEvents && result.error) {
      this.logLine(c("dim", `tmux display-menu failed: ${result.error}`));
    }
    return result.ok;
  }

  tmuxPane() {
    const envPane = process.env.TMUX_PANE || "";
    if (this.isUsableTmuxPane(envPane)) return envPane;

    const chatId = this.currentChat?.id || "";
    if (chatId) {
      const result = spawnSync(
        "tmux",
        ["list-panes", "-a", "-F", "#{pane_id}\t#{@acp_hub_chat_id}\t#{pane_dead}"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );

      if (!result.error && result.status === 0) {
        for (const line of String(result.stdout || "").split("\n")) {
          const [paneId, paneChatId, paneDead] = line.split("\t");
          if (paneId && paneChatId === chatId && paneDead === "0") return paneId;
        }
      }
    }

    const active = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!active.error && active.status === 0 && String(active.stdout || "").trim()) {
      return String(active.stdout || "").trim();
    }

    return envPane;
  }

  isUsableTmuxPane(pane) {
    if (!pane) return false;

    const result = spawnSync(
      "tmux",
      ["display-message", "-p", "-t", pane, "#{pane_dead}\t#{@acp_hub_chat_id}\t#{@acp_hub_provider}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.error || result.status !== 0) return false;

    const [paneDead, chatId, provider] = String(result.stdout || "").trim().split("\t");
    if (paneDead === "1") return false;
    if (this.currentChat?.id) {
      if (chatId && chatId !== this.currentChat.id) return false;
      if (!provider) return false;
    }

    return true;
  }

  tmuxClient() {
    const direct = this.tmuxFormat("#{client_name}");
    if (direct) return direct;

    const active = spawnSync("tmux", ["display-message", "-p", "#{client_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!active.error && active.status === 0 && String(active.stdout || "").trim()) {
      return String(active.stdout || "").trim();
    }

    const session = this.tmuxFormat("#{session_name}");
    if (!session) return "";

    const parent = spawnSync("tmux", ["show-option", "-t", session, "-qv", "@acp_hub_parent_client"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (parent.error || parent.status !== 0) return "";
    return String(parent.stdout || "").trim();
  }

  tmuxFormat(format) {
    const pane = this.tmuxPane();
    if (!pane) return "";

    const result = spawnSync("tmux", ["display-message", "-p", "-t", pane, format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (result.error || result.status !== 0) return "";
    return String(result.stdout || "").trim();
  }

  // Esc on the menu dismisses the list: if a chat window is open in this
  // workspace, reveal it (the popup stays); otherwise there is nothing behind
  // the menu, so minimize the popup. Keeps prefix+M from feeling like it
  // closes the whole session when you only wanted to back out of the list.
  returnFromMenuOrMinimize() {
    if (process.env.TMUX) {
      const session = this.tmuxFormat("#{session_name}");
      if (session) {
        const res = spawnSync(
          "tmux",
          [
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_active}|#{window_last_flag}|#{@acp_hub_action}|#{pane_dead}|#{window_activity}|#{window_id}",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        if (!res.error && res.status === 0) {
          const chats = String(res.stdout || "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [active, last, action, dead, activity, id] = line.split("|");
              return { active, last, action, dead, activity: Number(activity) || 0, id };
            })
            .filter((w) => w.action !== "menu" && w.dead !== "1" && w.active !== "1");

          if (chats.length) {
            // Prefer the window active just before the menu opened.
            const target =
              chats.find((w) => w.last === "1") ||
              chats.sort((a, b) => b.activity - a.activity)[0];
            const sel = spawnSync("tmux", ["select-window", "-t", target.id], { stdio: "ignore" });
            if (!sel.error && sel.status === 0) return;
          }
        }
      }
    }
    // No chat to fall back to: minimize the popup instead.
    this.closePopupClient();
  }

  closePopupClient() {
    const pane = this.tmuxPane();
    if (!pane) return false;

    const session = this.tmuxFormat("#{session_name}");
    const client = this.tmuxFormat("#{client_name}");
    if (!session || !client) return false;

    const projectOption = spawnSync("tmux", ["show-option", "-t", session, "-qv", "@acp_hub_project_path"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (projectOption.error || projectOption.status !== 0 || !String(projectOption.stdout || "").trim()) {
      return false;
    }

    const result = spawnSync("tmux", ["detach-client", "-t", client], {
      stdio: "ignore",
    });
    return !result.error && result.status === 0;
  }

  tmuxContext() {
    return {
      session: this.tmuxFormat("#{session_name}"),
      client: this.tmuxFormat("#{client_name}"),
      pane: this.tmuxPane(),
    };
  }

  tmuxInsertCommand(text) {
    return `send-keys -t ${tmuxDoubleQuote(this.tmuxPane())} -l ${tmuxDoubleQuote(text)}`;
  }

  tmuxSubmitCommand(text) {
    return tmuxSubmitToPane(this.tmuxPane(), text);
  }

  notify(message) {
    const pane = this.tmuxPane();
    if (pane) {
      const result = spawnSync("tmux", ["display-message", "-t", pane, String(message)], {
        stdio: "ignore",
      });
      if (!result.error && result.status === 0) return;
    }

    this.logLine(c("dim", String(message)));
  }

  textFallback(message, render) {
    if (this.tmuxPane() && !this.showInternalEvents) {
      this.notify(`${message}; use /debug to print details in chat`);
      return;
    }

    render();
  }

  async refreshSessions() {
    this.notify("Refreshing ACP sessions...");
    const result = await this.hub.call("refresh_sessions", {
      cwd: this.cwd,
      includeAllProviders: true,
    });

    const lines = [];
    for (const provider of result.providers || []) {
      const count = provider.sessionCount ?? provider.sessions?.length ?? 0;
      const status = provider.supported ? `${count} session(s)` : "not supported";
      lines.push(`${provider.provider}: ${status}`);
    }

    if (!this.showTmuxMenu("ACP Refresh", lines.map((line) => ({ label: line, disabled: true })))) {
      this.textFallback("ACP refresh panel unavailable", () => {
        for (const line of lines) this.logLine(line);
      });
    }
  }

  async question(prompt, options = {}) {
    if (this.canUseRawInput()) {
      return this.rawQuestion(prompt, options);
    }

    this.questionActive = true;
    this.currentPrompt = prompt;
    try {
      return await this.ensureReadline().question(prompt);
    } catch (error) {
      if (error.code === "ERR_USE_AFTER_CLOSE") return "/exit";
      throw error;
    } finally {
      this.questionActive = false;
      this.currentPrompt = "";
      this.flushChunkBuffer({ force: true });
    }
  }

  ensureReadline() {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }

    return this.rl;
  }

  canUseRawInput() {
    // Gate on having an open chat, not on the launch mode: a chat opened from
    // the popup menu (--mode menu) must get the same composer as --mode chat.
    // The text-menu fallback keeps its plain readline prompt.
    return (
      (this.mode === "chat" || Boolean(this.currentChat)) &&
      !this.menuTextActive &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      typeof process.stdin.setRawMode === "function" &&
      process.env.ACP_HUB_RAW_INPUT !== "0"
    );
  }

  currentDraftKey() {
    const chat = this.currentChat || {};
    return draftKey(chat.id || "", chat.cwd || this.cwd);
  }

  rawQuestion(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const draftKey = options.draft ? this.currentDraftKey() : "";
      const draftText = draftKey ? loadDraft(draftKey) : "";
      // Prefill: draft (the composer) wins; otherwise an explicit initial value
      // for one-off prompts like rename. Callers that pass neither are unchanged.
      const initialText = draftText || (typeof options.initial === "string" ? options.initial : "");
      const session = {
        prompt,
        line: initialText,
        cursor: initialText.length,
        draftKey,
        historyIndex: this.inputHistory.length,
        historyDraft: "",
        searchActive: false,
        searchQuery: "",
        searchIndex: 0,
        searchOriginalLine: "",
        searchOriginalCursor: 0,
        previousRawMode: process.stdin.isRaw,
        pinned: this.shouldUsePinnedInput(),
        bracketedPaste: this.shouldUseBracketedPaste(),
        pasteActive: false,
        pasteBuffer: "",
        lastPasteSummary: "",
        escapePrefixAt: 0,
        vimMode: "insert",
        vimOp: "",
        vimCount: "",
        vimFind: "",
        vimReplace: false,
        vimGPending: false,
        vimUndoStack: [],
        vimRedoStack: [],
        vimAnchor: 0,
        vimVisualLine: false,
        vimLastChange: null,
        vimChangePending: null,
        vimInsertStart: 0,
        autocompleteIndex: 0,
        autocompleteKey: "",
        autocompleteSuppressedKey: "",
        done: false,
        resizeHandler: null,
        resizeTimer: null,
      };

      const scheduleResizeRender = () => {
        if (session.done || this.rawInput !== session || !session.pinned) return;
        if (session.resizeTimer) clearTimeout(session.resizeTimer);
        session.resizeTimer = setTimeout(() => {
          session.resizeTimer = null;
          if (session.done || this.rawInput !== session || !session.pinned) return;
          this.renderRawInput();
        }, 20);
      };

      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
        if (session.bracketedPaste) this.disableBracketedPaste();
        if (session.resizeTimer) {
          clearTimeout(session.resizeTimer);
          session.resizeTimer = null;
        }
        if (session.resizeHandler) {
          process.removeListener("SIGWINCH", session.resizeHandler);
          session.resizeHandler = null;
        }
        this.stopComposerSpinner();
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(Boolean(session.previousRawMode));
        }
      };

      const finish = (value) => {
        if (session.done) return;
        session.done = true;
        cleanup();
        const text = String(value || "");
        if (this.scrollOffsetRows > 0) {
          // Submitting returns the viewport to the live tail.
          this.scrollOffsetRows = 0;
          this.scrollNewRows = 0;
          if (session.pinned) this.repaintPinnedOutput(this.rawInputLayout(session));
        }
        this.clearRawInputLine();
        if (session.pinned) {
          this.enableRawInputLayout(session);
          if (this.shouldEchoSubmittedInput(text)) {
            this.emitTranscript(`\n${this.formatSubmittedInput(text)}\n`);
            this.pendingResponseBreak = true;
          }
        } else {
          const output = `${session.prompt}${text}\n`;
          this.recordTranscriptOutput(output);
          process.stdout.write(output);
        }
        this.rawInput = null;
        this.questionActive = false;
        this.currentPrompt = "";
        this.flushChunkBuffer({ force: true });

        this.rememberInputHistory(text);

        if (session.draftKey && text.trim() && !["/exit", "/quit"].includes(text.trim())) {
          clearDraft(session.draftKey);
        }

        resolve(text);
      };

      const fail = (error) => {
        if (session.done) return;
        session.done = true;
        cleanup();
        this.clearRawInputLine();
        if (session.pinned) this.disableRawInputLayout();
        this.rawInput = null;
        this.questionActive = false;
        this.currentPrompt = "";
        reject(error);
      };

      const onKeypress = (input, key = {}) => {
        try {
          this.handleRawKeypress(session, input, key, finish);
        } catch (error) {
          fail(error);
        }
      };

      // Expose the resolver so async events (a permission arriving mid-turn)
      // can break out of this blocked prompt and hand control to the chat loop.
      session.finish = finish;
      // A fresh composer session never inherits a picker left open by a
      // previous one (e.g. a permission interrupt tore the old prompt down);
      // its promise resolves null so an awaiting caller never hangs.
      if (this.inlinePicker) {
        const stale = this.inlinePicker;
        this.inlinePicker = null;
        stale.resolve?.(null);
      }
      this.rawInput = session;
      this.questionActive = true;
      this.currentPrompt = prompt;
      readlineTerminal.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 });
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      if (session.bracketedPaste) this.enableBracketedPaste();
      if (session.pinned) {
        session.resizeHandler = scheduleResizeRender;
        process.on("SIGWINCH", session.resizeHandler);
        this.enableRawInputLayout(session);
      }
      this.renderRawInput();
      this.syncComposerSpinner();
      if (session.pinned) scheduleResizeRender();
    });
  }

  handleRawKeypress(session, input, key, finish) {
    if (this.inlinePicker && this.handleInlinePickerKey(session, input, key)) {
      return;
    }

    if (this.handleRawHistorySearchKey(session, input, key)) {
      return;
    }

    if (this.vimEnabled && this.handleVimKeypress(session, input, key, finish)) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      if (this.cancelCurrentTurnFromInput(session)) {
        this.renderRawInput();
        return;
      }
      if (session.line) {
        this.pushKillRing(session.line);
        session.line = "";
        session.cursor = 0;
        this.saveRawDraft(session);
        this.renderRawInput();
        return;
      }
      finish("/exit");
      return;
    }

    if (key.ctrl && key.name === "d" && !session.line) {
      finish("/exit");
      return;
    }

    if (this.handleAutocompleteKey(session, input, key)) {
      return;
    }

    if (key.name === "pageup" || key.name === "pagedown") {
      const page = Math.max(1, (this.rawInputLayout(session).outputBottom || 2) - 1);
      this.scrollTranscript(key.name === "pageup" ? page : -page);
      return;
    }

    if (key.name === "escape") {
      if (this.scrollOffsetRows > 0) {
        this.scrollTranscript(-this.scrollOffsetRows);
        return;
      }
      session.escapePrefixAt = Date.now();
      this.handleRawEscape(session);
      return;
    }

    if (key.ctrl && key.name === "r") {
      this.startRawHistorySearch(session);
      this.renderRawInput();
      return;
    }

    if (this.handleBracketedPasteKey(session, input, key)) {
      return;
    }

    if (this.handleRawEscapePrefix(session, input, key)) {
      return;
    }

    if (this.shouldInsertRawNewline(input, key)) {
      this.insertRawInputText(session, "\n");
      this.renderRawInput();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      // Picker commands (/model, /effort, /modes, /access with no args) open
      // inline in the dropdown zone below the input, keeping the composer and
      // the transcript on screen, instead of resolving the prompt and painting
      // over the output region.
      if (this.maybeOpenInlinePicker(session)) return;
      finish(session.line);
      return;
    }

    if (key.name === "tab") {
      // Empty input: Tab / Shift+Tab cycle the adapter's session modes
      // (e.g. Claude plan → default → acceptEdits), like opencode.
      if (!session.line) {
        this.cycleMode(key.shift ? -1 : 1);
        return;
      }
      if (this.completeRawFileMention(session)) {
        this.renderRawInput();
        return;
      }
      this.completeRawSlashCommand(session);
      this.renderRawInput();
      return;
    }

    if (key.name === "backspace") {
      if (session.cursor > 0) {
        // An attachment token deletes as one unit and detaches its file, so a
        // placeholder can't linger pointing at content that will still send.
        const before = session.line.slice(0, session.cursor);
        const token = before.match(ATTACHMENT_TOKEN_BEFORE_CURSOR);
        if (token) {
          const index = this.pendingAttachments.findIndex((item) => item.n === Number(token[2]));
          if (index !== -1) {
            const [removed] = this.pendingAttachments.splice(index, 1);
            session.lastPasteSummary = `removed ${removed.name || path.basename(removed.path || "") || "attachment"}`;
            this.refreshRawInputPrompt({ render: false });
          }
          session.line = `${before.slice(0, -token[0].length)}${session.line.slice(session.cursor)}`;
          session.cursor -= token[0].length;
        } else {
          session.line = `${session.line.slice(0, session.cursor - 1)}${session.line.slice(session.cursor)}`;
          session.cursor -= 1;
        }
        this.saveRawDraft(session);
      } else if (!session.line && this.pendingAttachments.length) {
        this.detachLastAttachmentFromComposer(session);
      }
      this.renderRawInput();
      return;
    }

    if (key.name === "delete") {
      if (session.cursor < session.line.length) {
        session.line = `${session.line.slice(0, session.cursor)}${session.line.slice(session.cursor + 1)}`;
        this.saveRawDraft(session);
      }
      this.renderRawInput();
      return;
    }

    if (key.meta && key.name === "b") {
      session.cursor = rawPreviousWord(session.line, session.cursor);
      this.renderRawInput();
      return;
    }

    if (key.meta && key.name === "f") {
      session.cursor = rawNextWord(session.line, session.cursor);
      this.renderRawInput();
      return;
    }

    // Ctrl+X: draft the prompt in $VISUAL/$EDITOR and reload it on exit —
    // long prompts get a real editor. Ctrl is the advertised chord (it sits
    // in the same place on every keyboard; Alt/Option/⌥ doesn't); Alt+E
    // stays as a silent alias for Meta-configured terminals.
    if ((key.ctrl && key.name === "x") || (key.meta && key.name === "e")) {
      this.openExternalEditor(session);
      return;
    }

    // Ctrl+O opens the menu overlay from the composer regardless of input; the
    // current text is preserved as a draft and restored on return. This is the
    // in-process target of prefix+M when focused in a chat pane.
    if (key.ctrl && key.name === "o") {
      if (this.triggerMenuFromComposer(session, finish)) return;
    }

    // Ctrl+T renames the current chat via a safe in-process prompt.
    if (key.ctrl && key.name === "t") {
      if (this.triggerRenameFromComposer(session, finish)) return;
    }

    if (key.name === "left") {
      // Empty input: ← backs out to the menu overlay in this same pane (the
      // agent-view "detach" gesture). With text, it just moves the cursor.
      if (!session.line && !this.pendingAttachments.length && this.triggerMenuFromComposer(session, finish)) {
        return;
      }
      session.cursor = Math.max(0, session.cursor - 1);
      this.renderRawInput();
      return;
    }

    if (key.name === "right") {
      session.cursor = Math.min(session.line.length, session.cursor + 1);
      this.renderRawInput();
      return;
    }

    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      // While reviewing the transcript, Home jumps to its top (Ctrl+A keeps
      // its line-start meaning either way).
      if (this.scrollOffsetRows > 0 && key.name === "home") {
        this.scrollTranscript(Number.MAX_SAFE_INTEGER);
        return;
      }
      session.cursor = this.rawCurrentLineBounds(session).start;
      this.renderRawInput();
      return;
    }

    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      if (this.scrollOffsetRows > 0 && key.name === "end") {
        this.scrollTranscript(-this.scrollOffsetRows);
        return;
      }
      session.cursor = this.rawCurrentLineBounds(session).end;
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "u") {
      const bounds = this.rawCurrentLineBounds(session);
      this.pushKillRing(session.line.slice(bounds.start, session.cursor));
      session.line = `${session.line.slice(0, bounds.start)}${session.line.slice(session.cursor)}`;
      session.cursor = bounds.start;
      this.saveRawDraft(session);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "k") {
      const bounds = this.rawCurrentLineBounds(session);
      this.pushKillRing(session.line.slice(session.cursor, bounds.end));
      session.line = `${session.line.slice(0, session.cursor)}${session.line.slice(bounds.end)}`;
      this.saveRawDraft(session);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "w") {
      const before = session.line.slice(0, session.cursor).replace(/\s+\S*$/, "").replace(/\S+$/, "");
      this.pushKillRing(session.line.slice(before.length, session.cursor));
      session.line = `${before}${session.line.slice(session.cursor)}`;
      session.cursor = before.length;
      this.saveRawDraft(session);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "y") {
      const text = this.killRing[0] || "";
      if (text) this.insertRawInputText(session, text);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "l") {
      this.redrawScreen();
      return;
    }

    if (key.name === "up") {
      if (this.moveRawCursorVertically(session, -1)) {
        this.renderRawInput();
        return;
      }
      if (this.inputHistory.length && session.historyIndex > 0) {
        // Entering history browsing: stash the live draft so coming back down
        // past the newest entry restores it instead of clearing the line.
        if (session.historyIndex === this.inputHistory.length) {
          session.historyDraft = session.line;
        }
        session.historyIndex -= 1;
        session.line = this.inputHistory[session.historyIndex] || "";
        session.cursor = session.line.length;
        this.saveRawDraft(session);
      }
      this.renderRawInput();
      return;
    }

    if (key.name === "down") {
      if (this.moveRawCursorVertically(session, 1)) {
        this.renderRawInput();
        return;
      }
      if (this.inputHistory.length && session.historyIndex < this.inputHistory.length) {
        session.historyIndex += 1;
        session.line =
          session.historyIndex === this.inputHistory.length
            ? session.historyDraft || ""
            : this.inputHistory[session.historyIndex] || "";
        session.cursor = session.line.length;
        this.saveRawDraft(session);
      }
      this.renderRawInput();
      return;
    }

    if (input && !key.ctrl && !key.meta && input >= " ") {
      this.insertRawInputText(session, input);
      session.historyIndex = this.inputHistory.length;
      this.renderRawInput();
    }
  }

  handleBracketedPasteKey(session, input, key = {}) {
    if (key.name === "paste-start") {
      session.pasteActive = true;
      session.pasteBuffer = "";
      this.renderRawInput();
      return true;
    }

    if (key.name === "paste-end") {
      const text = normalizePastedText(session.pasteBuffer);
      session.pasteActive = false;
      session.pasteBuffer = "";
      if (text) this.handlePastedText(session, text);
      this.renderRawInput();
      return true;
    }

    if (!session.pasteActive) return false;

    if (input) {
      session.pasteBuffer += input;
    } else if (key.sequence && key.sequence.length === 1) {
      session.pasteBuffer += key.sequence;
    }

    return true;
  }

  handlePastedText(session, text) {
    const cwd = this.currentChat?.cwd || this.cwd;
    const attachments = attachmentsFromPathOnlyText(text, cwd);
    if (attachments.length) {
      const added = this.addPendingAttachments(attachments);
      // Inline token marks where the attachment landed in the prompt; the
      // agent sees the same marker next to the attached content block.
      for (const attachment of added) this.insertRawInputText(session, attachmentToken(attachment));
      session.lastPasteSummary = added.length
        ? `attached ${pastedAttachmentSummary(added)} from paste · Enter sends`
        : "pasted file path is already attached";
      this.refreshRawInputPrompt({ render: false });
      return;
    }

    if (shouldStorePasteAsAttachment(text)) {
      const attachment = createPastedTextAttachment(text);
      const added = this.addPendingAttachments([attachment]);
      if (added.length) this.insertRawInputText(session, attachmentToken(attachment));
      session.lastPasteSummary = added.length
        ? `large paste saved as ${attachment.name} · Enter sends`
        : "large paste already attached";
      this.refreshRawInputPrompt({ render: false });
      return;
    }

    this.insertRawInputText(session, text, { paste: true });
    session.lastPasteSummary = pastedTextSummary(text);
  }

  startRawHistorySearch(session) {
    session.searchActive = true;
    session.searchQuery = "";
    session.searchIndex = 0;
    session.searchOriginalLine = session.line;
    session.searchOriginalCursor = session.cursor;
    this.applyRawHistorySearch(session);
  }

  handleRawHistorySearchKey(session, input, key = {}) {
    if (!session.searchActive) return false;

    if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "g"))) {
      session.searchActive = false;
      session.line = session.searchOriginalLine;
      session.cursor = session.searchOriginalCursor;
      this.renderRawInput();
      return true;
    }

    if (key.name === "return" || key.name === "enter" || key.name === "tab") {
      session.searchActive = false;
      this.saveRawDraft(session);
      this.renderRawInput();
      return true;
    }

    if ((key.ctrl && key.name === "r") || key.name === "down") {
      session.searchIndex += 1;
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    if (key.name === "up") {
      session.searchIndex = Math.max(0, session.searchIndex - 1);
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    if (key.name === "backspace") {
      session.searchQuery = session.searchQuery.slice(0, -1);
      session.searchIndex = 0;
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    if (input && !key.ctrl && !key.meta && input >= " ") {
      session.searchQuery += input;
      session.searchIndex = 0;
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    return true;
  }

  applyRawHistorySearch(session) {
    const matches = this.rawHistorySearchMatches(session.searchQuery);
    if (!matches.length) {
      session.line = session.searchOriginalLine;
      session.cursor = session.searchOriginalCursor;
      return;
    }

    const index = Math.max(0, Math.min(session.searchIndex, matches.length - 1));
    session.searchIndex = index;
    session.line = matches[index];
    session.cursor = session.line.length;
  }

  rawHistorySearchMatches(query) {
    const normalized = String(query || "").toLowerCase();
    const seen = new Set();
    const matches = [];

    for (let index = this.inputHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.inputHistory[index];
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      if (!normalized || entry.toLowerCase().includes(normalized)) matches.push(entry);
    }

    return matches;
  }

  shouldInsertRawNewline(input, key = {}) {
    if (key.ctrl && key.name === "j") return true;
    if (input === "\n") return true;
    if (key.meta && key.name === "j") return true;
    if (key.meta && input === "j") return true;
    if (key.meta && (key.name === "return" || key.name === "enter")) return true;
    if (input === "\x1bj" || input === "\x1bJ") return true;
    if (process.platform === "darwin" && input === "∆") return true;
    return input === "\x1b\r" || input === "\x1b\n";
  }

  handleRawEscapePrefix(session, input, key = {}) {
    if (!session.escapePrefixAt || Date.now() - session.escapePrefixAt > 700) return false;
    if (key.name !== "j" && input !== "j" && input !== "J") return false;

    session.escapePrefixAt = 0;
    this.lastEscapeAt = 0;
    this.insertRawInputText(session, "\n");
    this.renderRawInput();
    return true;
  }

  insertRawInputText(session, text, options = {}) {
    if (!options.paste) session.lastPasteSummary = "";
    session.line = `${session.line.slice(0, session.cursor)}${text}${session.line.slice(session.cursor)}`;
    session.cursor += text.length;
    session.historyIndex = this.inputHistory.length;
    this.saveRawDraft(session);
  }

  saveRawDraft(session) {
    if (!session?.draftKey) return;
    saveDraft(session.draftKey, session.line);
  }

  rememberInputHistory(text) {
    const entry = String(text || "");
    if (!entry.trim() || ["/exit", "/quit"].includes(entry.trim())) return;

    this.inputHistory = this.inputHistory.filter((item) => item !== entry);
    this.inputHistory.push(entry);
    if (this.inputHistory.length > INPUT_HISTORY_LIMIT) {
      this.inputHistory.splice(0, this.inputHistory.length - INPUT_HISTORY_LIMIT);
    }
    saveInputHistory(this.inputHistory);
  }

  canCancelCurrentTurn() {
    return Boolean(this.currentChat?.id && isActiveChatStatus(this.currentChat.status));
  }

  requestCancelCurrentTurn(options = {}) {
    if (!this.canCancelCurrentTurn()) return false;

    const chatId = this.currentChat.id;

    // Cancel-to-edit: Esc/Ctrl+C right after sending restores the prompt into
    // the empty composer, so "oops, one more thing" is cancel → tweak → Enter.
    // Never overwrites text the user already typed.
    const session = this.rawInput;
    if (
      !options.skipRestore &&
      session &&
      !session.line &&
      this.lastSentPrompt?.chatId === chatId &&
      this.lastSentPrompt.text
    ) {
      session.line = this.lastSentPrompt.text;
      session.cursor = session.line.length;
      if (this.vimEnabled) session.vimMode = "insert";
      this.saveRawDraft(session);
    }

    this.hub
      .call("cancel", { chatId })
      .then((result) =>
        this.notify(
          result?.droppedQueue
            ? `cancel requested · dropped ${result.droppedQueue} queued`
            : "cancel requested",
        ),
      )
      .catch((error) => this.notify(`cancel failed: ${error.message || String(error)}`));
    return true;
  }

  cancelCurrentTurnFromInput(session) {
    if (!this.canCancelCurrentTurn()) return false;

    // Ctrl+C with text is an explicit "discard what I typed": clear it and
    // skip the cancel-to-edit restore so the composer stays empty.
    const hadText = Boolean(session.line);
    if (hadText) {
      this.pushKillRing(session.line);
      session.line = "";
      session.cursor = 0;
      this.saveRawDraft(session);
    }

    return this.requestCancelCurrentTurn({ skipRestore: hadText });
  }

  pushKillRing(text) {
    if (!text) return;
    this.killRing.unshift(text);
    this.killRing = this.killRing.filter((entry, index, list) => entry && list.indexOf(entry) === index);
    if (this.killRing.length > KILL_RING_LIMIT) this.killRing.length = KILL_RING_LIMIT;
  }

  handleRawEscape(session) {
    // Esc during an active turn stops the agent, like other agent CLIs. The
    // draft is kept — unlike Ctrl+C — so a mid-stream correction survives.
    if (this.requestCancelCurrentTurn()) {
      this.lastEscapeAt = 0;
      this.renderRawInput();
      return;
    }

    const now = Date.now();
    if (now - this.lastEscapeAt < 700 && session.line) {
      this.pushKillRing(session.line);
      session.line = "";
      session.cursor = 0;
      this.saveRawDraft(session);
      this.lastEscapeAt = 0;
      this.renderRawInput();
      return;
    }

    this.lastEscapeAt = now;
    this.notify("press Esc again to clear input");
    this.renderRawInput();
  }

  // ── Vim mode ──────────────────────────────────────────────────────────
  // Opt-in modal editing for the composer (/vim). Insert mode passes keys to
  // the default handler; Esc enters normal mode, where a vim subset drives
  // motions and edits over session.line/cursor; v/V open visual selections.
  // With vim on, Esc no longer cancels the turn from insert — that gesture
  // moves to Ctrl+C, or Esc while already in normal mode (a first Esc there
  // clears any pending count/op). Only the main draft-backed composer is
  // modal: nested prompts (rename, confirms) keep their plain behavior.
  handleVimKeypress(session, input, key, finish) {
    if (!session.draftKey) return false;
    if (session.pasteActive || key.name === "paste-start" || key.name === "paste-end") return false;
    // Alt/Ctrl chords stay global (Alt+Enter newline, Alt+B word-jump…) — but
    // a bare ESC arrives from readline as {name:"escape", meta:true}, and
    // bouncing it here left vim stuck in insert forever.
    if (key.ctrl || (key.meta && key.name !== "escape")) return false;

    if (key.name === "escape") {
      if (this.scrollOffsetRows > 0) {
        this.scrollTranscript(-this.scrollOffsetRows);
        return true;
      }
      if (session.vimMode === "visual") {
        session.vimMode = "normal";
        vimClearPending(session);
        this.refreshRawInputPrompt({ render: false });
        this.renderRawInput();
        return true;
      }
      if (session.vimMode === "normal") {
        if (vimHasPending(session)) {
          vimClearPending(session);
          this.renderRawInput();
          return true;
        }
        if (this.requestCancelCurrentTurn()) this.renderRawInput();
        return true;
      }
      session.vimMode = "normal";
      // A change that entered insert (cw, C, s…) completes here: capture the
      // typed text so `.` can replay the whole change.
      if (session.vimChangePending) {
        session.vimLastChange = {
          ...session.vimChangePending,
          insert: session.line.slice(session.vimInsertStart, session.cursor),
        };
        session.vimChangePending = null;
      }
      vimClearPending(session);
      // Vim leaves insert with the cursor on the last typed char.
      if (session.cursor > 0 && session.line[session.cursor - 1] !== "\n") session.cursor -= 1;
      this.refreshRawInputPrompt({ render: false });
      this.renderRawInput();
      return true;
    }

    if (session.vimMode !== "normal" && session.vimMode !== "visual") return false;

    // Enter still submits and Tab keeps its global gestures in normal mode.
    if (key.name === "return" || key.name === "enter" || key.name === "tab") return false;

    if (key.name === "backspace" || key.name === "left") {
      vimClearPending(session);
      if (session.cursor > 0) session.cursor -= 1;
      this.renderRawInput();
      return true;
    }
    if (key.name === "right") {
      vimClearPending(session);
      if (session.cursor < session.line.length) session.cursor += 1;
      this.renderRawInput();
      return true;
    }
    if (key.name === "up" || key.name === "down") {
      vimClearPending(session);
      this.moveRawCursorVertically(session, key.name === "up" ? -1 : 1);
      this.renderRawInput();
      return true;
    }

    const ch = typeof input === "string" && input.length === 1
      ? input
      : key.sequence?.length === 1
        ? key.sequence
        : "";
    if (!ch) return true;

    if (session.vimMode === "visual") this.vimVisualKey(session, ch);
    else this.vimNormalKey(session, ch);
    return true;
  }

  vimNormalKey(session, ch) {
    // Multi-key sequences waiting for their final char.
    if (session.vimFind) {
      const spec = session.vimFind;
      session.vimFind = "";
      this.vimExecute(session, spec, ch);
      return;
    }
    if (session.vimReplace) {
      session.vimReplace = false;
      this.vimReplaceChar(session, ch);
      return;
    }
    if (session.vimGPending) {
      session.vimGPending = false;
      if (ch === "g") this.vimExecute(session, "gg");
      else vimClearPending(session);
      return;
    }

    // Count prefix; a bare 0 is the line-start motion instead.
    if (/[1-9]/.test(ch) || (ch === "0" && session.vimCount)) {
      session.vimCount += ch;
      this.renderRawInput();
      return;
    }

    switch (ch) {
      case "d":
      case "c":
      case "y":
        if (session.vimOp === ch) this.vimExecute(session, "line");
        else if (session.vimOp) {
          vimClearPending(session);
          this.renderRawInput();
        } else {
          session.vimOp = ch;
          this.renderRawInput();
        }
        return;
      case "g":
        session.vimGPending = true;
        this.renderRawInput();
        return;
      case "f":
      case "F":
      case "t":
      case "T":
        session.vimFind = ch;
        this.renderRawInput();
        return;
      case "r":
        if (session.vimOp) vimClearPending(session);
        else session.vimReplace = true;
        this.renderRawInput();
        return;
    }

    if ("hjklwbe0$^G%".includes(ch)) {
      this.vimExecute(session, ch);
      return;
    }

    // Anything past this point is a standalone edit; a dangling operator
    // (e.g. `dq`) aborts, like vim.
    if (session.vimOp) {
      vimClearPending(session);
      this.renderRawInput();
      return;
    }

    const count = vimTakeCount(session);

    switch (ch) {
      case "v":
      case "V":
        session.vimMode = "visual";
        session.vimAnchor = session.cursor;
        session.vimVisualLine = ch === "V";
        this.refreshRawInputPrompt({ render: false });
        this.renderRawInput();
        return;
      case ".":
        this.vimRepeatLastChange(session);
        return;
      case "u":
        this.vimUndoStep(session, session.vimUndoStack, session.vimRedoStack);
        return;
      case "U":
        this.vimUndoStep(session, session.vimRedoStack, session.vimUndoStack);
        return;

      // Insert transitions (not recorded for `.` — repeats cover changes).
      case "i":
        this.vimEnterInsert(session);
        return;
      case "a":
        if (session.cursor < this.rawCurrentLineBounds(session).end) session.cursor += 1;
        this.vimEnterInsert(session);
        return;
      case "I":
        session.cursor = vimFirstNonBlank(session.line, this.rawCurrentLineBounds(session));
        this.vimEnterInsert(session);
        return;
      case "A":
        session.cursor = this.rawCurrentLineBounds(session).end;
        this.vimEnterInsert(session);
        return;
      case "o": {
        const bounds = this.rawCurrentLineBounds(session);
        this.vimSaveUndo(session);
        session.line = `${session.line.slice(0, bounds.end)}\n${session.line.slice(bounds.end)}`;
        session.cursor = bounds.end + 1;
        this.saveRawDraft(session);
        this.vimEnterInsert(session);
        return;
      }
      case "O": {
        const bounds = this.rawCurrentLineBounds(session);
        this.vimSaveUndo(session);
        session.line = `${session.line.slice(0, bounds.start)}\n${session.line.slice(bounds.start)}`;
        session.cursor = bounds.start;
        this.saveRawDraft(session);
        this.vimEnterInsert(session);
        return;
      }
    }

    if ("xXDCsS~pP".includes(ch)) {
      this.vimApplyEdit(session, ch, count);
      return;
    }
    // Unmapped: swallow so it never types into the line.
  }

  // Visual mode: motions grow the selection; operators act on it and return
  // to normal (or insert for c/s).
  vimVisualKey(session, ch) {
    if (session.vimFind) {
      const spec = session.vimFind;
      session.vimFind = "";
      const count = vimTakeCount(session);
      this.vimMoveCursor(session, spec, count, ch);
      return;
    }
    if (session.vimGPending) {
      session.vimGPending = false;
      if (ch === "g") session.cursor = 0;
      this.renderRawInput();
      return;
    }

    if (/[1-9]/.test(ch) || (ch === "0" && session.vimCount)) {
      session.vimCount += ch;
      this.renderRawInput();
      return;
    }

    switch (ch) {
      case "v":
        if (session.vimVisualLine) session.vimVisualLine = false;
        else session.vimMode = "normal";
        this.refreshRawInputPrompt({ render: false });
        this.renderRawInput();
        return;
      case "V":
        if (session.vimVisualLine) session.vimMode = "normal";
        else session.vimVisualLine = true;
        this.refreshRawInputPrompt({ render: false });
        this.renderRawInput();
        return;
      case "o": {
        const anchor = session.vimAnchor;
        session.vimAnchor = session.cursor;
        session.cursor = anchor;
        this.renderRawInput();
        return;
      }
      case "g":
        session.vimGPending = true;
        return;
      case "f":
      case "F":
      case "t":
      case "T":
        session.vimFind = ch;
        return;
      case "d":
      case "x":
        this.vimVisualAction(session, "d");
        return;
      case "c":
      case "s":
        this.vimVisualAction(session, "c");
        return;
      case "y":
        this.vimVisualAction(session, "y");
        return;
      case "~":
        this.vimVisualAction(session, "~");
        return;
      case "p":
        this.vimVisualAction(session, "p");
        return;
    }

    if ("hjklwbe0$^G%".includes(ch)) {
      const count = vimTakeCount(session);
      this.vimMoveCursor(session, ch, count);
      return;
    }
    // Swallow the rest.
  }

  vimVisualAction(session, action) {
    const range = vimSelectionRange(session);
    session.vimMode = "normal";
    session.vimVisualLine = false;
    vimClearPending(session);
    this.refreshRawInputPrompt({ render: false });

    if (!range || range.end <= range.start) {
      this.renderRawInput();
      return;
    }

    switch (action) {
      case "y":
        this.pushKillRing(session.line.slice(range.start, range.end));
        session.cursor = range.start;
        this.renderRawInput();
        return;
      case "d":
        this.vimDeleteRange(session, range.start, range.end);
        return;
      case "c":
        this.vimDeleteRange(session, range.start, range.end);
        session.cursor = Math.min(range.start, session.line.length);
        this.vimEnterInsert(session);
        return;
      case "~": {
        this.vimSaveUndo(session);
        const flipped = session.line
          .slice(range.start, range.end)
          .replace(/[a-zA-Z]/g, (l) => (l === l.toLowerCase() ? l.toUpperCase() : l.toLowerCase()));
        session.line = `${session.line.slice(0, range.start)}${flipped}${session.line.slice(range.end)}`;
        session.cursor = range.start;
        this.saveRawDraft(session);
        this.renderRawInput();
        return;
      }
      case "p": {
        const text = this.killRing[0];
        if (!text) {
          this.renderRawInput();
          return;
        }
        this.vimSaveUndo(session);
        session.line = `${session.line.slice(0, range.start)}${text}${session.line.slice(range.end)}`;
        session.cursor = Math.max(range.start, range.start + text.length - 1);
        this.saveRawDraft(session);
        this.renderRawInput();
        return;
      }
    }
  }

  // Bare cursor movement shared by normal and visual modes.
  vimMoveCursor(session, motion, count, findChar = "") {
    if (motion === "j" || motion === "k") {
      for (let n = 0; n < count; n += 1) {
        if (!this.moveRawCursorVertically(session, motion === "j" ? 1 : -1)) break;
      }
    } else {
      let cursor = session.cursor;
      for (let n = 0; n < count; n += 1) {
        const next = vimMotionTarget(session.line, cursor, motion, findChar);
        if (next === null || next === cursor) break;
        cursor = next;
      }
      session.cursor = cursor;
    }
    this.renderRawInput();
  }

  // Runs a motion: bare it moves the cursor, under d/c/y it defines the range.
  vimExecute(session, motion, findChar = "") {
    const count = vimTakeCount(session);
    const op = session.vimOp;
    session.vimOp = "";

    if (!op) {
      this.vimMoveCursor(session, motion, count, findChar);
      return;
    }

    // Linewise ops don't take j/k in this subset.
    if (motion === "j" || motion === "k") {
      this.renderRawInput();
      return;
    }

    const range = vimOperatorRange(session.line, session.cursor, op, motion, count, findChar);
    if (!range || range.end <= range.start) {
      this.renderRawInput();
      return;
    }

    if (op === "y") {
      this.pushKillRing(session.line.slice(range.start, range.end));
      this.renderRawInput();
      return;
    }

    this.vimDeleteRange(session, range.start, range.end);
    if (op === "c") {
      // Insert at the change point: undo vimDeleteRange's newline snap, which
      // exists for normal-mode resting positions only.
      session.cursor = Math.min(range.start, session.line.length);
      session.vimChangePending = { kind: "op", op, motion, count, findChar };
      this.vimEnterInsert(session);
    } else {
      session.vimLastChange = { kind: "op", op, motion, count, findChar };
    }
  }

  // Standalone edits, shared between live keys and `.` replay. During replay,
  // edits that would enter insert splice the recorded text instead.
  vimApplyEdit(session, ch, count, arg = "", replayInsert = null) {
    const bounds = this.rawCurrentLineBounds(session);
    const line = session.line;
    const record = () => {
      if (replayInsert === null) session.vimLastChange = { kind: "edit", ch, count, arg };
    };
    const intoInsert = () => {
      if (replayInsert === null) {
        session.vimChangePending = { kind: "edit", ch, count, arg };
        this.vimEnterInsert(session);
      } else {
        this.vimInsertText(session, replayInsert);
      }
    };

    switch (ch) {
      case "x":
        this.vimDeleteRange(session, session.cursor, Math.min(session.cursor + count, bounds.end));
        record();
        return;
      case "X":
        this.vimDeleteRange(session, Math.max(bounds.start, session.cursor - count), session.cursor);
        record();
        return;
      case "D":
        this.vimDeleteRange(session, session.cursor, bounds.end);
        record();
        return;
      case "C": {
        const at = session.cursor;
        this.vimDeleteRange(session, at, bounds.end);
        session.cursor = Math.min(at, session.line.length);
        intoInsert();
        return;
      }
      case "s": {
        const at = session.cursor;
        this.vimDeleteRange(session, at, Math.min(at + count, bounds.end));
        session.cursor = Math.min(at, session.line.length);
        intoInsert();
        return;
      }
      case "S":
        this.vimDeleteRange(session, bounds.start, bounds.end);
        session.cursor = Math.min(bounds.start, session.line.length);
        intoInsert();
        return;
      case "~": {
        if (session.cursor >= bounds.end) return;
        this.vimSaveUndo(session);
        const end = Math.min(session.cursor + count, bounds.end);
        const flipped = line
          .slice(session.cursor, end)
          .replace(/[a-zA-Z]/g, (l) => (l === l.toLowerCase() ? l.toUpperCase() : l.toLowerCase()));
        session.line = `${line.slice(0, session.cursor)}${flipped}${line.slice(end)}`;
        session.cursor = Math.min(end, bounds.end - 1);
        this.saveRawDraft(session);
        record();
        this.renderRawInput();
        return;
      }
      case "p":
      case "P": {
        const text = this.killRing[0];
        if (!text) return;
        this.vimSaveUndo(session);
        const paste = text.repeat(count);
        const at = ch === "p" ? Math.min(session.cursor + 1, line.length) : session.cursor;
        session.line = `${line.slice(0, at)}${paste}${line.slice(at)}`;
        session.cursor = at + paste.length - 1;
        this.saveRawDraft(session);
        record();
        this.renderRawInput();
        return;
      }
    }
  }

  vimReplaceChar(session, ch, replayCount = null) {
    const count = replayCount ?? vimTakeCount(session);
    const bounds = this.rawCurrentLineBounds(session);
    if (ch === "\r" || ch === "\n") return;
    if (session.cursor + count > bounds.end) return; // not enough chars, like vim

    this.vimSaveUndo(session);
    session.line = `${session.line.slice(0, session.cursor)}${ch.repeat(count)}${session.line.slice(
      session.cursor + count,
    )}`;
    session.cursor += count - 1;
    this.saveRawDraft(session);
    if (replayCount === null) session.vimLastChange = { kind: "edit", ch: "r", count, arg: ch };
    this.renderRawInput();
  }

  vimRepeatLastChange(session) {
    const change = session.vimLastChange;
    if (!change) return;

    if (change.kind === "op") {
      const range = vimOperatorRange(
        session.line,
        session.cursor,
        change.op,
        change.motion,
        change.count,
        change.findChar || "",
      );
      if (!range || range.end <= range.start) {
        this.renderRawInput();
        return;
      }
      this.vimDeleteRange(session, range.start, range.end);
      if (change.op === "c") {
        session.cursor = Math.min(range.start, session.line.length);
        this.vimInsertText(session, change.insert || "");
      }
      return;
    }

    if (change.ch === "r") {
      this.vimReplaceChar(session, change.arg, change.count);
      return;
    }
    this.vimApplyEdit(session, change.ch, change.count, change.arg, change.insert ?? "");
  }

  // Splices replayed insert text at the cursor and lands back in normal mode.
  vimInsertText(session, text) {
    if (text) {
      session.line = `${session.line.slice(0, session.cursor)}${text}${session.line.slice(session.cursor)}`;
      session.cursor += text.length;
      this.saveRawDraft(session);
    }
    if (session.cursor > 0 && session.line[session.cursor - 1] !== "\n") session.cursor -= 1;
    this.renderRawInput();
  }

  vimUndoStep(session, fromStack, toStack) {
    const entry = fromStack?.pop();
    if (!entry) return;
    toStack.push({ line: session.line, cursor: session.cursor });
    session.line = entry.line;
    session.cursor = Math.min(entry.cursor, entry.line.length);
    this.saveRawDraft(session);
    this.renderRawInput();
  }

  vimDeleteRange(session, start, end) {
    if (end <= start) return;
    this.vimSaveUndo(session);
    this.pushKillRing(session.line.slice(start, end));
    session.line = `${session.line.slice(0, start)}${session.line.slice(end)}`;
    session.cursor = Math.min(start, session.line.length);
    // Never rest on a newline: snap to the last char of the landing line.
    const bounds = vimLineBounds(session.line, session.cursor);
    if (session.cursor >= bounds.end && bounds.end > bounds.start) session.cursor = bounds.end - 1;
    this.saveRawDraft(session);
    this.renderRawInput();
  }

  vimSaveUndo(session) {
    session.vimUndoStack = session.vimUndoStack || [];
    session.vimRedoStack = session.vimRedoStack || [];
    session.vimUndoStack.push({ line: session.line, cursor: session.cursor });
    if (session.vimUndoStack.length > VIM_UNDO_LIMIT) session.vimUndoStack.shift();
    session.vimRedoStack.length = 0;
  }

  vimEnterInsert(session) {
    session.vimMode = "insert";
    session.vimVisualLine = false;
    vimClearPending(session);
    session.vimInsertStart = session.cursor;
    this.refreshRawInputPrompt({ render: false });
    this.renderRawInput();
  }

  rawCurrentLineBounds(session) {
    const line = session.line || "";
    const cursor = Math.max(0, Math.min(session.cursor, line.length));
    const start = line.slice(0, cursor).lastIndexOf("\n") + 1;
    const endIndex = line.indexOf("\n", cursor);
    return {
      start,
      end: endIndex === -1 ? line.length : endIndex,
    };
  }

  moveRawCursorVertically(session, direction) {
    const visualLines = rawInputVisualLines(session.line, this.rawInputTextWidth(session));
    if (visualLines.length <= 1) return false;

    const cursor = Math.max(0, Math.min(session.cursor, session.line.length));
    const currentIndex = rawVisualLineIndexAtCursor(visualLines, cursor);

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= visualLines.length) return false;

    const current = visualLines[currentIndex];
    const next = visualLines[nextIndex];
    const column = Math.max(0, cursor - current.start);
    session.cursor = next.start + Math.min(column, next.end - next.start);
    return true;
  }

  renderRawInput(options = {}) {
    const session = this.rawInput;
    if (!session || !process.stdout.isTTY) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    if (session.pinned) {
      const layout = this.rawInputLayout(session);
      const shouldRepaintOutput =
        this.lastRawInputLayout &&
        (this.lastRawInputLayout.outputBottom !== layout.outputBottom ||
          this.lastRawInputLayout.columns !== layout.columns ||
          this.lastRawInputLayout.rows !== layout.rows);
      this.enableRawInputLayout(session, layout);
      if (options.clear === true || !sameRawInputLayout(this.lastRawInputLayout, layout)) {
        this.clearRawInputLayoutRows([this.lastRawInputLayout, layout]);
      }
      if (shouldRepaintOutput) this.repaintPinnedOutput(layout);
      this.renderPinnedRawInput(session, layout);
      return;
    }

    this.clearRawInputLine();
    const promptWidth = visibleLength(session.prompt);
    const lineWidth = Math.max(8, columns - promptWidth - 1);
    const view = this.rawInputViewport(session, lineWidth);
    const hint = this.inputHint(session.line);
    const hintLine = hint ? c("dim", `  ${truncateText(hint, columns - 3)}`) : "";

    process.stdout.write(`${session.prompt}${view.text}${hintLine ? ` ${hintLine.trimStart()}` : ""}`);
    readlineTerminal.cursorTo(process.stdout, promptWidth + view.cursorColumn);
  }

  clearRawInputLine() {
    if (!this.rawInput || !process.stdout.isTTY) return;
    if (!this.rawInput.pinned) {
      readlineTerminal.clearLine(process.stdout, 0);
      readlineTerminal.cursorTo(process.stdout, 0);
      return;
    }

    const layout = this.rawInputLayout(this.rawInput);
    this.clearRawInputLayoutRows([this.lastRawInputLayout, layout]);
    readlineTerminal.cursorTo(process.stdout, 0);
  }

  clearRawInputLayoutRows(layouts) {
    const screenRows = Math.max(1, process.stdout.rows || 24);
    const rows = new Set();

    for (const layout of layouts) {
      if (!layout) continue;
      for (const row of layout.composerRows || []) {
        if (Number.isInteger(row) && row >= 0 && row < screenRows) rows.add(row);
      }
    }

    for (const row of [...rows].sort((a, b) => a - b)) {
      readlineTerminal.cursorTo(process.stdout, 0, row);
      readlineTerminal.clearLine(process.stdout, 0);
    }
  }

  repaintPinnedOutput(layout = this.rawInputLayout(this.rawInput)) {
    if (!process.stdout.isTTY) return;
    if (this.activePicker) {
      // The picker owns the output region; repaint it instead of the
      // transcript (the transcript returns when the picker closes).
      this.activePicker.repaint();
      return;
    }

    const outputRows = Math.max(0, layout.outputBottom);
    if (!outputRows) return;

    const width = Math.max(1, layout.columns - 1);
    const painter = new FramePainter();
    this.paintTranscriptViewport(painter, outputRows, width);
    this.restoreComposerCursor(painter);
    painter.flush();
  }

  paintTranscriptViewport(painter, outputRows, width) {
    const window = this.collectTranscriptRowsFromEnd(width, outputRows, this.scrollOffsetRows);
    const rows = window.rows;
    const startRow = Math.max(0, outputRows - rows.length);

    for (let row = 0; row < outputRows; row += 1) {
      painter.to(0, row).clearLine();
      const content = rows[row - startRow];
      if (content) painter.text(content).text(colors.reset || "");
    }
  }

  // Soft-wrapped visual rows for the transcript tail: the last `count` rows
  // after skipping `skipFromEnd` rows from the bottom. Wraps lazily from the
  // end so cost is proportional to the window, not the whole buffer.
  collectTranscriptRowsFromEnd(width, count, skipFromEnd = 0) {
    const needed = Math.max(0, count) + Math.max(0, skipFromEnd);
    const lines = this.transcriptLines;
    let end = lines.length;
    while (end > 0 && stripAnsi(lines[end - 1] || "").trim() === "") end -= 1;

    const collected = [];
    for (let index = end - 1; index >= 0 && collected.length < needed; index -= 1) {
      const rows = wrapAnsiLine(lines[index], width);
      for (let row = rows.length - 1; row >= 0; row -= 1) collected.push(rows[row]);
    }
    collected.reverse();

    const sliceEnd = Math.max(0, collected.length - Math.max(0, skipFromEnd));
    const sliceStart = Math.max(0, sliceEnd - Math.max(0, count));
    return {
      rows: collected.slice(sliceStart, sliceEnd),
      total: collected.length,
      atTop: collected.length < needed,
    };
  }

  transcriptWrapWidth() {
    const columns = Math.max(24, process.stdout.columns || 80);
    return Math.max(1, columns - 1);
  }

  pinnedOutputRows() {
    return Math.max(1, this.lastRawScrollBottom || 1);
  }

  // Pinned layout is active whenever the scroll region is set; transcript
  // output must then be soft-wrapped and confined to the region.
  canPaintPinned() {
    return Boolean(process.stdout.isTTY && this.lastRawScrollBottom !== null);
  }

  // Records transcript text and paints it inside the pinned scroll region as
  // one atomic frame. The single choke point for transcript output while the
  // composer layout is active.
  emitTranscript(text, options = {}) {
    let output = String(text ?? "");
    if (!output) return;
    if (!output.endsWith("\n")) output += "\n";
    if (options.recordTranscript !== false) this.recordTranscriptOutput(output);
    this.paintTranscriptAppend(output);
  }

  paintTranscriptAppend(text) {
    const width = this.transcriptWrapWidth();
    const lines = String(text).split("\n");
    lines.pop();

    if (this.activePicker) {
      // A picker owns the screen: buffer only; the close repaint catches up.
      return;
    }

    if (this.scrollOffsetRows > 0) {
      // Viewing history: keep the viewport still and count what arrived.
      let arrived = 0;
      for (const line of lines) arrived += wrapAnsiLine(line, width).length;
      this.scrollNewRows += arrived;
      if (this.rawInput) this.renderRawInput();
      return;
    }

    if (!this.canPaintPinned()) {
      process.stdout.write(text);
      return;
    }

    const bottom = this.pinnedOutputRows() - 1;
    const painter = new FramePainter();
    painter.to(0, bottom);
    for (const line of lines) {
      for (const row of wrapAnsiLine(line, width)) {
        painter.text("\r\n").clearLine().text(row).text(colors.reset || "");
      }
    }
    this.restoreComposerCursor(painter);
    painter.flush();
  }

  restoreComposerCursor(painter) {
    const session = this.rawInput;
    if (!session || !session.pinned || session.done) return;
    const layout = this.rawInputLayout(session);
    const view = this.rawInputMultilineViewport(session, layout.inputWidth, layout.inputRows);
    const row = view.rows[view.cursorRow] || { prefix: "" };
    // Same column math as the composer painters — the half-box is flush with
    // the rule, so no border offset (a stale +2 here made the cursor jump
    // sideways on every transcript repaint).
    painter.to(
      visibleLength(row.prefix) + view.cursorColumn,
      layout.inputRow + view.cursorRow,
    );
  }

  scrollTranscript(deltaRows) {
    const session = this.rawInput;
    if (!session?.pinned || !this.canPaintPinned()) return;

    const layout = this.rawInputLayout(session);
    const viewport = Math.max(1, layout.outputBottom);
    const width = Math.max(1, layout.columns - 1);
    let offset = Math.max(0, this.scrollOffsetRows + deltaRows);

    if (offset > 0) {
      const probe = this.collectTranscriptRowsFromEnd(width, viewport, offset);
      if (probe.atTop) offset = Math.max(0, probe.total - viewport);
    }

    if (offset === this.scrollOffsetRows) return;
    this.scrollOffsetRows = offset;
    if (offset === 0) this.scrollNewRows = 0;

    this.renderRawInput();
    this.repaintPinnedOutput(this.rawInputLayout(session));
  }

  // Alt+E: hand the draft to $VISUAL/$EDITOR in this pane (blocking), then
  // reload the buffer into the composer. The editor owns the whole screen
  // while open; everything is repainted on return.
  openExternalEditor(session) {
    if (!process.stdout.isTTY || !session) return;
    const command = String(process.env.VISUAL || process.env.EDITOR || "").trim() || "vi";
    const parts = command.split(/\s+/).filter(Boolean);
    const file = path.join(os.tmpdir(), `acp-hub-draft-${process.pid}-${Date.now()}.md`);

    try {
      fs.writeFileSync(file, session.line || "", { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.notify(`editor: ${error.message || error}`);
      return;
    }

    const wasRaw = Boolean(process.stdin.isRaw);
    let result = null;
    try {
      if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(false);
      process.stdout.write("\x1b[2J\x1b[H");
      result = spawnSync(parts[0], [...parts.slice(1), file], { stdio: "inherit" });
    } finally {
      if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(wasRaw);
      if (session.bracketedPaste) this.enableBracketedPaste();
    }

    if (result?.error) {
      this.notify(`editor failed: ${result.error.message || result.error} (${parts[0]})`);
    } else {
      try {
        const text = fs.readFileSync(file, "utf8").replace(/\n+$/, "");
        session.line = text;
        session.cursor = text.length;
        if (this.vimEnabled) session.vimMode = "insert";
        this.saveRawDraft(session);
      } catch {
        // Editor deleted the file: keep the previous draft.
      }
    }

    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone.
    }
    this.redrawScreen();
  }

  redrawScreen() {
    if (!process.stdout.isTTY) return;
    this.scrollOffsetRows = 0;
    this.scrollNewRows = 0;

    if (this.rawInput?.pinned && this.canPaintPinned()) {
      process.stdout.write("\x1b[2J");
      this.lastRawInputLayout = null;
      this.renderRawInput({ clear: true });
      this.repaintPinnedOutput();
      return;
    }

    this.clearScreen();
    this.renderRawInput();
  }

  pickerSupported() {
    return Boolean(
      process.stdin.isTTY &&
        process.stdout.isTTY &&
        typeof process.stdin.setRawMode === "function" &&
        process.env.ACP_HUB_INTERACTIVE_UI !== "0",
    );
  }

  // Compact numbered menu for a handful of options (permission/plan-mode
  // approvals): no filter row — press the number to pick instantly, or
  // Ctrl+N/Ctrl+P (arrows) + Enter. Esc cancels (null). Anchored to the bottom
  // of the viewport like the other pickers.
  async quickSelect(config) {
    if (!this.pickerSupported() || !this.canPaintPinned()) return null;

    const items = (config.items || []).filter((item) => item && !item.disabled);
    if (!items.length) return null;

    // Composer live → render inline in the dropdown zone (permissions
    // arriving mid-prompt land here too); undefined = couldn't host, fall
    // through to the full-screen list.
    if (!this.inlinePicker && this.canHostInlinePicker()) {
      const picked = await this.openInlinePicker({
        title: config.title || "Select",
        items,
        index: Math.max(0, items.findIndex((item) => item.current)),
      });
      if (picked !== undefined) return picked;
    }

    return new Promise((resolve) => {
      const state = {
        title: config.title || "Select",
        hint: config.hint || `1-${Math.min(items.length, 9)} pick · ↑↓/jk move · Enter/l · Esc/h`,
        items,
        index: Math.max(0, items.findIndex((item) => item.current)),
        done: false,
        resizeHandler: null,
        resizeTimer: null,
        previousRawMode: process.stdin.isRaw,
      };
      if (state.index < 0) state.index = 0;

      const repaint = () => this.paintQuickSelect(state);

      const finish = (value) => {
        if (state.done) return;
        state.done = true;
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        if (state.resizeHandler) process.removeListener("SIGWINCH", state.resizeHandler);
        process.stdin.off("keypress", onKeypress);
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(Boolean(state.previousRawMode));
        }
        this.activePicker = null;
        this.restorePickerBackdrop();
        resolve(value);
      };

      const onKeypress = (input, key = {}) => {
        try {
          if (key.name === "escape" || (key.ctrl && key.name === "c") || key.name === "h") {
            finish(null);
            return;
          }
          if (key.name === "return" || key.name === "enter" || key.name === "l") {
            finish(state.items[state.index]?.value ?? null);
            return;
          }
          if (key.name === "up" || (key.ctrl && key.name === "p") || key.name === "k") {
            state.index = (state.index - 1 + state.items.length) % state.items.length;
            repaint();
            return;
          }
          if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "j") {
            state.index = (state.index + 1) % state.items.length;
            repaint();
            return;
          }
          // Number key: jump straight to that option and resolve.
          if (input && /^[1-9]$/.test(input)) {
            const n = Number(input) - 1;
            if (n < state.items.length) finish(state.items[n].value);
            return;
          }
        } catch {
          finish(null);
        }
      };

      this.activePicker = { repaint, onEvent: null };
      readlineTerminal.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 });
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      state.resizeHandler = () => {
        if (state.done) return;
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
          state.resizeTimer = null;
          if (!state.done) repaint();
        }, 30);
      };
      process.on("SIGWINCH", state.resizeHandler);
      repaint();
    });
  }

  // Compact list docked just above the composer, styled like the command
  // autocomplete. Only the rows it needs are painted — the transcript above
  // stays visible the whole time and is restored on close.
  paintQuickSelect(state) {
    if (!process.stdout.isTTY) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    const width = Math.max(1, columns - 1);
    const viewportRows = this.pickerViewportRows();
    const painter = new FramePainter();

    const rows = state.items.length;
    const itemsStart = Math.max(0, viewportRows - 1 - rows);
    const titleRow = itemsStart - 1;

    const writeRow = (row, content) => {
      if (row < 0) return;
      painter.to(0, row).clearLine();
      if (content) painter.text(fitAnsiLine(content, width)).text(colors.reset || "");
    };

    writeRow(titleRow, `${c("bold", state.title)}  ${c("muted", state.hint)}`);

    state.items.forEach((item, index) => {
      const selected = index === state.index;
      const marker = selected ? c("cyan", "❯") : " ";
      const number = c(selected ? "cyan" : "muted", String(index + 1));
      const currentMark = item.current ? c("green", "● ") : "  ";
      const label = selected ? c("bold", stripAnsi(item.label)) : c("muted", stripAnsi(item.label));
      writeRow(itemsStart + index, `  ${marker} ${number} ${currentMark}${label}`);
    });

    writeRow(viewportRows - 1, "");
    painter.to(0, viewportRows - 1);
    painter.flush();
  }

  // Full-viewport interactive list: arrows/Ctrl+N/Ctrl+P move, typing filters
  // fzf-style, Enter resolves the highlighted entry's value, Esc clears the
  // query first and cancels (null) second. Inside a chat it paints over the
  // transcript region (composer stays); the transcript is repainted on close.
  async interactivePick(config) {
    if (!this.pickerSupported()) return null;

    return new Promise((resolve) => {
      const state = {
        title: config.title || "Select",
        hint: config.hint || "j/k move · Enter/l open · / filter · Esc close",
        emptyText: config.emptyText || "No matches",
        items: config.items || [],
        query: "",
        // Navigation-first: keys move the list; "/" enters filter mode where
        // typing edits the query (Esc drops back to navigation).
        filterActive: false,
        index: -1,
        scroll: 0,
        done: false,
        renaming: null,
        renameText: "",
        replying: null,
        replyText: "",
        replyBusy: false,
        confirmDelete: null,
        previewEnabled: Boolean(config.onPreview),
        previewKey: null,
        previewData: null,
        previousRawMode: process.stdin.isRaw,
        resizeHandler: null,
        resizeTimer: null,
      };

      const visible = () => pickerFilterEntries(state.items, state.query);

      // Preview pane: fetch the transcript tail for the selected chat, debounced
      // so arrow-key travel doesn't hammer the daemon. Entries are cached with a
      // short TTL to stay fresh while chats stream.
      const previewCache = new Map();
      let previewTimer = null;
      const syncPreview = (entries) => {
        if (!config.onPreview) return;
        const entry = entries[state.index];
        const key = entry && !entry.disabled ? (entry.value?.chatId ?? null) : null;
        const cached = key ? previewCache.get(key) : null;
        const fresh = cached && Date.now() - cached.at < 3000;
        if (key === state.previewKey && (fresh || !key)) return;

        state.previewKey = key;
        state.previewData = cached?.data ?? null;
        if (previewTimer) {
          clearTimeout(previewTimer);
          previewTimer = null;
        }
        if (!key || fresh) return;

        previewTimer = setTimeout(() => {
          previewTimer = null;
          Promise.resolve(config.onPreview(entry))
            .then((data) => {
              if (state.done) return;
              previewCache.set(key, { data: data || { events: [] }, at: Date.now() });
              if (state.previewKey === key) {
                state.previewData = data || { events: [] };
                repaint();
              }
            })
            .catch(() => {});
        }, 80);
        previewTimer.unref?.();
      };

      const ensureSelection = (entries, preferValue = null) => {
        if (preferValue !== null) {
          const preferred = entries.findIndex(
            (entry) => !entry.disabled && pickerValueEquals(entry.value, preferValue),
          );
          if (preferred !== -1) {
            state.index = preferred;
            return;
          }
        }
        const current = entries.findIndex((entry) => !entry.disabled && entry.current);
        state.index =
          current !== -1 ? current : pickerNextIndex(entries, state.index, 0);
      };

      const repaint = () => {
        const entries = visible();
        syncPreview(entries);
        this.paintPicker(state, entries);
      };

      const replaceItems = (items, keepValue = null) => {
        if (state.done) return;
        state.items = items || [];
        ensureSelection(visible(), keepValue);
        repaint();
      };

      const finish = (value) => {
        if (state.done) return;
        state.done = true;
        if (previewTimer) clearTimeout(previewTimer);
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        if (state.resizeHandler) process.removeListener("SIGWINCH", state.resizeHandler);
        process.stdin.off("keypress", onKeypress);
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(Boolean(state.previousRawMode));
        }
        this.activePicker = null;
        // Callers that navigate to another window on select (the menu overlay)
        // defer the backdrop so they can switch first and repaint the old chat
        // in the background — no flash of the old pane before the switch.
        if (!config.deferBackdrop) this.restorePickerBackdrop();
        resolve(value);
      };

      const rebuildWith = (producer) => {
        Promise.resolve()
          .then(producer)
          .then((items) => {
            if (Array.isArray(items)) {
              const keep = visible()[state.index]?.value ?? null;
              replaceItems(items, keep);
            }
          })
          .catch(() => {});
      };

      const onKeypress = (input, key = {}) => {
        try {
          if (key.ctrl && key.name === "c") {
            finish(null);
            return;
          }

          // Rename mode: the query line becomes a title editor.
          if (state.renaming) {
            if (key.name === "escape") {
              state.renaming = null;
              state.renameText = "";
              repaint();
              return;
            }
            if (key.name === "return" || key.name === "enter") {
              const entry = state.renaming;
              const title = state.renameText.trim();
              state.renaming = null;
              state.renameText = "";
              if (title && config.onRename) {
                Promise.resolve(config.onRename(entry, title))
                  .then((items) => {
                    if (Array.isArray(items)) replaceItems(items, entry.value);
                    else repaint();
                  })
                  .catch(() => repaint());
              } else {
                repaint();
              }
              return;
            }
            if (key.name === "backspace") {
              state.renameText = state.renameText.slice(0, -1);
              repaint();
              return;
            }
            if (input && !key.ctrl && !key.meta && input >= " ") {
              state.renameText += input;
              repaint();
            }
            return;
          }

          // Reply mode: the query line becomes a one-line prompt sent straight
          // to the selected live chat, without leaving the picker.
          if (state.replying) {
            if (key.name === "escape") {
              state.replying = null;
              state.replyText = "";
              repaint();
              return;
            }
            if (key.name === "return" || key.name === "enter") {
              if (state.replyBusy) return;
              const entry = state.replying;
              const text = state.replyText.trim();
              if (!text) {
                state.replying = null;
                state.replyText = "";
                repaint();
                return;
              }
              state.replyBusy = true;
              repaint();
              Promise.resolve(config.onReply(entry, text))
                .then(() => {
                  state.replying = null;
                  state.replyText = "";
                  state.replyBusy = false;
                  // Refresh the preview so the dispatched turn shows up.
                  state.previewKey = null;
                  repaint();
                })
                .catch(() => {
                  state.replyBusy = false;
                  repaint();
                });
              return;
            }
            if (key.name === "backspace") {
              if (!state.replyBusy) state.replyText = state.replyText.slice(0, -1);
              repaint();
              return;
            }
            if (input && !key.ctrl && !key.meta && input >= " " && !state.replyBusy) {
              state.replyText += input;
              repaint();
            }
            return;
          }

          const currentEntries = visible();
          const selected = currentEntries[state.index];

          if (key.ctrl && key.name === "s" && config.onReply && selected?.canReply) {
            state.confirmDelete = null;
            state.replying = selected;
            state.replyText = "";
            state.replyBusy = false;
            repaint();
            return;
          }

          if (key.ctrl && key.name === "e" && config.onRename && selected?.canRename) {
            state.confirmDelete = null;
            state.renaming = selected;
            state.renameText = String(selected.renameInitial ?? stripAnsi(selected.label || "")).trim();
            repaint();
            return;
          }

          if (key.ctrl && key.name === "d" && config.onDelete && selected?.canDelete) {
            if (state.confirmDelete !== selected) {
              // First press arms the delete; the hint explains the second one.
              state.confirmDelete = selected;
              repaint();
              return;
            }
            state.confirmDelete = null;
            // Keep the selection near the removed row.
            const fallback =
              currentEntries.slice(state.index + 1).find((entry) => !entry.disabled)?.value ??
              [...currentEntries.slice(0, state.index)].reverse().find((entry) => !entry.disabled)?.value ??
              null;
            Promise.resolve(config.onDelete(selected))
              .then((items) => {
                if (Array.isArray(items)) replaceItems(items, fallback);
                else repaint();
              })
              .catch(() => repaint());
            return;
          }

          if (state.confirmDelete) state.confirmDelete = null;

          if (key.name === "escape") {
            // Layered back-out: filter mode → navigation (query kept), then
            // clear the query, then close the picker.
            if (state.filterActive) {
              state.filterActive = false;
              repaint();
              return;
            }
            if (state.query) {
              state.query = "";
              ensureSelection(visible());
              repaint();
            } else {
              finish(null);
            }
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            const entries = visible();
            const entry = entries[state.index];
            if (entry && !entry.disabled) finish(entry.value);
            return;
          }
          if (key.name === "up" || (key.ctrl && key.name === "p")) {
            state.index = pickerNextIndex(visible(), state.index, -1);
            repaint();
            return;
          }
          if (key.name === "down" || (key.ctrl && key.name === "n")) {
            state.index = pickerNextIndex(visible(), state.index, 1);
            repaint();
            return;
          }
          if (key.name === "pageup" || key.name === "pagedown") {
            const page = Math.max(1, this.pickerListCapacity() - 1);
            state.index = pickerNextIndex(visible(), state.index, key.name === "pageup" ? -page : page);
            repaint();
            return;
          }
          if (key.name === "tab" && config.onTab) {
            rebuildWith(config.onTab);
            return;
          }
          if (key.ctrl && key.name === "r" && config.onRefresh) {
            rebuildWith(config.onRefresh);
            return;
          }

          if (!state.filterActive) {
            // Navigation mode: vim keys drive the list, "/" opens the filter,
            // anything else printable is ignored (no accidental filtering).
            if (input === "/") {
              state.filterActive = true;
              repaint();
              return;
            }
            if (input === "j") {
              state.index = pickerNextIndex(visible(), state.index, 1);
              repaint();
              return;
            }
            if (input === "k") {
              state.index = pickerNextIndex(visible(), state.index, -1);
              repaint();
              return;
            }
            if (input === "l") {
              const entries = visible();
              const entry = entries[state.index];
              if (entry && !entry.disabled) finish(entry.value);
              return;
            }
            if (input === "h") {
              if (state.query) {
                state.query = "";
                ensureSelection(visible());
                repaint();
              } else {
                finish(null);
              }
              return;
            }
            if (input === "g") {
              state.index = pickerNextIndex(visible(), -1, 1);
              repaint();
              return;
            }
            if (input === "G") {
              state.index = pickerNextIndex(visible(), visible().length, -1);
              repaint();
              return;
            }
            if (key.name === "backspace") {
              if (state.query) {
                state.query = state.query.slice(0, -1);
                ensureSelection(visible());
              }
              repaint();
              return;
            }
            return;
          }

          // Filter mode: typing edits the query live.
          if (key.name === "backspace") {
            if (state.query) {
              state.query = state.query.slice(0, -1);
              ensureSelection(visible());
            } else {
              state.filterActive = false;
            }
            repaint();
            return;
          }
          if (input && !key.ctrl && !key.meta && input >= " ") {
            state.query += input;
            ensureSelection(visible());
            repaint();
          }
        } catch {
          finish(null);
        }
      };

      this.activePicker = {
        repaint,
        onEvent: config.onEvent ? (message) => config.onEvent(message, { replaceItems, state }) : null,
      };

      readlineTerminal.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 });
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      // Repaint on terminal resize: the popup client can detach (Esc) and a
      // later prefix+M reattaches at a different size — without this the
      // reattached pane keeps a stale or blank frame.
      state.resizeHandler = () => {
        if (state.done) return;
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
          state.resizeTimer = null;
          if (!state.done) repaint();
        }, 30);
      };
      process.on("SIGWINCH", state.resizeHandler);
      // Sticky selection: callers pass the value of the entry to land on
      // (e.g. the chat this popup had open) instead of starting at the top.
      ensureSelection(visible(), config.initialValue ?? null);
      repaint();
    });
  }

  pickerViewportRows() {
    if (this.canPaintPinned()) return this.pinnedOutputRows();
    return Math.max(6, process.stdout.rows || 24);
  }

  pickerListCapacity() {
    // title + query + separator above, hint row below
    return Math.max(1, this.pickerViewportRows() - 4);
  }

  paintPicker(state, entries) {
    if (!process.stdout.isTTY) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    const width = Math.max(1, columns - 1);
    const viewportRows = this.pickerViewportRows();
    const capacity = Math.max(1, viewportRows - 4);
    const painter = new FramePainter();

    const selectableCount = entries.filter((entry) => !entry.disabled).length;
    const counter = c("dim", `${selectableCount} item${selectableCount === 1 ? "" : "s"}`);
    const queryText = state.renaming
      ? `${c("yellow", "Rename:")} ${state.renameText}`
      : state.replying
        ? `${c("cyan", state.replyBusy ? "Sending…" : "Reply:")} ${state.replyText}`
        : state.filterActive
          ? state.query || c("muted", "filter…")
          : state.query
            ? `${state.query} ${c("muted", "(/ edits)")}`
            : c("muted", "/ to filter");

    // Two-column layout: list left, transcript preview right, when a preview
    // provider is wired and the popup is wide enough to be useful.
    const previewActive = state.previewEnabled && width >= 96;

    // Short lists hug the bottom of the viewport (near the composer the eye
    // was already on) instead of teleporting to the top; the preview layout
    // keeps the full height so the transcript pane stays useful.
    const usedRows = previewActive
      ? capacity
      : Math.max(1, Math.min(Math.max(entries.length, 1), capacity));
    const itemsStart = viewportRows - 1 - usedRows;
    const titleRow = itemsStart - 3;

    if (state.index >= state.scroll + usedRows) state.scroll = state.index - usedRows + 1;
    if (state.index !== -1 && state.index < state.scroll) state.scroll = state.index;
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, entries.length - usedRows)));

    const writeRow = (row, content) => {
      painter.to(0, row).clearLine();
      if (content) painter.text(fitAnsiLine(content, width)).text(colors.reset || "");
    };

    const listWidth = previewActive ? Math.min(64, Math.floor(width * 0.45)) : width;
    const previewWidth = previewActive ? width - listWidth - 3 : 0;
    const previewLines = previewActive
      ? formatChatPreview(state.previewData?.events, previewWidth, usedRows, (text) =>
          this.renderMarkdownDetached(text, previewWidth),
        )
      : [];
    const previewPending = previewActive && state.previewKey && !state.previewData;

    for (let row = 0; row < titleRow; row += 1) writeRow(row, "");
    writeRow(titleRow, `${c("bold", state.title)}  ${counter}`);
    writeRow(titleRow + 1, `${c("cyan", "❯")} ${queryText}`);
    writeRow(titleRow + 2, c("dim", "─".repeat(Math.min(width, 96))));

    for (let slot = 0; slot < usedRows; slot += 1) {
      const entry = entries[state.scroll + slot];
      let content = "";
      if (entry) {
        if (entry.disabled) {
          content = entry.label || "";
        } else {
          const selected = state.scroll + slot === state.index;
          const marker = selected ? c("cyan", "❯ ") : "  ";
          const currentMark = entry.current ? c("green", "● ") : "  ";
          content = `${marker}${currentMark}${entry.label || ""}`;
        }
      } else if (slot === 0 && !entries.length) {
        content = c("dim", `  ${state.emptyText}`);
      }

      if (previewActive) {
        const left = padAnsiToWidth(fitAnsiLine(content, listWidth), listWidth);
        const right = previewLines[slot] ?? (slot === 0 && previewPending ? c("dim", "…") : "");
        content = `${left} ${c("dim", "│")} ${right}`;
      }
      writeRow(itemsStart + slot, content);
    }

    const hintLine = state.renaming
      ? c("muted", " Enter apply · Esc cancel")
      : state.replying
        ? c("muted", state.replyBusy ? " sending…" : " Enter sends to the chat · Esc cancel")
        : state.confirmDelete
          ? c("yellow", " Ctrl+D again deletes this chat permanently · any key cancels")
          : state.filterActive
            ? c("muted", " filtering — type to narrow · Enter open · Esc back to list")
            : c("muted", ` ${state.hint}`);
    writeRow(viewportRows - 1, hintLine);

    const cursorText = state.renaming
      ? `Rename: ${state.renameText}`
      : state.replying
        ? `${state.replyBusy ? "Sending… " : "Reply: "}${state.replyText}`
        : state.query;
    painter.to(2 + visibleLength(cursorText), titleRow + 1);
    painter.flush();
  }

  restorePickerBackdrop() {
    if (!process.stdout.isTTY) return;
    if (this.canPaintPinned()) {
      this.repaintPinnedOutput();
      if (this.rawInput) this.renderRawInput();
      return;
    }
    this.clearScreen();
  }

  resetTranscriptBuffer() {
    this.transcriptLines = [""];
    this.scrollOffsetRows = 0;
    this.scrollNewRows = 0;
  }

  resetStreamRenderState() {
    if (this.liveTablePaintTimer) {
      clearTimeout(this.liveTablePaintTimer);
      this.liveTablePaintTimer = null;
    }
    this.liveTablePaintPending = false;
    this.liveTable = null;
    this.mdHeldLine = null;
  }

  recordTranscriptOutput(text = "") {
    const parts = String(text || "").split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) this.transcriptLines.push("");
      this.transcriptLines[this.transcriptLines.length - 1] += parts[index];
    }

    if (this.transcriptLines.length > TRANSCRIPT_SCREEN_LINE_LIMIT) {
      const removed = this.transcriptLines.length - TRANSCRIPT_SCREEN_LINE_LIMIT;
      this.transcriptLines.splice(0, removed);
      if (this.liveTable) {
        this.liveTable.startIndex -= removed;
        if (this.liveTable.startIndex < 0) this.liveTable = null;
      }
    }
  }

  // The half-box composer costs one border row (top rule with the status);
  // small popups fall back to the flat divider layout so the transcript keeps
  // enough room.
  shouldUseBoxedComposer(rows = process.stdout.rows || 24) {
    return rows >= 15 && process.env.ACP_HUB_COMPOSER_BOX !== "0";
  }

  rawInputLayout(session = this.rawInput) {
    const rows = Math.max(10, process.stdout.rows || 24);
    const columns = Math.max(24, process.stdout.columns || 80);
    const boxed = this.shouldUseBoxedComposer(rows) && session?.pinned !== false;
    const attachmentRows = this.rawAttachmentRowCount(columns);
    const inputRows = this.rawInputRowCount(session, this.rawInputTextWidth(session, columns, boxed));
    // The inline picker (/model, /effort…) takes over the dropdown zone; the
    // command autocomplete fills it otherwise. One extra row for its title.
    const picker = boxed && this.inlinePicker ? this.inlinePicker : null;
    const dropdown = picker
      ? { kind: "quickselect", matches: picker.items, index: picker.index, title: picker.title, hint: picker.hint }
      : boxed
        ? this.activeAutocomplete(session)
        : null;
    const dropdownRows = dropdown
      ? dropdown.kind === "quickselect"
        ? Math.min(8, dropdown.matches.length + 1)
        : Math.min(5, dropdown.matches.length)
      : 0;
    // One blank row under the list so it never sits glued to the tmux
    // status bar.
    const dropdownPadRows = dropdownRows ? 1 : 0;
    const hintRows = dropdownRows ? 0 : this.rawHintRowCount(session);
    const inputPadRows = COMPOSER_INPUT_VERTICAL_PADDING;
    // Flat chrome: divider + footer. Boxed chrome: top rule + bottom rule
    // wrapping the input, then either the footer or the autocomplete dropdown.
    const chromeRows = boxed ? (dropdownRows ? 2 : 3) : 2;
    // One blank row between the transcript and the box so responses never sit
    // glued to the top border (skipped in the flat layout: rows are scarce).
    const gapRows = boxed ? 1 : 0;
    const composerHeight =
      attachmentRows +
      inputRows +
      inputPadRows * 2 +
      chromeRows +
      dropdownRows +
      dropdownPadRows +
      hintRows +
      gapRows;
    const outputBottom = Math.max(1, rows - composerHeight);
    const gapRow = gapRows ? rows - composerHeight : null;
    const dividerRow = rows - composerHeight + gapRows;
    const inputPadTopRow = dividerRow + 1;
    const inputRow = inputPadTopRow + inputPadRows;
    const inputPadBottomRow = inputRow + inputRows;
    const boxBottomRow = boxed ? inputPadBottomRow + inputPadRows : null;
    // Attachment section (header + chips) sits under the input band: a fixed
    // place to see what's attached even when the prompt text is long.
    const attachmentRow = boxed ? boxBottomRow + 1 : inputPadBottomRow + inputPadRows;
    const dropdownRow = dropdownRows ? attachmentRow + attachmentRows : null;
    const dropdownPadRow = dropdownPadRows ? dropdownRow + dropdownRows : null;
    const footerRow = dropdownRows ? null : attachmentRow + attachmentRows;
    const hintRow = hintRows ? footerRow + 1 : null;

    return {
      rows,
      columns,
      boxed,
      attachmentRows,
      hintRows,
      inputPadRows,
      attachmentRow,
      inputPadTopRow,
      inputWidth: this.rawInputTextWidth(session, columns, boxed),
      inputRows,
      inputPadBottomRow,
      outputBottom,
      gapRow,
      dividerRow,
      boxBottomRow,
      dropdown,
      dropdownRows,
      dropdownRow,
      dropdownPadRow,
      inputRow,
      footerRow,
      hintRow,
      composerRows: [
        ...(gapRow !== null ? [gapRow] : []),
        dividerRow,
        ...Array.from({ length: inputPadRows }, (_, index) => inputPadTopRow + index),
        ...Array.from({ length: inputRows }, (_, index) => inputRow + index),
        ...Array.from({ length: inputPadRows }, (_, index) => inputPadBottomRow + index),
        ...(boxBottomRow !== null ? [boxBottomRow] : []),
        ...Array.from({ length: attachmentRows }, (_, index) => attachmentRow + index),
        ...Array.from({ length: dropdownRows }, (_, index) => dropdownRow + index),
        ...(dropdownPadRow !== null ? [dropdownPadRow] : []),
        ...(footerRow !== null ? [footerRow] : []),
        ...(hintRows ? [hintRow] : []),
      ],
    };
  }

  rawInputRowCount(session = this.rawInput, inputWidth = this.rawInputTextWidth(session)) {
    const rows = session?.line ? rawInputVisualLines(session.line, inputWidth).length : 1;
    return Math.max(MIN_COMPOSER_INPUT_ROWS, Math.min(MAX_COMPOSER_INPUT_ROWS, rows));
  }

  rawInputTextWidth(
    session = this.rawInput,
    columns = process.stdout.columns || 80,
    boxed = this.shouldUseBoxedComposer() && session?.pinned !== false,
  ) {
    const safeColumns = Math.max(1, Math.max(24, columns) - 1);
    if (session?.pinned !== false) {
      // Half-box: the input band is flush with the rule; only the in-band
      // padding and marker eat width.
      return Math.max(8, safeColumns - COMPOSER_INPUT_SIDE_PADDING - COMPOSER_MARKER_WIDTH);
    }
    const promptWidth = visibleLength(session?.prompt || "");
    return Math.max(8, safeColumns - promptWidth);
  }

  rawAttachmentRowCount(columns = process.stdout.columns || 80) {
    if (!this.pendingAttachments.length) return 0;
    // +1: the section header row above the chips.
    return wrapAttachmentChips(this.pendingAttachments, Math.max(1, Math.max(24, columns) - 1)).length + 1;
  }

  // Header + chip rows under the input band. The header groups what's pending
  // ("Images" when it's only images) so long prompts still show attachments.
  paintAttachmentSection(painter, layout, safeColumns) {
    if (!layout.attachmentRows) return;

    const chipRows = wrapAttachmentChips(this.pendingAttachments, safeColumns);
    const allImages = this.pendingAttachments.every((item) => item.kind === "image");
    const label = `${allImages ? "Images" : "Attachments"} (${this.pendingAttachments.length})`;
    painter
      .to(0, layout.attachmentRow)
      .clearLine()
      .text(fitAnsiLine(c("dim", label), safeColumns));

    for (let index = 0; index < layout.attachmentRows - 1; index += 1) {
      painter
        .to(0, layout.attachmentRow + 1 + index)
        .clearLine()
        .text(fitAnsiLine(chipRows[index] || "", safeColumns));
    }
  }

  rawHintRowCount(session = this.rawInput) {
    return this.inputHint(session?.line || "") ? 1 : 0;
  }

  enableRawInputLayout(session = this.rawInput, layout = this.rawInputLayout(session)) {
    if (!process.stdout.isTTY) return;
    if (this.lastRawScrollBottom === layout.outputBottom) return;
    process.stdout.write(`\x1b[1;${layout.outputBottom}r`);
    this.lastRawScrollBottom = layout.outputBottom;
  }

  disableRawInputLayout() {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[r");
    this.lastRawScrollBottom = null;
  }

  shouldUsePinnedInput() {
    return process.env.ACP_HUB_PINNED_INPUT !== "0";
  }

  shouldUseBracketedPaste() {
    return process.env.ACP_HUB_BRACKETED_PASTE !== "0";
  }

  enableBracketedPaste() {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[?2004h");
  }

  disableBracketedPaste() {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[?2004l");
  }

  renderPinnedRawInput(session, layout = this.rawInputLayout(session)) {
    if (layout.boxed) {
      this.renderBoxedComposer(session, layout);
      return;
    }

    const columns = layout.columns;
    const safeColumns = Math.max(1, columns - 1);
    const inputWidth =
      layout.inputWidth || Math.max(8, safeColumns - COMPOSER_INPUT_SIDE_PADDING - COMPOSER_MARKER_WIDTH);
    const view = this.rawInputMultilineViewport(session, inputWidth, layout.inputRows);
    const footer = this.composerFooter();
    const hint = this.inputHint(session.line);
    const painter = new FramePainter();

    this.paintAttachmentSection(painter, layout, safeColumns);

    painter.to(0, layout.dividerRow).text(fitAnsiLine(this.composerDividerLine(safeColumns), safeColumns));

    for (let index = 0; index < layout.inputPadRows; index += 1) {
      painter.to(0, layout.inputPadTopRow + index).text(inputComposerLine("", safeColumns));
    }

    for (let index = 0; index < layout.inputRows; index += 1) {
      const row = view.rows[index] || { prefix: "  ", text: "" };
      painter
        .to(0, layout.inputRow + index)
        .text(inputComposerLine(`${row.prefix}${row.text}`, safeColumns, row.placeholder));
    }

    for (let index = 0; index < layout.inputPadRows; index += 1) {
      painter.to(0, layout.inputPadBottomRow + index).text(inputComposerLine("", safeColumns));
    }

    painter.to(0, layout.footerRow).text(fitAnsiLine(this.composerMetaLine(footer), safeColumns));

    if (layout.hintRows) {
      painter.to(0, layout.hintRow).text(c("muted", fitPlainLine(this.composerMetaLine(hint), safeColumns)));
    }

    const cursorRow = view.rows[view.cursorRow] || { prefix: "" };
    painter.to(visibleLength(cursorRow.prefix) + view.cursorColumn, layout.inputRow + view.cursorRow);
    painter.flush();
    this.lastRawInputLayout = layout;
  }

  // Border color: provider accent in neutral states; attention states take
  // over the whole frame (permission/auth yellow, error red).
  composerBorderSeq() {
    if (!process.stdout.isTTY) return "";
    const status = normalizeToken(this.currentChat?.status || "");
    if (this.pendingPermission || status === "permission" || status === "auth") return "\x1b[33m";
    if (status === "error") return "\x1b[31m";
    return hubAccentSeq() || providerAccentSeq(this.currentChat?.provider);
  }

  // Rule title is a single segment: the provider identity while quiet, the
  // spinner + activity word while the agent runs, the semantic state when it
  // needs attention. One thing at a time.
  boxedComposerTitle() {
    const chat = this.currentChat || {};
    const status = chat.status || "idle";
    const token = normalizeToken(status);
    const seq = this.composerBorderSeq();
    const reset = colors.reset || "";
    const badges = this.composerBadges(chat, status)
      .map((badge) => c("yellow", badge))
      .join(" ");

    // Two colors only: idle blends into the rule's accent; ANY interaction
    // (thinking/working/responding/…, auth included) is yellow. Yellow title
    // = the agent is doing something. Errors keep red — that's a fault, not
    // an interaction.
    let main;
    if (token === "permission") {
      main = ""; // the [PERMISSION] badge carries it
    } else if (isActiveChatStatus(status) || token === "starting") {
      const frame = COMPOSER_SPINNER_FRAMES[this.composerSpinnerFrame % COMPOSER_SPINNER_FRAMES.length];
      main = c("yellow", `${frame} ${status}`);
    } else if (token === "auth" || token === "error") {
      main = c(token === "error" ? "red" : "yellow", `${statusGlyph(status)} ${status}`);
    } else {
      main = `${seq}${providerIconFor(chat.provider, chat)} ${compactProviderLabel(
        chat.providerLabel || chat.provider,
      )}${reset}`;
    }

    return [main, badges].filter(Boolean).join("  ");
  }

  renderBoxedComposer(session, layout) {
    const safeColumns = Math.max(1, layout.columns - 1);
    const interiorWidth = Math.max(4, safeColumns);
    const inputWidth = layout.inputWidth || Math.max(8, interiorWidth - 3);
    const view = this.rawInputMultilineViewport(session, inputWidth, layout.inputRows);
    const border = this.composerBorderSeq();
    const reset = colors.reset || "";
    const edge = (text) => `${border}${text}${reset}`;
    const painter = new FramePainter();

    if (layout.gapRow !== null) {
      painter.to(0, layout.gapRow).clearLine();
    }

    this.paintAttachmentSection(painter, layout, safeColumns);

    // Half-box: a single top rule carrying the title — ─ <title> ─────
    const rawTitle = this.boxedComposerTitle();
    const title = truncateAnsiText(rawTitle, Math.max(4, safeColumns - 8));
    const fill = Math.max(0, safeColumns - 3 - visibleLength(title));
    painter
      .to(0, layout.dividerRow)
      .clearLine()
      .text(`${edge("─")} ${title} ${edge("─".repeat(fill))}`);

    for (let index = 0; index < layout.inputRows; index += 1) {
      const row = view.rows[index] || { prefix: "  ", text: "" };
      const interior = inputComposerLine(`${row.prefix}${row.text}`, interiorWidth, row.placeholder);
      painter.to(0, layout.inputRow + index).clearLine().text(interior);
    }

    // Bottom rule closing the input band; wrapped-input overflow counters sit
    // inside it, right-aligned.
    if (layout.boxBottomRow !== null) {
      const overflowParts = [];
      if (view.hiddenAbove) overflowParts.push(`↑ ${view.hiddenAbove} more`);
      if (view.hiddenBelow) overflowParts.push(`↓ ${view.hiddenBelow} more`);
      painter.to(0, layout.boxBottomRow).clearLine();
      if (overflowParts.length) {
        const label = overflowParts.join(" · ");
        const left = Math.max(0, safeColumns - 4 - visibleLength(label));
        painter.text(`${edge("─".repeat(left))} ${c("dim", label)} ${edge("──")}`);
      } else {
        painter.text(edge("─".repeat(Math.max(1, safeColumns))));
      }
    }

    if (layout.dropdownRows) {
      this.paintAutocompleteDropdown(painter, layout, safeColumns);
    }

    if (layout.footerRow !== null) {
      painter
        .to(0, layout.footerRow)
        .clearLine()
        .text(fitAnsiLine(this.composerMetaLine(this.composerFooter()), safeColumns));
    }

    if (layout.hintRows) {
      painter
        .to(0, layout.hintRow)
        .clearLine()
        .text(c("muted", fitPlainLine(this.composerMetaLine(this.inputHint(session.line)), safeColumns)));
    }

    const cursorRow = view.rows[view.cursorRow] || { prefix: "" };
    painter.to(
      visibleLength(cursorRow.prefix) + view.cursorColumn,
      layout.inputRow + view.cursorRow,
    );
    painter.flush();
    this.lastRawInputLayout = layout;
  }

  // The inline picker list, in the same zone as the command autocomplete:
  // a title row, then the options (windowed around the selection when there
  // are more options than rows).
  paintInlinePickerDropdown(painter, layout, safeColumns) {
    const dropdown = layout.dropdown;
    const itemRows = layout.dropdownRows - 1;
    const start = Math.min(
      Math.max(0, dropdown.index - itemRows + 1),
      Math.max(0, dropdown.matches.length - itemRows),
    );

    painter
      .to(0, layout.dropdownRow)
      .clearLine()
      .text(fitAnsiLine(`  ${c("bold", dropdown.title)}  ${c("muted", dropdown.hint)}`, safeColumns));

    for (let row = 0; row < itemRows; row += 1) {
      const index = start + row;
      const item = dropdown.matches[index];
      const target = layout.dropdownRow + 1 + row;
      if (!item) {
        painter.to(0, target).clearLine();
        continue;
      }
      const selected = index === dropdown.index;
      const marker = selected ? c("cyan", "❯") : " ";
      const number = c(selected ? "cyan" : "muted", String(index + 1));
      const currentMark = item.current ? c("green", "● ") : "  ";
      const label = selected ? c("bold", stripAnsi(item.label)) : c("muted", stripAnsi(item.label));
      painter
        .to(0, target)
        .clearLine()
        .text(fitAnsiLine(`  ${marker} ${number} ${currentMark}${label}`, safeColumns));
    }
  }

  paintAutocompleteDropdown(painter, layout, safeColumns) {
    const dropdown = layout.dropdown;
    if (!dropdown) return;

    if (layout.dropdownPadRow !== null) {
      painter.to(0, layout.dropdownPadRow).clearLine();
    }

    if (dropdown.kind === "quickselect") {
      this.paintInlinePickerDropdown(painter, layout, safeColumns);
      return;
    }

    const nameWidth = Math.min(
      24,
      Math.max(...dropdown.matches.map((entry) => visibleLength(entry.name))) + 2,
    );

    for (let index = 0; index < layout.dropdownRows; index += 1) {
      const entry = dropdown.matches[index];
      const selected = index === dropdown.index;
      const marker = selected ? c("cyan", "❯") : " ";
      const name = selected ? c("bold", entry.name) : entry.name;
      const hint = entry.hint ? c("muted", entry.hint) : "";
      const padding = " ".repeat(Math.max(1, nameWidth - visibleLength(entry.name)));
      painter
        .to(0, layout.dropdownRow + index)
        .clearLine()
        .text(fitAnsiLine(`  ${marker} ${name}${hint ? `${padding}${hint}` : ""}`, safeColumns));
    }
  }

  // Provider-tinted input marker using an fg-only reset (\x1b[39m) so it keeps
  // the shaded input background applied by inputComposerLine.
  inputMarker() {
    if (!process.stdout.isTTY) return "❯ ";
    const code = { magenta: 35, cyan: 36, blue: 34 }[providerColorName(this.currentChat?.provider)] || 36;
    return `\x1b[${code}m❯\x1b[39m `;
  }

  composerStatusLabelStyled(status) {
    const token = normalizeToken(status);
    if (token === "permission") return "";
    // Two colors only: any interaction is yellow, errors red, quiet muted —
    // same scheme as the boxed title.
    if (isActiveChatStatus(status)) {
      const frame = COMPOSER_SPINNER_FRAMES[this.composerSpinnerFrame % COMPOSER_SPINNER_FRAMES.length];
      return c("yellow", `${frame} ${status}`);
    }
    if (token === "auth") return c("yellow", `${statusGlyph(status)} ${status}`);
    if (token === "error") return c("red", `${statusGlyph(status)} ${status}`);
    return c("muted", `${statusGlyph(status)} ${status || "idle"}`);
  }

  composerTitleStyled() {
    const chat = this.currentChat || {};
    const provider = `${coloredProviderIcon(chat)} ${coloredProviderLabel(chat)}`;
    const status = chat.status || "idle";
    const badges = this.composerBadges(chat, status).map((badge) => c("yellow", badge));
    return [provider, this.composerStatusLabelStyled(status), ...badges].filter(Boolean).join(" ");
  }

  composerDividerLine(columns) {
    const title = this.composerTitleStyled();
    const width = visibleLength(title);
    if (width >= columns) return truncateAnsiText(title, columns);
    return `${title} ${c("dim", "─".repeat(Math.max(0, columns - width - 1)))}`;
  }

  composerMetaLine(text) {
    return `${" ".repeat(COMPOSER_META_SIDE_PADDING)}${text || ""}`;
  }

  composerBadges(chat, status) {
    const badges = [];

    if (this.pendingPermission || normalizeToken(status) === "permission") {
      badges.push("[PERMISSION]");
    }
    if (this.rawInput?.pasteActive) badges.push("[PASTE]");
    if (this.rawInput?.searchActive) badges.push("[SEARCH]");
    if (this.scrollOffsetRows > 0) {
      badges.push(this.scrollNewRows > 0 ? `[↑ ${this.scrollNewRows} new · PgDn]` : "[↑ SCROLL]");
    }

    return badges;
  }

  // Estimated token cost of the current draft: composer text + pending
  // attachments (by size; images flat) + @file mentions resolved against the
  // project (fs.stat only — content is never read). Mention stats are cached
  // per draft text so typing doesn't pay repeated disk hits.
  composerDraftTokenLabel() {
    const session = this.rawInput;
    const line = session?.line || "";
    const pending = this.pendingAttachments || [];
    if (!line.trim() && !pending.length) return "";

    const now = Date.now();
    if (line !== this.tokenEstimateKey || now - (this.tokenEstimateAt || 0) > 1500) {
      this.tokenEstimateKey = line;
      this.tokenEstimateAt = now;
      try {
        this.tokenEstimateMentions = line.includes("@")
          ? mentionAttachmentsForText(this.currentChat?.cwd || this.cwd, line, pending)
          : [];
      } catch {
        this.tokenEstimateMentions = [];
      }
    }

    const tokens = estimateDraftTokens(line, [...pending, ...(this.tokenEstimateMentions || [])]);
    const label = formatTokenEstimate(tokens);
    if (!label) return "";
    // Yellow once the draft alone is heavy enough to matter against context.
    return tokens >= 32000 ? c("yellow", label) : c("muted", label);
  }

  composerFooter() {
    const chat = this.currentChat || {};
    const modelLabel =
      [chatModel(chat), chatEffort(chat)].filter(Boolean).join(" ") || chat.provider || "agent";
    // muted (a real gray), not ANSI dim: this row carries model/context/path
    // and has to stay readable on dark themes.
    const dim = (value) => (value ? c("muted", value) : "");
    // Color hierarchy: model in plain text (brightest), context by usage
    // semaphore, elevated access modes in yellow (risk signal), rest dim.
    const access = chatAccessLabel(chat);
    const accessElevated = access && /full|bypass|yolo|agent|write|edit/i.test(access);
    const segments = [
      this.vimBadgeLabel(),
      dim(this.composerAttachmentLabel()),
      modelLabel,
      this.composerContextLabel(),
      this.composerDraftTokenLabel(),
      this.composerQueueLabel(),
      dim(this.composerMcpLabel()),
      accessElevated ? c("yellow", access) : dim(access),
      dim(displayPath(chat.cwd || this.cwd)),
      dim(this.composerRootsLabel(chat)),
    ].filter(Boolean);
    return segments.join(c("dim", " · "));
  }

  vimBadgeLabel() {
    if (!this.vimEnabled) return "";
    const session = this.rawInput;
    if (session?.vimMode === "visual") {
      return c("cyan", session.vimVisualLine ? "V-LINE" : "VISUAL");
    }
    if (session?.vimMode !== "normal") return c("dim", "INSERT");
    const pending = [
      session.vimCount,
      session.vimOp,
      session.vimGPending ? "g" : "",
      session.vimFind,
      session.vimReplace ? "r" : "",
    ].join("");
    return c("yellow", pending ? `NORMAL ${pending}` : "NORMAL");
  }

  composerContextLabel() {
    const usage = (this.currentChat || {}).usage;
    const text = formatContextUsage(usage);
    if (!text) return "";
    const used = usage?.used;
    const size = usage?.size;
    if (typeof used === "number" && typeof size === "number" && size > 0) {
      const pct = used / size;
      // Compact and quiet while comfortable ("8%" dim); color and the full
      // used/size detail appear only once the window actually fills up.
      const cost = formatCost(usage.cost);
      const label =
        pct < 0.6
          ? `${Math.round(pct * 100)}%${cost ? ` ${cost}` : ""}`
          : `${formatTokenCount(used)}/${formatTokenCount(size)} (${Math.round(pct * 100)}%)${cost ? ` ${cost}` : ""}`;
      return c(pct >= 0.85 ? "red" : pct >= 0.6 ? "yellow" : "dim", label);
    }
    return c("dim", text);
  }

  composerQueueLabel() {
    const pending = this.currentChat?.queued || 0;
    return pending ? c("yellow", `${pending} queued`) : "";
  }

  composerMcpLabel() {
    const count = this.currentChat?.mcpServers?.length || 0;
    return count ? `+${count} mcp` : "";
  }

  composerAttachmentLabel() {
    const count = this.pendingAttachments.length;
    if (!count) return "";
    const totalSize = this.pendingAttachments.reduce((sum, attachment) => sum + (Number(attachment.size) || 0), 0);
    return `${count} attachment${count === 1 ? "" : "s"} ${formatBytes(totalSize)}`;
  }

  composerRootsLabel(chat) {
    const roots = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || this.cwd);
    if (!roots.length) return "";
    return `+${roots.length} root${roots.length === 1 ? "" : "s"}`;
  }

  shouldEchoSubmittedInput(text) {
    const trimmed = String(text || "").trim();
    return Boolean(trimmed) && (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/agent "));
  }

  formatSubmittedInput(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("//")) return this.formatSubmittedBlock(trimmed.slice(1));
    if (trimmed.startsWith("/agent ")) return this.formatSubmittedBlock(trimmed.slice(7).trim());
    return this.formatSubmittedBlock(trimmed);
  }

  formatSubmittedBlock(text) {
    // Provider-tinted rail so each chat's user turns carry its accent.
    const accent = providerAccentSeq(this.currentChat?.provider);
    const reset = colors.reset || "";
    const rail = (glyph) =>
      accent ? `${accent}${colors.bold || ""}${glyph}${reset}` : c("cyan", c("bold", glyph));
    // Single line reads as a prompt (❯); a multiline block gets a uniform left
    // rail so it scans as one quoted block instead of a prompt plus leftovers.
    const lines = String(text || "").split("\n");
    return lines
      .map((line, index) => `${rail(lines.length > 1 ? "│" : index === 0 ? "❯" : "│")} ${c("bold", line)}`)
      .join("\n");
  }

  renderUserTurn(text) {
    // A blank line before the user turn separates it from the previous response;
    // the pending break inserts a gap before the next response starts.
    this.logLine(`\n${this.formatSubmittedBlock(cleanInline(text))}`);
    this.pendingResponseBreak = true;
  }

  rawInputViewport(session, maxWidth) {
    const line = String(session.line || "").replace(/\n/g, " ");
    const cursor = Math.max(0, Math.min(session.cursor, line.length));

    if (line.length <= maxWidth) {
      return { text: line, cursorColumn: cursor };
    }

    const marker = "...";
    const bodyWidth = Math.max(4, maxWidth - marker.length * 2);
    let start = Math.max(0, cursor - Math.floor(bodyWidth * 0.7));
    let end = Math.min(line.length, start + bodyWidth);

    if (end === line.length) {
      start = Math.max(0, end - bodyWidth);
    }

    const left = start > 0 ? marker : "";
    const right = end < line.length ? marker : "";
    const visible = `${left}${line.slice(start, end)}${right}`;
    const cursorColumn =
      left.length + stringDisplayWidth(line.slice(start, Math.max(start, Math.min(cursor, end))));

    return { text: visible, cursorColumn };
  }

  rawInputMultilineViewport(session, maxWidth, maxRows) {
    const line = session.line || "";
    const visualLines = rawInputVisualLines(line, maxWidth);
    const cursor = Math.max(0, Math.min(session.cursor, line.length));
    const cursorLine = rawVisualLineIndexAtCursor(visualLines, cursor);
    const start = Math.min(Math.max(0, cursorLine - maxRows + 1), Math.max(0, visualLines.length - maxRows));
    const end = Math.min(visualLines.length, start + maxRows);
    const visibleLines = visualLines.slice(start, end);
    const selection =
      this.vimEnabled && session.vimMode === "visual" ? vimSelectionRange(session) : null;
    const rows = visibleLines.map((segment, offset) => {
      const index = start + offset;
      const isCursorLine = index === cursorLine;
      const prefix = this.rawInputRowPrefix(segment, index, offset, start, end, visualLines.length);
      const cursorUnits = Math.max(0, Math.min(cursor - segment.start, segment.text.length));
      let text = segment.text;
      if (selection) {
        // Reverse-video the selected span; 27m (not a full reset) keeps the
        // composer band's background style intact around it.
        const from = Math.max(0, selection.start - segment.start);
        const to = Math.min(text.length, selection.end - segment.start);
        if (to > from) {
          text = `${text.slice(0, from)}\x1b[7m${text.slice(from, to)}\x1b[27m${text.slice(to)}`;
        }
      }
      return {
        prefix,
        text,
        // Cursor column in display columns (wide chars take two).
        cursorColumn: isCursorLine ? stringDisplayWidth(segment.text.slice(0, cursorUnits)) : 0,
      };
    });

    if (!line) {
      rows[0] = {
        prefix: this.rawInputPrefix(this.inputMarker()),
        text: COMPOSER_PLACEHOLDER,
        cursorColumn: 0,
        placeholder: true,
      };
    }

    return {
      rows,
      cursorRow: Math.max(0, Math.min(maxRows - 1, cursorLine - start)),
      cursorColumn: rows[Math.max(0, Math.min(maxRows - 1, cursorLine - start))]?.cursorColumn || 0,
      hiddenAbove: start,
      hiddenBelow: Math.max(0, visualLines.length - end),
    };
  }

  rawInputRowPrefix(segment, index) {
    // Overflow is signalled by ↑/↓ counters in the box border, not by prefix
    // markers, so every row after the first just aligns under the marker.
    if (index === 0) return this.rawInputPrefix(this.inputMarker());
    return this.rawInputPrefix("  ");
  }

  rawInputPrefix(marker) {
    return `${" ".repeat(COMPOSER_INPUT_SIDE_PADDING)}${marker}`;
  }

  // Autocomplete dropdown state, derived from the input each render/keypress.
  // Only the selection index and the Esc suppression are stateful (on the
  // session, keyed by kind+query so they reset the moment the input changes).
  composerAutocomplete(session) {
    if (!session || session.pinned === false || session.searchActive || session.pasteActive) {
      return null;
    }

    const line = session.line || "";
    if (!line) return null;

    if (line.startsWith("/") && !line.startsWith("//")) {
      const token = line.split(/\s+/)[0];
      const cursor = Math.max(0, Math.min(session.cursor, line.length));
      if (cursor > token.length) return null;

      const matches = this.chatCommands().filter((command) => command.name.startsWith(token));
      if (!matches.length) return null;
      if (matches.length === 1 && matches[0].name === token) return null;
      // An exactly-typed command sorts first so Enter submits it instead of
      // accepting a longer completion (e.g. /mode while /model also matches).
      const exactIndex = matches.findIndex((command) => command.name === token);
      if (exactIndex > 0) matches.unshift(...matches.splice(exactIndex, 1));
      return { kind: "command", token, matches: matches.slice(0, 5), key: `c:${token}` };
    }

    const mention = this.currentFileMention(session);
    if (mention) {
      const files = this.fileMentionMatches(mention.query, 5);
      if (!files.length) return null;
      return {
        kind: "mention",
        mention,
        matches: files.map((file) => ({ name: `@${file}`, file })),
        key: `m:${mention.query}`,
      };
    }

    return null;
  }

  activeAutocomplete(session = this.rawInput) {
    if (!session) return null;
    if (!(this.shouldUseBoxedComposer() && session.pinned !== false)) return null;

    const state = this.composerAutocomplete(session);
    if (!state) return null;
    if (session.autocompleteSuppressedKey === state.key) return null;

    if (session.autocompleteKey !== state.key) {
      session.autocompleteKey = state.key;
      session.autocompleteIndex = 0;
    }
    state.index = Math.max(0, Math.min(session.autocompleteIndex, state.matches.length - 1));
    return state;
  }

  acceptAutocomplete(session, dropdown) {
    const entry = dropdown.matches[dropdown.index];
    if (!entry) return;

    if (dropdown.kind === "command") {
      const replacement = `${entry.name} `;
      session.line = `${replacement}${session.line.slice(dropdown.token.length).trimStart()}`;
      session.cursor = replacement.length;
      session.historyIndex = this.inputHistory.length;
      this.saveRawDraft(session);
    } else {
      this.replaceRawRange(
        session,
        dropdown.mention.start,
        dropdown.mention.end,
        `@${escapeMentionPath(entry.file)}`,
      );
    }
  }

  // Returns true when the key drove the dropdown (caller stops processing).
  handleAutocompleteKey(session, input, key) {
    const dropdown = this.activeAutocomplete(session);
    if (!dropdown) return false;

    const count = dropdown.matches.length;

    // Ctrl+N/P (and the arrows) travel the list; Tab completes the selection
    // so the typing hand never leaves the home row.
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      session.autocompleteIndex = (dropdown.index + 1) % count;
      this.renderRawInput();
      return true;
    }

    if (key.name === "up" || (key.ctrl && key.name === "p") || (key.name === "tab" && key.shift)) {
      session.autocompleteIndex = (dropdown.index - 1 + count) % count;
      this.renderRawInput();
      return true;
    }

    if (key.name === "tab") {
      this.acceptAutocomplete(session, dropdown);
      this.renderRawInput();
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      // An exactly-typed command falls through so Enter still submits.
      if (dropdown.kind === "command" && dropdown.matches[dropdown.index]?.name === dropdown.token) {
        return false;
      }
      this.acceptAutocomplete(session, dropdown);
      this.renderRawInput();
      return true;
    }

    if (key.name === "right" && session.cursor === session.line.length) {
      this.acceptAutocomplete(session, dropdown);
      this.renderRawInput();
      return true;
    }

    if (key.name === "escape") {
      session.autocompleteSuppressedKey = dropdown.key;
      this.renderRawInput();
      return true;
    }

    return false;
  }

  completeRawSlashCommand(session) {
    if (!session.line.startsWith("/") || session.line.startsWith("//")) return;

    const token = session.line.split(/\s+/)[0];
    const matches = this.chatCommands()
      .map((command) => command.name)
      .filter((name) => name.startsWith(token));

    if (matches.length !== 1) return;

    const replacement = `${matches[0]} `;
    session.line = `${replacement}${session.line.slice(token.length).trimStart()}`;
    session.cursor = replacement.length;
  }

  completeRawFileMention(session) {
    const mention = this.currentFileMention(session);
    if (!mention) return false;

    const matches = this.fileMentionMatches(mention.query, 8);
    if (!matches.length) return false;

    if (matches.length === 1) {
      this.replaceRawRange(session, mention.start, mention.end, `@${escapeMentionPath(matches[0])}`);
      return true;
    }

    const common = commonPathPrefix(matches);
    if (common && common.length > mention.query.length) {
      this.replaceRawRange(session, mention.start, mention.end, `@${escapeMentionPath(common)}`);
      return true;
    }

    return false;
  }

  replaceRawRange(session, start, end, text) {
    session.line = `${session.line.slice(0, start)}${text}${session.line.slice(end)}`;
    session.cursor = start + text.length;
    session.historyIndex = this.inputHistory.length;
    this.saveRawDraft(session);
  }

  inputHint(line) {
    if (this.scrollOffsetRows > 0) {
      return "viewing transcript · PgUp/PgDn page · Home top · End/Esc latest";
    }
    if (this.rawInput?.searchActive) {
      const matches = this.rawHistorySearchMatches(this.rawInput.searchQuery);
      const position = matches.length ? `${this.rawInput.searchIndex + 1}/${matches.length}` : "0/0";
      return `history ${position}: ${this.rawInput.searchQuery || "-"}`;
    }
    if (this.rawInput?.pasteActive) return "pasting block...";
    if (!line && this.pendingAttachments.length) {
      return footerParts([
        this.rawInput?.lastPasteSummary,
        "Enter sends attachments",
        "Backspace removes last",
        "/detach all clears",
      ]).join(" · ");
    }
    if (this.rawInput?.lastPasteSummary) return this.rawInput.lastPasteSummary;
    const mention = this.currentFileMention(this.rawInput);
    if (mention) {
      const matches = this.fileMentionMatches(mention.query, 5);
      if (!matches.length) return "@ no file matches";
      return matches.map((match) => `@${match}`).join(" ");
    }
    if (looksLikePathInput(line)) {
      const pathAttachments = attachmentsFromPathOnlyText(line, this.currentChat?.cwd || this.cwd);
      if (pathAttachments.length) return `Enter attaches ${pastedAttachmentSummary(pathAttachments)}`;
    }
    if (line && line.includes("\n")) return "Enter sends · Ctrl+J newline";
    // Inside a chat the hint row is always kept, so typing never drops it and
    // slides the composer down. Keys are spelled out (Tab, Alt+E) — no glyph
    // soup — and no chat STATE is repeated here: mode/access/model live in
    // the footer above; this row only teaches the keys.
    if (!line) {
      if (!this.currentChat?.id) return "";
      const modes = modeEntries(this.currentChat?.modes);
      if (modes.length >= 2) {
        return "← menu · Tab mode · Ctrl+X editor";
      }
      return "← menu · Ctrl+X editor";
    }
    if (!line.startsWith("/") || line.startsWith("//")) {
      return this.currentChat?.id ? "Enter sends · Ctrl+J newline · Ctrl+X editor · Ctrl+O menu" : "";
    }

    const token = line.split(/\s+/)[0];
    const matches = this.chatCommands().filter((command) => command.name.startsWith(token));
    if (!matches.length) return "unknown command";
    if (matches.length === 1 && matches[0].name === token) return matches[0].hint;

    return matches
      .slice(0, 5)
      .map((command) => command.name)
      .join(" ");
  }

  currentFileMention(session) {
    if (!session?.line) return null;
    const cursor = Math.max(0, Math.min(session.cursor, session.line.length));
    const before = session.line.slice(0, cursor);
    const match = /(^|[\s([{,])@([^\s]*)$/.exec(before);
    if (!match) return null;
    const start = before.length - match[2].length - 1;
    const end = cursor;
    return {
      start,
      end,
      query: unescapeMentionPath(match[2]),
    };
  }

  fileMentionMatches(query, limit = 10) {
    const files = this.projectFileMentions(this.currentChat?.cwd || this.cwd);
    const cleanQuery = normalizeMentionQuery(query);
    const matches = [];

    for (const file of files) {
      const score = fileMentionScore(file, cleanQuery);
      if (score < 0) continue;
      matches.push({ file, score });
    }

    return matches
      .sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file))
      .slice(0, limit)
      .map((entry) => entry.file);
  }

  projectFileMentions(cwd) {
    const root = path.resolve(cwd || this.cwd);
    const cached = this.fileMentionCache.get(root);
    if (cached && Date.now() - cached.timestamp < FILE_MENTION_CACHE_MS) return cached.files;

    const files = listProjectFiles(root, FILE_MENTION_LIMIT);
    this.fileMentionCache.set(root, { timestamp: Date.now(), files });
    return files;
  }

  chatCommands() {
    return [
      { name: "/menu", hint: "open agent/chat menu" },
      { name: "/control", hint: "open command center" },
      { name: "/cmd", hint: "open command center" },
      { name: "/panel", hint: "open command center" },
      { name: "/chats", hint: "show chat selector" },
      { name: "/compose", hint: "multiline prompt; finish with ." },
      { name: "/edit", hint: "write prompt in $VISUAL or $EDITOR" },
      { name: "/new", hint: "create another provider chat" },
      { name: "/refresh", hint: "import provider sessions" },
      { name: "/config", hint: "show or set ACP config options" },
      { name: "/model", hint: "set model config option" },
      { name: "/effort", hint: "set effort/reasoning option" },
      { name: "/commands", hint: "show provider commands" },
      { name: "/modes", hint: "show provider modes" },
      { name: "/mode", hint: "set provider mode" },
      { name: "/access", hint: "set access alias" },
      { name: "/permissions", hint: "set access alias" },
      { name: "/roots", hint: "manage additional directories" },
      { name: "/changes", hint: "browse edited files as diffs" },
      { name: "/attach", hint: "attach file(s) to next prompt" },
      { name: "/attachments", hint: "show pending attachments" },
      { name: "/files", hint: "show pending attachments" },
      { name: "/detach", hint: "remove pending attachments" },
      { name: "/cancel", hint: "cancel current turn" },
      { name: "/allow", hint: "approve permission option" },
      { name: "/deny", hint: "reject permission" },
      { name: "/rename", hint: "rename this chat" },
      { name: "/title", hint: "rename this chat" },
      { name: "/activity", hint: "tool activity: compact, hidden, debug" },
      { name: "/vim", hint: "toggle vim editing mode" },
      { name: "/debug", hint: "toggle hub internals" },
      { name: "/restart", hint: "restart the hub daemon (chats kept)" },
      { name: "/help", hint: "show command help" },
      { name: "/exit", hint: "close popup client" },
    ];
  }

  logLine(text = "", options = {}) {
    if (!options.skipChunkFlush) {
      this.flushChunkBuffer({ force: true, preservePendingMarkdownTable: true });
    }
    if (this.canPaintPinned()) {
      this.emitTranscript(`${text}\n`, options);
      return;
    }
    if (options.recordTranscript !== false) this.recordTranscriptOutput(`${text}\n`);
    this.beforeAsyncOutput();
    process.stdout.write(`${text}\n`);
    this.afterAsyncOutput();
  }

  hasPendingStreamState() {
    return Boolean(this.chunkBuffer || this.mdHeldLine !== null || this.liveTable);
  }

  writeChunk(text = "", options = {}) {
    if (!text) return;

    const markdown = options.markdown === true;
    const dim = options.dim === true;
    if (
      this.hasPendingStreamState() &&
      (this.chunkBufferMarkdown !== markdown || this.chunkBufferDim !== dim)
    ) {
      this.flushChunkBuffer({ force: true });
    }

    this.chunkBufferMarkdown = markdown;
    this.chunkBufferDim = dim;
    this.chunkBuffer += String(text);
    this.flushChunkBuffer();
  }

  renderMarkdown(text, { width = null } = {}) {
    const input = String(text || "");
    const hasTrailingNewline = input.endsWith("\n");
    const lines = input.split("\n");
    if (hasTrailingNewline) lines.pop();

    const output = [];
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const fence = line.match(/^\s*```(\S*)?\s*$/);

      if (fence) {
        this.markdownFence = !this.markdownFence;
        this.markdownFenceLang = this.markdownFence ? fence[1] || "" : "";
        output.push(this.markdownFence && fence[1] ? codeFenceHeader(fence[1], width) : "");
        index += 1;
        continue;
      }

      if (this.markdownFence) {
        output.push(codeBlockLine(highlightCode(line, this.markdownFenceLang), { width }));
        index += 1;
        continue;
      }

      if (isMarkdownTableStart(lines, index)) {
        const tableLines = [lines[index], lines[index + 1]];
        index += 2;

        while (index < lines.length && isMarkdownTableRow(lines[index])) {
          tableLines.push(lines[index]);
          index += 1;
        }

        output.push(renderMarkdownTable(tableLines));
        continue;
      }

      output.push(this.renderMarkdownLine(line, width));
      index += 1;
    }

    const rendered = output.join("\n");
    return `${rendered}${hasTrailingNewline ? "\n" : ""}`;
  }

  // renderMarkdown for text outside the transcript stream (picker preview):
  // the fence flag is streaming state shared with the live chunk machine, so
  // it must survive this call untouched.
  renderMarkdownDetached(text, width = null) {
    const savedFence = this.markdownFence;
    const savedFenceLang = this.markdownFenceLang;
    this.markdownFence = false;
    this.markdownFenceLang = "";
    try {
      return this.renderMarkdown(text, { width });
    } finally {
      this.markdownFence = savedFence;
      this.markdownFenceLang = savedFenceLang;
    }
  }

  renderMarkdownLine(line, width = null) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) return c("bold", renderInlineMarkdown(heading[2].trim()));

    if (/^\s*[-*_]{3,}\s*$/.test(line)) return c("dim", horizontalRuleLine(width));

    const quote = line.match(/^(\s*)>\s?(.*)$/);
    if (quote) return `${quote[1]}${c("dim", "|")} ${renderInlineMarkdown(quote[2])}`;

    const task = line.match(/^(\s*)[-*+]\s+\[([ xX-])\]\s+(.+)$/);
    if (task) {
      const marker = /x/i.test(task[2]) ? c("green", "x") : c("dim", " ");
      return `${task[1]}[${marker}] ${renderInlineMarkdown(task[3])}`;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (unordered) return `${unordered[1]}${c("dim", "-")} ${renderInlineMarkdown(unordered[2])}`;

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      return `${ordered[1]}${c("dim", `${ordered[2]}.`)} ${renderInlineMarkdown(ordered[3])}`;
    }

    return renderInlineMarkdown(line);
  }

  flushChunkBuffer(options = {}) {
    // Markdown streamed into the pinned layout goes through the line machine:
    // tables render progressively and are re-painted in place as rows arrive.
    if (this.chunkBufferMarkdown && !this.chunkBufferDim && this.canPaintPinned()) {
      this.flushMarkdownStream(options);
      return;
    }

    if (!this.chunkBuffer) return;

    let text;
    if (options.force) {
      if (
        options.preservePendingMarkdownTable &&
        this.chunkBufferMarkdown &&
        hasPendingMarkdownTable(this.chunkBuffer)
      ) {
        return;
      }
      text = this.chunkBuffer;
      this.chunkBuffer = "";
    } else {
      const newline = this.chunkBuffer.lastIndexOf("\n");
      if (newline === -1) return;
      if (this.chunkBufferMarkdown && hasPendingMarkdownTable(this.chunkBuffer)) return;

      text = this.chunkBuffer.slice(0, newline + 1);
      this.chunkBuffer = this.chunkBuffer.slice(newline + 1);
    }

    const output = this.formatChunkBufferText(text);
    let written = output;
    if (options.force && !output.endsWith("\n")) written += "\n";

    if (this.canPaintPinned()) {
      // Pinned layout active (e.g. dim thought chunks): soft-wrapped emit so
      // painted rows match the recorded transcript.
      this.emitTranscript(written);
    } else {
      this.recordTranscriptOutput(written);
      this.beforeAsyncOutput();
      process.stdout.write(output);
      if (options.force && !output.endsWith("\n")) {
        process.stdout.write("\n");
      }
      this.afterAsyncOutput();
    }

    if (!this.chunkBuffer) {
      this.chunkBufferMarkdown = false;
      this.chunkBufferDim = false;
    }
  }

  flushMarkdownStream(options = {}) {
    let complete = "";
    if (options.force) {
      complete = this.chunkBuffer;
      this.chunkBuffer = "";
    } else {
      const newline = this.chunkBuffer.lastIndexOf("\n");
      if (newline === -1) return;
      complete = this.chunkBuffer.slice(0, newline + 1);
      this.chunkBuffer = this.chunkBuffer.slice(newline + 1);
    }

    if (complete) {
      const lines = complete.split("\n");
      const trailing = lines.pop();
      // A force flush can cut a line mid-stream; render the partial as a line.
      if (trailing) lines.push(trailing);
      for (const line of lines) this.feedMarkdownLine(line);
    }

    if (options.force) {
      this.finalizeMarkdownStream();
      this.chunkBufferMarkdown = false;
      this.chunkBufferDim = false;
    }
  }

  // One logical markdown line at a time: fences pass through, a lone table row
  // is held until the separator proves a table started, and table rows feed
  // the live table which re-renders in place.
  feedMarkdownLine(line) {
    const fence = line.match(/^\s*```(\S*)?\s*$/);
    if (fence) {
      this.finalizeMarkdownStream();
      this.markdownFence = !this.markdownFence;
      this.markdownFenceLang = this.markdownFence ? fence[1] || "" : "";
      this.emitTranscript(`${this.markdownFence && fence[1] ? codeFenceHeader(fence[1]) : ""}\n`);
      return;
    }

    if (this.markdownFence) {
      this.emitTranscript(`${codeBlockLine(highlightCode(line, this.markdownFenceLang))}\n`);
      return;
    }

    if (this.liveTable) {
      if (isMarkdownTableRow(line)) {
        this.liveTable.sourceLines.push(line);
        this.scheduleLiveTablePaint();
        return;
      }
      this.finalizeLiveTable();
    }

    if (this.mdHeldLine !== null) {
      const held = this.mdHeldLine;
      this.mdHeldLine = null;
      if (isMarkdownTableSeparator(line)) {
        this.startLiveTable([held, line]);
        return;
      }
      this.emitTranscript(`${this.renderMarkdownLine(held)}\n`);
    }

    if (isMarkdownTableRow(line) && !isMarkdownTableSeparator(line)) {
      this.mdHeldLine = line;
      return;
    }

    this.emitTranscript(`${this.renderMarkdownLine(line)}\n`);
  }

  finalizeMarkdownStream() {
    if (this.mdHeldLine !== null) {
      const held = this.mdHeldLine;
      this.mdHeldLine = null;
      this.emitTranscript(`${this.renderMarkdownLine(held)}\n`);
    }
    this.finalizeLiveTable();
  }

  renderLiveTableLines(sourceLines) {
    const width = this.transcriptWrapWidth();
    return renderMarkdownTable(sourceLines)
      .split("\n")
      .map((row) => (visibleLength(row) > width ? truncateAnsiText(row, width) : row));
  }

  startLiveTable(sourceLines) {
    const rendered = this.renderLiveTableLines(sourceLines);
    this.liveTable = {
      sourceLines,
      startIndex: this.transcriptLines.length - 1,
      lineCount: rendered.length,
      paintedCount: rendered.length,
      rendered,
    };
    this.emitTranscript(`${rendered.join("\n")}\n`);
  }

  // Re-renders the streaming table with widths recomputed from all rows so far
  // and replaces its logical lines in the transcript. Runs synchronously per
  // row so the buffer (scrollback, repaints) is always current.
  syncLiveTableBuffer() {
    const table = this.liveTable;
    if (!table) return [];

    const rendered = this.renderLiveTableLines(table.sourceLines);
    this.transcriptLines.splice(table.startIndex, table.lineCount, ...rendered);
    table.lineCount = rendered.length;
    table.rendered = rendered;
    return rendered;
  }

  scheduleLiveTablePaint() {
    if (!this.liveTable) return;
    this.syncLiveTableBuffer();

    if (this.liveTablePaintTimer) {
      this.liveTablePaintPending = true;
      return;
    }

    this.paintLiveTable();
    this.liveTablePaintTimer = setTimeout(() => {
      this.liveTablePaintTimer = null;
      if (this.liveTablePaintPending && this.liveTable) {
        this.liveTablePaintPending = false;
        this.paintLiveTable();
      }
    }, LIVE_TABLE_PAINT_MS);
    this.liveTablePaintTimer.unref?.();
  }

  // Paints the current table block in place at the bottom of the scroll
  // region: scrolls up for rows added since the last paint, then rewrites the
  // visible block rows (widths may have changed).
  paintLiveTable() {
    const table = this.liveTable;
    if (!table) return;

    const rendered = table.rendered || this.syncLiveTableBuffer();
    const delta = table.lineCount - table.paintedCount;
    table.paintedCount = table.lineCount;

    if (this.activePicker) return;

    if (this.scrollOffsetRows > 0) {
      if (delta > 0) this.scrollNewRows += delta;
      if (this.rawInput) this.renderRawInput();
      return;
    }

    if (!this.canPaintPinned()) return;

    if (delta < 0) {
      this.repaintPinnedOutput();
      return;
    }

    const bottom = this.pinnedOutputRows();
    const painter = new FramePainter();
    if (delta > 0) {
      painter.to(0, bottom - 1).text("\r\n".repeat(delta));
    }

    const blockTop = bottom - rendered.length;
    const visible = rendered.slice(Math.max(0, -blockTop));
    const startRow = Math.max(0, blockTop);
    visible.forEach((row, index) => {
      painter.to(0, startRow + index).clearLine().text(row).text(colors.reset || "");
    });
    this.restoreComposerCursor(painter);
    painter.flush();
  }

  finalizeLiveTable() {
    if (!this.liveTable) return;
    if (this.liveTablePaintTimer) {
      clearTimeout(this.liveTablePaintTimer);
      this.liveTablePaintTimer = null;
    }
    this.liveTablePaintPending = false;
    this.syncLiveTableBuffer();
    this.paintLiveTable();
    this.liveTable = null;
  }

  formatChunkBufferText(text) {
    let output = this.chunkBufferMarkdown ? this.renderMarkdown(text) : text;
    if (this.chunkBufferDim) output = c("dim", output);
    return output;
  }

  beforeAsyncOutput() {
    if (!this.questionActive) return;

    if (this.rawInput) {
      this.clearRawInputLine();
      if (this.rawInput.pinned) {
        this.enableRawInputLayout(this.rawInput);
        readlineTerminal.cursorTo(process.stdout, 0, this.rawInputLayout(this.rawInput).outputBottom - 1);
      }
      return;
    }

    if (process.stdout.isTTY) {
      readlineTerminal.clearLine(process.stdout, 0);
      readlineTerminal.cursorTo(process.stdout, 0);
    } else {
      process.stdout.write("\n");
    }
  }

  afterAsyncOutput() {
    if (!this.questionActive || !process.stdout.isTTY) return;

    if (this.rawInput) {
      this.renderRawInput();
      return;
    }

    const line = this.rl.line || "";
    process.stdout.write(`${this.currentPrompt}${line}`);
  }

  clearScreen() {
    if (process.stdout.isTTY) {
      this.disableRawInputLayout();
      process.stdout.write("\x1b[2J\x1b[H");
    }
  }

  handleHubEvent(message) {
    if (this.closed) return;

    if (message.event === "shutdown") {
      // Graceful stop. Marking closed and closing readline used to leave the
      // RAW-stdin composer alive and deaf (the popup "hung"); route through
      // the same clean exit as a socket-level loss instead.
      if (this.rl) this.rl.close();
      this.exitOnDaemonLoss("stopped");
      return;
    }

    if (message.event === "permission_request" && message.chatId === this.currentChat?.id) {
      this.pendingPermission = {
        permissionId: message.permissionId,
        options: message.params.options || [],
        toolCall: message.params.toolCall || null,
      };
      // Open the picker right away instead of waiting for the user to guess how
      // to answer (the numbered options looked like agent input before).
      this.maybeInterruptForPermission();
      return;
    }

    if (this.activePicker?.onEvent) {
      this.activePicker.onEvent(message);
    }

    if (message.type === "chat_state" && message.chat?.id === this.currentChat?.id) {
      const titleChanged =
        message.chat.title && message.chat.title !== this.currentChat?.title;
      this.currentChat = message.chat;
      // Keep the window name (#W, the tab's fallback) in step with title
      // changes — the per-prompt provisional title and the adapter's own
      // session_info_update both land here.
      if (titleChanged) this.syncTmuxWindow(this.currentChat, { force: true });
      this.refreshRawInputPrompt({ render: false });
      if (isSettledChatStatus(this.currentChat.status)) {
        this.flushChunkBuffer({ force: true });
      }
      this.refreshRawInputPrompt();
      return;
    }

    if (message.type === "chat_event" && message.chatId === this.currentChat?.id) {
      this.currentChat = message.chat || this.currentChat;
      this.refreshRawInputPrompt({ render: false });
      this.renderEvent(message.event);
    }
  }

  refreshRawInputPrompt(options = {}) {
    if (!this.rawInput) return;
    this.rawInput.prompt = this.inputPrompt();
    this.syncComposerSpinner();
    if (options.render !== false) this.renderRawInput();
  }

  syncComposerSpinner() {
    if (!this.rawInput?.pinned || !isActiveChatStatus(this.currentChat?.status)) {
      this.stopComposerSpinner();
      return;
    }

    if (this.composerSpinnerTimer) return;
    this.composerSpinnerTimer = setInterval(() => {
      if (!this.rawInput?.pinned || !isActiveChatStatus(this.currentChat?.status)) {
        this.stopComposerSpinner();
        if (this.rawInput) this.renderRawInput();
        return;
      }

      this.composerSpinnerFrame += 1;
      this.renderRawInput();
    }, COMPOSER_SPINNER_INTERVAL_MS);
    this.composerSpinnerTimer.unref?.();
  }

  stopComposerSpinner() {
    if (!this.composerSpinnerTimer) return;
    clearInterval(this.composerSpinnerTimer);
    this.composerSpinnerTimer = null;
  }

  // Seeds/refreshes the current window's metadata on direct user actions
  // (open, rename, mode change). Ongoing status updates are owned by the
  // daemon, which keeps windows fresh even when no popup is attached.
  syncTmuxWindow(chat, options = {}) {
    if (!chat || !process.env.TMUX) return;

    const now = Date.now();
    if (!options.force && now - this.lastTmuxMetadataAt < 750) return;
    this.lastTmuxMetadataAt = now;

    // Target this UI's own pane/window explicitly. A bare set-window-option
    // writes to whatever window is "current", which during open — the menu
    // window closing, select-window still in flight — may not be this chat's
    // window yet. That left the chat window's @acp_hub_title (and the
    // @acp_hub_chat_id the daemon keys its own sync on) unset, so the tab
    // showed the raw canonical name until a reattach forced a refresh.
    const ownPane = process.env.TMUX_PANE || "";
    const values = tmuxWindowOptionValues(chat);
    setTmuxWindowOptions(values, ownPane);
    // Re-assert the session's ACP status format too — the popup/daemon boot
    // race can revert it to the theme default; then the tab falls back to the
    // window name, which we keep equal to the title so it stays clean.
    applyAcpStatusFormat(ownPane);

    // Keep the window name in sync with the chat title so #W (the tab's
    // fallback and the prefix+s tree label) reads as the title, never a hash.
    const windowName = values["@acp_hub_title"];
    if (ownPane && windowName && windowName !== this.lastSyncedWindowName) {
      this.lastSyncedWindowName = windowName;
      try {
        const child = spawn("tmux", ["rename-window", "-t", ownPane, windowName], { stdio: "ignore" });
        child.on("error", () => {});
        child.unref?.();
      } catch {
        // Cosmetic only.
      }
    }
  }

  renderEvent(event, options = {}) {
    switch (event.type) {
      case "system":
        if (options.replay && event.text?.startsWith("Starting ")) return;
        if (event.level === "error") {
          this.logLine(c("red", `\n✗ ${event.text}`));
        } else if (event.level === "warn") {
          this.logLine(c("yellow", `\n⚠ ${event.text}`));
        } else if (this.showInternalEvents) {
          this.logLine(c("dim", `[${event.level || "info"}] ${event.text}`));
        }
        break;
      case "adapter_log":
        if (!options.replay && this.showInternalEvents) this.logLine(c("dim", `[adapter] ${event.text}`));
        break;
      case "user":
        if (options.replay) this.renderUserTurn(event.text);
        break;
      case "agent_chunk":
        this.closeActivityBlock();
        this.renderResponseChunk(event);
        break;
      case "thought_chunk":
        this.renderThoughtChunk(event, options);
        break;
      case "tool_call":
        this.renderToolEvent(event, options);
        break;
      case "tool_update":
        this.renderToolEvent(event, options);
        break;
      case "plan":
        this.renderPlan(event.entries || [], options);
        break;
      case "permission":
        this.renderPermission(event);
        break;
      case "auth_required":
        this.logLine(`\n${c("yellow", event.text || "Authentication required")}`);
        break;
      case "turn_done":
        this.flushChunkBuffer({ force: true });
        this.closeActivityBlock();
        this.pendingResponseBreak = false;
        this.lastStreamEventKey = "";
        this.markdownFence = false;
        if (this.showInternalEvents || event.stopReason === "cancelled") {
          this.logLine(c("dim", `\n[done] ${event.stopReason}`));
        }
        break;
      case "error":
        this.logLine(c("red", `\n✗ ${event.text}`));
        break;
      case "raw_update":
        if (this.showInternalEvents) {
          this.logLine(c("dim", `\n[update] ${JSON.stringify(event.update)}`));
        }
        break;
      default:
        if (this.showInternalEvents) {
          this.logLine(c("dim", `\n[event] ${JSON.stringify(event)}`));
        }
    }
  }

  renderResponseChunk(event) {
    this.ensureResponseBreak();
    this.ensureStreamBoundary("agent", event.messageId);
    this.writeChunk(event.text || "", { markdown: true });
  }

  renderThoughtChunk(event, options = {}) {
    const visible = this.showInternalEvents || this.activityMode === "debug";
    if (!visible) return;

    this.closeActivityBlock();
    this.ensureResponseBreak();
    this.ensureStreamBoundary("thought", event.messageId);
    this.writeChunk(event.text || "", { markdown: true, dim: true });
  }

  ensureResponseBreak() {
    if (!this.pendingResponseBreak) return;

    this.flushChunkBuffer({ force: true, preservePendingMarkdownTable: true });
    if (this.canPaintPinned()) {
      this.emitTranscript("\n");
    } else {
      this.recordTranscriptOutput("\n");
      this.beforeAsyncOutput();
      process.stdout.write("\n");
      this.afterAsyncOutput();
    }
    this.pendingResponseBreak = false;
  }

  ensureStreamBoundary(type, messageId) {
    const key = `${type}:${messageId || ""}`;
    if (this.lastStreamEventKey && this.lastStreamEventKey !== key) {
      if (this.hasPendingStreamState()) {
        if (this.chunkBuffer && !/\n\s*$/.test(this.chunkBuffer)) this.chunkBuffer += "\n\n";
        this.flushChunkBuffer();
        // A held table-row candidate or live table must not leak into the next
        // message stream.
        if (!this.chunkBuffer && (this.mdHeldLine !== null || this.liveTable)) {
          this.finalizeMarkdownStream();
        }
      }
      // A new message stream starts fresh: don't let an unclosed code fence from
      // the previous message leak in and render everything after it raw.
      this.markdownFence = false;
    }
    this.lastStreamEventKey = key;
  }

  renderToolEvent(event, options = {}) {
    // A tool interrupts the agent's text run. Flush the buffered text first (so a
    // pending code block renders), then close any open code fence so a leftover
    // ``` doesn't render the following text (e.g. a results table) raw.
    this.flushChunkBuffer({ force: true });
    this.markdownFence = false;

    const status = event.status || "pending";
    const title = event.title || event.toolCallId || "tool";
    const kind = event.kind || "";
    const failed = /fail|error|denied|rejected|cancelled/i.test(status);

    if (failed && !this.showInternalEvents && this.activityMode !== "debug") {
      this.logLine(`\n${c("red", "✗")} ${c("red", status)} ${kind} ${cleanInline(title)}`);
      if (event.summary) this.logLine(c("dim", event.summary));
      return;
    }

    if (this.showInternalEvents || this.activityMode === "debug") {
      const color = failed ? "red" : "yellow";
      this.logLine(`\n${c(color, "[tool]")} ${status} ${kind} ${title}`);
      if (event.summary) this.logLine(c("dim", event.summary));
      return;
    }

    if (this.activityMode !== "hidden" && isCompletedToolStatus(status)) {
      this.renderActivityEvent(event);
      return;
    }

    // In-flight tool calls stay quiet: notify() paints tmux's client-wide
    // message line, which flashes over every window while the agent works.
    // The composer spinner and the status-bar glyph already say "working".
  }

  renderActivityEvent(event) {
    const group = activityGroupFor(event);
    const title = cleanInline(event.title || event.toolCallId || "tool");
    const summary = cleanActivitySummary(event.summary || "", group);

    if (this.lastActivityGroup && this.lastActivityGroup !== group) {
      // Blank before the rule mirrors the blank after it — symmetric sections.
      this.logLine("");
      this.logLine(c("dim", activityDividerLine()));
      this.activityGroupLineCount = 0;
    }

    if (this.lastActivityGroup !== group) {
      this.logLine("");
      this.logLine(`${c("green", "●")} ${c("bold", group)}`);
      this.lastActivityGroup = group;
      this.activityGroupLineCount = 0;
    }

    const prefix = this.activityGroupLineCount === 0 ? "  └ " : "    ";
    this.logLine(`${prefix}${title}`);
    this.activityGroupLineCount += 1;

    // A file edit renders as a git-style diff instead of the bare "diff <path>"
    // text summary, so you can see exactly which lines changed.
    if (event.diffs?.length && this.activityMode !== "hidden") {
      for (const diff of event.diffs) this.renderDiff(diff);
      return;
    }

    for (const line of summary) {
      this.logLine(c("dim", `      ${line}`));
    }
  }

  // One file's unified diff: a "path (+A -B)" header, then colored rows —
  // green additions, red deletions, dim context, "⋮" between hunks.
  renderDiff(diff) {
    const added = c("green", `+${diff.added}`);
    const removed = c("red", `-${diff.removed}`);
    this.logLine(`      ${c("bold", diff.path)} ${c("dim", "(")}${added} ${removed}${c("dim", ")")}`);

    diff.hunks.forEach((hunk, index) => {
      if (index > 0) this.logLine(c("dim", "      ⋮"));
      for (const row of hunk.rows) {
        if (row.sign === "+") this.logLine(c("green", `      + ${row.text}`));
        else if (row.sign === "-") this.logLine(c("red", `      - ${row.text}`));
        else this.logLine(c("dim", `        ${row.text}`));
      }
    });

    if (diff.truncated) this.logLine(c("dim", "      … diff truncated"));
  }

  // /changes: a picker of the files edited in this chat (path + counts, the
  // "collapsed" view); Enter expands the chosen file's full diff into the
  // transcript. "All files" dumps every diff.
  async showChangesPicker() {
    if (!this.currentChat?.id) {
      this.notify("open a chat first");
      return;
    }

    let files = [];
    try {
      ({ files } = await this.hub.call("list_changes", { chatId: this.currentChat.id }));
    } catch (error) {
      this.notify(`changes unavailable: ${error.message}`);
      return;
    }
    if (!files.length) {
      this.notify("no file changes in this chat yet");
      return;
    }

    const expand = (chosen) => {
      this.closeActivityBlock();
      for (const diff of chosen) {
        this.logLine("");
        this.renderDiff(diff);
      }
    };

    // Text-menu fallback (no pinned picker): dump every diff.
    if (!this.pickerSupported() || !this.canPaintPinned()) {
      expand(files);
      return;
    }

    const items = files.map((diff) => ({
      label: `${diff.path}  ${c("green", `+${diff.added}`)} ${c("red", `-${diff.removed}`)}`,
      searchText: diff.path,
      value: diff.path,
    }));
    items.unshift({
      label: c("bold", `All files (${files.length})`),
      searchText: "all files",
      value: "*",
    });

    const picked = await this.interactivePick({
      title: `Changes · ${cleanInline(this.currentChat.title || this.currentChat.provider || "")}`,
      hint: "j/k move · Enter/l show diff · / filter · Esc",
      items,
    });
    if (picked === null) return;

    expand(picked === "*" ? files : files.filter((diff) => diff.path === picked));
  }

  closeActivityBlock() {
    if (!this.lastActivityGroup) return;
    this.logLine("");
    this.logLine(c("dim", activityDividerLine()));
    this.lastActivityGroup = "";
    this.activityGroupLineCount = 0;
    this.pendingResponseBreak = true;
    this.lastStreamEventKey = "";
  }

  renderPlan(entries, options = {}) {
    if (!entries.length) return;

    const signature = entries.map((entry) => `${entry.status}\x00${cleanInline(entry.content)}`).join("\x01");
    // ACP re-sends the whole plan on every status change; skip identical repeats
    // so the transcript shows progression instead of duplicate blocks.
    if (!options.replay && signature === this.lastPlanSignature) return;
    this.lastPlanSignature = signature;

    const done = entries.filter((entry) => entry.status === "completed").length;
    this.closeActivityBlock();
    this.logLine(`\n${c("bold", "Plan")} ${c("dim", `(${done}/${entries.length})`)}`);
    for (const entry of entries) {
      this.logLine(`  ${planMarker(entry.status)} ${renderInlineMarkdown(cleanInline(entry.content))}`);
    }
  }

  showPlan() {
    const plan = this.currentChat?.plan;
    if (!plan?.entries?.length) {
      this.notify("no active plan for this chat");
      return;
    }
    this.lastPlanSignature = "";
    this.renderPlan(plan.entries, { replay: true });
  }

  showAuthPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("ACP Authentication", buildAuthPanelItems(this.currentChat, context, this.cwd));
  }

  printAuthMethods() {
    const methods = this.currentChat?.authMethods || [];
    if (!methods.length) {
      this.notify("no auth methods reported by this adapter");
      return;
    }
    this.logLine(c("bold", "\nAuthentication methods"));
    methods.forEach((method, index) => {
      const id = method.id || method.methodId || `method-${index + 1}`;
      const name = method.name || id;
      const type = method.type ? c("dim", ` (${method.type})`) : "";
      this.logLine(`${index + 1}. ${name} ${c("dim", `[${id}]`)}${type}`);
      if (method.description) this.logLine(c("dim", `   ${method.description}`));
    });
    this.logLine(c("dim", "Use /auth <id> or /auth <n>"));
  }

  async authenticateCurrentChat(arg) {
    const chatId = this.currentChat?.id;
    if (!chatId) return;
    const methods = this.currentChat?.authMethods || [];
    if (!methods.length) {
      this.notify("no auth methods reported by this adapter");
      return;
    }

    let methodId = arg;
    const byNumber = Number(arg);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= methods.length) {
      methodId = methods[byNumber - 1].id || methods[byNumber - 1].methodId;
    } else if (!methodId && methods.length === 1) {
      methodId = methods[0].id || methods[0].methodId;
    } else if (!methodId) {
      this.printAuthMethods();
      return;
    }

    try {
      await this.hub.call("authenticate", { chatId, methodId });
      this.notify("authenticated");
    } catch (error) {
      this.logLine(c("red", `Auth failed: ${error.message}`));
    }
  }

  showMcpPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("MCP Servers", buildMcpPanelItems(this.currentChat, context));
  }

  printMcpServers() {
    const servers = this.currentChat?.mcpServers || [];
    if (!servers.length) {
      this.notify("no MCP servers configured for this chat");
      return;
    }
    this.logLine(c("bold", "\nMCP servers"));
    servers.forEach((server, index) => {
      const target = server.url || server.command || "";
      this.logLine(`${index + 1}. ${mcpServerLabel(server)} ${c("dim", target)}`);
    });
  }

  setActivityMode(line) {
    const requested = line.split(/\s+/)[1] || "";
    const next = requested || (this.activityMode === "compact" ? "hidden" : "compact");
    const allowed = new Set(["compact", "hidden", "debug"]);

    if (!allowed.has(next)) {
      this.notify("activity modes: compact, hidden, debug");
      return;
    }

    this.activityMode = next;
    this.notify(`tool activity ${next}`);
  }

  // Permission is the one block that stops the agent, so it gets the
  // strongest flat treatment: a yellow rail card.
  renderPermission(event) {
    const tool = event.toolCall || {};
    const rail = c("yellow", "▎");
    const title = tool.title || tool.toolCallId || "Agent request";
    this.logLine("");
    this.logLine(`${rail} ${c("yellow", `⏸ Permission · ${cleanInline(title)}`)}${
      tool.kind ? `  ${c("dim", tool.kind)}` : ""
    }`);

    const options = event.options || [];
    const choices = options
      .map((option, index) => `${c("bold", String(index + 1))} ${option.name}`)
      .join("   ");
    if (choices) this.logLine(`${rail} ${choices}`);
    const span = options.length > 1 ? `1-${options.length}` : "1";
    this.logLine(`${rail} ${c("dim", `Type ${span} + Enter · Enter opens menu · /deny`)}`);
  }

  async answerPermission(line, intent) {
    if (!this.pendingPermission) {
      this.logLine(c("yellow", "No pending permission request"));
      return;
    }

    const options = this.pendingPermission.options || [];
    let option = null;

    if (intent === "allow") {
      const requested = Number(line.split(/\s+/)[1]);
      if (Number.isInteger(requested) && requested >= 1 && requested <= options.length) {
        option = options[requested - 1];
      } else {
        option =
          options.find((candidate) => String(candidate.kind || "").startsWith("allow")) ||
          options[0];
      }
    } else {
      option =
        options.find((candidate) => String(candidate.kind || "").startsWith("reject")) || null;
    }

    await this.hub.call("permission_response", {
      permissionId: this.pendingPermission.permissionId,
      optionId: option?.optionId || null,
    });
    this.pendingPermission = null;
  }
}


export {
  FramePainter,
  PopupUi,
};
