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
  layoutAnsiText,
  layoutEditableLine,
  wrapAnsiLine,
  wrapAnsiWords,
  textOffsetAtDisplayColumn,
  padAnsiToWidth,
} from "./render.mjs";
import {
  providerIconFor,
  formatChatPreview,
  formatRelativeAge,
  hubAccentSeq,
  codeBlockLine,
  codeFenceHeader,
  highlightCode,
  codeLanguageForPath,
  applyAcpStatusFormat,
  HUB_CLI_PATH,
  RESTART_LOCK_PATH,
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
  canMergeHistoryChunk,
  retainHistoryByTurns,
  projectTranscriptTurns,
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
  fitAnsiLine,
  truncateAnsiText,
  horizontalRuleLine,
  cleanActivitySummary,
  projectActivityDetails,
  displayPath,
  normalizeAdditionalDirectories,
  normalizeToken,
  splitCommandWords,
  configOptionId,
  resolveConfigOption,
  chatModel,
  compactProviderLabel,
  providerColorName,
  chatEffort,
  chatAccessLabel,
  chatConfigLabel,
  footerParts,
  attachmentChip,
  attachmentToken,
  attachmentTokenRanges,
  attachmentCursorTarget,
  snapAttachmentCursor,
  attachmentDeletionRange,
  expandRangeToAttachmentTokens,
  promptDisplayTextFromAttachments,
  wrapAttachmentChips,
  configOptionValues,
  configOptionMenuValues,
  isBooleanConfigOption,
  configOptionValueMatches,
  chatModeEntries,
  chatModeValue,
  resolveAccessTarget,
  valueLabel,
  formatConfigOption,
  formatProviderCommand,
  normalizeProviderCommands,
  mergeCommandDescriptors,
  resolveProviderCommand,
  planMarker,
  planPresentation,
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
  orderChatsByActivity,
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
  npxAdapterPin,
  loadHistorySettings,
  INPUT_HISTORY_LIMIT,
  TRANSCRIPT_SCREEN_LINE_LIMIT,
  MAX_COMPOSER_INPUT_ROWS,
  MIN_COMPOSER_INPUT_ROWS,
  COMPOSER_CARD_RAIL_WIDTH,
  COMPOSER_CARD_GAP,
  COMPOSER_CARD_RIGHT_PADDING,
  COMPOSER_INPUT_VERTICAL_PADDING,
  COMPOSER_ANIMATION_INTERVAL_MS,
  LIVE_TABLE_PAINT_MS,
  COMPOSER_PLACEHOLDER,
  FILE_MENTION_LIMIT,
  FILE_MENTION_CACHE_MS,
  KILL_RING_LIMIT,
  COMPOSER_SPINNER_FRAMES,
  colors,
} from "./core.mjs";
import {
  THEME_VARIANTS,
  resolveHubThemePalette,
} from "./theme.mjs";

const VIM_UNDO_LIMIT = 100;
const DEFAULT_SCROLL_PAGE_PERCENT = 40;
const DEFAULT_MOUSE_SCROLL_ROWS = 4;
const DEFAULT_PLAN_PIN_MODE = "auto";
const DEFAULT_PLAN_COMPLETED_BEHAVIOR = "collapse";
const DEFAULT_PLAN_AWAITING_POLICY = "auto";
const DEFAULT_PLAN_SHORTCUT = "C-p";
const DEFAULT_TURN_DETAILS_MODE = "auto";
const DEFAULT_TURN_DETAILS_SHORTCUT = "F3";
const DEFAULT_MOUSE_SELECTION_SHORTCUT = "F4";
const DEFAULT_TRANSCRIPT_PADDING = 3;
const DEFAULT_PROMPT_PADDING = 2;
const DEFAULT_ACTIVITY_ICON = "●";
const DEFAULT_MENU_ORDER = "recent";
const DEFAULT_MENU_SCOPE = "project";
const DEFAULT_MENU_LIST_PERCENT = 58;
const DEFAULT_STATUS_ANIMATION = "wave";
const DEFAULT_STATUS_ANIMATION_INTERVAL_MS = 120;
const DEFAULT_STATUS_ANIMATION_PAUSE_MS = 900;
const DEFAULT_THEME_VARIANT = "vanzi";
const STATUS_ANIMATION_MODES = ["wave", "breathe", "spinner", "off"];
const ANIMATED_COMPOSER_STATUSES = new Set([
  "starting",
  "responding",
  "thinking",
  "planning",
  "working",
  "cancelling",
]);
// Portable 256-colour gold ramp. It keeps the existing semantic yellow while
// adding luminance only; the terminal text and its display width never change.
const STATUS_GLOW_SEQUENCES = [179, 221, 228, 230]
  .map((code) => `\x1b[38;5;${code}m`);
const STATUS_BREATHE_LEVELS = [0, 1, 2, 3, 3, 2, 1, 0];
const MENU_ORDER_MODES = ["recent", "oldest", "projects"];
const TRANSCRIPT_FRAME_INTERVAL_MS = 50;
const MIN_PLAN_TRANSCRIPT_ROWS = 5;
const MIN_EXPANDED_PLAN_TRANSCRIPT_ROWS = 1;
const TURN_CANCEL_CONFIRM_MS = 1500;
const SGR_MOUSE_PREFIX = "\x1b[<";
const SGR_MOUSE_TIMEOUT_MS = 100;

function statusAnimationText(value, frame = 0, mode = DEFAULT_STATUS_ANIMATION, options = {}) {
  const text = String(value || "");
  if (!text || !process.stdout.isTTY || !["wave", "breathe"].includes(mode)) {
    return c("yellow", text);
  }

  const safeFrame = Math.max(0, Number.parseInt(frame, 10) || 0);
  if (mode === "breathe") {
    const level = STATUS_BREATHE_LEVELS[safeFrame % STATUS_BREATHE_LEVELS.length];
    return `${STATUS_GLOW_SEQUENCES[level]}${text}${colors.reset || ""}`;
  }

  const graphemes = [...text];
  // Let the bright head cross the word quickly, then hold a quiet tail before
  // restarting. The loader is rendered independently and keeps moving during
  // this pause, so the agent never looks stalled.
  const traversalFrames = graphemes.length + 3;
  const pauseFrames = Math.max(0, Number.parseInt(options.pauseFrames, 10) || 0);
  const cycle = Math.max(1, traversalFrames + pauseFrames);
  const phase = safeFrame % cycle;
  const head = phase < traversalFrames ? phase : graphemes.length + 3;
  const rendered = graphemes.map((grapheme, index) => {
    const distance = Math.abs(index - head);
    const level = distance === 0 ? 3 : distance === 1 ? 2 : distance === 2 ? 1 : 0;
    return `${STATUS_GLOW_SEQUENCES[level]}${grapheme}`;
  }).join("");
  return `${rendered}${colors.reset || ""}`;
}

function tmuxGlobalOption(name) {
  if (!process.env.TMUX) return "";
  try {
    const result = spawnSync("tmux", ["show-option", "-gqv", name], {
      encoding: "utf8",
      timeout: 250,
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

function configuredUiValue(envName, tmuxOption) {
  if (Object.hasOwn(process.env, envName)) return String(process.env[envName] || "").trim();
  return tmuxGlobalOption(tmuxOption);
}

function configuredUiInteger(envName, tmuxOption, fallback, min, max) {
  const parsed = Number.parseInt(configuredUiValue(envName, tmuxOption), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function configuredUiBoolean(envName, tmuxOption, fallback) {
  const value = configuredUiValue(envName, tmuxOption).toLowerCase();
  if (!value) return fallback;
  if (["1", "on", "true", "yes"].includes(value)) return true;
  if (["0", "off", "false", "no"].includes(value)) return false;
  return fallback;
}

function configuredUiChoice(envName, tmuxOption, fallback, choices) {
  const value = configuredUiValue(envName, tmuxOption).toLowerCase();
  return choices.includes(value) ? value : fallback;
}

function normalizeActivityIcon(value, fallback = DEFAULT_ACTIVITY_ICON) {
  const icon = stripAnsi(String(value || ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  const width = stringDisplayWidth(icon);
  return width >= 1 && width <= 2 ? icon : fallback;
}

function attachmentForeground(value, provider = "", accentForeground = "") {
  const text = String(value || "");
  const accent = accentForeground || resolveHubThemePalette({
    provider,
    vanziAccentSeq: hubAccentSeq(),
  }).accentForeground;
  return accent ? `${accent}${text}\x1b[39m` : text;
}

function renderVanziSurface(label, { background = "", foreground = "" } = {}) {
  const text = cleanInline(label);
  if (!text) return "";
  if (!process.stdout.isTTY) return ` ${text} `;

  return `${background}${foreground}${colors.bold || ""} ${text} ${colors.reset || ""}`;
}

// Exclusive navigation tabs: selected belongs to exactly one current view.
function renderVanziTab(label, { selected = false, palette = null } = {}) {
  const text = cleanInline(label);
  if (!text) return "";
  if (!process.stdout.isTTY) return ` ${text} `;

  const theme = palette || resolveHubThemePalette({ vanziAccentSeq: hubAccentSeq() });
  const background = selected ? theme.accentBackground : theme.surfaceBackground;
  const foreground = selected
    ? "\x1b[38;2;14;14;14m"
    : theme.text;
  return renderVanziSurface(text, { background, foreground });
}

// Simultaneous metadata values are cards, not tabs: every surface remains
// present, the first visible card owns the visual accent, and hover decorates
// only its target without transferring selection state.
function renderComposerMetadataCard(
  label,
  { primary = false, hovered = false, tone = "", control = "", palette = null } = {},
) {
  const theme = palette || resolveHubThemePalette({ vanziAccentSeq: hubAccentSeq() });
  const effort = control === "effort";
  const background = primary
    ? effort
      ? theme.surfaceSelectedBackground
      : theme.accentBackground
    : hovered
      ? theme.surfaceHoverBackground
      : theme.surfaceBackground;
  const foreground = primary
    ? effort
      ? theme.textStrong
      : "\x1b[38;2;14;14;14m"
    : tone === "warning"
      ? colors.yellow
      : theme.text;
  return renderVanziSurface(label, { background, foreground, hovered });
}

// Expanded footer groups are simultaneous values of one ACP config option.
// Model choices own the current theme accent. Effort remains neutral until a
// candidate is previewed, when that same accent moves to exactly one choice.
function renderComposerFooterChoice(
  label,
  {
    control = "model",
    current = false,
    hovered = false,
    pending = false,
    disabled = false,
    accentOnHover = true,
    palette = null,
  } = {},
) {
  const text = `${cleanInline(label)}${pending ? "…" : ""}`;
  if (!text) return "";
  if (!process.stdout.isTTY) return ` ${text} `;

  const model = control === "model";
  const effectiveHover = hovered && !disabled;
  const preview = effectiveHover && accentOnHover;
  const theme = palette || resolveHubThemePalette({ vanziAccentSeq: hubAccentSeq() });
  let background;
  if (preview || (model && current)) background = theme.accentBackground;
  else if (!model && current) background = theme.surfaceSelectedBackground;
  else if (effectiveHover) background = theme.surfaceHoverBackground;
  else background = theme.surfaceBackground;

  let foreground;
  if (disabled) foreground = theme.textDisabled;
  else if (preview || (model && current)) foreground = "\x1b[38;2;14;14;14m";
  else if (!model && current) foreground = theme.textStrong;
  else if (model) foreground = theme.accentForeground;
  else foreground = theme.text;
  return renderVanziSurface(text, {
    background,
    foreground,
  });
}

function titleCaseFooterWords(value) {
  return cleanInline(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (["gpt", "sol", "api", "acp", "mcp"].includes(lower)) return lower.toUpperCase();
      if (index === 0) return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
      return lower;
    })
    .join(" ");
}

// Presentation-only humanization. Raw ids remain untouched for ACP requests,
// persistence and config matching.
function composerControlLabel(value, kind = "") {
  const text = cleanInline(value);
  if (!text) return "";

  if (kind === "model") {
    if (/\s/.test(text)) return text;
    const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(text);
    if (gpt) {
      const suffix = gpt[2] ? ` ${titleCaseFooterWords(gpt[2])}` : "";
      return `GPT-${gpt[1]}${suffix}`;
    }
    if (/^[a-z]+$/.test(text)) return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    return /[_-]/.test(text) ? titleCaseFooterWords(text) : text;
  }

  if (kind === "effort") {
    const effort = normalizeToken(text);
    const known = {
      xhigh: "XHigh",
      "extra-high": "Extra high",
      high: "High",
      medium: "Medium",
      low: "Low",
      minimal: "Minimal",
      none: "None",
    };
    return known[effort] || titleCaseFooterWords(text);
  }

  if (kind === "access") {
    return titleCaseFooterWords(text.replace(/^agent(?:[-_\s]+)/i, ""));
  }

  return titleCaseFooterWords(text);
}

function styleAttachmentTokens(value, provider = "", accentForeground = "") {
  const text = String(value || "");
  const ranges = attachmentTokenRanges(text);
  if (!ranges.length) return text;
  let output = "";
  let offset = 0;
  for (const range of ranges) {
    output += text.slice(offset, range.start);
    output += attachmentForeground(
      text.slice(range.start, range.end),
      provider,
      accentForeground,
    );
    offset = range.end;
  }
  return `${output}${text.slice(offset)}`;
}

function isSubmittedAttachmentLine(value) {
  return /^\[(?:IMAGE|FILE|PASTED)\d+\](?:\s|$)/.test(String(value || ""));
}

function normalizePlanShortcut(value, fallback = DEFAULT_PLAN_SHORTCUT) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (/^(off|none|disabled)$/i.test(text)) return "off";
  const ctrl = text.match(/^(?:c|ctrl)[+-]([a-z])$/i);
  if (ctrl) return `C-${ctrl[1].toLowerCase()}`;
  const fn = text.match(/^f([1-9]|1[0-2])$/i);
  if (fn) return `F${fn[1]}`;
  return fallback;
}

function keyMatchesPlanShortcut(key = {}, shortcut = DEFAULT_PLAN_SHORTCUT) {
  if (!shortcut || shortcut === "off") return false;
  const ctrl = shortcut.match(/^C-([a-z])$/);
  if (ctrl) return key.ctrl === true && key.name === ctrl[1];
  return key.name?.toLowerCase() === shortcut.toLowerCase();
}

function formatTurnDuration(durationMs) {
  const milliseconds = Math.max(0, Number(durationMs) || 0);
  if (milliseconds < 1000) return "<1s";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function isUserTranscriptEntry(value) {
  return Boolean(value && typeof value === "object" && value.kind === "user");
}

function isSemanticTranscriptEntry(value) {
  return Boolean(value && typeof value === "object" && typeof value.kind === "string");
}

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
    // Explicit geometry owner for the short interval between submitting one
    // composer and mounting the next.  A null rawInput means "no interactive
    // input", not "pretend there is an empty composer".
    this.pendingPinnedInput = null;
    this.pendingPinnedLayout = null;
    this.lastRawInputLayout = null;
    this.lastRawScrollBottom = null;
    this.inputHistory = loadInputHistory();
    this.uiSettings = loadUiSettings();
    this.vimEnabled = process.env.ACP_HUB_VIM === "1" || this.uiSettings.vim === true;
    this.pendingAttachments = [];
    this.attachmentSeq = 0;
    this.fileMentionCache = new Map();
    this.killRing = [];
    this.composerAnimationFrame = 0;
    this.composerAnimationTimer = null;
    this.composerAnimationKey = "";
    this.chunkBuffer = "";
    this.chunkBufferMarkdown = false;
    this.chunkBufferDim = false;
    this.markdownFence = false;
    this.markdownFenceLang = "";
    this.liveCodeBlock = null;
    this.liveCodeBlockPaintTimer = null;
    this.liveCodeBlockPaintPending = false;
    this.lastTmuxMetadataAt = 0;
    this.showInternalEvents = options.debug === true || process.env.ACP_HUB_DEBUG_UI === "1";
    this.activityMode = process.env.ACP_HUB_ACTIVITY || "compact";
    this.themeVariant = configuredUiChoice(
      "ACP_HUB_THEME",
      "@acp_hub_theme",
      DEFAULT_THEME_VARIANT,
      THEME_VARIANTS,
    );
    this.activityIcons = {
      ran: normalizeActivityIcon(
        configuredUiValue("ACP_HUB_ACTIVITY_ICON_RAN", "@acp_hub_activity_icon_ran"),
      ),
      explored: normalizeActivityIcon(
        configuredUiValue(
          "ACP_HUB_ACTIVITY_ICON_EXPLORED",
          "@acp_hub_activity_icon_explored",
        ),
      ),
      edited: normalizeActivityIcon(
        configuredUiValue("ACP_HUB_ACTIVITY_ICON_EDITED", "@acp_hub_activity_icon_edited"),
      ),
      tools: normalizeActivityIcon(
        configuredUiValue("ACP_HUB_ACTIVITY_ICON_TOOLS", "@acp_hub_activity_icon_tools"),
      ),
    };
    this.pendingResponseBreak = false;
    this.lastStreamEventKey = "";
    this.lastPlanSignature = "";
    this.transcriptEntries = [""];
    this.historyEvents = [];
    // Optimistic submissions live beside the canonical daemon history until
    // their matching user event arrives. Keeping them semantic (instead of
    // painting a one-off terminal row) means every full repaint sees them.
    this.pendingPromptSubmissions = new Map();
    this.promptSubmissionSequence = 0;
    this.transcriptRevision = 0;
    this.projectedTranscriptRevision = 0;
    this.lastTranscriptFrame = null;
    this.turnCardProjectionCache = new Map();
    this.turnDetailOverrides = new Map();
    this.activityGroupOverrides = new Map();
    // Transcript and composer repaint independently. Keep their mouse regions
    // independent too, otherwise an Activity refresh can silently make footer
    // controls inert until the next full composer render.
    this.interactiveRegions = [];
    this.composerInteractiveRegions = [];
    this.hoveredInteractiveKey = "";
    this.composerFooterExpansion = null;
    this.composerFooterSelectionPending = null;
    this.transcriptProjectionTimer = null;
    this.suppressTranscriptPaint = false;
    // Projection/capture builds semantic transcript entries off-screen.  The
    // depth makes the no-paint contract safe for nested captures (a full
    // projection captures detail and final sections independently), while the
    // phase is useful for diagnostics and keeps "building" distinct from the
    // one canonical terminal commit that follows it.
    this.transcriptProjectionDepth = 0;
    this.transcriptRenderPhase = "live";
    this.scrollOffsetRows = 0;
    this.scrollNewRows = 0;
    this.applyHistoryRetentionLimit(loadHistorySettings().eventLimit);
    this.transcriptPadding = configuredUiInteger(
      "ACP_HUB_TRANSCRIPT_PADDING",
      "@acp_hub_transcript_padding",
      DEFAULT_TRANSCRIPT_PADDING,
      0,
      4,
    );
    this.promptPadding = configuredUiInteger(
      "ACP_HUB_PROMPT_PADDING",
      "@acp_hub_prompt_padding",
      DEFAULT_PROMPT_PADDING,
      0,
      4,
    );
    this.scrollPagePercent = configuredUiInteger(
      "ACP_HUB_SCROLL_PAGE_PERCENT",
      "@acp_hub_scroll_page_percent",
      DEFAULT_SCROLL_PAGE_PERCENT,
      10,
      100,
    );
    this.mouseScrollEnabled = configuredUiBoolean(
      "ACP_HUB_MOUSE",
      "@acp_hub_mouse",
      true,
    );
    this.mouseScrollRows = configuredUiInteger(
      "ACP_HUB_MOUSE_SCROLL_ROWS",
      "@acp_hub_mouse_scroll_rows",
      DEFAULT_MOUSE_SCROLL_ROWS,
      1,
      20,
    );
    this.mouseClickEnabled = configuredUiBoolean(
      "ACP_HUB_MOUSE_CLICK",
      "@acp_hub_mouse_click",
      true,
    );
    this.mouseHoverEnabled = configuredUiBoolean(
      "ACP_HUB_MOUSE_HOVER",
      "@acp_hub_mouse_hover",
      true,
    );
    this.mouseSelectionShortcut = normalizePlanShortcut(
      configuredUiValue("ACP_HUB_MOUSE_SELECT_KEY", "@acp_hub_mouse_select_key") ||
        DEFAULT_MOUSE_SELECTION_SHORTCUT,
      DEFAULT_MOUSE_SELECTION_SHORTCUT,
    );
    this.turnDetailsMode = configuredUiChoice(
      "ACP_HUB_TURN_DETAILS",
      "@acp_hub_turn_details",
      ["auto", "expanded", "hidden"].includes(this.uiSettings.turnDetailsMode)
        ? this.uiSettings.turnDetailsMode
        : DEFAULT_TURN_DETAILS_MODE,
      ["auto", "expanded", "hidden"],
    );
    this.turnDetailsShortcut = normalizePlanShortcut(
      configuredUiValue("ACP_HUB_TURN_DETAILS_KEY", "@acp_hub_turn_details_key") ||
        DEFAULT_TURN_DETAILS_SHORTCUT,
      DEFAULT_TURN_DETAILS_SHORTCUT,
    );
    this.planPinMode = configuredUiChoice(
      "ACP_HUB_PLAN_PIN",
      "@acp_hub_plan_pin",
      ["auto", "on", "off"].includes(this.uiSettings.planPinMode)
        ? this.uiSettings.planPinMode
        : DEFAULT_PLAN_PIN_MODE,
      ["auto", "on", "off"],
    );
    this.planCompletedBehavior = configuredUiChoice(
      "ACP_HUB_PLAN_COMPLETED",
      "@acp_hub_plan_completed",
      DEFAULT_PLAN_COMPLETED_BEHAVIOR,
      ["hide", "collapse", "keep"],
    );
    this.planAwaitingPolicy = configuredUiChoice(
      "ACP_HUB_PLAN_AWAITING",
      "@acp_hub_plan_awaiting",
      DEFAULT_PLAN_AWAITING_POLICY,
      ["auto", "on", "off"],
    );
    this.planShortcut = normalizePlanShortcut(
      configuredUiValue("ACP_HUB_PLAN_KEY", "@acp_hub_plan_key") || DEFAULT_PLAN_SHORTCUT,
    );
    this.planExpanded = false;
    this.mdHeldLine = null;
    this.liveTable = null;
    this.liveTablePaintTimer = null;
    this.liveTablePaintPending = false;
    this.activePicker = null;
    // Full-viewport overlays (the Ctrl+O chat menu) temporarily own every
    // physical row while the draft-backed composer remains alive but
    // suspended. This is a scene boundary, not a second input session.
    this.fullscreenOverlay = null;
    this.restoreFullscreenOnNextComposer = false;
    this.inlinePicker = null;
    this.autoShownRestoreFailureKey = null;
    this.hubOperation = null;
    this.menuTextActive = false;
    this.menuDefaultOrder = configuredUiChoice(
      "ACP_HUB_MENU_ORDER",
      "@acp_hub_menu_order",
      DEFAULT_MENU_ORDER,
      MENU_ORDER_MODES,
    );
    this.menuDefaultScope = configuredUiChoice(
      "ACP_HUB_MENU_SCOPE",
      "@acp_hub_menu_scope",
      DEFAULT_MENU_SCOPE,
      ["project", "all"],
    );
    this.menuListPercent = configuredUiInteger(
      "ACP_HUB_MENU_LIST_PERCENT",
      "@acp_hub_menu_list_percent",
      DEFAULT_MENU_LIST_PERCENT,
      45,
      75,
    );
    this.statusAnimation = configuredUiChoice(
      "ACP_HUB_STATUS_ANIMATION",
      "@acp_hub_status_animation",
      DEFAULT_STATUS_ANIMATION,
      STATUS_ANIMATION_MODES,
    );
    this.statusAnimationIntervalMs = configuredUiInteger(
      "ACP_HUB_STATUS_ANIMATION_INTERVAL",
      "@acp_hub_status_animation_interval",
      DEFAULT_STATUS_ANIMATION_INTERVAL_MS,
      80,
      600,
    );
    this.statusAnimationPauseMs = configuredUiInteger(
      "ACP_HUB_STATUS_ANIMATION_PAUSE",
      "@acp_hub_status_animation_pause",
      DEFAULT_STATUS_ANIMATION_PAUSE_MS,
      0,
      3000,
    );
    this.menuFilters = {
      provider: "all",
      scope: this.menuDefaultScope,
      order: this.menuDefaultOrder,
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
    this.stopComposerAnimation();
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
            // A missing chat is never replaced implicitly: doing so changes
            // the window identity and can duplicate an already-open session.
            // Keep the popup alive in Chats so the next action is explicit.
            this.logProse(c("red", error.message || String(error)), {
              firstPrefix: c("red", "✗ "),
              continuationPrefix: "  ",
            });
            this.options.chatId = "";
            action = "menu";
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
      if (this.transcriptProjectionTimer) clearTimeout(this.transcriptProjectionTimer);
      this.transcriptProjectionTimer = null;
      this.flushChunkBuffer({ force: true });
      this.resetStreamRenderState();
      this.disableRawInputLayout();
      this.stopComposerAnimation();
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
      this.logProse(c("red", error.message || String(error)));
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
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        controls.rebuildWith(async () =>
          this.buildMenuPickerItems(await this.buildMenu()),
        );
      }, 200);
      refreshTimer.unref?.();
    };

    try {
      return await this.interactivePick({
        title: () =>
          `ACP Hub · ${projectName(this.cwd)} · ${this.menuScopeLabel()}`,
        tabs: (width) => this.menuOrderTabs(width),
        hint: "Tab order · s scope · Ctrl+O close · j/k move · Enter/l open · / filter · ^S reply · ^E rename · ^D delete · Esc",
        emptyText: "No chats match — Esc clears the filter",
        deferBackdrop: options.deferBackdrop === true,
        fullViewport: true,
        fullHeight: true,
        closeWithCtrlO: true,
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
          this.cycleMenuOrder();
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onScope: async () => {
          this.toggleMenuScope();
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

  menuOrderMode() {
    const value = this.menuFilters?.order || this.menuDefaultOrder || DEFAULT_MENU_ORDER;
    return MENU_ORDER_MODES.includes(value) ? value : DEFAULT_MENU_ORDER;
  }

  menuOrderLabel() {
    return {
      recent: "Recent",
      oldest: "Oldest",
      projects: "Projects",
    }[this.menuOrderMode()];
  }

  menuScopeLabel() {
    return this.menuFilters?.scope === "all" ? "All projects" : "Current project";
  }

  themedProviderIcon(chat = this.currentChat || {}) {
    const accent = this.themeAccentSeq(chat?.provider);
    const icon = providerIconFor(chat?.provider, chat);
    return accent ? `${accent}${icon}${colors.reset || ""}` : icon;
  }

  themedProviderLabel(chat = this.currentChat || {}) {
    const accent = this.themeAccentSeq(chat?.provider);
    const label = compactProviderLabel(chat?.providerLabel || chat?.provider || "Agent");
    return accent ? `${accent}${label}${colors.reset || ""}` : label;
  }

  menuOrderTabs(width = Number.POSITIVE_INFINITY) {
    const compact = Number.isFinite(width) && width < 26;
    const labels = compact
      ? { recent: "Rec", oldest: "Old", projects: "Proj" }
      : { recent: "Recent", oldest: "Oldest", projects: "Projects" };
    const active = this.menuOrderMode();
    if (!process.stdout.isTTY) {
      return MENU_ORDER_MODES
        .map((mode) => (mode === active ? `[${labels[mode]}]` : labels[mode]))
        .join(" ");
    }

    // Same visual grammar as Vanzi's tmux windows and the composer's
    // interactive config controls. No Nerd Font glyph is required.
    return MENU_ORDER_MODES
      .map((mode) => renderVanziTab(labels[mode], {
        selected: mode === active,
        palette: this.themePalette(),
      }))
      .join(" ");
  }

  cycleMenuOrder() {
    const current = MENU_ORDER_MODES.indexOf(this.menuOrderMode());
    this.menuFilters.order = MENU_ORDER_MODES[(current + 1) % MENU_ORDER_MODES.length];
    return this.menuFilters.order;
  }

  toggleMenuScope() {
    this.menuFilters.scope = this.menuFilters.scope === "project" ? "all" : "project";
    return this.menuFilters.scope;
  }

  resetMenuFilters() {
    this.menuFilters = {
      provider: "all",
      scope: this.menuDefaultScope || DEFAULT_MENU_SCOPE,
      order: this.menuDefaultOrder || DEFAULT_MENU_ORDER,
      query: "",
      limit: 80,
    };
  }

  menuChatEntryLabel(chat, width = Number.POSITIVE_INFINITY, options = {}) {
    const title = cleanInline(chat?.title || chat?.id || "chat");
    const icon = `${this.themedProviderIcon(chat)} `;
    const status = chat?.active ? `  ${statusIndicator(chat.status)}` : "";
    const project = options.includeProject
      ? chat?.projectName || projectName(chat?.cwd || "")
      : "";
    const age = formatRelativeAge(chat?.updatedAt);
    const mode = chat?.mode || "";
    const config = chatConfigLabel(chat);
    const metaCandidates = [
      [project, age, mode, config],
      [project, age, mode],
      [project, age],
      [age],
      [],
    ];
    const available = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : Infinity;
    const minimumTitleWidth = 12;
    let suffix = status;

    for (const parts of metaCandidates) {
      const meta = parts.filter(Boolean).join(" · ");
      const candidate = `${status}${meta ? `  ${c("muted", meta)}` : ""}`;
      suffix = candidate;
      if (
        !Number.isFinite(available) ||
        available - visibleLength(icon) - visibleLength(candidate) >= minimumTitleWidth
      ) {
        break;
      }
    }

    const titleWidth = Number.isFinite(available)
      ? Math.max(1, available - visibleLength(icon) - visibleLength(suffix))
      : Infinity;
    const renderedTitle = Number.isFinite(titleWidth)
      ? truncateAnsiText(title, titleWidth)
      : title;
    const renderedTitleWithTone = options.selected
      ? c("bold", renderedTitle)
      : c("menuText", renderedTitle);
    const label = `${icon}${renderedTitleWithTone}${suffix}`;
    return Number.isFinite(available) ? fitAnsiLine(label, available) : label;
  }

  menuNewChatEntryLabel(agent, width = Number.POSITIVE_INFINITY, selected = false) {
    const isDefault = agent.id === this.config.defaultAgent;
    const icon = this.themedProviderIcon({ provider: agent.id, providerIcon: agent.icon });
    const text = `New ${agent.label || agent.id} chat${isDefault ? " · default" : ""}`;
    const body = selected ? c("bold", text) : c("menuText", text);
    const label = `${icon} ${body}`;
    return Number.isFinite(width) ? fitAnsiLine(label, Math.max(1, Math.floor(width))) : label;
  }

  buildMenuPickerItems(menu) {
    const items = [];
    const chats = this.orderChatsForDisplay(menu.visibleChats || []);
    const order = this.menuOrderMode();

    const chatEntry = (chat, options = {}) => {
      return {
        label: this.menuChatEntryLabel(chat, 160, options),
        renderLabel: (width, state = {}) =>
          this.menuChatEntryLabel(chat, width, { ...options, selected: state.selected === true }),
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

    if (order === "projects") {
      const groups = new Map();
      for (const chat of chats) {
        const key = chat.cwd || chat.projectName || "project";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(chat);
      }
      for (const groupChats of groups.values()) {
        const sample = groupChats[0] || {};
        const label = sample.cwd === this.cwd
          ? `${sample.projectName || projectName(this.cwd)} · current project`
          : sample.projectName || projectName(sample.cwd || "");
        items.push({ label: c("muted", label), disabled: true });
        for (const chat of groupChats) items.push(chatEntry(chat));
      }
    } else {
      items.push({
        label: c("muted", `${this.menuOrderLabel()} activity · ${this.menuScopeLabel()}`),
        disabled: true,
      });
      for (const chat of chats) {
        items.push(chatEntry(chat, { includeProject: this.menuFilters.scope === "all" }));
      }
    }

    if (!chats.length) {
      items.push({ label: c("dim", "No chats in this view"), disabled: true });
    }
    if (this.menuFilters.scope === "project") {
      items.push({ label: c("dim", "s shows chats from all projects"), disabled: true });
    }

    items.push({ label: c("muted", "New chat"), disabled: true });
    for (const agent of menu.agents || []) {
      items.push({
        label: this.menuNewChatEntryLabel(agent, 160, false),
        renderLabel: (width, state = {}) =>
          this.menuNewChatEntryLabel(agent, width, state.selected === true),
        searchText: `new ${agent.id} ${agent.label || ""}`,
        value: { type: "new", provider: agent.id },
      });
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
        this.resetMenuFilters();
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
      if (answer.startsWith("/o ") || answer.startsWith("/order ")) {
        const order = answer.split(/\s+/)[1] || this.menuDefaultOrder || DEFAULT_MENU_ORDER;
        if (!MENU_ORDER_MODES.includes(order)) {
          this.logLine(c("yellow", "Order must be recent, oldest, or projects"));
          continue;
        }
        this.menuFilters.order = order;
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
      // The daemon must choose the chronological page before applying limit.
      order: this.menuOrderMode() === "oldest" ? "oldest" : "recent",
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

  orderChatsForDisplay(chats, requestedOrder = null) {
    const order = requestedOrder || this.menuOrderMode();
    if (order === "recent" || order === "oldest") {
      return orderChatsByActivity(chats, order);
    }

    const recentRank = new Map(
      orderChatsByActivity(chats, "recent").map((chat, index) => [chat, index]),
    );
    return [...chats].sort((a, b) => {
      const currentProjectA = a.cwd === this.cwd ? 0 : 1;
      const currentProjectB = b.cwd === this.cwd ? 0 : 1;
      if (currentProjectA !== currentProjectB) return currentProjectA - currentProjectB;

      // Projects mode groups by project only. Provider remains a row-level
      // identity, never a hidden primary sort that splits Claude from Codex.
      const groupA = `${a.projectName}\0${a.cwd || ""}`;
      const groupB = `${b.projectName}\0${b.cwd || ""}`;
      if (groupA !== groupB) return groupA.localeCompare(groupB);
      const rank = chatAttentionRank(a) - chatAttentionRank(b);
      if (rank !== 0) return rank;
      return (recentRank.get(a) ?? 0) - (recentRank.get(b) ?? 0);
    });
  }

  renderMenu(menu) {
    this.clearScreen();
    this.printHeader();
    this.logLine(
      `${c("bold", "Filters")} provider=${this.menuFilters.provider} scope=${this.menuFilters.scope} query=${
        this.menuFilters.query ? JSON.stringify(this.menuFilters.query) : "-"
      } order=${this.menuOrderMode()}`,
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
    } else if (this.menuOrderMode() === "projects") {
      this.renderGroupedChats(menu.visibleChats);
    } else {
      this.renderChronologicalChats(menu.visibleChats);
    }

    this.logLine("");
    this.logLine(c("dim", "cN open | /q text | /p codex|claude|all | /s project|all | /o recent|oldest|projects | /new <agent> | /refresh | /help"));
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
          `  ${c("dim", `c${index}`)}  ${this.themedProviderIcon(chat)} ${c("bold", title)}${status}${
            meta ? `  ${c("dim", meta)}` : ""
          }`,
        );
        index += 1;
      }
    }
  }

  renderChronologicalChats(chats) {
    chats.forEach((chat, index) => {
      const status = chat.active ? `  ${statusIndicator(chat.status)}` : "";
      const title = truncateText(cleanInline(chat.title || chat.id), 60);
      const meta = [
        this.menuFilters.scope === "all" ? chat.projectName : "",
        formatRelativeAge(chat.updatedAt),
        chat.mode,
        chatConfigLabel(chat),
      ]
        .filter(Boolean)
        .join(" · ");
      this.logLine(
        `  ${c("dim", `c${index + 1}`)}  ${this.themedProviderIcon(chat)} ${c("bold", title)}${status}${
          meta ? `  ${c("dim", meta)}` : ""
        }`,
      );
    });
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
    this.logLine("/o order            recent, oldest, or projects");
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
    }, COMPOSER_ANIMATION_INTERVAL_MS);
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
    this.stopComposerAnimation();
    if (this.currentChat?.id) {
      await this.hub.call("unsubscribe", { chatId: this.currentChat.id }).catch(() => {});
    }

    const result = await this.withStartupIndicator(() =>
      this.hub.call("subscribe", { chatId }),
    );
    // The daemon is authoritative: this prevents a stale popup environment
    // from applying a second, smaller cutoff than the persisted registry.
    this.applyHistoryRetentionLimit(result.historyLimit);
    this.currentChat = result.chat;
    this.pendingPermission = null;
    this.autoShownPermissionId = null;
    this.autoShownRestoreFailureKey = null;
    this.hubOperation = result.adapterOperation || null;
    this.syncTmuxWindow(this.currentChat, { force: true });

    this.disableRawInputLayout();
    this.markdownFence = false;
    this.markdownFenceLang = "";
    this.lastPlanSignature = "";
    this.planExpanded = false;
    this.turnDetailOverrides = new Map();
    this.activityGroupOverrides = new Map();
    this.turnCardProjectionCache = new Map();
    this.pendingPromptSubmissions = new Map();
    this.promptSubmissionSequence = 0;
    this.transcriptRevision = 0;
    this.projectedTranscriptRevision = 0;
    this.lastTranscriptFrame = null;
    this.hoveredInteractiveKey = "";
    this.interactiveRegions = [];
    this.composerInteractiveRegions = [];
    this.composerFooterExpansion = null;
    this.composerFooterSelectionPending = null;
    this.resetStreamRenderState();
    this.clearScreen();
    this.resetTranscriptBuffer();

    this.renderHistory(result.history || []);
    this.flushChunkBuffer({ force: true });

    this.pendingPermission = result.pendingPermission || null;

    return this.chatLoop();
  }

  renderHistory(events) {
    const limit = Math.max(1, Number(this.historyEventLimit) || TRANSCRIPT_SCREEN_LINE_LIMIT);
    this.historyEvents = retainHistoryByTurns(events || [], limit)
      .map((event) => ({ ...event }));
    this.transcriptRevision = (Number(this.transcriptRevision) || 0) + 1;
    this.rebuildTranscriptProjection({ initial: true });
  }

  applyHistoryRetentionLimit(value) {
    const parsed = Number.parseInt(value, 10);
    const fallback = loadHistorySettings().eventLimit;
    this.historyEventLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    // A semantic event can project to more than one transcript entry. Keep a
    // proportional entry budget so the renderer cannot silently undercut the
    // configured event history while retaining the existing safe minimum.
    this.transcriptEntryLimit = Math.max(
      TRANSCRIPT_SCREEN_LINE_LIMIT,
      this.historyEventLimit * 4,
    );
    return this.historyEventLimit;
  }

  appendHistoryEvent(event) {
    if (!event || typeof event !== "object") return;
    const next = { ...event };
    const previous = this.historyEvents.at(-1);
    if (canMergeHistoryChunk(previous, next)) {
      previous.text = `${previous.text || ""}${next.text || ""}`;
      previous.at = next.at || previous.at;
      if (next.turnSequence) previous.turnSequence = next.turnSequence;
      this.transcriptRevision = (Number(this.transcriptRevision) || 0) + 1;
      return;
    }
    this.historyEvents.push(next);
    const limit = Math.max(1, Number(this.historyEventLimit) || TRANSCRIPT_SCREEN_LINE_LIMIT);
    this.historyEvents = retainHistoryByTurns(this.historyEvents, limit);
    this.transcriptRevision = (Number(this.transcriptRevision) || 0) + 1;
  }

  nextClientPromptId() {
    this.promptSubmissionSequence = (Number(this.promptSubmissionSequence) || 0) + 1;
    const suffix = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${this.promptSubmissionSequence}`;
    return `prompt-${suffix}`;
  }

  nextOptimisticTurnSequence() {
    if (!(this.pendingPromptSubmissions instanceof Map)) {
      this.pendingPromptSubmissions = new Map();
    }
    let highest = Math.max(0, Number.parseInt(this.currentChat?.turnSequence, 10) || 0);
    for (const event of this.historyEvents) {
      highest = Math.max(highest, Number.parseInt(event?.turnSequence, 10) || 0);
    }
    for (const submission of this.pendingPromptSubmissions.values()) {
      highest = Math.max(highest, Number.parseInt(submission?.turnSequence, 10) || 0);
    }
    return highest + 1;
  }

  stagePromptSubmission(text, options = {}) {
    const normalized = normalizePastedText(text).trim();
    if (!normalized) return null;

    if (!(this.pendingPromptSubmissions instanceof Map)) {
      this.pendingPromptSubmissions = new Map();
    }
    const clientPromptId = String(options.clientPromptId || this.nextClientPromptId());
    const existing = this.pendingPromptSubmissions.get(clientPromptId);
    if (existing) return existing;

    const expectQueued = Object.hasOwn(options, "expectQueued")
      ? options.expectQueued === true
      : Boolean(
          this.currentChat?.turnActive ||
          isActiveChatStatus(this.currentChat?.status),
        );
    const submission = {
      clientPromptId,
      chatId: this.currentChat?.id || "",
      text: normalized,
      state: "pending",
      turnSequence:
        Math.max(0, Number.parseInt(options.turnSequence, 10) || 0) ||
        this.nextOptimisticTurnSequence(),
      at: options.at || new Date().toISOString(),
      order: this.promptSubmissionSequence,
      // A prompt sent while a turn is active belongs to the composer-owned
      // queue shelf, not to the transcript. If the daemon resolves a race in
      // the other direction, acknowledgement below moves it atomically.
      queued: expectQueued,
    };
    this.pendingPromptSubmissions.set(clientPromptId, submission);
    this.transcriptRevision = (Number(this.transcriptRevision) || 0) + 1;
    this.scheduleTranscriptProjection({ immediate: true });
    return submission;
  }

  acknowledgePromptSubmission(clientPromptId, result = {}) {
    if (!(this.pendingPromptSubmissions instanceof Map)) return null;
    const submission = this.pendingPromptSubmissions.get(clientPromptId);
    if (!submission) return null;
    const acknowledgedId = String(result.clientPromptId || clientPromptId);
    if (acknowledgedId !== clientPromptId) {
      this.pendingPromptSubmissions.delete(clientPromptId);
      submission.clientPromptId = acknowledgedId;
      this.pendingPromptSubmissions.set(acknowledgedId, submission);
    }
    const wasQueued = submission.queued === true;
    submission.state = result.queued ? "queued" : "acknowledged";
    submission.queued = result.queued === true;
    const sequence = Number.parseInt(result.turnSequence, 10);
    if (Number.isFinite(sequence) && sequence > 0) submission.turnSequence = sequence;
    if (wasQueued !== submission.queued) {
      this.transcriptRevision = (Number(this.transcriptRevision) || 0) + 1;
      this.scheduleTranscriptProjection({ immediate: true, renderComposer: true });
    }
    return submission;
  }

  reconcilePromptSubmission(event) {
    if (event?.type !== "user" || !event.clientPromptId) return false;
    if (!(this.pendingPromptSubmissions instanceof Map)) return false;
    const removed = this.pendingPromptSubmissions.delete(String(event.clientPromptId));
    if (removed) this.transcriptRevision = (Number(this.transcriptRevision) || 0) + 1;
    return removed;
  }

  discardPromptSubmission(clientPromptId, options = {}) {
    if (!clientPromptId) return false;
    if (!(this.pendingPromptSubmissions instanceof Map)) return false;
    const removed = this.pendingPromptSubmissions.delete(String(clientPromptId));
    if (removed) {
      this.transcriptRevision = (Number(this.transcriptRevision) || 0) + 1;
      if (options.render !== false) this.scheduleTranscriptProjection({ immediate: true });
    }
    return removed;
  }

  transcriptProjectionEvents() {
    if (!(this.pendingPromptSubmissions instanceof Map) || !this.pendingPromptSubmissions.size) {
      return this.historyEvents;
    }

    const events = this.historyEvents.map((event) => ({ ...event }));
    const canonicalIds = new Set(
      events
        .filter((event) => event?.type === "user" && event.clientPromptId)
        .map((event) => String(event.clientPromptId)),
    );

    for (const submission of this.pendingPromptSubmissions.values()) {
      if (submission.chatId && submission.chatId !== this.currentChat?.id) continue;
      if (canonicalIds.has(submission.clientPromptId)) continue;
      if (submission.queued) continue;
      const optimistic = {
        type: "user",
        text: submission.text,
        clientPromptId: submission.clientPromptId,
        submissionState: submission.state,
        optimistic: true,
        turnSequence: submission.turnSequence,
        at: submission.at,
      };
      const scopedIndex = events.findIndex(
        (event) =>
          (Number.parseInt(event?.turnSequence, 10) || 0) === submission.turnSequence,
      );
      if (scopedIndex >= 0) events.splice(scopedIndex, 0, optimistic);
      else events.push(optimistic);
    }
    return events;
  }

  queuedRequestItems(chat = this.currentChat) {
    const items = [];
    const byId = new Map();
    for (const [index, request] of (chat?.queuedRequests || []).entries()) {
      const id = String(request?.id || `queued-${index + 1}`);
      const item = {
        id,
        kind: request?.kind || "prompt",
        preview: cleanInline(request?.preview || ""),
        position: Number(request?.position) || index + 1,
        queuedAt: request?.queuedAt || null,
      };
      items.push(item);
      byId.set(id, item);
    }

    if (this.pendingPromptSubmissions instanceof Map) {
      for (const submission of this.pendingPromptSubmissions.values()) {
        if (!submission?.queued) continue;
        if (submission.chatId && submission.chatId !== chat?.id) continue;
        const id = String(submission.clientPromptId || "");
        const existing = byId.get(id);
        if (existing) {
          // The local client still knows the complete multiline/attachment
          // display text; use its first logical content for a better preview.
          existing.preview = cleanInline(submission.text) || existing.preview;
          continue;
        }
        const item = {
          id,
          kind: "prompt",
          preview: cleanInline(submission.text),
          position: items.length + 1,
          queuedAt: submission.at || null,
        };
        items.push(item);
        byId.set(id, item);
      }
    }

    return items.sort((left, right) => left.position - right.position);
  }

  queueShelfCount(chat = this.currentChat) {
    return Math.max(
      0,
      Number(chat?.queued) || 0,
      this.queuedRequestItems(chat).length,
    );
  }

  queueShelfLine(width, chat = this.currentChat) {
    return this.queueShelfLines(width, 1, chat)[0] || "";
  }

  queueShelfLines(width, rowLimit = 8, chat = this.currentChat) {
    const count = this.queueShelfCount(chat);
    if (!count) return [];

    const items = this.queuedRequestItems(chat);
    const limit = Math.max(1, Math.min(count, Number.parseInt(rowLimit, 10) || 1));
    const heading = `Queue ${count}`;
    const continuation = " ".repeat(visibleLength(heading));
    const lines = [];
    for (let index = 0; index < limit; index += 1) {
      const item = items[index] || null;
      const preview = styleAttachmentTokens(
        item?.preview || "Waiting to run",
        chat?.provider,
        this.themeAccentSeq(chat?.provider),
      );
      let label = String(index + 1);
      if (index === 0) label = item?.kind === "command" ? "Command" : "Next";
      else if (item?.kind === "command") label = `Command ${index + 1}`;
      const prefix = index === 0 ? c("yellow", heading) : continuation;
      const hidden = index === limit - 1 ? Math.max(0, count - limit) : 0;
      const more = hidden ? c("dim", ` · +${hidden} more`) : "";
      lines.push(fitAnsiLine(
        `${prefix}${c("dim", ` · ${label}: `)}${preview}${more}`,
        Math.max(1, width),
      ));
    }
    return lines;
  }

  scheduleTranscriptProjection(options = {}) {
    if (options.immediate) {
      if (this.transcriptProjectionTimer) clearTimeout(this.transcriptProjectionTimer);
      this.transcriptProjectionTimer = null;
      this.rebuildTranscriptProjection(options);
      return;
    }
    if (this.transcriptProjectionTimer) return;
    this.transcriptProjectionTimer = setTimeout(() => {
      this.transcriptProjectionTimer = null;
      this.rebuildTranscriptProjection(options);
    }, TRANSCRIPT_FRAME_INTERVAL_MS);
    this.transcriptProjectionTimer.unref?.();
  }

  transcriptPaintSuppressed() {
    return Boolean(
      this.suppressTranscriptPaint ||
      (Number(this.transcriptProjectionDepth) || 0) > 0 ||
      (this.transcriptRenderPhase && this.transcriptRenderPhase !== "live"),
    );
  }

  withTranscriptRenderPhase(phase, callback) {
    const previousPhase = this.transcriptRenderPhase || "live";
    const previousSuppress = this.suppressTranscriptPaint === true;
    this.transcriptProjectionDepth = (Number(this.transcriptProjectionDepth) || 0) + 1;
    this.transcriptRenderPhase = phase || "projection";
    this.suppressTranscriptPaint = true;
    try {
      return callback();
    } finally {
      this.transcriptProjectionDepth = Math.max(
        0,
        (Number(this.transcriptProjectionDepth) || 1) - 1,
      );
      this.transcriptRenderPhase = previousPhase;
      this.suppressTranscriptPaint = previousSuppress;
    }
  }

  captureEventEntries(events, options = {}) {
    const saved = {
      transcriptEntries: this.transcriptEntries,
      chunkBuffer: this.chunkBuffer,
      chunkBufferMarkdown: this.chunkBufferMarkdown,
      chunkBufferDim: this.chunkBufferDim,
      markdownFence: this.markdownFence,
      markdownFenceLang: this.markdownFenceLang,
      liveCodeBlock: this.liveCodeBlock,
      liveCodeBlockPaintTimer: this.liveCodeBlockPaintTimer,
      liveCodeBlockPaintPending: this.liveCodeBlockPaintPending,
      pendingResponseBreak: this.pendingResponseBreak,
      lastStreamEventKey: this.lastStreamEventKey,
      lastPlanSignature: this.lastPlanSignature,
      mdHeldLine: this.mdHeldLine,
      liveTable: this.liveTable,
      liveTablePaintTimer: this.liveTablePaintTimer,
      liveTablePaintPending: this.liveTablePaintPending,
    };

    return this.withTranscriptRenderPhase("capture", () => {
      this.transcriptEntries = [""];
      this.chunkBuffer = "";
      this.chunkBufferMarkdown = false;
      this.chunkBufferDim = false;
      this.markdownFence = false;
      this.markdownFenceLang = "";
      this.liveCodeBlock = null;
      this.liveCodeBlockPaintTimer = null;
      this.liveCodeBlockPaintPending = false;
      this.pendingResponseBreak = false;
      this.lastStreamEventKey = "";
      this.lastPlanSignature = "";
      this.mdHeldLine = null;
      this.liveTable = null;
      this.liveTablePaintTimer = null;
      this.liveTablePaintPending = false;

      try {
        const projected =
          !this.showInternalEvents && this.activityMode === "compact"
            ? projectActivityDetails(events || [])
            : (events || []).map((event) => ({ kind: "event", event }));
        for (const item of projected) {
          if (item.kind === "activity-group") {
            // The semantic group bypasses renderToolEvent, whose normal path flushes
            // prose first. Preserve that same chronological boundary here so a
            // short commentary chunk cannot be deferred until after later tools.
            this.flushChunkBuffer({ force: true });
            this.markdownFence = false;
            this.emitTranscriptEntry({ kind: "activity-group", group: item.group });
          } else {
            this.renderEvent(item.event, { replay: true, turnCard: true });
          }
        }
        const streamingSnapshot = options.streaming === true;
        this.flushChunkBuffer({ force: true, streamingSnapshot });
        if (streamingSnapshot) {
          // A capture is temporary, so snapshot confirmed live structures into
          // its semantic result without forcing an ambiguous held table header
          // to become prose. The enclosing finally restores the real stream.
          this.finalizeLiveTable();
          this.finalizeLiveCodeBlock();
        }
        const captured = this.transcriptEntries.slice();
        while (captured.length && this.transcriptEntryIsBlank(captured[0])) captured.shift();
        while (captured.length && this.transcriptEntryIsBlank(captured.at(-1))) captured.pop();
        return captured;
      } finally {
        // Only timers created by the temporary capture are current here. The
        // saved live timers (if any) are restored after these are cancelled.
        if (this.liveTablePaintTimer) clearTimeout(this.liveTablePaintTimer);
        if (this.liveCodeBlockPaintTimer) clearTimeout(this.liveCodeBlockPaintTimer);
        Object.assign(this, saved);
      }
    });
  }

  turnCardTranscriptEntry(turn) {
    const active = turn.status === "active";
    if (!this.turnCardProjectionCache) this.turnCardProjectionCache = new Map();
    const cacheKey = active
      ? ""
      : `${turn.id}|${this.activityMode}|${this.showInternalEvents ? 1 : 0}`;
    if (cacheKey && this.turnCardProjectionCache.has(cacheKey)) {
      return this.turnCardProjectionCache.get(cacheKey);
    }
    const detailSource = turn.detailEvents;
    const finalSource = turn.finalEvents;
    const captureOptions = { streaming: active };
    const detailEntries = this.captureEventEntries(detailSource, captureOptions);
    let finalEntries = this.captureEventEntries(finalSource, captureOptions);

    if (!finalEntries.length && !active) {
      const error = [...turn.events].reverse().find((event) => event.type === "error")?.text;
      const fallback =
        turn.status === "error"
          ? error || "Turn failed before the agent produced a final response."
          : turn.status === "cancelled"
            ? "Turn cancelled before a final response was completed."
            : turn.status === "partial"
              ? "The response ended before the agent could complete it."
              : "Turn completed without a final text response.";
      finalEntries = [{ kind: "prose", text: fallback, dim: turn.status === "completed" }];
    }

    const entry = {
      kind: "turn-card",
      turn,
      detailEntries,
      finalEntries,
    };
    if (cacheKey) this.turnCardProjectionCache.set(cacheKey, entry);
    return entry;
  }

  rebuildTranscriptProjection(options = {}) {
    const projectionRevision = Number(this.transcriptRevision) || 0;
    const previousOffset = this.scrollOffsetRows;
    const previousNewRows = this.scrollNewRows;
    const projectionWidth = this.transcriptWrapWidth();
    // Row totals are only needed to preserve an historical scroll anchor.
    // At the live tail, avoiding two full-history layout passes keeps a large
    // retained transcript cheap while the current answer streams.
    const preserveScrollAnchor = previousOffset > 0;
    const previousRowCount = preserveScrollAnchor
      ? this.transcriptEntries.reduce(
          (total, entry) => total + this.transcriptEntryRows(entry, projectionWidth).length,
          0,
        )
      : 0;
    this.withTranscriptRenderPhase("projection", () => {
      this.resetStreamRenderState();
      this.transcriptEntries = [""];
      this.recordTranscriptEntry({ kind: "chat-header" });
      this.pendingResponseBreak = false;
      this.lastStreamEventKey = "";

      for (const item of projectTranscriptTurns(this.transcriptProjectionEvents())) {
        if (item.kind === "event") {
          this.renderEvent(item.event, { replay: true });
          continue;
        }
        if (item.userEvent?.text) {
          if (item.userEvent.type === "command") this.renderProviderCommand(item.userEvent);
          else this.renderUserTurn(item.userEvent.text);
        }
        this.recordTranscriptEntry(this.turnCardTranscriptEntry(item));
        this.pendingResponseBreak = false;
      }

      this.flushChunkBuffer({ force: true });
      this.normalizeTurnDetailOverrides();
      this.normalizeActivityGroupOverrides();
      this.pruneTurnCardProjectionCache();
    });
    const nextRowCount = preserveScrollAnchor
      ? this.transcriptEntries.reduce(
          (total, entry) => total + this.transcriptEntryRows(entry, projectionWidth).length,
          0,
        )
      : 0;
    const rowDelta = nextRowCount - previousRowCount;
    const appendedRows = Math.max(0, rowDelta);
    this.scrollOffsetRows =
      previousOffset > 0 ? Math.max(0, previousOffset + rowDelta) : previousOffset;
    this.scrollNewRows = previousOffset > 0 ? previousNewRows + appendedRows : previousNewRows;
    this.projectedTranscriptRevision = Math.max(
      Number(this.projectedTranscriptRevision) || 0,
      projectionRevision,
    );

    if (options.initial && !this.rawInput && !this.canPaintPinned() && process.stdout.isTTY) {
      const width = projectionWidth;
      const rows = this.transcriptEntries.flatMap((entry) => this.transcriptEntryRows(entry, width));
      if (rows.length) process.stdout.write(`${rows.join("\n")}\n`);
      return;
    }

    if (this.canPaintPinned()) {
      if (options.renderComposer && this.rawInput?.pinned) {
        // Queue promotion changes transcript and composer geometry together.
        // Paint both through one FramePainter transaction so the fixed shelf
        // cannot disappear one frame before its prompt becomes visible.
        this.renderRawInput({ forceOutput: true });
      } else {
        this.repaintPinnedOutput();
      }
    } else if (this.rawInput && process.stdout.isTTY) {
      this.clearScreen();
      const width = this.transcriptWrapWidth();
      const rows = this.transcriptEntries.flatMap((entry) => this.transcriptEntryRows(entry, width));
      if (rows.length) process.stdout.write(`${rows.join("\n")}\n`);
      this.renderRawInput();
    }
  }

  chatHeaderLines(chat = this.currentChat) {
    if (!chat) return [];
    const dot = c("dim", "·");
    const title = chat.title && chat.title !== chat.id ? cleanInline(chat.title) : "";
    const status =
      chat.status && chat.status !== "idle" ? c(statusColorName(chat.status), chat.status) : "";
    const parts = [
      `${this.themedProviderIcon(chat)} ${this.themedProviderLabel(chat)}`,
      c("bold", chat.projectName),
      title ? c("bold", title) : "",
      chat.mode ? c("dim", chat.mode) : "",
      status,
    ].filter(Boolean);
    return [
      parts.join(` ${dot} `),
      ...(this.showInternalEvents && chat.cwd ? [c("dim", chat.cwd)] : []),
    ];
  }

  async chatLoop() {
    try {
      for (;;) {
        const prompt = this.inputPrompt();
        const line = (await this.question(prompt, { draft: true })).trim();

        // Ctrl+G (and prefix+, / the panel action) requests a rename prompt.
        if (this.pendingComposerAction === "rename") {
          this.pendingComposerAction = null;
          await this.renameChatInteractive();
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
          await this.executeProviderCommand(line);
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
          if (await this.showProviderCommandsPicker()) continue;
          this.printCommandCatalog();
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
        if (line === "/effort" || line === "/reasoning") {
          if (await this.showConfigOptionPicker("effort", "Effort")) continue;
          if (this.showConfigOptionPanel("effort", "ACP Effort")) continue;
          this.textFallback("ACP effort menu unavailable", () => this.printConfigOption("effort"));
          continue;
        }
        if (line.startsWith("/effort ") || line.startsWith("/reasoning ")) {
          await this.handleShortcutConfigCommand(
            "effort",
            line.replace(/^\/(?:effort|reasoning)\s+/, "").trim(),
          );
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
              ? "vim mode on — Esc for normal mode; empty Ctrl+C twice cancels the turn"
              : "vim mode off",
          );
          continue;
        }
        if (line === "/hub") {
          if (await this.showHubVersionPicker()) continue;
          await this.handleHubVersionCommand("");
          continue;
        }
        if (line.startsWith("/hub ")) {
          await this.handleHubVersionCommand(line.slice(4).trim());
          continue;
        }
        if (line === "/restart") {
          // Soft recovery from inside the popup: the next prefix+m starts a
          // fresh daemon with every chat restored from the registry.
          this.restartHubDetached();
          continue;
        }
        if (line === "/cancel") {
          await this.hub.call("cancel", { chatId: this.currentChat.id }).catch((error) => {
            this.logProse(c("red", error.message));
          });
          continue;
        }
        if (line === "/plan" || line.startsWith("/plan ")) {
          this.handlePlanCommand(line.slice(5).trim());
          continue;
        }
        if (line === "/details" || line.startsWith("/details ")) {
          this.handleTurnDetailsCommand(line.slice(8).trim());
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
        if (line === "/mcp" || line.startsWith("/mcp ")) {
          await this.handleMcpCommand(line.slice(4).trim());
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
          this.rebuildTranscriptProjection();
          continue;
        }
        if (line === "/activity" || line.startsWith("/activity ")) {
          this.setActivityMode(line);
          continue;
        }

        if (line.startsWith("/")) {
          const commandToken = line.split(/\s+/, 1)[0];
          const ownedByHub = this.hubCommandForToken(commandToken);
          if (ownedByHub && ownedByHub.name !== commandToken) {
            this.notify(
              `Hub commands use lowercase · type ${ownedByHub.name}, or //${ownedByHub.name.slice(1)} to force the ACP command`,
            );
          } else if (ownedByHub) {
            this.notify(`unsupported arguments for Hub command ${commandToken} · use //${commandToken.slice(1)} to force the ACP command`);
          } else if (resolveProviderCommand(line, this.currentChat?.availableCommands || [])) {
            await this.executeProviderCommand(line);
          } else {
            this.notify(`unknown command: ${commandToken} · /commands lists ACP commands · /agent sends raw text`);
          }
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
        this.logProse(c("red", result.error.message));
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

    const optimisticText = promptDisplayTextFromAttachments(cleanText, attachments);
    const submission = this.stagePromptSubmission(optimisticText);
    if (submission) {
      // Set this before awaiting the daemon so an immediate Esc still has a
      // draft to restore even when the RPC acknowledgement has not returned.
      this.lastSentPrompt = {
        chatId: this.currentChat.id,
        text: cleanText,
        clientPromptId: submission.clientPromptId,
      };
    }

    try {
      const result = await this.hub.call("send_prompt", {
        chatId: this.currentChat.id,
        text: cleanText,
        attachments,
        clientPromptId: submission?.clientPromptId || null,
      });
      if (submission) this.acknowledgePromptSubmission(submission.clientPromptId, result);
      if (result?.queued) {
        this.notify(`queued (${result.queueLength} pending) — sends when the current turn finishes`);
      }
      this.pendingAttachments = [];
      this.refreshRawInputPrompt();
    } catch (error) {
      if (submission) this.discardPromptSubmission(submission.clientPromptId);
      if (this.lastSentPrompt?.clientPromptId === submission?.clientPromptId) {
        this.lastSentPrompt = null;
      }
      this.logProse(c("red", error.message));
    }
  }

  async executeProviderCommand(text) {
    const resolved = resolveProviderCommand(text, this.currentChat?.availableCommands || []);
    if (!resolved) {
      this.notify("provider command is not in the current ACP command list");
      return;
    }

    try {
      const result = await this.hub.call("execute_provider_command", {
        chatId: this.currentChat.id,
        command: resolved.text,
        clientCommandId: `command-${crypto.randomUUID()}`,
      });
      if (result?.queued) {
        this.notify(`command queued (${result.queueLength} pending)`);
      }
      this.refreshRawInputPrompt();
    } catch (error) {
      this.logProse(c("red", error.message || String(error)));
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
      this.logProse(c("red", `Delete failed: ${error.message}`));
      return false;
    }
  }

  printHubVersionHelp() {
    this.logLine("");
    this.logLine(c("bold", "Hub adapter manager"));
    this.logLine(c("dim", "Inspect and maintain the private ACP adapters used by this Hub."));
    this.logLine("");
    this.logLine(`${c("bold", "/hub versions")}           ${c("dim", "installed, pending, runtime, and global versions")}`);
    this.logLine(`${c("bold", "/hub updates")}            ${c("dim", "check the configured registry channel")}`);
    this.logLine(`${c("bold", "/hub update <agent|all>")} ${c("dim", "prepare the current pin or stage a newer adapter")}`);
    this.logLine(`${c("bold", "/hub rollback <agent>")}   ${c("dim", "stage the previous verified adapter")}`);
    this.logLine("");
    this.logLine(c("dim", "Staged versions activate after /restart. Global CLIs are never modified."));
    this.logLine("");
  }

  hubDisplayState(state) {
    if (!state?.managed) return { label: "external", color: "dim" };
    if (state.deprecated) return { label: "deprecated", color: "red" };
    if (state.pendingVersion) return { label: "restart required", color: "yellow" };
    if (state.updateAvailable) return { label: "update available", color: "yellow" };
    if (!state.activeVersion) return { label: "npx fallback", color: "dim" };
    return { label: "current", color: "green" };
  }

  setHubOperation(operation, options = {}) {
    this.hubOperation = operation || null;
    if (options.render !== false && this.rawInput?.pinned) {
      this.renderRawInput();
      this.syncComposerAnimation();
    }
    return this.hubOperation;
  }

  hubOperationPhaseLabel(phase) {
    return {
      checking: "Checking registry",
      download: "Downloading package",
      verify: "Verifying cached install",
      handshake: "Testing ACP handshake",
      ready: "Finalizing",
      staging: "Staging rollback",
      staged: "Ready for restart",
      current: "Already current",
      failed: "Update failed",
    }[phase] || "Updating adapter";
  }

  hubOperationPanelLines(width, rowLimit = 4) {
    const operation = this.hubOperation;
    if (!operation || rowLimit < 1) return [];
    const lines = [];
    const label = operation.providerLabel || operation.provider || "Adapter";
    const from = operation.fromVersion || operation.configuredVersion || "current";
    const to = operation.version || "latest";

    if (operation.status === "running") {
      const phaseOrder = operation.action === "rollback"
        ? ["staging"]
        : ["checking", "download", "verify", "handshake", "ready"];
      const currentIndex = Math.max(0, phaseOrder.indexOf(operation.phase));
      const progress = phaseOrder.map((phase, index) => {
        if (index < currentIndex) return c("greenStrong", "●");
        if (index === currentIndex) return c("yellow", "◐");
        return c("muted", "○");
      }).join(" ");
      lines.push(
        `${c("yellow", "◐")} ${c("bold", `${label} · ${operation.action === "rollback" ? "Rollback" : "Updating"}`)}`,
      );
      lines.push(`${c("muted", this.hubOperationPhaseLabel(operation.phase))}  ${progress}`);
      lines.push(
        c("dim", `${from} → ${to} · you can keep typing or close this popup`),
      );
    } else if (operation.status === "succeeded") {
      const items = operation.result?.items || [];
      lines.push(
        `${c("greenStrong", "✓")} ${c("bold", operation.phase === "current" ? "Adapter already current" : "Adapter verified and staged")}`,
      );
      for (const item of items.slice(0, Math.max(1, rowLimit - 2))) {
        const itemFrom = item.activeVersion || item.configuredVersion || "npx fallback";
        const itemTo = item.pendingVersion || item.activeVersion || itemFrom;
        const state = item.requiresRestart ? c("yellow", "restart required") : c("green", "active");
        lines.push(`${item.provider || label}  ${c("dim", itemFrom)} ${c("muted", "→")} ${c("green", itemTo)}  ${state}`);
      }
      lines.push(c("dim", operation.result?.requiresRestart
        ? "Enter opens Restart now / Later · global CLI is unchanged"
        : "Enter dismisses this result · global CLI is unchanged"));
    } else {
      lines.push(`${c("red", "✗")} ${c("bold", `${label} · ${this.hubOperationPhaseLabel("failed")}`)}`);
      lines.push(c("red", operation.error || "Adapter operation failed"));
      lines.push(c("dim", operation.result?.requiresRestart
        ? "Some adapters staged · Enter opens Retry / Restart / Dismiss"
        : "Enter opens Retry / Dismiss · existing adapter remains unchanged"));
    }

    return lines.slice(0, rowLimit).map((line) => fitAnsiLine(line, width));
  }

  async acknowledgeHubOperation(operation = this.hubOperation) {
    if (!operation?.id) return false;
    await this.hub.call("adapter_operation_ack", { operationId: operation.id });
    if (this.hubOperation?.id === operation.id) this.setHubOperation(null);
    return true;
  }

  async showHubOperationActions() {
    const operation = this.hubOperation;
    if (!operation || operation.status === "running") return false;
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    if (operation.status === "failed") {
      const staged = operation.result?.requiresRestart === true;
      const busy = operation.result?.busyChats || [];
      const picked = await this.quickSelect({
        title: `${operation.providerLabel || operation.provider} · update failed`,
        items: [
          {
            label: `Dismiss${c("dim", staged ? " · keep staged candidate for later" : " · keep existing adapter")}`,
            current: true,
            value: "dismiss",
          },
          { label: `Retry${c("dim", ` · ${operation.provider}`)}`, value: "retry" },
          ...(staged && !busy.length
            ? [{ label: `Restart Hub now${c("dim", " · activate successful candidates")}`, value: "restart" }]
            : []),
        ],
      });
      if (picked === "retry") {
        await this.handleHubVersionCommand(`${operation.action} ${operation.provider}`, {
          confirmed: true,
          pickerFlow: true,
        });
      } else if (picked === "restart") {
        await this.acknowledgeHubOperation(operation);
        this.restartHubDetached();
      } else if (picked === "dismiss") {
        await this.acknowledgeHubOperation(operation);
        if (staged) this.notify("successful adapters remain staged · /restart activates them later");
      }
      return true;
    }

    if (!operation.result?.requiresRestart) {
      await this.acknowledgeHubOperation(operation);
      return true;
    }
    const busy = operation.result?.busyChats || [];
    const picked = await this.quickSelect({
      title: busy.length
        ? `Adapter staged · ${busy.length} active chat${busy.length === 1 ? "" : "s"}`
        : "Adapter staged · activate with restart",
      items: [
        {
          label: `Restart later${c("dim", " · keep current chats and runtime")}`,
          current: true,
          value: "later",
        },
        ...(busy.length
          ? []
          : [{
              label: `Restart Hub now${c("dim", " · activate staged adapter")}`,
              value: "restart",
            }]),
      ],
    });
    if (picked === "restart") {
      await this.acknowledgeHubOperation(operation);
      this.restartHubDetached();
    } else if (picked === "later") {
      await this.acknowledgeHubOperation(operation);
      this.notify("adapter staged · /restart activates it later");
    }
    return true;
  }

  hubUpdateComparisonTable(states = [], width = this.transcriptContentWidth()) {
    const escapeCell = (value) => String(value || "-")
      .replaceAll("\\", "\\\\")
      .replaceAll("|", "\\|");
    const rows = states.filter((state) => state.managed).map((state) => {
      const current = state.activeVersion || state.configuredVersion || "-";
      const next = state.pendingVersion || (state.updateAvailable ? state.availableVersion : null) || current;
      let status = "Current";
      if (state.deprecated) status = "Review";
      else if (state.pendingVersion) status = "Restart";
      else if (state.registryError && !state.availableVersion) status = "Retry";
      else if (state.updateAvailable) status = "Update";
      else if (!state.activeVersion) status = "Prepare";
      return [
        state.label || state.provider,
        `${current}${state.activeVersion ? "" : " (npx)"}`,
        next,
        status,
      ];
    });
    if (!rows.length) return "";
    const source = [
      "| Adapter | Current | New | Status |",
      "|:--|:--|:--|:--|",
      ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
    ];
    return renderMarkdownTable(source, { width });
  }

  hubGuidanceEntries(states = []) {
    const entries = [];
    for (const state of states) {
      const label = state.label || state.provider;
      if (!state.managed) {
        entries.push({
          label,
          text: "This adapter is managed externally through agents.json; /hub will not modify it.",
        });
        continue;
      }
      if (state.deprecated) {
        entries.push({
          label,
          text: state.pendingVersion
            ? `Do not activate pending ${state.pendingVersion} yet. Review agents.json: ${state.deprecated}`
            : `Review agents.json before the package is removed: ${state.deprecated}`,
        });
        continue;
      }
      if (state.pendingVersion) {
        entries.push({
          label,
          command: "/restart",
          text: `Activate the verified ${state.pendingVersion} adapter.`,
        });
        continue;
      }
      if (state.updateAvailable) {
        entries.push({
          label,
          command: `/hub update ${state.provider}`,
          text: `Verify and stage ${state.availableVersion} over ${state.activeVersion || `${state.configuredVersion} (npx)`}.`,
        });
        continue;
      }
      if (state.registryError && !state.availableVersion) {
        entries.push({
          label,
          command: "/hub updates",
          text: "Retry the registry check after checking network/npm access.",
        });
        continue;
      }
      if (!state.activeVersion) {
        entries.push({
          label,
          command: `/hub update ${state.provider}`,
          text: "Prepare a verified private copy for atomic activation and rollback.",
        });
        continue;
      }
      if (state.registryError) {
        entries.push({
          label,
          command: "/hub updates",
          text: `Retry the registry check${state.registryStale ? "; cached data is shown above" : " after checking network/npm access"}.`,
        });
      }
    }
    return entries;
  }

  printHubGuidance(states = []) {
    const entries = this.hubGuidanceEntries(states);
    if (!entries.length) return;
    this.logLine("");
    this.logLine(c("bold", "Next steps"));
    for (const entry of entries) {
      const command = entry.command ? `  ${c("cyan", entry.command)}` : "";
      this.logLine(`  ${c("yellow", "•")} ${c("bold", entry.label)}${command}`);
      this.logLine(`    ${c("dim", entry.text)}`);
    }
  }

  printHubVersions(result, options = {}) {
    const states = result.providers || [];
    const managed = states.filter((state) => state.managed);
    const newerReleases = managed.filter((state) => state.updateAvailable);
    const deprecatedAdapters = managed.filter((state) => state.deprecated);
    const title = options.title || "Adapter versions";

    this.logLine("");
    this.logLine(c("bold", title));
    this.logLine(c(
      "dim",
      `ACP v1 · ${result.settings?.channel || "stable"} channel · ${managed.length} managed adapter${managed.length === 1 ? "" : "s"}`,
    ));
    if (options.checked === true) {
      const registryFailures = managed.filter((state) => state.registryError);
      const fallbacks = managed.filter((state) => !state.activeVersion && !state.pendingVersion);
      if (newerReleases.length) {
        this.logLine(c("yellow", `${newerReleases.length} newer release${newerReleases.length === 1 ? "" : "s"} available`));
      } else if (registryFailures.length) {
        this.logLine(c("yellow", `Update check incomplete for ${registryFailures.length} adapter${registryFailures.length === 1 ? "" : "s"}`));
      } else {
        this.logLine(c("green", "No newer adapter release found"));
      }
      if (deprecatedAdapters.length) {
        this.logLine(c(
          "red",
          `${deprecatedAdapters.length} deprecated adapter${deprecatedAdapters.length === 1 ? " requires" : "s require"} review`,
        ));
      }
      if (fallbacks.length) {
        this.logLine(c(
          "cyan",
          `${fallbacks.length} adapter${fallbacks.length === 1 ? " still uses" : "s still use"} npx fallback`,
        ));
      }
      this.logLine("");
      const table = this.hubUpdateComparisonTable(states);
      for (const line of table.split("\n")) this.logLine(line);
      this.printHubGuidance(states);
      this.logLine("");
      return;
    }

    for (const state of result.providers || []) {
      const displayState = this.hubDisplayState(state);
      const row = (label, value, color = null) => {
        if (!value) return;
        const rendered = color ? c(color, value) : value;
        this.logLine(`  ${c("dim", label.padEnd(11))}${rendered}`);
      };

      this.logLine("");
      this.logLine(
        `${this.themedProviderIcon({ provider: state.provider })} ${c("bold", state.label || state.provider)}  ${c(displayState.color, displayState.label)}`,
      );
      if (!state.managed) {
        row("command", state.command || state.reason || "custom");
        continue;
      }
      row("package", state.package);
      row(
        "active",
        state.activeVersion
          ? `${state.package}@${state.activeVersion}`
          : `${state.package}@${state.configuredVersion} · npx fallback`,
      );
      row("pending", state.pendingVersion ? `${state.package}@${state.pendingVersion} · restart required` : "", "yellow");
      row("available", state.availableVersion ? `${state.package}@${state.availableVersion}` : "", state.updateAvailable ? "yellow" : null);
      row("rollback", state.previousVersion ? `${state.package}@${state.previousVersion}` : "");
      const selectedVersion = state.pendingVersion || state.activeVersion;
      const selected = (state.installed || []).find((entry) => entry.version === selectedVersion);
      for (const [name, version] of Object.entries(selected?.dependencies || {})) {
        row("runtime", `${name}@${version}`);
      }
      if (state.globalCli) {
        row(
          "global CLI",
          `${state.globalCli.command}@${state.globalCli.version || "unknown"} · ${state.globalCli.path}`,
          "dim",
        );
      }
      if (state.deprecated) row("deprecated", state.deprecated, "red");
      if (state.registryError) {
        row(
          "registry",
          `unavailable${state.registryStale ? " · cached data shown" : ""}`,
          "yellow",
        );
      }
    }
    this.printHubGuidance(states);
    this.logLine("");
  }

  hubActionDescriptors() {
    return [
      {
        name: "versions",
        label: "Versions",
        hint: "Show active, pending, runtime, and global CLI versions",
      },
      {
        name: "updates",
        label: "Check for updates",
        hint: "Refresh the configured npm channel without installing",
      },
      {
        name: "update",
        label: "Prepare / update adapter",
        hint: "Prepare the current pin or stage a newer managed adapter",
        provider: true,
        all: true,
      },
      {
        name: "rollback",
        label: "Roll back adapter",
        hint: "Stage a previous verified version",
        provider: true,
      },
    ];
  }

  hubActionPickerSpec() {
    const items = this.hubActionDescriptors().map((action) => ({
      label: `${action.label}${c("dim", ` · ${action.hint}`)}`,
      searchText: `${action.name} ${action.label} ${action.hint}`,
      value: action.name,
    }));
    return {
      title: "Hub adapters",
      items,
      apply: (action) => this.runHubPickerAction(action),
    };
  }

  async showHubVersionPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;
    const spec = this.hubActionPickerSpec();
    const picked = await this.quickSelect({ title: spec.title, items: spec.items });
    if (picked !== null) await spec.apply(picked);
    return true;
  }

  async runHubPickerAction(action) {
    if (action === "update" || action === "rollback") {
      return this.showHubProviderPicker(action);
    }
    await this.handleHubVersionCommand(action);
    return true;
  }

  async showHubProviderPicker(action) {
    let snapshot;
    try {
      snapshot = await this.hub.call("adapter_versions", { globals: false });
    } catch (error) {
      this.logProse(c("red", `Version inspection failed: ${error.message}`));
      return false;
    }

    let states = (snapshot.providers || []).filter((state) => state.managed);
    if (action === "rollback") {
      states = states.filter((state) => state.previousVersion);
      if (!states.length) {
        this.notify("no verified rollback version is available");
        return true;
      }
    }
    if (!states.length) {
      this.notify("no Hub-managed adapters are configured");
      return true;
    }

    const currentProvider = this.currentChat?.provider;
    states.sort((left, right) => {
      if (left.provider === currentProvider) return -1;
      if (right.provider === currentProvider) return 1;
      return String(left.label || left.provider).localeCompare(String(right.label || right.provider));
    });
    const items = states.map((state) => {
      const effective = state.pendingVersion || state.activeVersion || state.configuredVersion;
      const detail = action === "rollback"
        ? `restore ${state.previousVersion}`
        : `${effective}${state.pendingVersion ? " pending" : state.activeVersion ? " active" : " npx fallback"}`;
      return {
        label: `${state.label || state.provider}${c("dim", ` · ${detail}`)}`,
        searchText: `${state.provider} ${state.label || ""} ${detail}`,
        current: state.provider === currentProvider,
        value: state.provider,
      };
    });
    if (action === "update" && states.length > 1) {
      items.push({
        label: `All managed adapters${c("dim", " · verify and stage each provider")}`,
        searchText: "all every managed adapter",
        value: "all",
      });
    }

    const picked = await this.quickSelect({
      title: action === "rollback" ? "Roll back adapter" : "Prepare / update adapter",
      items,
    });
    if (picked !== null) await this.confirmHubPickerAction(action, picked);
    return true;
  }

  async confirmHubPickerAction(action, provider) {
    const verb = action === "rollback" ? "roll back" : "update";
    const picked = await this.quickSelect({
      title: `Confirm ${verb} · ${provider}`,
      items: [
        {
          label: `Cancel${c("dim", " · leave adapter versions unchanged")}`,
          current: true,
          value: "cancel",
        },
        {
          label: `${action === "rollback" ? "Stage rollback" : "Prepare and verify"}${c("dim", ` · ${provider}`)}`,
          value: "confirm",
        },
      ],
    });
    if (picked !== "confirm") {
      this.notify(`${verb} cancelled`);
      return false;
    }
    await this.handleHubVersionCommand(`${action} ${provider}`, {
      confirmed: true,
      pickerFlow: true,
    });
    return true;
  }

  restartHubDetached() {
    this.logLine(c("yellow", "restarting the hub — reopen with prefix+m (chats are kept)"));
    const token = crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(RESTART_LOCK_PATH), { recursive: true, mode: 0o700 });
      try {
        const existing = JSON.parse(fs.readFileSync(RESTART_LOCK_PATH, "utf8"));
        const startedAt = Number(existing?.startedAt) || 0;
        if (!startedAt || Date.now() - startedAt > 60_000) {
          fs.unlinkSync(RESTART_LOCK_PATH);
        } else {
          this.notify("restart already in progress · prefix+m will wait for it");
          return true;
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        // A corrupt marker cannot safely own the transaction; replace it.
        if (error instanceof SyntaxError) fs.unlinkSync(RESTART_LOCK_PATH);
      }
      fs.writeFileSync(
        RESTART_LOCK_PATH,
        JSON.stringify({ token, pid: process.pid, state: "requested", startedAt: Date.now() }),
        { flag: "wx", mode: 0o600 },
      );
      const child = spawn(process.execPath, [HUB_CLI_PATH, "restart"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ACP_HUB_RESTART_TOKEN: token },
      });
      child.once("error", () => {
        try {
          const lock = JSON.parse(fs.readFileSync(RESTART_LOCK_PATH, "utf8"));
          if (lock?.token === token) fs.unlinkSync(RESTART_LOCK_PATH);
        } catch {
          // A running restart process may already own or remove the marker.
        }
      });
      child.unref();
      return true;
    } catch (error) {
      try {
        const lock = JSON.parse(fs.readFileSync(RESTART_LOCK_PATH, "utf8"));
        if (lock?.token === token) fs.unlinkSync(RESTART_LOCK_PATH);
      } catch {
        // Nothing to clean up.
      }
      this.logProse(c("red", `restart failed: ${error.message || error}`));
      return false;
    }
  }

  async handleHubVersionCommand(argument = "", options = {}) {
    const words = argument.split(/\s+/).filter(Boolean);
    const action = (words.shift() || "help").toLowerCase();
    if (action === "help") {
      this.printHubVersionHelp();
      return;
    }
    if (action === "versions" || action === "version") {
      try {
        const result = await this.hub.call("adapter_versions", { globals: true });
        this.printHubVersions(result, { title: "Adapter versions" });
      } catch (error) {
        this.logProse(c("red", `Version inspection failed: ${error.message}`));
      }
      return;
    }
    if (action === "updates" || action === "check") {
      try {
        this.notify("checking adapter registries…");
        const result = await this.hub.call("adapter_versions", { check: true, globals: true });
        this.printHubVersions(result, { title: "Adapter updates", checked: true });
      } catch (error) {
        this.logProse(c("red", `Update check failed: ${error.message}`));
      }
      return;
    }
    if (action === "update") {
      const provider = (words.shift() || this.currentChat?.provider || "").toLowerCase();
      if (provider !== "all" && !this.config.agents?.[provider]) {
        this.notify(`unknown agent: ${provider || "-"}`);
        return;
      }
      if (!options.confirmed) {
        await this.confirmHubPickerAction("update", provider);
        return;
      }
      try {
        const result = await this.hub.call("adapter_update_start", { provider, force: true });
        this.setHubOperation(result.operation);
      } catch (error) {
        this.logProse(c("red", `Adapter update failed: ${error.message}`));
      }
      return;
    }
    if (action === "rollback") {
      const provider = (words.shift() || this.currentChat?.provider || "").toLowerCase();
      if (!this.config.agents?.[provider]) {
        this.notify(`unknown agent: ${provider || "-"}`);
        return;
      }
      if (!options.confirmed) {
        await this.confirmHubPickerAction("rollback", provider);
        return;
      }
      try {
        const result = await this.hub.call("adapter_rollback_start", { provider });
        this.setHubOperation(result.operation);
      } catch (error) {
        this.logProse(c("red", `Rollback failed: ${error.message}`));
      }
      return;
    }
    this.notify("usage: /hub versions|updates|update <agent|all>|rollback <agent>");
  }

  async printChats() {
    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    if (!chats.length) {
      this.logLine(c("dim", "No chats yet"));
      return;
    }

    this.renderGroupedChats(this.orderChatsForDisplay(chats, "projects"));
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
    this.logLine("/commands          search Hub, agent, and skill commands");
    this.logLine("/modes             show modes reported by the provider");
    this.logLine("/mode <value>      set an exact provider mode");
    this.logLine("/access [value]    mode/permission details; compatibility alias");
    this.logLine("/plan [action]     expand plan; configure pin/awaiting auto/on/off");
    this.logLine("/details [action]  expand/collapse turn activity (F3 toggles latest)");
    this.logLine("/roots             show additional workspace directories");
    this.logLine("/roots add <path>  add an extra workspace directory for next restore");
    this.logLine("/changes           browse files edited in this chat as git-style diffs");
    this.logLine("/attach <path>     attach file(s) to the next prompt");
    this.logLine("/attachments       show pending prompt attachments");
    this.logLine("/detach <n>|all    remove pending prompt attachments");
    this.logLine("@file              mention and attach a project file; Tab completes");
    this.logLine("/command [args]    run a current ACP command when Hub has no collision");
    this.logLine("//command [args]   force an ACP command when Hub owns /command");
    this.logLine("/agent <text>      send literal text, including unadvertised slash text");
    this.logLine("/cancel            cancel current ACP turn (or press Esc twice)");
    this.logLine("/allow <n>         choose a pending permission option");
    this.logLine("/deny              reject or cancel a pending permission");
    this.logLine("/rename <title>    rename this chat for menus/search");
    this.logLine("/close             close this chat and stop its ACP adapter");
    this.logLine("/activity <mode>   tool activity: compact, hidden, debug");
    this.logLine("/vim               toggle vim editing mode in the composer");
    this.logLine("/debug             toggle internal ACP hub logs in the chat pane");
    this.logLine("/hub <action>      inspect, update, or roll back Hub-managed adapters");
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

  async applyConfigOption(configId, value, options = {}) {
    if (!this.currentChat?.id) return false;

    try {
      const result = await this.hub.call("set_config_option", {
        chatId: this.currentChat.id,
        configId,
        value,
      });
      this.currentChat = result.chat || this.currentChat;
      this.syncTmuxWindow(this.currentChat, { force: true });
      if (options.render !== false) this.refreshRawInputPrompt();
      this.notify(`ACP config ${result.configId || configId}=${valueLabel(result.value) || value}`);
      return true;
    } catch (error) {
      this.logProse(c("red", error.message || String(error)));
      if (options.fallback !== false) {
        if (this.showConfigOptionPanel(configId)) return false;
        this.textFallback("ACP config options unavailable", () => this.printConfigOption(configId));
      }
      return false;
    }
  }

  // Tab (+1) / Shift+Tab (-1) step through the adapter's advertised modes,
  // wrapping around. Modes are a behavior axis (Claude plan/default/…),
  // independent of the model (/model); the footer's access label reflects the
  // new mode, so the change is visible without opening the picker.
  async cycleMode(direction) {
    if (this.cyclingMode) return;
    const modes = chatModeEntries(this.currentChat);
    if (modes.length < 2) {
      this.notify(modes.length ? "only one mode available" : "no modes for this adapter");
      return;
    }

    const idOf = (mode) => String(mode.id || mode.modeId || mode.name || mode);
    const current = String(chatModeValue(this.currentChat) ?? "");
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
      this.logProse(c("red", error.message || String(error)));
      if (this.showModesPanel()) return;
      this.textFallback("ACP modes menu unavailable", () => this.printModes());
    }
  }

  printAccessHelp() {
    this.logLine("");
    this.logLine(c("bold", "Provider Mode & Permissions"));
    this.logLine(`provider           ${this.currentChat?.providerLabel || this.currentChat?.provider || "-"}`);
    this.logLine(`current mode       ${chatModeValue(this.currentChat) || "-"}`);
    this.logLine(`Hub policy         ${this.currentChat?.permissionPolicy || "prompt"}`);
    const state = this.currentChat?.permissionState || {};
    const active = state.activeOnce;
    const grants = state.sessionGrants || [];
    this.logLine(`one-time grant     ${active ? active.optionName || active.toolKind || "active" : "-"}`);
    this.logLine(`session grants     ${grants.length || 0}`);
    this.logLine("");
    this.logLine("/mode              choose a mode reported by this provider");
    this.logLine("/mode <value>      set that exact provider mode");
    this.logLine("/access            compatibility alias for /mode");
    this.logLine("");
    this.logLine(c("dim", "Allow Once/Session grants an exception; it does not rename the base mode."));
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
      this.logLine(c("yellow", `No exact or unique provider mode matching ${value}.`));
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
        this.logProse(c("red", `attach failed: ${file}: ${error.message || String(error)}`));
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
        `${attachmentChip(attachment, index, this.themeAccentSeq(this.currentChat?.provider))} ${c("dim", attachment.mimeType)} ${c(
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

  commandCatalogCommands(chat = this.currentChat) {
    return this.chatCommands(chat).filter((command) => !command.aliasOf);
  }

  commandCatalogSignature(chat = this.currentChat) {
    return JSON.stringify(
      normalizeProviderCommands(chat?.availableCommands || []).map((command) => ({
        command: command.command,
        description: command.description,
        inputHint: command.inputHint,
        aliases: command.aliases,
        presentation: command.presentation,
      })),
    );
  }

  commandPickerItems(chat = this.currentChat) {
    const commands = this.commandCatalogCommands(chat);
    const groups = [
      ["Hub commands", commands.filter((command) => command.origin === "hub")],
      ["Agent commands", commands.filter((command) => command.origin === "provider")],
      ["Skills", commands.filter((command) => command.origin === "skill")],
    ];
    const items = [];
    for (const [label, entries] of groups) {
      if (!entries.length) continue;
      items.push({ label: c("bold", label), disabled: true });
      for (const command of entries) {
        const collision = command.collision === true;
        const invocation = command.name;
        const argumentsHint = command.inputHint ? ` ${command.inputHint}` : "";
        const description = command.description ? `  ${c("dim", command.description)}` : "";
        const aliases = (command.aliases || []).map((alias) => `/${alias}`);
        const aliasLabel = aliases.length
          ? `  ${c("dim", `aliases: ${aliases.join(", ")}`)}`
          : "";
        items.push({
          label: `${c("bold", invocation)}${c("dim", argumentsHint)}${description}${aliasLabel}${
            collision ? `  ${c("yellow", "Hub collision")}` : ""
          }`,
          searchText: [
            invocation,
            command.command,
            command.inputHint,
            command.description,
            ...aliases,
            ...(command.aliases || []),
          ]
            .filter(Boolean)
            .join(" "),
          value: `${invocation}${command.inputHint ? " " : ""}`,
        });
      }
    }
    return items;
  }

  printCommandCatalog(chat = this.currentChat) {
    const commands = this.commandCatalogCommands(chat);
    this.logLine("");
    this.logLine(c("bold", "Commands"));

    const groups = [
      ["Hub", commands.filter((command) => command.origin === "hub")],
      ["Agent", commands.filter((command) => command.origin === "provider")],
      ["Skills", commands.filter((command) => command.origin === "skill")],
    ];
    for (const [label, entries] of groups) {
      if (!entries.length) continue;
      this.logLine("");
      this.logLine(c("bold", label));
      for (const command of entries) {
        const inputHint = command.inputHint ? ` ${c("dim", command.inputHint)}` : "";
        const description = command.description ? ` ${c("dim", command.description)}` : "";
        const aliases = (command.aliases || []).map((alias) => `/${alias}`);
        const aliasText = aliases.length
          ? ` ${c("dim", `(aliases: ${aliases.join(", ")})`)}`
          : "";
        const collision = command.collision ? ` ${c("yellow", "Hub collision")}` : "";
        this.logLine(`- ${c("bold", command.name)}${inputHint}${description}${aliasText}${collision}`);
      }
    }

    this.logLine("");
    this.logLine(c("dim", "Use /command normally, //command for a Hub collision, or /agent <text> for raw text."));
  }

  printProviderCommands() {
    this.printCommandCatalog();
  }

  async showProviderCommandsPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;
    const chatId = this.currentChat?.id;
    let signature = this.commandCatalogSignature(this.currentChat);
    const items = this.commandPickerItems(this.currentChat);
    if (!items.length) return false;

    const picked = await this.interactivePick({
      title: "Commands",
      hint: "j/k move · / filter · Enter insert · Esc",
      items,
      onEvent: (message, { replaceItems }) => {
        if (message.type !== "chat_state" || message.chat?.id !== chatId) return;
        const nextSignature = this.commandCatalogSignature(message.chat);
        if (nextSignature === signature) return;
        signature = nextSignature;
        replaceItems(this.commandPickerItems(message.chat));
      },
    });
    if (typeof picked === "string" && picked) {
      saveDraft(this.currentDraftKey(), picked);
      this.notify("command inserted in the composer");
    }
    return true;
  }

  printModes() {
    const entries = chatModeEntries(this.currentChat);
    const current = chatModeValue(this.currentChat);
    this.logLine("");
    this.logLine(c("bold", "Provider Modes"));
    this.logLine(`current            ${current || "-"}`);

    if (!entries.length) {
      this.logLine(c("dim", "No mode config reported by this adapter yet."));
      return;
    }

    for (const mode of entries) {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      const description = mode.description || "";
      const marker = id === current ? "*" : " ";
      this.logLine(`${marker} ${id}${label === id ? "" : ` ${c("dim", label)}`}`);
      if (description) this.logLine(c("dim", `    ${description}`));
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
    const visibleChats = this.orderChatsForDisplay(chats, "projects").slice(0, 40);

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
        label: `${this.themedProviderIcon(chat)} ${c("bold", title)}${status}${
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
  // Ctrl+O/← changes the visible scene without resolving the draft-backed
  // question. Keeping the same session object is what preserves cursor, Vim
  // state, undo history, attachments, and the exact multiline viewport.
  // Ctrl+O may enter from transcript scrollback; the empty-line ← shortcut
  // remains latest-view-only so it cannot steal a navigation gesture.
  triggerMenuFromComposer(session, options = {}) {
    if (
      !this.currentChat?.id ||
      (this.scrollOffsetRows !== 0 && options.allowScrolled !== true) ||
      !this.pickerSupported() ||
      !this.canPaintPinned() ||
      this.fullscreenOverlay ||
      session?.done
    ) {
      return false;
    }
    this.saveRawDraft(session);
    void this.openMenuOverlayFromComposer(session);
    return true;
  }

  suspendComposerForOverlay(session) {
    if (!session || this.rawInput !== session || session.done || session.overlaySuspended) {
      return false;
    }

    session.overlaySuspended = true;
    this.fullscreenOverlay = { kind: "menu", session };
    if (session.onKeypress) process.stdin.off("keypress", session.onKeypress);
    if (session.resizeTimer) {
      clearTimeout(session.resizeTimer);
      session.resizeTimer = null;
    }
    if (session.resizeHandler) process.removeListener("SIGWINCH", session.resizeHandler);
    if (session.bracketedPaste) {
      this.disableBracketedPaste();
      session.bracketedPasteSuspended = true;
    }
    this.stopComposerAnimation();
    return true;
  }

  resumeComposerFromOverlay(session) {
    if (!session || this.rawInput !== session || session.done || !session.overlaySuspended) {
      this.fullscreenOverlay = null;
      return false;
    }

    session.overlaySuspended = false;
    this.fullscreenOverlay = null;
    if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
    if (session.onKeypress) process.stdin.on("keypress", session.onKeypress);
    if (session.bracketedPaste && session.bracketedPasteSuspended) {
      session.bracketedPasteSuspended = false;
      this.enableBracketedPaste();
    }
    if (session.pinned && session.resizeHandler) {
      process.on("SIGWINCH", session.resizeHandler);
    }

    // The picker replaced every physical row and reset the scroll region.
    // Rebuild transcript + latest Plan/queue + the untouched composer in one
    // synchronized frame, then put the cursor back at its original offset.
    this.lastRawInputLayout = null;
    this.lastRawScrollBottom = null;
    this.lastTranscriptFrame = null;
    this.renderRawInput({ forceOutput: true, clearScreen: true, clear: true });
    this.syncComposerAnimation();
    if (
      this.pendingPermission &&
      this.autoShownPermissionId !== this.pendingPermission.permissionId
    ) {
      queueMicrotask(() => {
        if (this.rawInput === session && !this.fullscreenOverlay) {
          this.maybeOpenPermissionPanel();
        }
      });
    } else if (
      this.currentChat?.restoreFailure &&
      this.autoShownRestoreFailureKey !== this.restoreFailureKey()
    ) {
      queueMicrotask(() => {
        if (this.rawInput === session && !this.fullscreenOverlay) {
          this.maybeOpenRestoreRecoveryPanel();
        }
      });
    }
    return true;
  }

  async openMenuOverlayFromComposer(session) {
    if (!this.suspendComposerForOverlay(session)) return false;
    try {
      await this.showMenuOverlay({ suspendedComposer: session });
    } catch (error) {
      this.notify(`acp-hub: menu failed: ${error.message || String(error)}`);
    } finally {
      this.resumeComposerFromOverlay(session);
    }
    return true;
  }

  // Ctrl+G (and prefix+, / the panel "Rename chat" action, which route here)
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

  async showMenuOverlay(options = {}) {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const suspendedComposer = options.suspendedComposer || null;
    if (!suspendedComposer) {
      // /menu and cold transitions have already resolved their input. Keep the
      // overlay as the scene owner until the next composer mounts, otherwise a
      // daemon event can briefly repaint the old pending composer underneath.
      this.fullscreenOverlay = { kind: "menu", session: null };
    }

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
    if (!suspendedComposer) {
      // The next rawQuestion performs the single complete restoration. When a
      // different tmux window was selected, that repaint happens only after the
      // synchronous switch and is therefore confined to the background pane.
      this.restoreFullscreenOnNextComposer = true;
    }
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

  // Inline picker: /model, /effort, /modes, /access, /hub (and every quickSelect
  // while the composer is live, permissions included) render in the shared
  // upper panel above the input card. The composer stays visible but is NOT focused:
  // the picker captures every key until a choice is made or it's dismissed.
  inlinePickerSpecFor(line) {
    const mutation = String(line || "").trim().match(
      /^\/hub\s+(update|rollback)(?:\s+([^\s]+))?$/i,
    );
    if (mutation) {
      const action = mutation[1].toLowerCase();
      const provider = String(
        mutation[2] || this.currentChat?.provider || "",
      ).toLowerCase();
      const valid = action === "update"
        ? provider === "all" || Boolean(this.config.agents?.[provider])
        : Boolean(this.config.agents?.[provider]);
      if (!valid) return null;
      const verb = action === "rollback" ? "roll back" : "update";
      return {
        title: `Confirm ${verb} · ${provider}`,
        items: [
          {
            label: `Cancel${c("dim", " · leave adapter versions unchanged")}`,
            searchText: "cancel leave unchanged",
            current: true,
            value: "cancel",
          },
          {
            label: `${action === "rollback" ? "Stage rollback" : "Prepare and verify"}${c("dim", ` · ${provider}`)}`,
            searchText: `${action} ${provider} confirm prepare verify`,
            value: "confirm",
          },
        ],
        apply: async (value) => {
          if (value !== "confirm") {
            this.notify(`${verb} cancelled`);
            return false;
          }
          await this.handleHubVersionCommand(`${action} ${provider}`, {
            confirmed: true,
            pickerFlow: true,
          });
          return true;
        },
      };
    }

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
      case "/hub":
        return this.hubActionPickerSpec();
      default:
        return null;
    }
  }

  // The composer can host an inline picker only while its enhanced pinned
  // upper panel is available.
  canHostInlinePicker(session = this.rawInput) {
    return Boolean(
      session &&
        !session.done &&
        this.shouldUseEnhancedComposer() &&
        session.pinned !== false &&
        process.stdout.isTTY,
    );
  }

  // Open the list and resolve with the chosen value (null = dismissed).
  openInlinePicker({ title, hint = "", items, index = 0, purpose = "quickselect", requestId = "" }) {
    if (this.inlinePicker || !this.canHostInlinePicker()) return Promise.resolve(undefined);
    this.closeComposerFooterExpansion({ render: false });

    return new Promise((resolve) => {
      this.inlinePicker = {
        title,
        hint: hint || `1-${Math.min(items.length, 9)} pick · j/k move · Enter/l · Esc/h`,
        items,
        index: Math.max(0, index),
        purpose,
        requestId,
        resolve,
      };
      this.renderRawInput();
    });
  }

  closeInlinePicker(value = null, options = {}) {
    const picker = this.inlinePicker;
    this.inlinePicker = null;
    if (options.render !== false && this.rawInput) this.renderRawInput();
    picker?.resolve?.(value);
  }

  maybeOpenInlinePicker(session) {
    if (this.inlinePicker) return false;
    if (!this.canHostInlinePicker(session)) return false;
    if (!this.currentChat?.id) return false;

    const submitted = session.line.trim();
    if (submitted === "/mcp") {
      session.line = "";
      session.cursor = 0;
      this.saveRawDraft(session);
      void this.showMcpAdminPicker().catch((error) =>
        this.notify(`MCP: ${error.message || String(error)}`),
      );
      return true;
    }

    const spec = this.inlinePickerSpecFor(submitted);
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
      .catch((error) => this.logProse(c("red", error.message || String(error))));
    return true;
  }

  handleInlinePickerKey(session, input, key) {
    const picker = this.inlinePicker;
    if (!picker) return false;

    const choose = (value) => {
      // Keep the visible permission shelf in place while the daemon validates
      // the selected authority. Its decision event (or the RPC result fallback)
      // then replaces it directly with Plan/queue in one composed frame.
      this.closeInlinePicker(value, {
        render: picker.purpose !== "permission" || value === null,
      });
    };

    const move = (delta) => {
      picker.index = (picker.index + delta + picker.items.length) % picker.items.length;
      this.repaintComposerUpperPanel(session);
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
      this.repaintComposerUpperPanel(session);
      return true;
    }
    if (input === "G") {
      picker.index = picker.items.length - 1;
      this.repaintComposerUpperPanel(session);
      return true;
    }
    if (key.name === "return" || key.name === "enter" || input === "l") {
      choose(picker.items[picker.index]?.value ?? null);
      return true;
    }
    if (input && /^[1-9]$/.test(input)) {
      const n = Number(input) - 1;
      if (n < picker.items.length) choose(picker.items[n].value);
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

  restoreFailureKey(chat = this.currentChat) {
    const failure = chat?.restoreFailure;
    if (!failure) return "";
    return [chat.id, failure.kind, failure.sessionId, failure.attemptedAt].join(":");
  }

  maybeOpenRestoreRecoveryPanel(options = {}) {
    const session = this.rawInput;
    const key = this.restoreFailureKey();
    if (!session || session.done || !session.draftKey || !key) return false;
    if (this.activePicker || this.fullscreenOverlay || this.pendingPermission) return false;
    if (!this.pickerSupported() || !this.canHostInlinePicker(session)) return false;

    if (
      this.inlinePicker?.purpose === "restore-recovery" &&
      this.inlinePicker.requestId === key
    ) return true;
    if (!options.force && this.autoShownRestoreFailureKey === key) return false;

    if (this.inlinePicker) this.closeInlinePicker(null, { render: false });
    if (options.force) this.autoShownRestoreFailureKey = null;
    void this.maybeAutoOpenRestoreRecovery();
    return true;
  }

  async maybeAutoOpenRestoreRecovery() {
    const key = this.restoreFailureKey();
    if (!key || this.autoShownRestoreFailureKey === key) return false;
    if (!this.pickerSupported() || !this.canHostInlinePicker()) return false;
    this.autoShownRestoreFailureKey = key;
    return this.showRestoreRecoveryPicker(key);
  }

  async showRestoreRecoveryPicker(requestId = this.restoreFailureKey()) {
    if (!requestId || !this.currentChat?.restoreFailure) return false;
    const failure = this.currentChat.restoreFailure;
    const items = [
      {
        label: `Retry restore${c("dim", " · same ACP session")}`,
        searchText: "retry restore same session",
        current: true,
        value: "retry",
      },
      {
        label: `Start fresh${c("dim", " · preserve local transcript")}`,
        searchText: "start fresh preserve transcript",
        value: "fresh",
      },
      {
        label: `Chats${c("dim", " · choose another conversation")}`,
        searchText: "chats menu conversations",
        value: "chats",
      },
    ];
    const picked = await this.quickSelect({
      title: `Restore failed · ${cleanInline(failure.message || "ACP session unavailable")}`,
      hint: "1-3 pick · ↑↓/jk move · Enter/l · Esc/h keeps chat",
      items,
      purpose: "restore-recovery",
      requestId,
    });
    if (picked === null || !this.currentChat?.restoreFailure) return true;

    if (picked === "chats") {
      queueMicrotask(() => {
        if (this.rawInput && !this.rawInput.done) {
          this.triggerMenuFromComposer(this.rawInput, { allowScrolled: true });
        }
      });
      return true;
    }

    const chatId = this.currentChat.id;
    try {
      const result = await this.hub.call(
        picked === "fresh" ? "recover_chat_fresh" : "retry_restore",
        { chatId },
      );
      this.applyRestoreRecoveryResult(result);
      if (result?.chat?.restoreFailure) {
        // Keep the failure visible but do not immediately trap the user in the
        // same picker again. Empty Enter explicitly reopens it.
        this.autoShownRestoreFailureKey = this.restoreFailureKey(result.chat);
        this.notify(`restore failed: ${result.chat.restoreFailure.message}`);
      }
    } catch (error) {
      this.autoShownRestoreFailureKey = this.restoreFailureKey();
      this.notify(`recovery failed: ${error.message || String(error)}`);
      if (this.rawInput) this.renderRawInput();
    }
    return true;
  }

  applyRestoreRecoveryResult(result) {
    if (!result?.chat) return false;
    const session = this.rawInput;
    this.applyHistoryRetentionLimit(result.historyLimit);
    this.currentChat = result.chat;
    if (!this.currentChat.restoreFailure) this.autoShownRestoreFailureKey = null;
    this.pendingPermission = result.pendingPermission || null;
    this.renderHistory(result.history || []);
    this.flushChunkBuffer({ force: true });
    this.syncTmuxWindow(this.currentChat, { force: true });

    // A fresh session receives a new canonical chat id. Keep the same draft,
    // cursor and composer object, but persist future edits under that new id.
    if (session?.draftKey) {
      session.draftKey = this.currentDraftKey();
      this.saveRawDraft(session);
    }
    this.lastTranscriptFrame = null;
    if (session && !session.done) {
      this.renderRawInput({ forceOutput: true });
      this.syncComposerAnimation();
    }
    return true;
  }

  // Interactive picker over the pending permission's options. ACP carries flat
  // options ({optionId, name, kind}) — no per-option previews or free-text
  // notes exist at the protocol level. Permission is the highest-priority
  // owner of the shared upper panel: it replaces a transient menu in place,
  // but never finishes or recreates the draft-backed composer.
  maybeOpenPermissionPanel(options = {}) {
    const session = this.rawInput;
    const pending = this.pendingPermission;
    if (!session || session.done || !session.draftKey) return false;
    if (this.activePicker || this.fullscreenOverlay || !pending) return false;
    if (!this.pickerSupported() || !this.canHostInlinePicker(session)) return false;
    this.closeComposerFooterExpansion({ render: false });

    if (
      this.inlinePicker?.purpose === "permission" &&
      this.inlinePicker.requestId === pending.permissionId
    ) return true;
    if (!options.force && this.autoShownPermissionId === pending.permissionId) return false;

    // A permission blocks the agent and therefore outranks model/effort/menu.
    // Resolve the covered picker without painting the Plan/queue in between;
    // the permission picker replaces it in the next synchronized frame.
    if (this.inlinePicker) this.closeInlinePicker(null, { render: false });
    if (options.force) this.autoShownPermissionId = null;
    void this.maybeAutoOpenPermission();
    return true;
  }

  // Open the pending permission once inside the live composer. After Esc keeps
  // the request pending, the id guard stops it from immediately re-trapping;
  // empty Enter explicitly reopens it.
  async maybeAutoOpenPermission() {
    const pending = this.pendingPermission;
    if (!pending) return false;
    if (this.autoShownPermissionId === pending.permissionId) return false;
    if (!this.pickerSupported() || !this.canHostInlinePicker()) return false;
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
      purpose: "permission",
      requestId: pending.permissionId,
    });

    // Esc keeps the request pending (/allow <n> still works); a response that
    // raced another client is dropped silently.
    if (picked === null) return true;
    if (this.pendingPermission !== pending) return true;

    try {
      const result = await this.hub.call("permission_response", {
        permissionId: pending.permissionId,
        optionId: picked,
      });
      if (result?.chat) this.currentChat = result.chat;
      this.clearPendingPermissionUi(pending.permissionId);
    } catch (error) {
      this.autoShownPermissionId = null;
      this.notify(`Permission response failed: ${error.message}`);
      // The selection intentionally withheld the intermediate frame. Restore
      // the still-pending request immediately so it never looks resolved.
      this.maybeOpenPermissionPanel();
    }
    return true;
  }

  clearPendingPermissionUi(permissionId = "", options = {}) {
    const pending = this.pendingPermission;
    if (!pending) return false;
    if (permissionId && pending.permissionId !== permissionId) return false;

    if (
      this.inlinePicker?.purpose === "permission" &&
      (!permissionId || this.inlinePicker.requestId === permissionId)
    ) {
      this.closeInlinePicker(null, { render: false });
    }
    this.pendingPermission = null;
    this.autoShownPermissionId = null;
    if (options.render !== false && this.rawInput) this.renderRawInput();
    return true;
  }

  modesPickerSpec() {
    const modes = chatModeEntries(this.currentChat);
    if (!modes.length) return null;

    const currentMode = chatModeValue(this.currentChat);

    const items = modes.map((mode) => {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      const description = mode.description || "";
      return {
        label: `${id}${label === id ? "" : c("dim", ` · ${label}`)}${description ? c("dim", ` · ${description}`) : ""}`,
        searchText: `${id} ${label} ${description}`,
        current: id === currentMode,
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
    const spec = this.modesPickerSpec();
    if (!spec) return null;
    const chat = this.currentChat || {};
    const state = chat.permissionState || {};
    const grant = state.pending
      ? "approval pending"
      : state.activeOnce
        ? `allow once: ${state.activeOnce.toolKind || "tool"}`
        : state.sessionGrants?.length
          ? `${state.sessionGrants.length} session grant${state.sessionGrants.length === 1 ? "" : "s"}`
          : `approvals ${chat.permissionPolicy || "prompt"}`;
    return {
      ...spec,
      title: `Mode · ${chatModeValue(chat) || "-"} · ${grant}`,
      hint: "Select a provider mode · permission grants remain separate",
      apply: (value) => this.applyAccess(value),
    };
  }

  async showAccessPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const spec = this.accessPickerSpec();
    if (!spec) return false;

    const picked = await this.quickSelect({
      title: spec.title,
      hint: spec.hint,
      items: spec.items,
    });
    if (picked !== null) await spec.apply(picked);
    return true;
  }

  async showChatsMenu() {
    if (!this.tmuxPane()) return false;

    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    const visibleChats = this.orderChatsForDisplay(chats, "projects").slice(0, 30);
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
    const subtitle = [status, chatModeValue(chat), config].filter(Boolean).join("  ");
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
      { label: "Provider mode", key: "o", command: tmuxPanelCommand(this.cwd, context, "modes", chatId) },
      { label: "Plan", key: "P", command: tmuxPanelCommand(this.cwd, context, "plan", chatId) },
      { label: "Permission status", key: "a", command: tmuxPanelCommand(this.cwd, context, "access", chatId) },
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
      { label: `mode      ${chatModeValue(chat) || "-"}`, disabled: true },
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
    const currentMode = chatModeValue(this.currentChat);
    const permissionState = this.currentChat?.permissionState || {};
    const sessionGrants = permissionState.sessionGrants || [];
    const items = [
      { label: `mode        ${currentMode || "-"}`, disabled: true },
      { label: `Hub policy  ${this.currentChat?.permissionPolicy || "prompt"}`, disabled: true },
      {
        label: `one-time    ${permissionState.activeOnce?.optionName || permissionState.activeOnce?.toolKind || "-"}`,
        disabled: true,
      },
      { label: `session     ${sessionGrants.length ? `${sessionGrants.length} remembered grant(s)` : "-"}`, disabled: true },
      { separator: true },
      { label: "Provider modes", disabled: true },
    ];

    const modes = chatModeEntries(this.currentChat);
    if (!modes.length) {
      items.push({ label: "No mode selector reported by this adapter", disabled: true });
    } else {
      for (const mode of modes.slice(0, 20)) {
        const id = mode.id || mode.modeId || mode.name || String(mode);
        const label = mode.label || mode.title || mode.name || id;
        const marker = id === currentMode ? "*" : " ";
        items.push({
          label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
          command: tmuxActionCommand(this.cwd, context, "mode", chatId, id),
        });
      }
    }

    if (sessionGrants.length) {
      items.push({ separator: true });
      items.push({ label: "Session grants (adapter-defined scope)", disabled: true });
      for (const grant of sessionGrants.slice(-8)) {
        items.push({
          label: `- ${grant.optionName || grant.optionId || "allowed"}${grant.toolKind ? ` · ${grant.toolKind}` : ""}`,
          disabled: true,
        });
      }
    }

    return this.showTmuxMenu("ACP Mode & Permissions", items);
  }

  showProviderCommandsPanel() {
    const commands = normalizeProviderCommands(this.currentChat?.availableCommands || []);
    const items = [];

    if (!commands.length) {
      return this.showTmuxMenu("Provider Commands", [
        { label: "No provider commands reported by ACP yet", disabled: true },
        { label: "Use /agent /command to send raw slash text", disabled: true },
      ]);
    }

    items.push({ label: "Select a command to insert it at the prompt", disabled: true });
    items.push({ separator: true });

    const visibleCommands = commands.slice(0, 24);
    for (const command of visibleCommands) {
      const text = command.forceInvocation;
      items.push({
        label: stripAnsi(formatProviderCommand(command)),
        command: this.tmuxInsertCommand(text),
      });
    }

    if (commands.length > visibleCommands.length) {
      items.push({ separator: true });
      items.push({
        label: `Showing ${visibleCommands.length} of ${commands.length} · use /commands for the full searchable catalog`,
        disabled: true,
      });
    }

    return this.showTmuxMenu("Provider Commands", items);
  }

  showModesPanel() {
    const context = this.tmuxContext();
    const chatId = this.currentChat?.id || "";
    const current = chatModeValue(this.currentChat);
    const entries = chatModeEntries(this.currentChat);
    const items = [{ label: `current  ${current || "-"}`, disabled: true }];

    if (!entries.length) {
      items.push({ separator: true });
      items.push({ label: "No mode config reported by this adapter yet", disabled: true });
      return this.showTmuxMenu("ACP Modes", items);
    }

    items.push({ separator: true });

    for (const mode of entries.slice(0, 30)) {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      const marker = id === current ? "*" : " ";
      items.push({
        label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
        command: tmuxActionCommand(this.cwd, context, "mode", chatId, id),
      });
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
        cancelConfirmKey: "",
        cancelConfirmUntil: 0,
        cancelConfirmTimer: null,
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
        mouseSequence: "",
        mouseSequenceAt: 0,
        mousePress: null,
        mouseTracking: false,
        mouseTrackingSuspended: false,
        mouseSelectionMode: false,
        overlaySuspended: false,
        bracketedPasteSuspended: false,
        onKeypress: null,
        autocompleteIndex: 0,
        autocompleteKey: "",
        autocompleteSuppressedKey: "",
        done: false,
        resizeHandler: null,
        resizeTimer: null,
      };

      const scheduleResizeRender = () => {
        if (
          session.done ||
          session.overlaySuspended ||
          this.fullscreenOverlay ||
          this.rawInput !== session ||
          !session.pinned
        ) return;
        if (session.resizeTimer) clearTimeout(session.resizeTimer);
        session.resizeTimer = setTimeout(() => {
          session.resizeTimer = null;
          if (
            session.done ||
            session.overlaySuspended ||
            this.fullscreenOverlay ||
            this.rawInput !== session ||
            !session.pinned
          ) return;
          this.renderRawInput();
        }, 20);
      };

      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
        session.mousePress = null;
        this.composerInteractiveRegions = [];
        this.hoveredInteractiveKey = "";
        this.composerFooterExpansion = null;
        this.composerFooterSelectionPending = null;
        if (session.mouseTracking) {
          this.disableMouseTracking();
          session.mouseTracking = false;
        }
        if (session.bracketedPaste) this.disableBracketedPaste();
        if (session.resizeTimer) {
          clearTimeout(session.resizeTimer);
          session.resizeTimer = null;
        }
        if (session.cancelConfirmTimer) {
          clearTimeout(session.cancelConfirmTimer);
          session.cancelConfirmTimer = null;
        }
        if (session.resizeHandler) {
          process.removeListener("SIGWINCH", session.resizeHandler);
          session.resizeHandler = null;
        }
        this.stopComposerAnimation();
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
        }
        if (session.pinned) {
          this.beginPinnedInputTransition(session);
        } else {
          this.clearRawInputLine();
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
        if (session.pinned) {
          const painter = new FramePainter();
          this.clearRawInputLayoutRows(
            [this.lastRawInputLayout, this.rawInputLayout(session)],
            painter,
          );
          this.disableRawInputLayout(painter);
          painter.to(0, 0).flush();
        } else {
          this.clearRawInputLine();
        }
        this.rawInput = null;
        this.pendingPinnedInput = null;
        this.pendingPinnedLayout = null;
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
      session.onKeypress = onKeypress;

      // Expose the resolver for composer actions that intentionally leave this
      // prompt (rename/exit). Permission requests no longer use it: they mount
      // in the shared upper panel while this same session stays alive.
      session.finish = finish;
      // A fresh composer session never inherits a picker left open by a
      // previous one; its promise resolves null so an awaiting caller never
      // hangs.
      if (this.inlinePicker) {
        const stale = this.inlinePicker;
        this.inlinePicker = null;
        stale.resolve?.(null);
      }
      this.rawInput = session;
      this.pendingPinnedInput = null;
      this.pendingPinnedLayout = null;
      this.questionActive = true;
      this.currentPrompt = prompt;
      readlineTerminal.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 });
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", session.onKeypress);
      if (session.bracketedPaste) this.enableBracketedPaste();
      if (session.pinned) {
        if (this.mouseScrollEnabled) {
          session.mouseTracking = true;
          this.enableMouseTracking();
        }
        session.resizeHandler = scheduleResizeRender;
        process.on("SIGWINCH", session.resizeHandler);
      }
      const restoresFullscreen = this.restoreFullscreenOnNextComposer === true;
      this.restoreFullscreenOnNextComposer = false;
      this.fullscreenOverlay = null;
      if (restoresFullscreen) {
        this.lastRawInputLayout = null;
        this.lastRawScrollBottom = null;
        this.lastTranscriptFrame = null;
      }
      this.renderRawInput(
        restoresFullscreen
          ? { forceOutput: true, clearScreen: true, clear: true }
          : {},
      );
      this.syncComposerAnimation();
      if (session.pinned) scheduleResizeRender();
      // Reopened chats can already have a pending ACP request. Wait until the
      // real composer owns the pinned geometry, then mount the permission list
      // in its shared upper panel without disturbing the restored draft/cursor.
      if (
        this.pendingPermission &&
        this.autoShownPermissionId !== this.pendingPermission.permissionId
      ) {
        queueMicrotask(() => {
          if (this.rawInput === session && !session.done) {
            this.maybeOpenPermissionPanel();
          }
        });
      } else if (
        this.currentChat?.restoreFailure &&
        this.autoShownRestoreFailureKey !== this.restoreFailureKey()
      ) {
        queueMicrotask(() => {
          if (this.rawInput === session && !session.done) {
            this.maybeOpenRestoreRecoveryPanel();
          }
        });
      }
    });
  }

  handleRawKeypress(session, input, key, finish) {
    // readline emits an SGR mouse report as several ordinary keypresses
    // (ESC[<, digits, separators, M/m). Consume the complete report before
    // autocomplete, Vim, or text insertion can mistake its bytes for input.
    if (this.consumeRawMouseKeypress(session, input, key)) return;

    if (
      keyMatchesPlanShortcut(
        key,
        this.mouseSelectionShortcut || DEFAULT_MOUSE_SELECTION_SHORTCUT,
      )
    ) {
      this.setMouseSelectionMode(session, !session.mouseSelectionMode);
      return;
    }

    if (session.mouseSelectionMode && key.name === "escape") {
      this.setMouseSelectionMode(session, false);
      return;
    }

    if (session.cancelConfirmKey) {
      const repeatsConfirmation =
        (session.cancelConfirmKey === "escape" && key.name === "escape") ||
        (session.cancelConfirmKey === "ctrl-c" && key.ctrl && key.name === "c");
      if (!repeatsConfirmation) {
        this.clearTurnCancelConfirmation(session, { render: false });
      }
    }

    // The visual upper-panel priority is also the input priority. A transient
    // quickselect/autocomplete may cover an expanded Plan without mutating its
    // state; while visible, it must receive navigation before the Plan viewer.
    const autocomplete = !this.inlinePicker ? this.activeAutocomplete(session) : null;
    const autocompleteVisible = Boolean(autocomplete);

    // Keep transcript paging global while a quickselect owns the keyboard;
    // the list itself has no paged navigation semantics.
    if (
      this.inlinePicker &&
      (key.name === "pageup" || key.name === "pagedown")
    ) {
      const page = this.transcriptPageRows(session);
      this.scrollTranscript(key.name === "pageup" ? page : -page);
      return;
    }

    if (this.inlinePicker && this.handleInlinePickerKey(session, input, key)) {
      return;
    }

    // The expanded Plan owns only its close/page shortcuts. Everything else
    // continues through the normal composer pipeline. A suggestion panel may
    // temporarily cover the Plan and keeps first claim on the same keys.
    if (
      this.planExpanded &&
      !this.inlinePicker &&
      !autocompleteVisible &&
      this.handlePlanViewerKey(session, input, key)
    ) return;

    // Transcript paging is global to the composer, including while Vim normal
    // mode or an autocomplete dropdown is active.
    if (key.name === "pageup" || key.name === "pagedown") {
      const page = this.transcriptPageRows(session);
      this.scrollTranscript(key.name === "pageup" ? page : -page);
      return;
    }

    if (this.handleRawHistorySearchKey(session, input, key)) {
      return;
    }

    // Vim's first Esc must still enter NORMAL. Suppress the current suggestion
    // key in the same transition so the panel closes instead of trapping the
    // user behind a second, non-Vim dismissal gesture.
    if (this.vimEnabled && autocomplete && key.name === "escape") {
      session.autocompleteSuppressedKey = autocomplete.key;
    }

    if (this.vimEnabled && this.handleVimKeypress(session, input, key, finish)) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      if (session.line) {
        this.clearComposerInput(session);
        this.renderRawInput();
        return;
      }
      // In Vim, Ctrl+C is the safe cancellation gesture because Esc already
      // owns mode transitions. An empty composer arms it; the same chord must
      // be pressed again before the short confirmation window expires.
      if (this.vimEnabled && this.confirmTurnCancellation(session, "ctrl-c")) {
        return;
      }
      // Outside Vim an empty Ctrl+C is deliberately inert. Ctrl+D and /exit
      // remain the explicit ways to close the popup.
      return;
    }

    if (key.ctrl && key.name === "d" && !session.line) {
      finish("/exit");
      return;
    }

    if (this.handleAutocompleteKey(session, input, key)) {
      return;
    }

    if (keyMatchesPlanShortcut(key, this.planShortcut || DEFAULT_PLAN_SHORTCUT)) {
      this.togglePlanExpanded();
      return;
    }

    if (
      keyMatchesPlanShortcut(
        key,
        this.turnDetailsShortcut || DEFAULT_TURN_DETAILS_SHORTCUT,
      )
    ) {
      this.toggleLatestTurnDetails();
      return;
    }

    if (key.name === "escape") {
      if (this.closeComposerFooterExpansion()) return;
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
      // After dismissing a permission with Esc, empty Enter reopens the same
      // inline request. Do not resolve/recreate the composer: its draft,
      // cursor, Plan and queue return in place when the picker closes.
      if (
        !session.line.trim() &&
        !this.pendingAttachments.length &&
        this.pendingPermission &&
        this.maybeOpenPermissionPanel({ force: true })
      ) return;
      // A failed restore has no live ACP peer. Preserve any draft instead of
      // resolving it into a doomed send, and reopen the explicit recovery
      // choices in the same shared upper panel.
      if (
        this.currentChat?.restoreFailure &&
        this.maybeOpenRestoreRecoveryPanel({ force: true })
      ) return;
      // A completed maintenance operation remains visible and actionable in
      // the shared shelf. Empty Enter opens its explicit actions without
      // consuming the composer or turning the next slash command into an
      // accidental confirmation response.
      if (
        !session.line.trim() &&
        !this.pendingAttachments.length &&
        this.hubOperation &&
        this.hubOperation.status !== "running"
      ) {
        this.showHubOperationActions()
          .catch((error) => this.logProse(c("red", error.message || String(error))));
        return;
      }
      // Picker commands (/model, /effort, /modes, /access, /hub with no args) open
      // inline in the upper panel above the input card, keeping the composer and
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
        this.deleteRawInputUnit(session, -1);
      } else if (!session.line && this.pendingAttachments.length) {
        this.detachLastAttachmentFromComposer(session);
      }
      this.renderRawInput();
      return;
    }

    if (key.name === "delete") {
      if (session.cursor < session.line.length) this.deleteRawInputUnit(session, 1);
      this.renderRawInput();
      return;
    }

    if (key.meta && key.name === "b") {
      session.cursor = snapAttachmentCursor(
        session.line,
        rawPreviousWord(session.line, session.cursor),
        -1,
      );
      this.renderRawInput();
      return;
    }

    if (key.meta && key.name === "f") {
      session.cursor = snapAttachmentCursor(
        session.line,
        rawNextWord(session.line, session.cursor),
        1,
      );
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

    // Ctrl+O opens the menu overlay regardless of draft or transcript scroll;
    // both are preserved and restored on return. This is the in-process target
    // of prefix+M when focused in a chat pane.
    if (key.ctrl && key.name === "o") {
      if (this.triggerMenuFromComposer(session, { allowScrolled: true })) return;
    }

    // Ctrl+G renames the current chat via a safe in-process prompt. Ctrl+T
    // stays as an alias, but isn't advertised: it's a popular tmux PREFIX
    // (this user's included), and the prefix eats the key before it ever
    // reaches the composer.
    if (key.ctrl && (key.name === "g" || key.name === "t")) {
      if (this.triggerRenameFromComposer(session, finish)) return;
    }

    if (key.name === "left") {
      // Empty input: ← backs out to the menu overlay in this same pane (the
      // agent-view "detach" gesture). With text, it just moves the cursor.
      if (!session.line && !this.pendingAttachments.length && this.triggerMenuFromComposer(session)) {
        return;
      }
      this.moveRawCursorAcrossAttachments(session, -1);
      this.renderRawInput();
      return;
    }

    if (key.name === "right") {
      this.moveRawCursorAcrossAttachments(session, 1);
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
      this.deleteRawInputRange(session, bounds.start, session.cursor, { kill: true });
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "k") {
      const bounds = this.rawCurrentLineBounds(session);
      this.deleteRawInputRange(session, session.cursor, bounds.end, { kill: true });
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "w") {
      const before = session.line.slice(0, session.cursor).replace(/\s+\S*$/, "").replace(/\S+$/, "");
      this.deleteRawInputRange(session, before.length, session.cursor, { kill: true });
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

  togglePlanExpanded(force = null) {
    if (force === false) {
      this.planExpanded = false;
      if (this.rawInput) this.renderRawInput();
      return true;
    }
    const view = this.currentPlanPresentation();
    if (!view) {
      this.notify("no active plan for this chat");
      return false;
    }
    if (view.lifecycle === "awaiting") {
      this.notify("the agent has not published a plan yet");
      return false;
    }
    const next = force === null ? !this.planExpanded : force === true;
    this.planExpanded = next;
    if (this.rawInput) this.renderRawInput();
    return true;
  }

  handlePlanViewerKey(session, input, key = {}) {
    if (!this.planExpanded) return false;
    if (keyMatchesPlanShortcut(key, this.planShortcut || DEFAULT_PLAN_SHORTCUT)) {
      this.togglePlanExpanded(false);
      return true;
    }

    if (key.name === "escape") {
      this.togglePlanExpanded(false);
      // In Vim insert/visual mode the same Esc must still reach the editor and
      // perform its canonical transition to NORMAL. Non-Vim composers consume
      // it here so closing the drawer is the only side effect.
      return !this.vimEnabled;
    }

    // Visibility is independent from focus: ordinary editing, Vim motions,
    // history, transcript paging, attachments, commands, and submission
    // continue through the composer while the complete Plan remains visible.
    return false;
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
    this.clearTurnCancelConfirmation(session, { render: false });
    this.insertRawInputText(session, "\n");
    this.renderRawInput();
    return true;
  }

  insertRawInputText(session, text, options = {}) {
    if (!options.paste) session.lastPasteSummary = "";
    session.cursor = snapAttachmentCursor(session.line, session.cursor, 1);
    session.line = `${session.line.slice(0, session.cursor)}${text}${session.line.slice(session.cursor)}`;
    session.cursor += text.length;
    session.historyIndex = this.inputHistory?.length || 0;
    this.saveRawDraft(session);
  }

  moveRawCursorAcrossAttachments(session, direction) {
    session.cursor = attachmentCursorTarget(session.line, session.cursor, direction);
    return session.cursor;
  }

  detachAttachmentTokenRanges(session, ranges) {
    const numbers = new Set((ranges || []).map((range) => range.number).filter(Number.isFinite));
    if (!numbers.size || !Array.isArray(this.pendingAttachments)) return [];
    const removed = [];
    this.pendingAttachments = this.pendingAttachments.filter((attachment) => {
      if (!numbers.has(Number(attachment?.n))) return true;
      removed.push(attachment);
      return false;
    });
    if (removed.length) {
      const last = removed.at(-1);
      session.lastPasteSummary = `removed ${last?.name || path.basename(last?.path || "") || "attachment"}`;
      this.refreshRawInputPrompt?.({ render: false });
    }
    return removed;
  }

  deleteRawInputRange(session, start, end, options = {}) {
    const range = expandRangeToAttachmentTokens(session.line, start, end);
    if (range.end <= range.start) return "";
    const removedText = session.line.slice(range.start, range.end);
    const removedTokens = attachmentTokenRanges(session.line).filter(
      (token) => token.start < range.end && token.end > range.start,
    );
    if (options.kill) this.pushKillRing(removedText);
    session.line = `${session.line.slice(0, range.start)}${session.line.slice(range.end)}`;
    session.cursor = Math.min(range.start, session.line.length);
    this.detachAttachmentTokenRanges(session, removedTokens);
    if (options.save !== false) this.saveRawDraft(session);
    return removedText;
  }

  deleteRawInputUnit(session, direction) {
    const range = attachmentDeletionRange(session.line, session.cursor, direction);
    if (!range) return false;
    this.deleteRawInputRange(session, range.start, range.end);
    return true;
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

    // Cancel-to-edit: a confirmed Esc (or explicit /cancel) right after sending
    // restores the prompt into the empty composer, so "oops, one more thing"
    // remains cancel → tweak → Enter.
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
      .then((result) => {
        for (const clientPromptId of result?.droppedPromptIds || []) {
          this.discardPromptSubmission(clientPromptId, { render: false });
        }
        if (result?.droppedPromptIds?.length) {
          this.scheduleTranscriptProjection({ immediate: true });
        }
        this.notify(
          result?.droppedQueue
            ? `cancel requested · dropped ${result.droppedQueue} queued`
            : "cancel requested",
        );
      })
      .catch((error) => this.notify(`cancel failed: ${error.message || String(error)}`));
    return true;
  }

  clearComposerInput(session) {
    if (!session?.line) return false;
    this.clearTurnCancelConfirmation(session, { render: false });
    this.deleteRawInputRange(session, 0, session.line.length, { kill: true });
    session.cursor = 0;
    session.historyIndex = this.inputHistory?.length || 0;
    session.autocompleteKey = "";
    session.autocompleteIndex = 0;
    session.autocompleteSuppressedKey = "";
    if (this.vimEnabled) {
      if (session.vimMode === "visual") session.vimMode = "normal";
      session.vimAnchor = 0;
      session.vimVisualLine = false;
      vimClearPending(session);
    }
    this.saveRawDraft(session);
    return true;
  }

  clearTurnCancelConfirmation(session = this.rawInput, options = {}) {
    if (!session) return false;
    const hadConfirmation = Boolean(session.cancelConfirmKey || session.cancelConfirmUntil);
    if (session.cancelConfirmTimer) clearTimeout(session.cancelConfirmTimer);
    session.cancelConfirmTimer = null;
    session.cancelConfirmKey = "";
    session.cancelConfirmUntil = 0;
    if (hadConfirmation && options.render !== false && this.rawInput === session) {
      this.renderRawInput();
    }
    return hadConfirmation;
  }

  turnCancelConfirmationLabel(session = this.rawInput) {
    if (!session?.cancelConfirmKey || Date.now() >= session.cancelConfirmUntil) return "";
    const key = session.cancelConfirmKey === "ctrl-c" ? "Ctrl+C" : "Esc";
    const queued = Math.max(0, Number(this.currentChat?.queued) || 0);
    return queued
      ? `Stop agent and discard ${queued} queued? Press ${key} again`
      : `Stop agent? Press ${key} again`;
  }

  confirmTurnCancellation(session, key) {
    if (!this.canCancelCurrentTurn()) {
      this.clearTurnCancelConfirmation(session, { render: false });
      return false;
    }

    const now = Date.now();
    if (session.cancelConfirmKey === key && now < session.cancelConfirmUntil) {
      this.clearTurnCancelConfirmation(session, { render: false });
      const requested = this.requestCancelCurrentTurn();
      if (requested) this.renderRawInput();
      return requested;
    }

    this.clearTurnCancelConfirmation(session, { render: false });
    session.cancelConfirmKey = key;
    session.cancelConfirmUntil = now + TURN_CANCEL_CONFIRM_MS;
    const label = this.turnCancelConfirmationLabel(session);
    this.notify(label);
    session.cancelConfirmTimer = setTimeout(() => {
      if (this.rawInput !== session || session.done) return;
      this.clearTurnCancelConfirmation(session, { render: false });
      this.renderRawInput();
    }, TURN_CANCEL_CONFIRM_MS);
    session.cancelConfirmTimer.unref?.();
    this.renderRawInput();
    return true;
  }

  pushKillRing(text) {
    if (!text) return;
    this.killRing.unshift(text);
    this.killRing = this.killRing.filter((entry, index, list) => entry && list.indexOf(entry) === index);
    if (this.killRing.length > KILL_RING_LIMIT) this.killRing.length = KILL_RING_LIMIT;
  }

  handleRawEscape(session) {
    // Esc is now exclusively a guarded turn-cancel gesture at the base
    // composer. Clearing belongs to Ctrl+C; contextual Esc (picker, search,
    // plan drawer, scroll) is consumed before reaching this method.
    this.confirmTurnCancellation(session, "escape");
  }

  // ── Vim mode ──────────────────────────────────────────────────────────
  // Opt-in modal editing for the composer (/vim). Insert mode passes keys to
  // the default handler; Esc enters normal mode, where a vim subset drives
  // motions and edits over session.line/cursor; v/V open visual selections.
  // With Vim on, Esc leaves insert/visual or clears a pending normal command.
  // A clean NORMAL mode uses the same guarded double-Esc cancellation as the
  // regular composer; empty Ctrl+C offers an equivalent guarded gesture.
  // Only the main draft-backed composer is modal.
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
        this.clearTurnCancelConfirmation(session, { render: false });
        session.vimMode = "normal";
        vimClearPending(session);
        this.refreshRawInputPrompt({ render: false });
        this.renderRawInput();
        return true;
      }
      if (session.vimMode === "normal") {
        if (vimHasPending(session)) {
          this.clearTurnCancelConfirmation(session, { render: false });
          vimClearPending(session);
          this.renderRawInput();
          return true;
        }
        if (this.closeComposerFooterExpansion()) return true;
        this.confirmTurnCancellation(session, "escape");
        return true;
      }
      this.clearTurnCancelConfirmation(session, { render: false });
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
      // Vim leaves insert on the last ordinary character, or immediately
      // before an attachment token instead of landing inside its label.
      if (session.cursor > 0 && session.line[session.cursor - 1] !== "\n") {
        session.cursor = attachmentCursorTarget(session.line, session.cursor, -1);
      }
      this.refreshRawInputPrompt({ render: false });
      this.renderRawInput();
      return true;
    }

    if (session.vimMode !== "normal" && session.vimMode !== "visual") return false;

    // Enter still submits and Tab keeps its global gestures in normal mode.
    if (key.name === "return" || key.name === "enter" || key.name === "tab") return false;

    if (key.name === "backspace" || key.name === "left") {
      vimClearPending(session);
      if (session.cursor > 0) this.moveRawCursorAcrossAttachments(session, -1);
      this.renderRawInput();
      return true;
    }
    if (key.name === "right") {
      vimClearPending(session);
      if (session.cursor < session.line.length) this.moveRawCursorAcrossAttachments(session, 1);
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
    const selection = vimSelectionRange(session);
    const range = selection
      ? expandRangeToAttachmentTokens(session.line, selection.start, selection.end)
      : null;
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
      let lastDirection = 0;
      for (let n = 0; n < count; n += 1) {
        const next = vimMotionTarget(session.line, cursor, motion, findChar);
        if (next === null || next === cursor) break;
        lastDirection = Math.sign(next - cursor);
        cursor = next;
      }
      session.cursor = snapAttachmentCursor(session.line, cursor, lastDirection);
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

    const rawRange = vimOperatorRange(session.line, session.cursor, op, motion, count, findChar);
    const range = rawRange
      ? expandRangeToAttachmentTokens(session.line, rawRange.start, rawRange.end)
      : null;
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

    const range = expandRangeToAttachmentTokens(
      session.line,
      session.cursor,
      session.cursor + count,
    );
    const removedTokens = attachmentTokenRanges(session.line).filter(
      (token) => token.start < range.end && token.end > range.start,
    );
    this.vimSaveUndo(session);
    session.line = `${session.line.slice(0, range.start)}${ch.repeat(count)}${session.line.slice(range.end)}`;
    session.cursor = range.start + count - 1;
    this.detachAttachmentTokenRanges(session, removedTokens);
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
      session.cursor = snapAttachmentCursor(session.line, session.cursor, 1);
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
    const range = expandRangeToAttachmentTokens(session.line, start, end);
    if (range.end <= range.start) return;
    const removedTokens = attachmentTokenRanges(session.line).filter(
      (token) => token.start < range.end && token.end > range.start,
    );
    this.vimSaveUndo(session);
    this.pushKillRing(session.line.slice(range.start, range.end));
    session.line = `${session.line.slice(0, range.start)}${session.line.slice(range.end)}`;
    session.cursor = Math.min(range.start, session.line.length);
    this.detachAttachmentTokenRanges(session, removedTokens);
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
    const currentEnd = current.contentEnd ?? current.end;
    const currentColumn = stringDisplayWidth(
      session.line.slice(current.start, Math.max(current.start, Math.min(cursor, currentEnd))),
    );
    session.cursor = snapAttachmentCursor(
      session.line,
      next.start + textOffsetAtDisplayColumn(next.text, currentColumn),
      0,
    );
    return true;
  }

  renderRawInput(options = {}) {
    const session = this.rawInput;
    if (!session || !process.stdout.isTTY) return;

    if (this.fullscreenOverlay && !this.activePicker) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    if (session.pinned) {
      if (this.activePicker) {
        // A full-screen picker exclusively owns the pinned viewport. Model
        // changes remain buffered and its forced backdrop restore catches up.
        this.activePicker.repaint();
        return;
      }
      const layout = this.rawInputLayout(session);
      const shouldRepaintOutput =
        options.forceOutput === true ||
        !this.lastRawInputLayout ||
        this.lastRawInputLayout.outputBottom !== layout.outputBottom ||
          this.lastRawInputLayout.columns !== layout.columns ||
          this.lastRawInputLayout.rows !== layout.rows;
      const painter = new FramePainter();
      if (options.clearScreen === true) painter.text("\x1b[2J");
      const viewportChanged = this.enableRawInputLayout(session, layout, painter);
      if (shouldRepaintOutput) {
        // The clear below includes both composer bands. When a tall draft
        // collapses, some rows from the previous band have just become
        // transcript space and may already contain the optimistic prompt.
        // Invalidate before clearing so the following repaint restores those
        // physical rows instead of trusting the still-correct logical cache.
        this.lastTranscriptFrame = null;
      }
      if (options.clear === true || !sameRawInputLayout(this.lastRawInputLayout, layout)) {
        this.clearRawInputLayoutRows([this.lastRawInputLayout, layout], painter);
      }
      if (shouldRepaintOutput || viewportChanged) {
        this.repaintPinnedOutput(layout, painter, { restoreCursor: false });
      }
      this.renderPinnedRawInput(session, layout, painter);
      painter.flush();
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
    const painter = new FramePainter();
    this.clearRawInputLayoutRows([this.lastRawInputLayout, layout], painter);
    painter.to(0, 0).flush();
  }

  clearRawInputLayoutRows(layouts, painter = null) {
    const screenRows = Math.max(1, process.stdout.rows || 24);
    const rows = new Set();
    const frame = painter || new FramePainter();

    for (const layout of layouts) {
      if (!layout) continue;
      for (const row of layout.composerRows || []) {
        if (Number.isInteger(row) && row >= 0 && row < screenRows) rows.add(row);
      }
    }

    for (const row of [...rows].sort((a, b) => a - b)) {
      frame.to(0, row).clearLine();
    }
    if (!painter) frame.flush();
  }

  repaintPinnedOutput(layout = this.pinnedSceneLayout(), painter = null, options = {}) {
    if (!process.stdout.isTTY) return;
    if (this.transcriptPaintSuppressed()) return;
    if (this.activePicker) {
      // The picker owns the output region; repaint it instead of the
      // transcript (the transcript returns when the picker closes).
      this.activePicker.repaint();
      return;
    }
    if (this.fullscreenOverlay) return;
    if (!layout) return;

    const outputRows = Math.max(0, layout.outputBottom);
    if (!outputRows) return;

    const width = Math.max(1, layout.columns - 1);
    const frame = painter || new FramePainter();
    // A transcript frame is meaningful only inside the scroll region it was
    // laid out for. The explicit pending composer owns geometry between input
    // sessions, so the region and its rows can always be committed together.
    this.syncPinnedViewportGeometry(layout, frame);
    this.paintTranscriptViewport(frame, outputRows, width);
    if (options.restoreCursor !== false) this.restoreComposerCursor(frame);
    if (!painter) frame.flush();
  }

  paintTranscriptViewport(painter, outputRows, width) {
    const window = this.collectTranscriptRowsFromEnd(width, outputRows, this.scrollOffsetRows);
    const rows = window.visualRows || window.rows.map((text) => ({ text }));
    const startRow = Math.max(0, outputRows - rows.length);
    const nextFrameRows = Array.from({ length: outputRows }, (_, row) =>
      String(rows[row - startRow]?.text ?? ""),
    );
    this.interactiveRegions = [];

    for (let row = 0; row < outputRows; row += 1) {
      const visual = rows[row - startRow];
      if (visual?.interactiveKey) {
        this.interactiveRegions.push({
          key: visual.interactiveKey,
          turnId: visual.turnId,
          activityGroupId: visual.activityGroupId,
          action: visual.action,
          x1: 0,
          x2: Math.max(0, width - 1),
          y1: row,
          y2: row,
        });
      }
    }

    const previous = this.lastTranscriptFrame;
    const modelRevision = Number(this.projectedTranscriptRevision) || 0;
    // A delayed composer/layout repaint must never roll the terminal back to
    // an older semantic projection. Normally JavaScript ordering prevents it;
    // the revision guard also covers resize/timer callbacks retained across a
    // rapid submit/cancel transition.
    if (previous && modelRevision < (Number(previous.modelRevision) || 0)) return;
    const compatible = Boolean(
      previous && previous.width === width && previous.outputRows === outputRows,
    );
    let shifted = 0;
    if (compatible && previous.rows.some((row, index) => row !== nextFrameRows[index])) {
      const maxShift = Math.min(8, outputRows - 1);
      for (let amount = 1; amount <= maxShift; amount += 1) {
        let matches = true;
        for (let row = 0; row < outputRows - amount; row += 1) {
          if (previous.rows[row + amount] !== nextFrameRows[row]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          shifted = amount;
          break;
        }
      }
    }

    if (shifted > 0) {
      painter.to(0, outputRows - 1);
      for (let row = outputRows - shifted; row < outputRows; row += 1) {
        painter.text("\r\n").clearLine();
        if (nextFrameRows[row]) painter.text(nextFrameRows[row]).text(colors.reset || "");
      }
    } else {
      for (let row = 0; row < outputRows; row += 1) {
        if (compatible && previous.rows[row] === nextFrameRows[row]) continue;
        painter.to(0, row).clearLine();
        if (nextFrameRows[row]) painter.text(nextFrameRows[row]).text(colors.reset || "");
      }
    }

    this.lastTranscriptFrame = {
      width,
      outputRows,
      rows: nextFrameRows,
      modelRevision,
    };
  }

  transcriptPaddingCells(viewportWidth = this.transcriptWrapWidth()) {
    const configured = Number.isFinite(Number(this.transcriptPadding))
      ? Math.max(0, Math.min(4, Number(this.transcriptPadding)))
      : 0;
    return Math.min(configured, Math.max(0, Math.floor((Math.max(1, viewportWidth) - 1) / 2)));
  }

  promptPaddingCells(viewportWidth = this.transcriptWrapWidth()) {
    const configured = Number.isFinite(Number(this.promptPadding))
      ? Math.max(0, Math.min(4, Number(this.promptPadding)))
      : DEFAULT_PROMPT_PADDING;
    return Math.min(configured, Math.max(0, Math.floor((Math.max(1, viewportWidth) - 1) / 2)));
  }

  transcriptContentWidth(viewportWidth = this.transcriptWrapWidth()) {
    const width = Math.max(1, viewportWidth || 1);
    return Math.max(1, width - this.transcriptPaddingCells(width) * 2);
  }

  // One low-level surface primitive powers both static submitted prompts and
  // the live editable card. Each caller owns its own semantic content and
  // spacing policy, so the composer can evolve without changing history.
  fullBleedSurfaceLine(
    value,
    viewportWidth,
    {
      background = "",
      foreground = "",
      leftRail = "",
      leftRailForeground = "",
      leftPadding = 0,
      railGap = 0,
      rightPadding = 0,
    } = {},
  ) {
    const width = Math.max(1, viewportWidth || 1);
    const style = `${background}${foreground}`;
    const reset = colors.reset || "";
    const prefix = leftRail
      // The rail is an accent edge, not part of the shaded surface. Reset
      // first so only this glyph uses the terminal/default background, then
      // restore the card style for its inner gap and content.
      ? `${reset}${leftRailForeground}${colors.bold || ""}${leftRail}${reset}${style}${" ".repeat(Math.max(0, railGap))}`
      : " ".repeat(Math.max(0, leftPadding));
    const suffix = " ".repeat(Math.max(0, rightPadding));
    const contentWidth = Math.max(
      0,
      width - stringDisplayWidth(prefix) - stringDisplayWidth(suffix),
    );
    const fitted = fitAnsiLine(String(value ?? ""), contentWidth);
    const styledText = reset && style ? fitted.split(reset).join(`${reset}${style}`) : fitted;
    return `${leftRail ? "" : style}${prefix}${styledText}${suffix}${reset}`;
  }

  decorateTranscriptVisualRow(row, viewportWidth, padding) {
    const visual = row && typeof row === "object" ? { ...row } : { text: String(row ?? "") };
    const text = String(visual.text ?? "");
    if (!visual.fullBleed && !stripAnsi(text)) return { ...visual, text: "" };

    const inset = " ".repeat(Math.max(0, padding));
    if (!visual.fullBleed) return { ...visual, text: `${inset}${text}` };
    const leftRail = String(visual.leftRail || "");
    return {
      ...visual,
      text: this.fullBleedSurfaceLine(text, viewportWidth, {
        background: visual.background || "",
        foreground: visual.foreground || "",
        leftRail,
        leftRailForeground: visual.leftRailForeground || colors.cyan || "",
        leftPadding: leftRail ? 0 : padding,
        railGap: leftRail ? Math.max(1, padding) : 0,
        rightPadding: padding,
      }),
    };
  }

  transcriptEntryRows(entry, width, options = {}) {
    return this.transcriptEntryVisualRows(entry, width, options).map((row) => row.text);
  }

  transcriptEntryVisualRows(entry, width, options = {}) {
    const viewportWidth = Math.max(1, width || 1);
    const padding = options.inset === false
      ? 0
      : isUserTranscriptEntry(entry)
        ? this.promptPaddingCells(viewportWidth)
        : this.transcriptPaddingCells(viewportWidth);
    const edgeRailReserve = isUserTranscriptEntry(entry)
      ? 1 + Math.max(1, padding) - padding
      : 0;
    const contentWidth = Math.max(1, viewportWidth - padding * 2 - edgeRailReserve);
    const rows = this.transcriptEntryRawVisualRows(entry, contentWidth);
    return rows.map((row) =>
      padding || row?.fullBleed
        ? this.decorateTranscriptVisualRow(row, viewportWidth, padding)
        : row,
    );
  }

  transcriptEntryRawVisualRows(entry, width) {
    if (entry?.kind === "turn-card") return this.layoutTurnCardRows(entry, width);
    let rows;
    if (entry?.kind === "chat-header") {
      rows = this.chatHeaderLines().flatMap((line) => wrapAnsiLine(line, width));
    } else if (isUserTranscriptEntry(entry)) {
      const background = colors.userBg || colors.codeBg || "";
      const leftRailForeground = this.themeAccentSeq(entry.provider) || colors.cyan || "";
      const body = this.layoutUserTurnRows(entry.text, width, entry.provider).map((text) => ({
          text,
          fullBleed: true,
          background,
          leftRail: "┃",
          leftRailForeground,
        }));
      const spacer = () => ({
        text: "",
        fullBleed: true,
        background,
        leftRail: "┃",
        leftRailForeground,
      });
      return body.length ? [spacer(), ...body, spacer()] : [];
    } else if (entry?.kind === "activity-group") {
      return this.layoutActivityGroupRows(entry, width);
    } else if (entry?.kind === "prose") {
      rows = this.layoutProseTranscriptRows(entry, width);
    } else if (entry?.kind === "code") {
      return this.layoutCodeTranscriptRows(entry, width).map((text) => ({
        text,
        fullBleed: true,
        background: colors.codeBg || "",
        foreground: entry.dim ? colors.dim || "" : "",
      }));
    } else if (entry?.kind === "code-block") {
      rows = this.layoutCompactCodeBlockRows(entry, width);
    } else if (entry?.kind === "table") {
      rows = this.renderLiveTableLines(entry.sourceLines || [], width);
      if (entry.dim) rows = rows.map((row) => c("dim", row));
    } else if (entry?.kind === "rule") {
      rows = [c("dim", horizontalRuleLine(width))];
    } else if (entry?.kind === "hard") {
      rows = wrapAnsiLine(String(entry.text ?? ""), width);
    } else {
      rows = wrapAnsiLine(String(entry ?? ""), width);
    }
    return rows.map((text) => ({ text }));
  }

  turnCardCanExpand(entry) {
    return Boolean(entry?.detailEntries?.some((item) => !this.transcriptEntryIsBlank(item)));
  }

  turnCardDefaultExpanded(entry) {
    if (!this.turnCardCanExpand(entry)) return false;
    if (this.turnDetailsMode === "expanded") return true;
    return this.turnDetailsMode === "auto" && entry.turn?.status === "active";
  }

  turnCardExpanded(entry) {
    if (!this.turnCardCanExpand(entry)) return false;
    const id = entry.turn?.id;
    if (this.turnDetailOverrides?.has(id)) return this.turnDetailOverrides.get(id) === true;
    return this.turnCardDefaultExpanded(entry);
  }

  normalizeTurnDetailOverrides() {
    if (!this.turnDetailOverrides?.size) return;
    const cards = new Map(
      this.transcriptEntries
        .filter((entry) => entry?.kind === "turn-card" && entry.turn?.id)
        .map((entry) => [entry.turn.id, entry]),
    );
    for (const [turnId, override] of this.turnDetailOverrides) {
      const entry = cards.get(turnId);
      if (!entry || override === this.turnCardDefaultExpanded(entry)) {
        this.turnDetailOverrides.delete(turnId);
      }
    }
  }

  pruneTurnCardProjectionCache() {
    if (!this.turnCardProjectionCache?.size) return 0;
    const retainedTurnIds = new Set(
      this.transcriptEntries
        .filter((entry) => entry?.kind === "turn-card" && entry.turn?.id)
        .map((entry) => entry.turn.id),
    );
    let removed = 0;
    for (const [key, entry] of this.turnCardProjectionCache) {
      if (retainedTurnIds.has(entry?.turn?.id)) continue;
      this.turnCardProjectionCache.delete(key);
      removed += 1;
    }
    return removed;
  }

  activityGroupCanExpand(group) {
    return Boolean(
      group?.actions?.some(
        (action) => String(action?.summary || "").trim() || action?.diffs?.length,
      ),
    );
  }

  activityGroupOverrideKey(turnId, groupId) {
    return `${turnId || "standalone"}:${groupId || "activity"}`;
  }

  activityGroupDefaultExpanded(turn, group) {
    return turn?.status === "active" && this.activityGroupCanExpand(group);
  }

  activityGroupExpanded(turn, group) {
    if (!this.activityGroupCanExpand(group)) return false;
    if (!(this.activityGroupOverrides instanceof Map)) this.activityGroupOverrides = new Map();
    const key = this.activityGroupOverrideKey(turn?.id, group?.id);
    if (this.activityGroupOverrides.has(key)) return this.activityGroupOverrides.get(key) === true;
    return this.activityGroupDefaultExpanded(turn, group);
  }

  activityGroupTone(status) {
    if (status === "error") return "red";
    if (status === "active") return "yellow";
    if (status === "cancelled") return "dim";
    return "green";
  }

  activityGroupMetadata(group) {
    const files = group?.changedFiles?.length || 0;
    const actions = group?.actionCount || group?.actions?.length || 0;
    if (files && actions > 1) {
      return `${actions} actions · ${files} file${files === 1 ? "" : "s"}`;
    }
    if (files) return `${files} file${files === 1 ? "" : "s"}`;
    return actions > 1 ? String(actions) : "";
  }

  activityIconForGroup(name) {
    const key =
      name === "Ran"
        ? "ran"
        : name === "Explored"
          ? "explored"
          : name === "Edited"
            ? "edited"
            : "tools";
    return normalizeActivityIcon(this.activityIcons?.[key]);
  }

  activityIconSlotWidth() {
    return Math.max(
      1,
      ...["Ran", "Explored", "Edited", "Used Tools"].map((name) =>
        stringDisplayWidth(this.activityIconForGroup(name)),
      ),
    );
  }

  activityLabelColumn() {
    // `├─`, one separating space, the shared icon slot, then one more space.
    return 4 + this.activityIconSlotWidth();
  }

  layoutActivityDiffRows(diff, width, prefix) {
    const safeWidth = Math.max(1, width || 1);
    const contentWidth = Math.max(1, safeWidth - stringDisplayWidth(prefix));
    const language = codeLanguageForPath(diff?.path);
    const added = c("greenStrong", `+${Number(diff?.added) || 0}`);
    const removed = c("red", `-${Number(diff?.removed) || 0}`);
    const header = `${c("bold", cleanInline(diff?.path || "file"))} ${c("dim", "(")}${added} ${removed}${c("dim", ")")}`;
    const rows = wrapAnsiLine(header, contentWidth).map((row) => `${prefix}${row}`);

    for (const [hunkIndex, hunk] of (diff?.hunks || []).entries()) {
      if (hunkIndex > 0) rows.push(`${prefix}${c("dim", "⋮")}`);
      for (const row of hunk?.rows || []) {
        const code = highlightCode(String(row.text || ""), language);
        const line =
          row.sign === "+"
            ? `${c("greenStrong", "+")} ${code}`
            : row.sign === "-"
              ? `${c("red", "-")} ${code}`
              : c("dim", `  ${code}`);
        for (const wrapped of wrapAnsiLine(line, contentWidth)) rows.push(`${prefix}${wrapped}`);
      }
    }
    if (diff?.truncated) rows.push(`${prefix}${c("dim", "… diff truncated")}`);
    return rows;
  }

  layoutActivityGroupRows(entry, width, options = {}) {
    const safeWidth = Math.max(1, width || 1);
    const group = entry?.group || {};
    const turn = options.turn || null;
    const terminal = options.terminal === true;
    const canExpand = this.activityGroupCanExpand(group);
    const expanded = this.activityGroupExpanded(turn, group);
    const interactiveKey = canExpand
      ? `activity:${this.activityGroupOverrideKey(turn?.id, group.id)}:toggle`
      : "";
    const hovered = Boolean(interactiveKey && this.hoveredInteractiveKey === interactiveKey);
    const branch = c("faint", terminal ? "└─" : "├─");
    const marker = padAnsiToWidth(
      c(
        this.activityGroupTone(group.status) === "green"
          ? "greenStrong"
          : this.activityGroupTone(group.status),
        this.activityIconForGroup(group.name),
      ),
      this.activityIconSlotWidth(),
    );
    const metadata = this.activityGroupMetadata(group);
    const metadataSuffix = metadata ? ` ${c("dim", `· ${metadata}`)}` : "";
    const disclosureSuffix = canExpand ? `  ${c("dim", expanded ? "▾" : "▸")}` : "";
    const styledHeader = `${branch} ${marker} ${c("bold", cleanInline(group.name || "Used Tools"))}${metadataSuffix}${disclosureSuffix}`;
    const rows = [
      {
        text: hovered
          ? truncateText(stripAnsi(styledHeader), safeWidth)
          : truncateAnsiText(styledHeader, safeWidth),
        fullBleed: hovered,
        background: hovered ? colors.hoverBg || "" : "",
        foreground: hovered ? colors.hoverFg || "" : "",
        interactiveKey,
        turnId: turn?.id || "",
        activityGroupId: group.id || "",
        action: canExpand ? "toggle-activity-group" : "",
      },
    ];

    const labelColumn = this.activityLabelColumn();
    const actionPrefix = this.activityTreePrefix(safeWidth, labelColumn, !terminal);
    const detailPrefix = this.activityTreePrefix(safeWidth, labelColumn + 2, !terminal);
    const actionWidth = Math.max(1, safeWidth - stringDisplayWidth(actionPrefix));
    const detailWidth = Math.max(1, safeWidth - stringDisplayWidth(detailPrefix));

    for (const action of group.actions || []) {
      const title = cleanInline(action?.title || action?.toolCallId || "tool");
      const tone = this.activityGroupTone(action?.status);
      const styledTitle = action?.status === "completed" ? title : c(tone, title);
      for (const line of layoutAnsiText(styledTitle, actionWidth, { mode: "word" })) {
        rows.push({ text: `${actionPrefix}${line}` });
      }

      if (!expanded) continue;
      if (action?.diffs?.length) {
        for (const diff of action.diffs) {
          rows.push(
            ...this.layoutActivityDiffRows(diff, safeWidth, detailPrefix).map((text) => ({ text })),
          );
        }
        continue;
      }
      for (const summary of cleanActivitySummary(action?.summary || "", group.name)) {
        for (const line of layoutAnsiText(c("dim", summary), detailWidth, { mode: "word" })) {
          rows.push({ text: `${detailPrefix}${line}` });
        }
      }
    }
    return rows;
  }

  normalizeActivityGroupOverrides() {
    if (!(this.activityGroupOverrides instanceof Map) || !this.activityGroupOverrides.size) return;
    const retained = new Map();
    for (const card of this.transcriptEntries) {
      if (card?.kind !== "turn-card" || !card.turn?.id) continue;
      for (const child of card.detailEntries || []) {
        if (child?.kind !== "activity-group" || !child.group?.id) continue;
        retained.set(this.activityGroupOverrideKey(card.turn.id, child.group.id), {
          turn: card.turn,
          group: child.group,
        });
      }
    }
    for (const [key, override] of this.activityGroupOverrides) {
      const current = retained.get(key);
      if (!current || override === this.activityGroupDefaultExpanded(current.turn, current.group)) {
        this.activityGroupOverrides.delete(key);
      }
    }
  }

  activityRailSpacerRow() {
    return { text: c("faint", "│"), activitySpacer: true };
  }

  activityTreePrefix(width, targetColumns, rail = true) {
    const safeWidth = Math.max(1, width || 1);
    // Keep one display cell for content. At ordinary widths targetColumns is
    // the exact column where text begins; tiny terminals shed indentation
    // before they are allowed to overflow their visual row.
    const columns = Math.min(
      Math.max(0, Number(targetColumns) || 0),
      Math.max(0, safeWidth - 1),
    );
    if (!columns) return "";
    if (!rail) return " ".repeat(columns);
    return `${c("faint", "│")}${" ".repeat(Math.max(0, columns - 1))}`;
  }

  activityRowIsSpacer(row) {
    return stripAnsi(row?.text || "").trim() === "│";
  }

  layoutTurnDetailBlocks(entries, width, turn) {
    const safeWidth = Math.max(1, width || 1);
    const blocks = [];
    let contentEntries = [];

    const normalizeBoundaryRows = (rows) => {
      let start = 0;
      let end = rows.length;
      while (start < end && this.activityRowIsSpacer(rows[start])) start += 1;
      while (end > start && this.activityRowIsSpacer(rows[end - 1])) end -= 1;
      return rows.slice(start, end);
    };

    const flushContent = () => {
      if (!contentEntries.length) return;
      // Free semantic blocks align with the action label/content column. Any
      // list, plan, or Markdown nesting is then added by the child renderer.
      const contentPrefix = this.activityTreePrefix(
        safeWidth,
        this.activityLabelColumn(),
        true,
      );
      const contentWidth = Math.max(1, safeWidth - stringDisplayWidth(contentPrefix));
      const contentRows = contentEntries.flatMap((child) =>
        this.transcriptEntryRows(child, contentWidth, { inset: false }).map((text) => ({
          text: text ? `${contentPrefix}${text}` : c("faint", "│"),
        })),
      );
      const normalized = normalizeBoundaryRows(contentRows);
      if (normalized.length) blocks.push({ kind: "content", rows: normalized });
      contentEntries = [];
    };

    for (const child of entries || []) {
      if (child?.kind === "activity-group") {
        flushContent();
        blocks.push({ kind: "activity-group", entry: child });
      } else {
        contentEntries.push(child);
      }
    }
    flushContent();

    return blocks.flatMap((block, index) => {
      if (block.kind !== "activity-group") return [block];
      const terminal = index === blocks.length - 1;
      const rows = normalizeBoundaryRows(
        this.layoutActivityGroupRows(block.entry, safeWidth, { turn, terminal }),
      );
      return rows.length ? [{ ...block, terminal, rows }] : [];
    });
  }

  turnCardDuration(turn) {
    const hasExplicitDuration = turn?.durationMs !== null && turn?.durationMs !== undefined;
    if (hasExplicitDuration && Number.isFinite(Number(turn.durationMs))) {
      return Math.max(0, Number(turn.durationMs));
    }
    const started = Date.parse(turn?.startedAt || "");
    if (!Number.isFinite(started)) return 0;
    const completed = Date.parse(turn?.completedAt || "");
    return Math.max(0, (Number.isFinite(completed) ? completed : Date.now()) - started);
  }

  layoutTurnCardRows(entry, width) {
    const safeWidth = Math.max(1, width || 1);
    const turn = entry.turn || {};
    const finalRows = (entry.finalEntries || []).flatMap((child) =>
      this.transcriptEntryRawVisualRows(child, safeWidth),
    );
    const finalOnlyRows = () => (finalRows.length ? [{ text: "" }, ...finalRows] : []);
    const explicitOverride = this.turnDetailOverrides?.has(turn.id);
    const strictlyHidden = this.turnDetailsMode === "hidden" && !explicitOverride;
    if (strictlyHidden) return finalOnlyRows();
    const canExpand = this.turnCardCanExpand(entry);
    const actionCount = Number(turn.actionCount) || 0;
    const changedFileCount = turn.changedFiles?.length || 0;
    const commandName = turn.requestEvent?.name || turn.userEvent?.name || "command";
    const commandPresentation = turn.requestEvent?.presentation || turn.userEvent?.presentation;
    const semanticCommand = turn.requestKind === "command" && commandPresentation !== "work";
    const exceptionalOutcome = ["cancelled", "error", "partial"].includes(turn.status);
    const unavailableDetails = !canExpand && Boolean(actionCount || changedFileCount);
    const shouldShowHeader =
      canExpand || semanticCommand || exceptionalOutcome || unavailableDetails;
    if (!shouldShowHeader) return finalOnlyRows();
    const expanded = this.turnCardExpanded(entry);
    const interactiveKey = canExpand ? `turn:${turn.id}:toggle` : "";
    const hovered = Boolean(interactiveKey && this.hoveredInteractiveKey === interactiveKey);
    const statusLabels = {
      completed: "Worked for",
      cancelled: "Cancelled after",
      error: "Failed after",
      partial: "Stopped after",
    };
    const metrics = [
      actionCount
        ? turn.status === "active"
          ? `${actionCount} action${actionCount === 1 ? "" : "s"}`
          : `${actionCount} tool call${actionCount === 1 ? "" : "s"}`
        : "",
      changedFileCount
        ? `${changedFileCount} file${changedFileCount === 1 ? "" : "s"}`
        : "",
      unavailableDetails
        ? turn.status === "active"
          ? "details pending"
          : "details unavailable"
        : "",
    ].filter(Boolean);
    const marker = canExpand ? (expanded ? "▾" : "▸") : "•";
    const commandAction = commandName === "compact" ? "Compacting" : `Running /${commandName}`;
    const plainHeader = semanticCommand
      ? turn.status === "active"
        ? `${marker} ${commandAction}…`
        : `${marker} /${commandName} · ${formatTurnDuration(this.turnCardDuration(turn))}`
      : turn.status === "active"
        ? `${marker} In progress${metrics.length ? ` · ${metrics.join(" · ")}` : ""}`
        : `${marker} ${statusLabels[turn.status] || "Worked for"} ${formatTurnDuration(this.turnCardDuration(turn))}${metrics.length ? ` · ${metrics.join(" · ")}` : ""}`;
    const tone = turn.status === "error" ? "red" : turn.status === "active" ? "yellow" : "muted";
    const headerText = hovered
      ? truncateText(plainHeader, safeWidth)
      : fitAnsiLine(c(tone, plainHeader), safeWidth);
    const rows = [
      {
        text: headerText,
        fullBleed: hovered,
        background: hovered ? colors.hoverBg || "" : "",
        foreground: hovered ? colors.hoverFg || "" : "",
        interactiveKey,
        turnId: turn.id,
        action: canExpand ? "toggle-turn" : "",
      },
    ];

    if (expanded && canExpand) {
      // Vertical rhythm belongs to the container, not to individual groups.
      // Every visible semantic block receives exactly one rail-only boundary;
      // leading/trailing blanks already owned by a child are normalized away.
      for (const block of this.layoutTurnDetailBlocks(entry.detailEntries, safeWidth, turn)) {
        rows.push(this.activityRailSpacerRow(), ...block.rows);
      }
    }

    if (finalRows.length) {
      rows.push({ text: "" });
      rows.push(...finalRows);
    }

    return [{ text: "" }, ...rows];
  }

  layoutProseTranscriptRows(entry, width) {
    const safeWidth = Math.max(1, width || 1);
    const prefixLimit = Math.max(1, safeWidth - 1);
    const rawFirstPrefix = String(entry.firstPrefix || "");
    const rawContinuationPrefix = String(entry.continuationPrefix ?? rawFirstPrefix);
    const firstPrefix =
      stringDisplayWidth(rawFirstPrefix) > prefixLimit
        ? truncateAnsiText(rawFirstPrefix, prefixLimit)
        : rawFirstPrefix;
    const continuationPrefix =
      stringDisplayWidth(rawContinuationPrefix) > prefixLimit
        ? truncateAnsiText(rawContinuationPrefix, prefixLimit)
        : rawContinuationPrefix;
    const firstContentWidth = Math.max(1, safeWidth - stringDisplayWidth(firstPrefix));
    const continuationContentWidth = Math.max(1, safeWidth - stringDisplayWidth(continuationPrefix));
    const rows = layoutAnsiText(entry.text, firstContentWidth, {
      mode: "word",
      continuationWidth: continuationContentWidth,
    });
    const rendered = rows.map((row, index) => `${index === 0 ? firstPrefix : continuationPrefix}${row}`);
    return entry.dim ? rendered.map((row) => c("dim", row)) : rendered;
  }

  layoutCodeTranscriptRows(entry, width) {
    const highlighted = entry.lang
      ? highlightCode(String(entry.text ?? ""), entry.lang)
      : String(entry.text ?? "");
    return wrapAnsiLine(highlighted, Math.max(1, width));
  }

  layoutCompactCodeBlockRows(entry, width) {
    const safeWidth = Math.max(1, width || 1);
    const horizontalPadding = Math.min(2, Math.max(0, Math.floor((safeWidth - 1) / 2)));
    const innerWidth = Math.max(1, safeWidth - horizontalPadding * 2);
    const logicalRows = [];

    if (entry.lang) {
      logicalRows.push({ text: String(entry.lang), header: true });
    }
    for (const line of entry.lines || []) {
      const highlighted = entry.lang
        ? highlightCode(String(line ?? ""), entry.lang)
        : String(line ?? "");
      const wrapped = highlighted ? wrapAnsiLine(highlighted, innerWidth) : [""];
      for (const text of wrapped) logicalRows.push({ text, dim: entry.dim === true });
    }
    if (!logicalRows.length) return [];

    const contentWidth = Math.min(
      innerWidth,
      Math.max(1, ...logicalRows.map((row) => stringDisplayWidth(row.text))),
    );
    const background = colors.codeBg || "";
    const reset = colors.reset || "";
    const blockWidth = Math.min(safeWidth, contentWidth + horizontalPadding * 2);
    const side = " ".repeat(horizontalPadding);
    const shade = (row, foreground = "") => {
      const style = `${background}${foreground}`;
      const styledText = reset && style
        ? String(row).split(reset).join(`${reset}${style}`)
        : String(row);
      return `${style}${side}${padAnsiToWidth(styledText, contentWidth)}${side}${reset}`;
    };
    const spacer = `${background}${" ".repeat(blockWidth)}${reset}`;
    const body = logicalRows.map((row) => {
      const foreground = row.header
        ? colors.codeLabel || colors.muted || ""
        : row.dim
          ? colors.dim || ""
          : "";
      return shade(row.text, foreground);
    });
    return [spacer, ...body, spacer];
  }

  transcriptEntryIsBlank(entry) {
    return typeof entry === "string" && stripAnsi(entry).trim() === "";
  }

  // Soft-wrapped visual rows for the transcript tail: the last `count` rows
  // after skipping `skipFromEnd` rows from the bottom. Wraps lazily from the
  // end so cost is proportional to the window, not the whole buffer.
  collectTranscriptRowsFromEnd(width, count, skipFromEnd = 0) {
    const needed = Math.max(0, count) + Math.max(0, skipFromEnd);
    const entries = this.transcriptEntries;
    let end = entries.length;
    while (end > 0 && this.transcriptEntryIsBlank(entries[end - 1])) end -= 1;

    const collected = [];
    for (let index = end - 1; index >= 0 && collected.length < needed; index -= 1) {
      const rows = this.transcriptEntryVisualRows(entries[index], width);
      for (let row = rows.length - 1; row >= 0; row -= 1) collected.push(rows[row]);
    }
    collected.reverse();

    const sliceEnd = Math.max(0, collected.length - Math.max(0, skipFromEnd));
    const sliceStart = Math.max(0, sliceEnd - Math.max(0, count));
    const visualRows = collected.slice(sliceStart, sliceEnd);
    return {
      rows: visualRows.map((row) => row.text),
      visualRows,
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
    return Boolean(process.stdout.isTTY && Number.isInteger(this.lastRawScrollBottom));
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

  emitUserTurn(text, provider = this.currentChat?.provider || "") {
    const entry = this.recordUserTurn(text, provider);
    if (!entry) return;

    const rows = this.transcriptEntryRows(entry, this.transcriptWrapWidth());
    this.paintTranscriptRows(["", ...rows], `\n${rows.join("\n")}\n`);
  }

  emitTranscriptEntry(entry) {
    if (!isSemanticTranscriptEntry(entry)) return -1;
    const index = this.recordTranscriptEntry(entry);
    const rows = this.transcriptEntryRows(entry, this.transcriptWrapWidth());
    this.paintTranscriptRows(rows, `${rows.join("\n")}\n`);
    return index;
  }

  paintTranscriptAppend(text) {
    const width = this.transcriptWrapWidth();
    const padding = this.transcriptPaddingCells(width);
    const contentWidth = Math.max(1, width - padding * 2);
    const lines = String(text).split("\n");
    lines.pop();

    const rows = lines
      .flatMap((line) => wrapAnsiLine(line, contentWidth))
      .map((row) => this.decorateTranscriptVisualRow({ text: row }, width, padding).text);
    this.paintTranscriptRows(rows, `${rows.join("\n")}\n`);
  }

  paintTranscriptRows(rows, fallbackText = "") {
    const visualRows = Array.isArray(rows) ? rows : [];

    if (this.transcriptPaintSuppressed()) return;

    if (this.activePicker || this.fullscreenOverlay) {
      // A picker owns the screen: buffer only; the close repaint catches up.
      return;
    }

    if (this.scrollOffsetRows > 0) {
      // Viewing history: keep the viewport still and count what arrived.
      this.scrollNewRows += visualRows.length;
      if (this.rawInput) this.renderRawInput();
      return;
    }

    if (!this.canPaintPinned()) {
      const restoreReadline = Boolean(this.questionActive && !this.rawInput);
      if (restoreReadline) this.beforeAsyncOutput();
      process.stdout.write(fallbackText || `${visualRows.join("\n")}\n`);
      if (restoreReadline) this.afterAsyncOutput();
      return;
    }

    const bottom = this.pinnedOutputRows() - 1;
    const painter = new FramePainter();
    painter.to(0, bottom);
    for (const row of visualRows) {
      painter.text("\r\n").clearLine().text(row).text(colors.reset || "");
    }
    this.restoreComposerCursor(painter);
    painter.flush();
    this.lastTranscriptFrame = null;
  }

  restoreComposerCursor(painter) {
    const session = this.rawInput;
    if (!session || !session.pinned || session.done || this.fullscreenOverlay) return;
    const layout = this.rawInputLayout(session);
    const view = this.rawInputMultilineViewport(session, layout.inputWidth, layout.inputRows);
    // Same content coordinate as the card painter: rail + inner gap, followed
    // by the display-column cursor position inside the editable text.
    painter.to(
      this.composerCardContentColumn() + view.cursorColumn,
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

    this.renderRawInput({ forceOutput: true });
  }

  transcriptPageRows(session = this.rawInput) {
    const viewport = Math.max(1, this.rawInputLayout(session).outputBottom || 1);
    const percent = Math.max(
      10,
      Math.min(100, Number(this.scrollPagePercent) || DEFAULT_SCROLL_PAGE_PERCENT),
    );
    return Math.max(1, Math.round((viewport * percent) / 100));
  }

  enableMouseTracking() {
    if (!process.stdout.isTTY) return;
    // Button-event tracking includes the wheel; SGR mode keeps coordinates
    // unambiguous in wide popups and is translated correctly by tmux.
    process.stdout.write(
      `\x1b[?1000h${this.mouseHoverEnabled ? "\x1b[?1003h" : ""}\x1b[?1006h`,
    );
  }

  disableMouseTracking() {
    if (!process.stdout.isTTY) return;
    process.stdout.write(
      `\x1b[?1006l${this.mouseHoverEnabled ? "\x1b[?1003l" : ""}\x1b[?1000l`,
    );
  }

  suspendComposerMouseTracking() {
    const session = this.rawInput;
    if (!session?.mouseTracking || session.mouseTrackingSuspended) return false;
    this.disableMouseTracking();
    session.mouseTrackingSuspended = true;
    session.mousePress = null;
    this.hoveredInteractiveKey = "";
    return true;
  }

  resumeComposerMouseTracking(wasSuspended) {
    const session = this.rawInput;
    if (!wasSuspended || !session?.mouseTracking || !session.mouseTrackingSuspended) return;
    if (session.mouseSelectionMode) return;
    session.mouseTrackingSuspended = false;
    this.enableMouseTracking();
  }

  setMouseSelectionMode(session = this.rawInput, active = true) {
    if (!session?.pinned) return false;
    const next = active === true;
    if (session.mouseSelectionMode === next) return true;

    session.mouseSelectionMode = next;
    session.mousePress = null;
    session.mouseSequence = "";
    session.mouseSequenceAt = 0;
    this.hoveredInteractiveKey = "";

    if (next) {
      if (session.mouseTracking && !session.mouseTrackingSuspended) {
        this.disableMouseTracking();
      }
      session.mouseTrackingSuspended = true;
    } else if (session.mouseTracking && session.mouseTrackingSuspended) {
      session.mouseTrackingSuspended = false;
      this.enableMouseTracking();
    }

    this.renderRawInput();
    return true;
  }

  decodeSgrMouseSequence(sequence) {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(String(sequence || ""));
    if (!match) return null;
    const code = Number(match[1]);
    const baseButton = code & ~(4 | 8 | 16 | 32);
    const motion = Boolean(code & 32);
    const suffix = match[4];
    let type = "press";
    if (suffix === "m") type = "release";
    else if (baseButton === 64 || baseButton === 65) type = "wheel";
    else if (motion) type = "move";
    return {
      type,
      button: baseButton,
      x: Math.max(0, Number(match[2]) - 1),
      y: Math.max(0, Number(match[3]) - 1),
      shift: Boolean(code & 4),
      alt: Boolean(code & 8),
      ctrl: Boolean(code & 16),
      motion,
    };
  }

  interactiveRegionAt(x, y) {
    return [...(this.composerInteractiveRegions || []), ...(this.interactiveRegions || [])].find(
      (region) => x >= region.x1 && x <= region.x2 && y >= region.y1 && y <= region.y2,
    ) || null;
  }

  setHoveredInteractiveRegion(region) {
    const next = this.mouseHoverEnabled ? region?.key || "" : "";
    if (next === this.hoveredInteractiveKey) return false;
    const previous = this.hoveredInteractiveKey;
    this.hoveredInteractiveKey = next;
    if (this.canPaintPinned()) {
      const footerChanged = [previous, next].some((key) =>
        String(key || "").startsWith("composer-footer:"),
      );
      const transcriptChanged = [previous, next].some(
        (key) => key && !String(key).startsWith("composer-footer:"),
      );
      if (transcriptChanged) this.repaintPinnedOutput();
      if (footerChanged) this.paintComposerFooterRow();
    }
    return true;
  }

  composerFooterExpansionSpec(control = this.composerFooterExpansion?.control) {
    if (!["model", "effort"].includes(control)) return null;
    const option = resolveConfigOption(this.currentChat?.configOptions || [], control);
    if (!option) return null;
    const configId = configOptionId(option);
    const values = configOptionMenuValues(option);
    if (!configId || values.length < 2) return null;
    const items = values.map((entry, index) => ({
      id: `${control}:${index}`,
      value: entry.value,
      label: composerControlLabel(entry.label || entry.value, control),
      current: configOptionValueMatches(option, entry.value),
    }));
    return {
      control,
      configId,
      items,
      currentIndex: Math.max(0, items.findIndex((item) => item.current)),
    };
  }

  closeComposerFooterExpansion(options = {}) {
    if (!this.composerFooterExpansion) return false;
    this.composerFooterExpansion = null;
    if (String(this.hoveredInteractiveKey || "").startsWith("composer-footer:")) {
      this.hoveredInteractiveKey = "";
    }
    if (options.render !== false) this.paintComposerFooterRow();
    return true;
  }

  toggleComposerFooterExpansion(control) {
    if (this.composerFooterSelectionPending) return false;
    const spec = this.composerFooterExpansionSpec(control);
    if (!spec) {
      if (this.composerFooterExpansion?.control === control) {
        this.closeComposerFooterExpansion({ render: false });
      }
      return false;
    }
    if (this.composerFooterExpansion?.control === control) {
      return this.closeComposerFooterExpansion();
    }
    this.composerFooterExpansion = {
      control,
      offset: Math.max(0, spec.currentIndex - 1),
    };
    this.hoveredInteractiveKey = "";
    this.paintComposerFooterRow();
    return true;
  }

  pageComposerFooterExpansion(delta) {
    const state = this.composerFooterExpansion;
    const spec = this.composerFooterExpansionSpec();
    if (!state || !spec || this.composerFooterSelectionPending) return false;
    const next = Math.max(0, Math.min(spec.items.length - 1, state.offset + delta));
    if (next === state.offset) return false;
    state.offset = next;
    this.hoveredInteractiveKey = "";
    this.paintComposerFooterRow();
    return true;
  }

  async selectComposerFooterOption(control, value) {
    const spec = this.composerFooterExpansionSpec(control);
    if (!spec || this.composerFooterSelectionPending) return false;
    const item = spec.items.find((candidate) => String(candidate.value) === String(value));
    if (!item) return false;
    if (item.current) return this.closeComposerFooterExpansion();

    this.composerFooterSelectionPending = { control, value: item.value };
    this.paintComposerFooterRow();
    let applied = false;
    try {
      applied = await this.applyConfigOption(spec.configId, item.value, {
        fallback: false,
        render: false,
      });
    } catch (error) {
      this.notify(`footer selection: ${error.message || String(error)}`);
    } finally {
      this.composerFooterSelectionPending = null;
    }
    if (applied) {
      this.closeComposerFooterExpansion({ render: false });
    }
    this.paintComposerFooterRow();
    return applied;
  }

  async openComposerFooterControl(control) {
    if (!control || !this.rawInput || this.rawInput.done) return false;
    // Permission remains the highest-priority shelf owner. A click while one
    // is pending reopens that decision instead of allowing a config picker to
    // cover the authority request.
    if (this.pendingPermission) {
      return this.maybeOpenPermissionPanel({ force: true });
    }

    if (this.inlinePicker) {
      if (this.inlinePicker.purpose === "permission") return false;
      this.closeInlinePicker(null, { render: false });
      await Promise.resolve();
    }

    if (control === "model" || control === "effort") {
      if (this.toggleComposerFooterExpansion(control)) return true;
      return this.showConfigOptionPicker(
        control,
        control === "model" ? "Model" : "Effort",
      );
    }
    if (control === "access") {
      this.closeComposerFooterExpansion({ render: false });
      return this.showAccessPicker();
    }
    if (control === "mcp") {
      this.closeComposerFooterExpansion({ render: false });
      return this.showMcpAdminPicker();
    }
    return false;
  }

  turnCardEntry(turnId) {
    return this.transcriptEntries.find(
      (entry) => entry?.kind === "turn-card" && entry.turn?.id === turnId,
    ) || null;
  }

  setTurnCardExpanded(turnId, force = null, options = {}) {
    const entry = this.turnCardEntry(turnId);
    if (!entry || !this.turnCardCanExpand(entry)) return false;
    const current = this.turnCardExpanded(entry);
    const next = force === null ? !current : force === true;
    if (next === current) return true;

    const width = this.transcriptWrapWidth();
    const beforeRows = this.transcriptEntryRows(entry, width).length;
    if (next === this.turnCardDefaultExpanded(entry)) {
      this.turnDetailOverrides.delete(turnId);
    } else {
      this.turnDetailOverrides.set(turnId, next);
    }
    const afterRows = this.transcriptEntryRows(entry, width).length;
    const delta = afterRows - beforeRows;
    if (options.preserveAnchor && delta && this.rawInput?.pinned) {
      this.scrollOffsetRows = Math.max(0, this.scrollOffsetRows + delta);
    }
    if (this.canPaintPinned()) this.repaintPinnedOutput();
    return true;
  }

  setActivityGroupExpanded(turnId, groupId, force = null, options = {}) {
    const entry = this.turnCardEntry(turnId);
    const child = entry?.detailEntries?.find(
      (item) => item?.kind === "activity-group" && item.group?.id === groupId,
    );
    if (!entry || !child || !this.activityGroupCanExpand(child.group)) return false;
    if (!(this.activityGroupOverrides instanceof Map)) this.activityGroupOverrides = new Map();

    const current = this.activityGroupExpanded(entry.turn, child.group);
    const next = force === null ? !current : force === true;
    if (next === current) return true;

    const width = this.transcriptWrapWidth();
    const beforeRows = this.transcriptEntryRows(entry, width).length;
    const key = this.activityGroupOverrideKey(turnId, groupId);
    if (next === this.activityGroupDefaultExpanded(entry.turn, child.group)) {
      this.activityGroupOverrides.delete(key);
    } else {
      this.activityGroupOverrides.set(key, next);
    }
    const afterRows = this.transcriptEntryRows(entry, width).length;
    const delta = afterRows - beforeRows;
    if (options.preserveAnchor && delta && this.rawInput?.pinned) {
      this.scrollOffsetRows = Math.max(0, this.scrollOffsetRows + delta);
    }
    if (this.canPaintPinned()) this.repaintPinnedOutput();
    return true;
  }

  latestTurnCardEntry() {
    return [...this.transcriptEntries].reverse().find(
      (entry) => entry?.kind === "turn-card" && this.turnCardCanExpand(entry),
    ) || null;
  }

  toggleLatestTurnDetails(force = null) {
    const entry = this.latestTurnCardEntry();
    if (!entry) {
      this.notify("no turn details available");
      return false;
    }
    return this.setTurnCardExpanded(entry.turn.id, force, { preserveAnchor: true });
  }

  handleDecodedMouseEvent(session, event) {
    if (!event || !session?.pinned) return true;
    // Native tmux drag selection receives the drag/release after the initial
    // press was forwarded here. Expire that orphaned press so it can never be
    // mistaken for a later click when copy-mode returns control to the app.
    if (session.mousePress?.at && Date.now() - session.mousePress.at > 1000) {
      session.mousePress = null;
    }
    if (event.type === "wheel") {
      if (this.mouseScrollEnabled === false) return true;
      const rows = Math.max(1, Number(this.mouseScrollRows) || DEFAULT_MOUSE_SCROLL_ROWS);
      this.scrollTranscript(event.button === 64 ? rows : -rows);
      return true;
    }

    const region = this.interactiveRegionAt(event.x, event.y);
    if (event.type === "move") {
      if (session.mousePress && (event.x !== session.mousePress.x || event.y !== session.mousePress.y)) {
        session.mousePress.dragged = true;
      }
      this.setHoveredInteractiveRegion(region);
      return true;
    }

    if (event.type === "press") {
      this.setHoveredInteractiveRegion(region);
      session.mousePress =
        event.button === 0 && region && !event.shift
          ? { key: region.key, x: event.x, y: event.y, dragged: false, at: Date.now() }
          : null;
      return true;
    }

    if (event.type === "release") {
      const pressed = session.mousePress;
      session.mousePress = null;
      this.setHoveredInteractiveRegion(region);
      if (
        this.mouseClickEnabled !== false &&
        event.button === 0 &&
        pressed &&
        !pressed.dragged &&
        region?.key === pressed.key
      ) {
        if (region.action === "toggle-turn") {
          this.setTurnCardExpanded(region.turnId, null, { preserveAnchor: true });
        } else if (region.action === "toggle-activity-group") {
          this.setActivityGroupExpanded(region.turnId, region.activityGroupId, null, {
            preserveAnchor: true,
          });
        } else if (region.action === "open-composer-control") {
          void this.openComposerFooterControl(region.control).catch((error) => {
            this.notify(`footer control: ${error.message || String(error)}`);
          });
        } else if (region.action === "select-composer-footer-option") {
          void this.selectComposerFooterOption(region.control, region.value).catch((error) => {
            this.notify(`footer selection: ${error.message || String(error)}`);
          });
        } else if (region.action === "page-composer-footer-group") {
          this.pageComposerFooterExpansion(Number(region.delta) || 0);
        }
      }
      return true;
    }

    return true;
  }

  consumeRawMouseKeypress(session, input, key = {}) {
    if (!session) return false;
    const fragment = String(key.sequence ?? input ?? "");
    const now = Date.now();

    if (
      session.mouseSequence &&
      now - (session.mouseSequenceAt || now) > SGR_MOUSE_TIMEOUT_MS
    ) {
      session.mouseSequence = "";
      session.mouseSequenceAt = 0;
    }

    if (!session.mouseSequence) {
      if (!fragment.startsWith(SGR_MOUSE_PREFIX)) return false;
      session.mouseSequence = fragment;
      session.mouseSequenceAt = now;
    } else {
      session.mouseSequence += fragment;
    }

    const sequence = session.mouseSequence;
    if (!/[Mm]$/.test(sequence) && sequence.length <= 64) return true;

    session.mouseSequence = "";
    session.mouseSequenceAt = 0;
    const event = this.decodeSgrMouseSequence(sequence);
    if (!event) return true;
    return this.handleDecodedMouseEvent(session, event);
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
      if (session.mouseTracking) this.disableMouseTracking();
      if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(false);
      process.stdout.write("\x1b[2J\x1b[H");
      result = spawnSync(parts[0], [...parts.slice(1), file], { stdio: "inherit" });
    } finally {
      if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(wasRaw);
      if (session.bracketedPaste) this.enableBracketedPaste();
      if (session.mouseTracking) this.enableMouseTracking();
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
      this.lastTranscriptFrame = null;
      this.lastRawInputLayout = null;
      this.renderRawInput({ clear: true, clearScreen: true, forceOutput: true });
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

    // Composer live → render inline in the shared upper panel (permissions
    // arriving mid-prompt land here too); undefined = couldn't host, fall
    // through to the full-screen list.
    if (!this.inlinePicker && this.canHostInlinePicker()) {
      const picked = await this.openInlinePicker({
        title: config.title || "Select",
        hint: config.hint || "",
        items,
        index: Math.max(0, items.findIndex((item) => item.current)),
        purpose: config.purpose || "quickselect",
        requestId: config.requestId || "",
      });
      if (picked !== undefined) return picked;
    }

    return new Promise((resolve) => {
      const mouseWasSuspended = this.suspendComposerMouseTracking();
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
        this.resumeComposerMouseTracking(mouseWasSuspended);
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
      const currentMark = item.current ? c("greenStrong", "● ") : "  ";
      const label = selected ? c("bold", stripAnsi(item.label)) : c("muted", stripAnsi(item.label));
      writeRow(itemsStart + index, `  ${marker} ${number} ${currentMark}${label}`);
    });

    writeRow(viewportRows - 1, "");
    painter.to(0, viewportRows - 1);
    painter.flush();
  }

  // Interactive list: arrows/Ctrl+N/Ctrl+P move, typing filters fzf-style,
  // Enter resolves the highlighted entry's value, Esc clears the query first
  // and cancels (null) second. Ordinary pickers use the transcript viewport;
  // the Ctrl+O menu opts into a complete full-height terminal scene.
  runLatestPickerRebuild(state, producer, apply) {
    const revision = (state.rebuildRevision || 0) + 1;
    state.rebuildRevision = revision;
    return Promise.resolve()
      .then(producer)
      .then((value) => {
        if (state.done || state.rebuildRevision !== revision) return false;
        apply(value);
        return true;
      })
      .catch(() => false);
  }

  async interactivePick(config) {
    if (!this.pickerSupported()) return null;

    return new Promise((resolve) => {
      const mouseWasSuspended = this.suspendComposerMouseTracking();
      const state = {
        title: config.title || "Select",
        tabs: config.tabs || null,
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
        rebuildRevision: 0,
        previewEnabled: Boolean(config.onPreview),
        fullViewport: config.fullViewport === true,
        fullHeight: config.fullHeight === true,
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
        this.resumeComposerMouseTracking(mouseWasSuspended);
        // Callers that navigate to another window on select (the menu overlay)
        // defer the backdrop so they can switch first and repaint the old chat
        // in the background — no flash of the old pane before the switch.
        if (!config.deferBackdrop) this.restorePickerBackdrop();
        resolve(value);
      };

      const dynamicKeep = Symbol("dynamic picker selection");
      const rebuildWith = (producer, keepValue = dynamicKeep) =>
        this.runLatestPickerRebuild(state, producer, (items) => {
          if (Array.isArray(items)) {
            const keep = keepValue === dynamicKeep
              ? visible()[state.index]?.value ?? null
              : keepValue;
            replaceItems(items, keep);
          } else {
            repaint();
          }
        });

      const onKeypress = (input, key = {}) => {
        try {
          if (key.ctrl && key.name === "c") {
            finish(null);
            return;
          }
          if (key.ctrl && key.name === "o" && config.closeWithCtrlO) {
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
                rebuildWith(() => config.onRename(entry, title), entry.value);
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
            rebuildWith(() => config.onDelete(selected), fallback);
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
            const page = Math.max(1, this.pickerListCapacity(state) - 1);
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
            if (input === "s" && !key.ctrl && !key.meta && config.onScope) {
              rebuildWith(config.onScope);
              return;
            }
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
        onEvent: config.onEvent
          ? (message) => config.onEvent(message, { replaceItems, rebuildWith, state })
          : null,
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

  pickerViewportRows(state = null) {
    if (state?.fullViewport) return Math.max(6, process.stdout.rows || 24);
    if (this.canPaintPinned()) return this.pinnedOutputRows();
    return Math.max(6, process.stdout.rows || 24);
  }

  pickerListCapacity(state = null) {
    // title + query + separator above, hint row below
    return Math.max(1, this.pickerViewportRows(state) - 4);
  }

  pickerColumnWidths(width, state = null) {
    const available = Math.max(1, Math.floor(width || 1));
    const previewActive = Boolean(state?.previewEnabled && available >= 96);
    if (!previewActive) {
      return { previewActive: false, listWidth: available, previewWidth: 0 };
    }

    const percent = Math.max(
      45,
      Math.min(75, Number.parseInt(this.menuListPercent, 10) || DEFAULT_MENU_LIST_PERCENT),
    );
    const dividerWidth = 3;
    const minimumPreviewWidth = 38;
    const maximumListWidth = Math.max(1, available - dividerWidth - minimumPreviewWidth);
    const targetListWidth = Math.floor((available * percent) / 100);
    const listWidth = Math.min(maximumListWidth, Math.max(Math.min(56, maximumListWidth), targetListWidth));
    return {
      previewActive: true,
      listWidth,
      previewWidth: available - listWidth - dividerWidth,
    };
  }

  paintPicker(state, entries) {
    if (!process.stdout.isTTY) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    const width = Math.max(1, columns - 1);
    const viewportRows = this.pickerViewportRows(state);
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
    const { previewActive, listWidth, previewWidth } = this.pickerColumnWidths(width, state);

    // Short lists hug the bottom of the viewport (near the composer the eye
    // was already on) instead of teleporting to the top; the preview layout
    // keeps the full height so the transcript pane stays useful.
    const usedRows = state.fullHeight || previewActive
      ? capacity
      : Math.max(1, Math.min(Math.max(entries.length, 1), capacity));
    const itemsStart = viewportRows - 1 - usedRows;
    const titleRow = itemsStart - 3;

    if (state.index >= state.scroll + usedRows) state.scroll = state.index - usedRows + 1;
    if (state.index !== -1 && state.index < state.scroll) state.scroll = state.index;
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, entries.length - usedRows)));

    if (state.fullViewport) {
      // The menu is a complete terminal scene, not a sheet over the transcript.
      // Reset the composer's scroll region inside the same synchronized paint
      // that replaces every row, so no intermediate footer/card is exposed.
      painter.text("\x1b[r");
      this.lastRawScrollBottom = null;
      this.lastTranscriptFrame = null;
    }

    const writeRow = (row, content) => {
      painter.to(0, row).clearLine();
      if (content) painter.text(fitAnsiLine(content, width)).text(colors.reset || "");
    };

    const previewLines = previewActive
      ? formatChatPreview(state.previewData?.events, previewWidth, usedRows, (text) =>
          this.renderMarkdownDetached(text, previewWidth),
        )
      : [];
    const previewPending = previewActive && state.previewKey && !state.previewData;

    for (let row = 0; row < titleRow; row += 1) writeRow(row, "");
    const title = typeof state.title === "function" ? state.title() : state.title;
    const queryRow = titleRow + (state.tabs ? 2 : 1);
    writeRow(titleRow, `${c("bold", title)}  ${counter}`);
    if (state.tabs) {
      const tabs = typeof state.tabs === "function" ? state.tabs(width) : state.tabs;
      writeRow(titleRow + 1, tabs);
      writeRow(queryRow, `${c("cyan", "❯")} ${queryText}`);
    } else {
      writeRow(queryRow, `${c("cyan", "❯")} ${queryText}`);
      writeRow(titleRow + 2, c("dim", "─".repeat(Math.min(width, 96))));
    }

    for (let slot = 0; slot < usedRows; slot += 1) {
      const entry = entries[state.scroll + slot];
      let content = "";
      if (entry) {
        if (entry.disabled) {
          content = entry.label || "";
        } else {
          const selected = state.scroll + slot === state.index;
          const marker = selected ? c("cyan", "❯ ") : "  ";
          const currentMark = entry.current ? c("greenStrong", "● ") : "  ";
          const labelWidth = Math.max(1, listWidth - visibleLength(marker) - visibleLength(currentMark));
          const label = typeof entry.renderLabel === "function"
            ? entry.renderLabel(labelWidth, { selected, current: Boolean(entry.current) })
            : entry.label || "";
          content = `${marker}${currentMark}${label}`;
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
    painter.to(2 + visibleLength(cursorText), queryRow);
    painter.flush();
  }

  restorePickerBackdrop() {
    if (!process.stdout.isTTY) return;
    if (this.canPaintPinned()) {
      // The picker owned these physical rows without changing the transcript
      // model, so the logical framebuffer cannot be trusted. Restore output
      // and composer together instead of repainting them in two frames.
      this.lastTranscriptFrame = null;
      if (this.rawInput?.pinned) {
        this.renderRawInput({ forceOutput: true });
      } else {
        this.repaintPinnedOutput();
      }
      return;
    }
    this.clearScreen();
  }

  resetTranscriptBuffer() {
    this.transcriptEntries = [""];
    this.lastTranscriptFrame = null;
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
    if (this.liveCodeBlockPaintTimer) {
      clearTimeout(this.liveCodeBlockPaintTimer);
      this.liveCodeBlockPaintTimer = null;
    }
    this.liveCodeBlockPaintPending = false;
    this.liveCodeBlock = null;
    this.mdHeldLine = null;
  }

  recordTranscriptOutput(text = "") {
    const parts = String(text || "").split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) this.transcriptEntries.push("");
      if (typeof this.transcriptEntries[this.transcriptEntries.length - 1] !== "string") {
        this.transcriptEntries.push("");
      }
      this.transcriptEntries[this.transcriptEntries.length - 1] += parts[index];
    }

    this.trimTranscriptBuffer();
  }

  recordTranscriptEntry(entry) {
    if (!isSemanticTranscriptEntry(entry)) return -1;

    let index = this.transcriptEntries.length - 1;
    if (typeof this.transcriptEntries[index] === "string" && this.transcriptEntries[index] === "") {
      this.transcriptEntries[index] = entry;
    } else {
      this.transcriptEntries.push(entry);
      index = this.transcriptEntries.length - 1;
    }
    this.transcriptEntries.push("");
    const removed = this.trimTranscriptBuffer();
    return Math.max(-1, index - removed);
  }

  recordUserTurn(text, provider = this.currentChat?.provider || "") {
    const normalized = normalizePastedText(text).trim();
    if (!normalized) return null;

    // Match the existing leading newline without flattening the user turn into
    // terminal rows. The trailing string remains the append target for the
    // response stream that follows this semantic entry.
    this.recordTranscriptOutput("\n");
    const entry = { kind: "user", text: normalized, provider };
    this.recordTranscriptEntry(entry);
    return entry;
  }

  trimTranscriptBuffer() {
    let removed = 0;
    const limit = Math.max(
      TRANSCRIPT_SCREEN_LINE_LIMIT,
      Number(this.transcriptEntryLimit) || TRANSCRIPT_SCREEN_LINE_LIMIT,
    );
    if (this.transcriptEntries.length > limit) {
      removed = this.transcriptEntries.length - limit;
      this.transcriptEntries.splice(0, removed);
      if (this.liveTable) {
        this.liveTable.startIndex -= removed;
        if (this.liveTable.startIndex < 0) this.liveTable = null;
      }
      if (this.liveCodeBlock) {
        this.liveCodeBlock.startIndex -= removed;
        if (this.liveCodeBlock.startIndex < 0) this.liveCodeBlock = null;
      }
    }
    return removed;
  }

  // Enhanced composer mode hosts inline pickers. Small popups keep the exact
  // card geometry but use the classic completion flow. The historical env name
  // remains a compatibility switch.
  shouldUseEnhancedComposer(rows = process.stdout.rows || 24) {
    const configured =
      process.env.ACP_HUB_COMPOSER_ENHANCED ?? process.env.ACP_HUB_COMPOSER_BOX;
    return rows >= 15 && configured !== "0";
  }

  currentPlanPresentation() {
    const view = planPresentation(this.currentChat);
    if (this.shouldCarryPlanPresentation(view)) {
      const waiting = this.planWaitingPresentation("Awaiting update", "waiting");
      return {
        ...view,
        canonicalLifecycle: view.lifecycle,
        lifecycle: "carried",
        ...waiting,
        carried: true,
        presentationOnly: true,
      };
    }
    if (!this.shouldPresentAwaitingPlan(view)) return view;

    const waiting = this.planWaitingPresentation("Awaiting agent plan", "active");

    return {
      entries: [],
      revision: 0,
      turnSequence: Number.parseInt(this.currentChat?.turnSequence, 10) || 0,
      lifecycle: "awaiting",
      updatedAt: this.currentChat?.updatedAt || null,
      done: 0,
      total: 0,
      percent: 0,
      currentIndex: -1,
      currentEntry: null,
      ...waiting,
      synthetic: true,
    };
  }

  planWaitingPresentation(defaultLabel, defaultTone) {
    const status = normalizeToken(this.currentChat?.status || "");
    let stateLabel = defaultLabel;
    let tone = defaultTone;
    if (status === "permission") {
      stateLabel = "Waiting for permission";
      tone = "waiting";
    } else if (status === "auth") {
      stateLabel = "Waiting for authentication";
      tone = "waiting";
    } else if (status === "cancelling") {
      stateLabel = "Cancelling";
      tone = "waiting";
    }
    return { stateLabel, tone };
  }

  shouldCarryPlanPresentation(view = planPresentation(this.currentChat)) {
    const chatTurnSequence = Math.max(
      0,
      Number.parseInt(this.currentChat?.turnSequence, 10) || 0,
    );
    const planTurnSequence = Math.max(0, Number.parseInt(view?.turnSequence, 10) || 0);
    return Boolean(
      this.currentChat?.turnActive &&
      view?.lifecycle === "previous" &&
      view.previousLifecycle === "incomplete" &&
      view.entries?.length &&
      planTurnSequence > 0 &&
      chatTurnSequence === planTurnSequence + 1,
    );
  }

  shouldPresentAwaitingPlan(view = planPresentation(this.currentChat)) {
    const chat = this.currentChat;
    if (!chat?.turnActive || this.planAwaitingPolicy === "off") return false;
    if (view && view.lifecycle !== "previous") return false;
    if (this.planAwaitingPolicy === "on") return true;
    const mode = normalizeToken(chat.mode || chat.configValues?.mode || "");
    return mode === "plan" || mode === "planning";
  }

  shouldShowPinnedPlan(view = this.currentPlanPresentation()) {
    if (!view) return false;
    if (this.planExpanded) return true;
    if (this.planPinMode === "off") return false;
    if (this.planPinMode === "auto" && view.lifecycle === "previous") return false;
    if (view.lifecycle === "completed" && this.planCompletedBehavior === "hide") return false;
    return true;
  }

  planToneColor(view) {
    if (view?.tone === "error") return "red";
    if (view?.tone === "complete") return "green";
    if (view?.tone === "active" || view?.tone === "waiting") return "yellow";
    return "muted";
  }

  planProgressGlyphs(view, limit = 12) {
    if (!view?.entries?.length) return "";
    if (view.entries.length > limit) {
      const filled = Math.round((view.done / view.total) * 8);
      return `${c("greenStrong", "●".repeat(filled))}${c("muted", "○".repeat(Math.max(0, 8 - filled)))}`;
    }
    return view.entries
      .map((entry) => {
        if (entry.status === "completed") return c("greenStrong", "●");
        if (entry.status === "in_progress") return c("yellow", "◐");
        if (entry.status === "failed") return c("red", "×");
        if (entry.status === "skipped" || entry.status === "cancelled") return c("muted", "⊘");
        return c("muted", "○");
      })
      .join(" ");
  }

  planHeaderSummary(view, detail = "full") {
    if (!view) return "";
    const state = c(this.planToneColor(view), view.stateLabel);
    if (view.lifecycle === "awaiting") {
      if (detail === "compact") return `${c("bold", "Plan")} ${c("yellow", "…")}`;
      return `${c("bold", "Plan")} ${c("yellow", "…")} ${state}`;
    }

    const count = `${c("bold", "Plan")} ${c("dim", `${view.done}/${view.total}`)}`;
    if (detail === "compact") return count;
    if (detail === "medium") {
      return `${count} ${c("dim", `${view.percent}%`)} ${state}`;
    }
    return `${count} ${this.planProgressGlyphs(view)} ${c("dim", `${view.percent}%`)} ${state}`;
  }

  planHeaderCandidates(view) {
    const candidates = [
      this.planHeaderSummary(view, "full"),
      this.planHeaderSummary(view, "medium"),
      this.planHeaderSummary(view, "compact"),
    ];
    return candidates.filter(
      (candidate, index) =>
        candidate &&
        candidates.findIndex((value) => stripAnsi(value) === stripAnsi(candidate)) === index,
    );
  }

  planHeaderLine(view, width) {
    return fitAnsiLine(` ${this.planHeaderSummary(view, "full")}`, width);
  }

  planExpandedBody(view, width) {
    const lines = [];
    for (const entry of view.entries) {
      const prefix = `  ${planMarker(entry.status)} `;
      const continuation = " ".repeat(visibleLength(prefix));
      const wrapped = wrapAnsiWords(
        renderInlineMarkdown(entry.content),
        Math.max(8, width - visibleLength(prefix)),
      );
      if (!wrapped.length) {
        lines.push(prefix);
        continue;
      }
      lines.push(`${prefix}${wrapped[0]}`);
      for (const row of wrapped.slice(1)) lines.push(`${continuation}${row}`);
    }
    return lines.map((line) => fitAnsiLine(line, width));
  }

  planExpandedBodyLines(view, width) {
    return this.planExpandedBody(view, width);
  }

  planDrawerContentWidth(columns = process.stdout.columns || 80) {
    const safeColumns = Math.max(1, Math.max(24, columns) - 1);
    const inset = Math.max(0, this.transcriptPaddingCells(safeColumns) - 1);
    return Math.max(8, safeColumns - inset * 2);
  }

  planDisplayLines(width, rowLimit) {
    const view = this.currentPlanPresentation();
    if (!view || !this.planExpanded || rowLimit < 1) return [];
    const body = this.planExpandedBodyLines(view, width);
    // Expanded means the phase list itself, not a focused viewport. There is
    // no selected phase, navigation footer, or private scroll position.
    return body.slice(0, Math.max(1, Number.parseInt(rowLimit, 10) || 1));
  }

  planDesiredRowCount(rows, columns) {
    const view = this.currentPlanPresentation();
    if (!this.planExpanded || !this.shouldShowPinnedPlan(view) || view?.lifecycle === "awaiting") {
      return 0;
    }

    const width = this.planDrawerContentWidth(columns);
    return Math.max(1, this.planExpandedBodyLines(view, width).length);
  }

  planBandAllocation(rows, columns, baseComposerHeight) {
    const desiredPlanRows = this.planDesiredRowCount(rows, columns);
    if (!desiredPlanRows) {
      // A collapsed Plan is summarized by the smart header and owns no rows.
      return { planRows: 0, gapRows: 0 };
    }

    // The expanded drawer grows upward from the fixed card. This method budgets
    // content only; the shared shelf allocator owns its breathing row.
    const planCapacity = Math.max(
      1,
      rows - baseComposerHeight - MIN_EXPANDED_PLAN_TRANSCRIPT_ROWS,
    );
    return {
      planRows: Math.max(1, Math.min(desiredPlanRows, planCapacity)),
      gapRows: 0,
    };
  }

  composerUpperPanelAllocation(
    rows,
    columns,
    baseComposerHeight,
    dropdown = null,
    desiredDropdownRows = 0,
    desiredQueueRows = 0,
  ) {
    const allocateShelf = (
      kind,
      desiredContentRows,
      minimumContentRows = 1,
      transcriptReserve = MIN_PLAN_TRANSCRIPT_ROWS,
    ) => {
      // Keep at least one transcript row on physically constrained terminals.
      // The shelf's decorative top gap is the first thing surrendered; normal
      // popups always retain it.
      const absoluteCapacity = Math.max(1, rows - baseComposerHeight - 1);
      const topGapRows = absoluteCapacity >= minimumContentRows + 1 ? 1 : 0;
      const minimumRows = Math.min(
        absoluteCapacity,
        topGapRows + minimumContentRows,
      );
      const capacity = Math.min(
        absoluteCapacity,
        Math.max(minimumRows, rows - baseComposerHeight - transcriptReserve),
      );
      const contentCapacity = Math.max(1, capacity - topGapRows);
      const contentRows = Math.max(
        Math.min(minimumContentRows, contentCapacity),
        Math.min(desiredContentRows, contentCapacity),
      );
      return {
        kind,
        rows: topGapRows + contentRows,
        contentRows,
        topGapRows,
        gapRows: 0,
      };
    };

    if (dropdown && desiredDropdownRows > 0) {
      const kind = ["quickselect", "hub-operation"].includes(dropdown.kind)
        ? dropdown.kind
        : "autocomplete";
      const minimumContentRows = kind === "quickselect" ? Math.min(2, desiredDropdownRows) : 1;
      return allocateShelf(kind, desiredDropdownRows, minimumContentRows);
    }

    // Reserve the shelf's top breathing row before calculating Plan capacity.
    const plan = this.planBandAllocation(rows, columns, baseComposerHeight + 1);
    if (plan.planRows) {
      return allocateShelf(
        "plan",
        plan.planRows,
        1,
        MIN_EXPANDED_PLAN_TRANSCRIPT_ROWS,
      );
    }

    if (desiredQueueRows > 0) return allocateShelf("queue", desiredQueueRows);
    return { kind: null, rows: 0, contentRows: 0, topGapRows: 0, gapRows: 0 };
  }

  createPendingPinnedInput(session = this.rawInput) {
    return {
      prompt: session?.prompt || this.inputPrompt(),
      line: "",
      cursor: 0,
      pinned: true,
      done: true,
      autocompleteIndex: 0,
      autocompleteKey: "",
      autocompleteSuppressedKey: "",
    };
  }

  pinnedSceneLayout() {
    if (this.rawInput?.pinned) return this.rawInputLayout(this.rawInput);
    return this.pendingPinnedLayout || null;
  }

  beginPinnedInputTransition(session = this.rawInput) {
    if (!session?.pinned || !process.stdout.isTTY) return null;

    const previousLayout = this.lastRawInputLayout || this.rawInputLayout(session);
    const pending = this.createPendingPinnedInput(session);
    const layout = this.rawInputLayout(pending);
    const shouldRepaintOutput =
      !previousLayout ||
      previousLayout.outputBottom !== layout.outputBottom ||
      previousLayout.columns !== layout.columns ||
      previousLayout.rows !== layout.rows;
    const painter = new FramePainter();
    const viewportChanged = this.enableRawInputLayout(pending, layout, painter);

    this.pendingPinnedInput = pending;
    this.pendingPinnedLayout = layout;
    if (shouldRepaintOutput || viewportChanged) this.lastTranscriptFrame = null;

    this.clearRawInputLayoutRows([previousLayout, layout], painter);
    if (shouldRepaintOutput || viewportChanged) {
      this.repaintPinnedOutput(layout, painter, { restoreCursor: false });
    }
    // Keep Plan and the empty incoming composer visually stable while the
    // submitted command is dispatched. The next real input session replaces
    // this non-interactive owner without inventing geometry from null.
    this.renderPinnedRawInput(pending, layout, painter);
    painter.flush();
    return layout;
  }

  rawInputLayout(session = this.rawInput) {
    const rows = Math.max(10, process.stdout.rows || 24);
    const columns = Math.max(24, process.stdout.columns || 80);
    const enhanced = this.shouldUseEnhancedComposer(rows) && session?.pinned !== false;
    const attachmentRows = this.rawAttachmentRowCount(columns);
    const desiredQueueRows = Math.min(8, this.queueShelfCount());
    let inputRows = this.rawInputRowCount(session, this.rawInputTextWidth(session, columns));
    // The inline picker (/model, /effort…) has first claim on the shared upper
    // shelf; command autocomplete follows, then recoverable adapter work, the
    // Plan drawer, and queue. Quickselect reserves one extra title row.
    const picker = enhanced && this.inlinePicker ? this.inlinePicker : null;
    const autocomplete = enhanced ? this.activeAutocomplete(session) : null;
    const dropdown = picker
      ? { kind: "quickselect", matches: picker.items, index: picker.index, title: picker.title, hint: picker.hint }
      : autocomplete || (enhanced && this.hubOperation
        ? { kind: "hub-operation", operation: this.hubOperation }
        : null);
    const desiredDropdownRows = dropdown
      ? dropdown.kind === "quickselect"
        ? Math.min(8, dropdown.matches.length + 1)
        : dropdown.kind === "hub-operation"
          ? Math.min(6, this.hubOperationPanelLines(
              Math.max(8, columns - this.composerCardContentColumn() * 2),
              6,
            ).length)
          : Math.min(5, dropdown.matches.length)
      : 0;
    const hintRows = rows < 15 ? 0 : this.rawHintRowCount(session);
    const inputPadRows = COMPOSER_INPUT_VERTICAL_PADDING;
    // Fixed rows: transcript/header separator + smart header + gap before the
    // card + shaded top row + internal metadata separator + metadata itself.
    // Outside the card, the shortcut hint owns one blank row on each side; if
    // compact mode hides the hint, retain only the final safety row before tmux.
    const cardChromeRows = 6;
    const externalInfoRows = hintRows ? hintRows + 2 : 1;
    const fixedComposerHeight =
      attachmentRows +
      inputPadRows * 2 +
      cardChromeRows +
      externalInfoRows;
    let baseComposerHeight = fixedComposerHeight + inputRows;
    let upperPanel = this.composerUpperPanelAllocation(
      rows,
      columns,
      baseComposerHeight,
      dropdown,
      desiredDropdownRows,
      desiredQueueRows,
    );
    let composerHeight = baseComposerHeight + upperPanel.rows + upperPanel.gapRows;

    // On the absolute smallest popup, a six-row draft plus the open drawer may
    // otherwise occupy the entire screen and overlap the one-row scroll
    // region. Reduce only the visible input viewport until one transcript row
    // remains; the source draft and cursor mapping are unchanged.
    while (composerHeight > rows - 1 && inputRows > MIN_COMPOSER_INPUT_ROWS) {
      inputRows -= 1;
      baseComposerHeight = fixedComposerHeight + inputRows;
      upperPanel = this.composerUpperPanelAllocation(
        rows,
        columns,
        baseComposerHeight,
        dropdown,
        desiredDropdownRows,
        desiredQueueRows,
      );
      composerHeight = baseComposerHeight + upperPanel.rows + upperPanel.gapRows;
    }

    const planRows = upperPanel.kind === "plan" ? upperPanel.contentRows : 0;
    const queueRows = upperPanel.kind === "queue" ? upperPanel.contentRows : 0;
    const dropdownRows = ["quickselect", "autocomplete", "hub-operation"].includes(upperPanel.kind)
      ? upperPanel.contentRows
      : 0;
    const gapRows = upperPanel.gapRows;
    const outputBottom = Math.max(1, rows - composerHeight);
    const headerTopGapRow = rows - composerHeight + gapRows;
    // Keep gapRow as a compatibility alias for frame/layout integrations that
    // already understand it as the first composer-owned separator.
    const gapRow = headerTopGapRow;
    const headerRow = headerTopGapRow + 1;
    const upperPanelRow = upperPanel.rows ? headerRow + 1 : null;
    const upperPanelPadRow = upperPanel.topGapRows ? upperPanelRow : null;
    const upperPanelContentRow = upperPanel.rows
      ? upperPanelRow + upperPanel.topGapRows
      : null;
    const planRow = upperPanel.kind === "plan" ? upperPanelContentRow : null;
    const queueRow = upperPanel.kind === "queue" ? upperPanelContentRow : null;
    const headerGapRow = headerRow + 1 + upperPanel.rows;
    const cardTopRow = headerGapRow + 1;
    const inputPadTopRow = cardTopRow + 1;
    const inputRow = inputPadTopRow + inputPadRows;
    const inputPadBottomRow = inputRow + inputRows;
    // Attachments and metadata remain inside the same live card. The metadata
    // line is the final shaded row: it intentionally has no internal blank row
    // beneath it.
    const attachmentRow = inputPadBottomRow + inputPadRows;
    const cardMetaGapRow = attachmentRow + attachmentRows;
    const footerRow = cardMetaGapRow + 1;
    const cardBottomRow = footerRow;
    const afterCardRow = cardBottomRow + 1;
    const dropdownPadRow = dropdownRows ? upperPanelPadRow : null;
    const dropdownRow = dropdownRows ? upperPanelContentRow : null;
    const infoGapTopRow = afterCardRow;
    const hintRow = hintRows ? infoGapTopRow + 1 : null;
    const infoGapBottomRow = hintRows ? hintRow + 1 : null;

    return {
      rows,
      columns,
      enhanced,
      planRows,
      planRow,
      planExpanded: this.planExpanded === true,
      upperPanelKind: upperPanel.kind,
      upperPanelRows: upperPanel.rows,
      upperPanelRow,
      upperPanelPadRow,
      upperPanelContentRow,
      queueRows,
      queueRow,
      attachmentRows,
      hintRows,
      inputPadRows,
      attachmentRow,
      inputPadTopRow,
      inputWidth: this.rawInputTextWidth(session, columns),
      inputRows,
      inputPadBottomRow,
      outputBottom,
      gapRow,
      headerTopGapRow,
      headerRow,
      headerGapRow,
      cardTopRow,
      cardMetaGapRow,
      cardBottomRow,
      infoGapTopRow,
      infoGapBottomRow,
      dropdown,
      dropdownRows,
      dropdownRow,
      dropdownPadRow,
      inputRow,
      footerRow,
      hintRow,
      composerRows: [
        ...(gapRow !== null ? [gapRow] : []),
        headerRow,
        ...Array.from({ length: upperPanel.rows }, (_, index) => upperPanelRow + index),
        headerGapRow,
        cardTopRow,
        ...Array.from({ length: inputPadRows }, (_, index) => inputPadTopRow + index),
        ...Array.from({ length: inputRows }, (_, index) => inputRow + index),
        ...Array.from({ length: inputPadRows }, (_, index) => inputPadBottomRow + index),
        ...Array.from({ length: attachmentRows }, (_, index) => attachmentRow + index),
        cardMetaGapRow,
        cardBottomRow,
        ...(infoGapTopRow !== null ? [infoGapTopRow] : []),
        ...(hintRows ? [hintRow] : []),
        ...(infoGapBottomRow !== null ? [infoGapBottomRow] : []),
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
  ) {
    const safeColumns = Math.max(1, Math.max(24, columns) - 1);
    if (session?.pinned !== false) {
      // The live card reserves its edge rail, inner gap, and right padding.
      return this.composerCardContentWidth(safeColumns);
    }
    const promptWidth = visibleLength(session?.prompt || "");
    return Math.max(8, safeColumns - promptWidth);
  }

  rawAttachmentRowCount(columns = process.stdout.columns || 80) {
    if (!this.pendingAttachments.length) return 0;
    const safeColumns = Math.max(1, Math.max(24, columns) - 1);
    // One breathing row + header + chips, all inside the card. The shared
    // metadata gap supplies the trailing separation after attachments.
    return wrapAttachmentChips(
      this.pendingAttachments,
      this.composerCardContentWidth(safeColumns),
      this.themeAccentSeq(this.currentChat?.provider),
    ).length + 2;
  }

  // Leading breathing row + header + chips, all inside the same shaded rail.
  paintAttachmentSection(painter, layout, safeColumns) {
    if (!layout.attachmentRows) return;

    const chipRows = wrapAttachmentChips(
      this.pendingAttachments,
      this.composerCardContentWidth(safeColumns),
      this.themeAccentSeq(this.currentChat?.provider),
    );
    const allImages = this.pendingAttachments.every((item) => item.kind === "image");
    const label = `${allImages ? "Images" : "Attachments"} (${this.pendingAttachments.length})`;
    painter
      .to(0, layout.attachmentRow)
      .clearLine()
      .text(this.composerCardLine("", safeColumns))
      .to(0, layout.attachmentRow + 1)
      .clearLine()
      .text(this.composerCardLine(c("dim", label), safeColumns));

    for (let index = 0; index < chipRows.length; index += 1) {
      painter
        .to(0, layout.attachmentRow + 2 + index)
        .clearLine()
        .text(this.composerCardLine(chipRows[index] || "", safeColumns));
    }
  }

  paintPlanSection(painter, layout, safeColumns) {
    if (!layout.planRows || layout.planRow === null) return;
    // The Plan drawer belongs to the composer frame, whose rail starts one cell
    // before transcript content. Keep that alignment even when the transcript
    // padding grows (e.g. 2 → plan inset 1).
    const inset = Math.max(0, this.transcriptPaddingCells(safeColumns) - 1);
    const contentWidth = Math.max(1, safeColumns - inset * 2);
    const lines = this.planDisplayLines(contentWidth, layout.planRows);
    for (let index = 0; index < layout.planRows; index += 1) {
      painter
        .to(inset, layout.planRow + index)
        .clearLine()
        .text(fitAnsiLine(lines[index] || "", contentWidth));
    }
  }

  paintQueueSection(painter, layout, safeColumns) {
    if (!layout.queueRows || layout.queueRow === null) return;
    const inset = this.composerCardContentColumn();
    const contentWidth = Math.max(1, safeColumns - inset * 2);
    const lines = this.queueShelfLines(contentWidth, layout.queueRows);
    for (let index = 0; index < layout.queueRows; index += 1) {
      painter
        .to(0, layout.queueRow + index)
        .clearLine()
        .to(inset, layout.queueRow + index)
        .text(lines[index] || "");
    }
  }

  rawHintRowCount(session = this.rawInput) {
    return this.inputHint(session?.line || "") ? 1 : 0;
  }

  syncPinnedViewportGeometry(layout, painter = null) {
    if (!process.stdout.isTTY || !layout) return false;
    const outputBottom = Math.max(1, Number.parseInt(layout.outputBottom, 10) || 1);
    if (this.lastRawScrollBottom === outputBottom) return false;

    const sequence = `\x1b[1;${outputBottom}r`;
    if (painter) painter.text(sequence);
    else process.stdout.write(sequence);

    this.lastRawScrollBottom = outputBottom;
    // The old rows describe a different physical viewport. Keeping them would
    // let the differential painter skip content that was addressed into the
    // former composer region and never became visible transcript output.
    this.lastTranscriptFrame = null;
    return true;
  }

  enableRawInputLayout(
    session = this.rawInput,
    layout = this.rawInputLayout(session),
    painter = null,
  ) {
    return this.syncPinnedViewportGeometry(layout, painter);
  }

  disableRawInputLayout(painter = null) {
    this.pendingPinnedInput = null;
    this.pendingPinnedLayout = null;
    if (process.stdout.isTTY) {
      if (painter) painter.text("\x1b[r");
      else process.stdout.write("\x1b[r");
    }
    this.lastRawScrollBottom = null;
    this.lastTranscriptFrame = null;
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

  renderPinnedRawInput(session, layout = this.rawInputLayout(session), painter = null) {
    const safeColumns = Math.max(1, layout.columns - 1);
    const inputWidth = layout.inputWidth || this.composerCardContentWidth(safeColumns);
    const view = this.rawInputMultilineViewport(session, inputWidth, layout.inputRows);
    const footerLayout = this.composerFooterLayout(this.composerCardContentWidth(safeColumns));
    this.updateComposerFooterInteractiveRegions(session, layout, footerLayout);
    const frame = painter || new FramePainter();

    if (layout.gapRow !== null) {
      frame.to(0, layout.gapRow).clearLine();
    }

    frame
      .to(0, layout.headerRow)
      .clearLine()
      .text(this.composerHeaderLine(safeColumns));

    if (layout.upperPanelPadRow !== null) {
      frame.to(0, layout.upperPanelPadRow).clearLine();
    }
    this.paintPlanSection(frame, layout, safeColumns);
    this.paintQueueSection(frame, layout, safeColumns);
    if (layout.dropdownRows) {
      if (layout.dropdown?.kind === "hub-operation") {
        this.paintHubOperationSection(frame, layout, safeColumns);
      } else {
        this.paintAutocompleteDropdown(frame, layout, safeColumns);
      }
    }

    frame
      .to(0, layout.headerGapRow)
      .clearLine()
      .to(0, layout.cardTopRow)
      .clearLine()
      .text(this.composerCardLine("", safeColumns));

    for (let index = 0; index < layout.inputPadRows; index += 1) {
      frame
        .to(0, layout.inputPadTopRow + index)
        .clearLine()
        .text(this.composerCardLine("", safeColumns));
    }

    for (let index = 0; index < layout.inputRows; index += 1) {
      const row = view.rows[index] || { text: "" };
      frame
        .to(0, layout.inputRow + index)
        .clearLine()
        .text(this.composerCardLine(row.text, safeColumns, { muted: row.placeholder }));
    }

    for (let index = 0; index < layout.inputPadRows; index += 1) {
      frame
        .to(0, layout.inputPadBottomRow + index)
        .clearLine()
        .text(this.composerCardLine("", safeColumns));
    }

    this.paintAttachmentSection(frame, layout, safeColumns);

    const overflowParts = [];
    if (view.hiddenAbove) overflowParts.push(`↑ ${view.hiddenAbove} more`);
    if (view.hiddenBelow) overflowParts.push(`↓ ${view.hiddenBelow} more`);
    const overflowLabel = overflowParts.join(" · ");
    const gapContent = overflowLabel
      ? `${" ".repeat(Math.max(0, this.composerCardContentWidth(safeColumns) - visibleLength(overflowLabel)))}${c("dim", overflowLabel)}`
      : "";
    frame
      .to(0, layout.cardMetaGapRow)
      .clearLine()
      .text(this.composerCardLine(gapContent, safeColumns));

    frame
      .to(0, layout.footerRow)
      .clearLine()
      .text(
        this.composerCardLine(
          footerLayout.text,
          safeColumns,
        ),
      );

    if (layout.infoGapTopRow !== null) {
      frame.to(0, layout.infoGapTopRow).clearLine();
    }

    if (layout.hintRows) {
      frame
        .to(0, layout.hintRow)
        .clearLine()
        .text(c("muted", fitPlainLine(this.composerMetaLine(this.inputHint(session.line)), safeColumns)));
    }

    if (layout.infoGapBottomRow !== null) {
      frame.to(0, layout.infoGapBottomRow).clearLine();
    }

    frame.to(
      this.composerCardContentColumn() + view.cursorColumn,
      layout.inputRow + view.cursorRow,
    );
    if (!painter) frame.flush();
    this.lastRawInputLayout = layout;
  }

  composerCardContentColumn() {
    return COMPOSER_CARD_RAIL_WIDTH + COMPOSER_CARD_GAP;
  }

  composerCardContentWidth(width) {
    return Math.max(
      8,
      Math.max(1, width || 1) - this.composerCardContentColumn() - COMPOSER_CARD_RIGHT_PADDING,
    );
  }

  themePalette(provider = this.currentChat?.provider || "") {
    return resolveHubThemePalette({
      variant: this.themeVariant || DEFAULT_THEME_VARIANT,
      provider,
      vanziAccentSeq: hubAccentSeq(),
    });
  }

  themeAccentSeq(provider = this.currentChat?.provider || "") {
    return this.themePalette(provider).accentForeground;
  }

  // The live composer intentionally owns a variant of the shared prompt
  // surface: same full-width shade and provider rail, but a compact semantic
  // header in its first row and independently tunable spacing.
  composerCardLine(value, width, { muted = false } = {}) {
    return this.fullBleedSurfaceLine(value, width, {
      background: colors.userBg || colors.codeBg || "",
      foreground: muted ? colors.inputMuted || colors.muted || "" : "",
      leftRail: "┃",
      leftRailForeground: this.composerAccentSeq(),
      railGap: COMPOSER_CARD_GAP,
      rightPadding: COMPOSER_CARD_RIGHT_PADDING,
    });
  }

  // Theme accent in neutral states; semantic attention states always win.
  composerAccentSeq() {
    if (!process.stdout.isTTY) return "";
    const status = normalizeToken(this.currentChat?.status || "");
    if (this.pendingPermission || status === "permission" || status === "auth") return "\x1b[33m";
    if (status === "error") return colors.red;
    return this.themeAccentSeq(this.currentChat?.provider);
  }

  composerProviderTitle() {
    const chat = this.currentChat || {};
    const seq = this.composerAccentSeq();
    const reset = colors.reset || "";
    return `${seq}${providerIconFor(chat.provider, chat)} ${compactProviderLabel(
      chat.providerLabel || chat.provider,
    )}${reset}`;
  }

  // The primary identity is exclusive: quiet composers show provider icon +
  // label, while an active process replaces both with its animated state.
  // Permission keeps the provider visible because its explicit badge already
  // carries the blocking state.
  composerHeaderPrimary() {
    const chat = this.currentChat || {};
    const status = chat.status || "idle";
    const token = normalizeToken(status);
    const provider = this.composerProviderTitle();
    if (token === "permission") {
      return provider;
    }
    if (isActiveChatStatus(status) || token === "starting") {
      const mode = this.composerStatusAnimationMode();
      const animationFrame = Math.max(0, Number(this.composerAnimationFrame) || 0);
      const glyph = mode === "off"
        ? statusGlyph(status)
        : COMPOSER_SPINNER_FRAMES[animationFrame % COMPOSER_SPINNER_FRAMES.length];
      return `${c("yellow", glyph)} ${statusAnimationText(status, animationFrame, mode, {
        pauseFrames: this.composerStatusAnimationPauseFrames(),
      })}`;
    }
    if (token === "auth" || token === "error") {
      const state = c(token === "error" ? "red" : "yellow", `${statusGlyph(status)} ${status}`);
      return `${provider}  ${state}`;
    }
    return provider;
  }

  composerHeaderTitle() {
    return [this.composerHeaderPrimary(), this.composerHeaderBadges()]
      .filter(Boolean)
      .join("  ");
  }

  composerHeaderBadges() {
    const chat = this.currentChat || {};
    return this.composerBadges(chat, chat.status || "idle")
      .map((badge) => c("yellow", badge))
      .join(" ");
  }

  composerHeaderLine(safeColumns) {
    const indent = " ".repeat(this.composerCardContentColumn());
    const contentWidth = Math.max(1, safeColumns - visibleLength(indent));
    const title = this.composerHeaderTitle();
    const primary = this.composerHeaderPrimary();
    const badges = this.composerHeaderBadges();
    const view = this.currentPlanPresentation();
    const planVisible = this.shouldShowPinnedPlan(view);

    if (planVisible) {
      const summaries = this.planHeaderCandidates(view);
      const full = summaries[0] || "";
      const medium = summaries[1] || full;
      const compact = summaries.at(-1) || medium;
      const candidates = [
        [full, badges],
        [medium, badges],
        [full, ""],
        [compact, badges],
        [medium, ""],
        [compact, ""],
      ];
      const seen = new Set();
      for (const [plan, trailingBadges] of candidates) {
        const key = `${stripAnsi(plan)}\u0000${stripAnsi(trailingBadges)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const combined = [primary, plan, trailingBadges].filter(Boolean).join("  ");
        if (visibleLength(combined) > contentWidth) continue;
        return fitAnsiLine(`${indent}${combined}`, safeColumns);
      }
    }

    return fitAnsiLine(
      `${indent}${truncateAnsiText(title || primary, contentWidth)}`,
      safeColumns,
    );
  }

  paintComposerHeaderRow() {
    const session = this.rawInput;
    if (
      !session?.pinned ||
      session.done ||
      this.fullscreenOverlay ||
      !process.stdout.isTTY
    ) return false;
    const layout = this.rawInputLayout(session);
    const safeColumns = Math.max(1, layout.columns - 1);
    const painter = new FramePainter();
    painter
      .to(0, layout.headerRow)
      .clearLine()
      .text(this.composerHeaderLine(safeColumns));
    this.restoreComposerCursor(painter);
    painter.flush();
    return true;
  }

  updateComposerFooterInteractiveRegions(session, layout, footerLayout) {
    if (!session?.pinned || session.done || !layout || layout.footerRow === null) {
      this.composerInteractiveRegions = [];
      return;
    }
    const offset = this.composerCardContentColumn();
    this.composerInteractiveRegions = (footerLayout?.placements || []).map((region) => ({
      ...region,
      x1: offset + region.x1,
      x2: offset + region.x2,
      y1: layout.footerRow,
      y2: layout.footerRow,
    }));
  }

  paintComposerFooterRow() {
    const session = this.rawInput;
    if (!session?.pinned || session.done || this.fullscreenOverlay || !process.stdout.isTTY) {
      return false;
    }
    const layout = this.rawInputLayout(session);
    const safeColumns = Math.max(1, layout.columns - 1);
    const footer = this.composerFooterLayout(this.composerCardContentWidth(safeColumns));
    this.updateComposerFooterInteractiveRegions(session, layout, footer);
    const painter = new FramePainter();
    painter
      .to(0, layout.footerRow)
      .clearLine()
      .text(this.composerCardLine(footer.text, safeColumns));
    this.restoreComposerCursor(painter);
    painter.flush();
    return true;
  }

  // Selection-only navigation does not change composer geometry or transcript
  // content. Repaint just the shared upper panel to avoid clearing the card,
  // header, and transcript on every arrow/j/k press.
  paintComposerUpperPanelRows(session = this.rawInput) {
    if (!session?.pinned || session.done || !process.stdout.isTTY) return false;
    const layout = this.rawInputLayout(session);
    if (!layout.dropdownRows || layout.dropdownRow === null) return false;
    if (!sameRawInputLayout(this.lastRawInputLayout, layout)) return false;

    const safeColumns = Math.max(1, layout.columns - 1);
    const painter = new FramePainter();
    if (layout.dropdown?.kind === "hub-operation") {
      this.paintHubOperationSection(painter, layout, safeColumns);
    } else {
      this.paintAutocompleteDropdown(painter, layout, safeColumns);
    }
    this.restoreComposerCursor(painter);
    painter.flush();
    this.lastRawInputLayout = layout;
    return true;
  }

  repaintComposerUpperPanel(session = this.rawInput) {
    if (!this.paintComposerUpperPanelRows(session)) this.renderRawInput();
  }

  // The inline picker list, in the same upper panel as command autocomplete:
  // a title row, then the options (windowed around the selection when there
  // are more options than rows).
  paintInlinePickerDropdown(painter, layout, safeColumns) {
    const dropdown = layout.dropdown;
    const indent = " ".repeat(this.composerCardContentColumn());
    const itemRows = layout.dropdownRows - 1;
    const start = Math.min(
      Math.max(0, dropdown.index - itemRows + 1),
      Math.max(0, dropdown.matches.length - itemRows),
    );

    painter
      .to(0, layout.dropdownRow)
      .clearLine()
      .text(fitAnsiLine(`${indent}${c("bold", dropdown.title)}  ${c("muted", dropdown.hint)}`, safeColumns));

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
      const currentMark = item.current ? c("greenStrong", "● ") : "  ";
      const label = selected ? c("bold", stripAnsi(item.label)) : c("muted", stripAnsi(item.label));
      painter
        .to(0, target)
        .clearLine()
        .text(fitAnsiLine(`${indent}${marker} ${number} ${currentMark}${label}`, safeColumns));
    }
  }

  paintAutocompleteDropdown(painter, layout, safeColumns) {
    const dropdown = layout.dropdown;
    if (!dropdown) return;

    if (dropdown.kind === "quickselect") {
      this.paintInlinePickerDropdown(painter, layout, safeColumns);
      return;
    }

    const nameWidth = Math.min(
      24,
      Math.max(...dropdown.matches.map((entry) => visibleLength(entry.name))) + 2,
    );
    const indent = " ".repeat(this.composerCardContentColumn());
    const start = Math.min(
      Math.max(0, dropdown.index - layout.dropdownRows + 1),
      Math.max(0, dropdown.matches.length - layout.dropdownRows),
    );

    for (let row = 0; row < layout.dropdownRows; row += 1) {
      const index = start + row;
      const entry = dropdown.matches[index];
      const selected = index === dropdown.index;
      const marker = selected ? c("cyan", "❯") : " ";
      const name = selected ? c("bold", entry.name) : entry.name;
      const hint = entry.hint ? c("muted", entry.hint) : "";
      const padding = " ".repeat(Math.max(1, nameWidth - visibleLength(entry.name)));
      painter
        .to(0, layout.dropdownRow + row)
        .clearLine()
        .text(fitAnsiLine(`${indent}${marker} ${name}${hint ? `${padding}${hint}` : ""}`, safeColumns));
    }
  }

  paintHubOperationSection(painter, layout, safeColumns) {
    if (layout.dropdown?.kind !== "hub-operation" || layout.dropdownRow === null) return;
    const inset = this.composerCardContentColumn();
    const indent = " ".repeat(inset);
    const contentWidth = Math.max(8, safeColumns - inset * 2);
    const lines = this.hubOperationPanelLines(contentWidth, layout.dropdownRows);

    for (let row = 0; row < layout.dropdownRows; row += 1) {
      painter
        .to(0, layout.dropdownRow + row)
        .clearLine()
        .text(lines[row] ? fitAnsiLine(`${indent}${lines[row]}`, safeColumns) : "");
    }
  }

  composerMetaLine(text) {
    return `${" ".repeat(this.composerCardContentColumn())}${text || ""}`;
  }

  composerBadges(chat, status) {
    const badges = [];

    if (this.rawInput?.mouseSelectionMode) badges.push("[SELECT]");

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

  composerConfigControl(configId, kind, fallback = "") {
    const option = resolveConfigOption(this.currentChat?.configOptions || [], configId);
    const values = option ? configOptionMenuValues(option) : [];
    const current = values.find((entry) => configOptionValueMatches(option, entry.value));
    const preferred = current?.label && current.label !== current.value
      ? current.label
      : fallback || current?.value || "";
    return {
      label: composerControlLabel(preferred, kind),
      available: Boolean(option && values.length),
    };
  }

  composerAccessControl() {
    const raw = chatAccessLabel(this.currentChat || {});
    const entries = chatModeEntries(this.currentChat || {});
    const current = entries.find((entry) =>
      [entry?.id, entry?.modeId, entry?.name, entry?.label]
        .filter(Boolean)
        .some((value) => normalizeToken(value) === normalizeToken(raw)),
    );
    return {
      label: composerControlLabel(current?.name || current?.label || raw, "access"),
      available: entries.length > 0,
      elevated: Boolean(raw && /full|bypass|yolo|agent|write|edit/i.test(raw)),
    };
  }

  composerFooterSegments() {
    const chat = this.currentChat || {};
    const dim = (value) => (value ? c("muted", value) : "");
    const model = this.composerConfigControl(
      "model",
      "model",
      chatModel(chat) || chat.provider || "agent",
    );
    const effort = this.composerConfigControl("effort", "effort", chatEffort(chat));
    const access = this.composerAccessControl();
    const permission = this.composerPermissionLabel(chat);
    const usage = chat.usage || {};
    const usageRatio = Number(usage.size) > 0 ? Number(usage.used) / Number(usage.size) : 0;
    const card = (id, label, priority, control, tone = "") => ({
      id,
      group: "left",
      kind: "card",
      label,
      priority,
      control,
      tone,
    });
    const info = (id, text, priority, control = "") => ({
      id,
      group: "right",
      kind: "info",
      text,
      priority,
      control,
    });

    return [
      model.label ? card("model", model.label, 90, model.available ? "model" : "") : null,
      effort.label ? card("effort", effort.label, 58, effort.available ? "effort" : "") : null,
      access.label
        ? card(
            "access",
            access.label,
            135,
            access.available ? "access" : "",
            access.elevated ? "warning" : "",
          )
        : null,
      permission ? card("permission", stripAnsi(permission), 145, "access", "warning") : null,
      info("vim", this.vimBadgeLabel(), 72),
      info(
        "context",
        this.composerContextLabel(),
        usageRatio >= 0.85 ? 125 : usageRatio >= 0.6 ? 95 : 64,
      ),
      info("queue", this.composerQueueLabel(), 88),
      info("attachments", dim(this.composerAttachmentLabel()), 54),
      info("draft", this.composerDraftTokenLabel(), 48),
      info("mcp", dim(this.composerMcpLabel()), 28, "mcp"),
      info("roots", dim(this.composerRootsLabel(chat)), 22),
      info("path", dim(displayPath(chat.cwd || this.cwd)), 10),
    ].filter((segment) => segment && (segment.label || segment.text));
  }

  composerFooterChoiceText(spec, item, options = {}) {
    const key = options.key || `composer-footer:${spec.control}:option:${item.id}`;
    const pending = this.composerFooterSelectionPending;
    const hoveredChoicePrefix = `composer-footer:${spec.control}:option:`;
    const hoveredChoiceActive = String(this.hoveredInteractiveKey || "").startsWith(
      hoveredChoicePrefix,
    );
    const pendingChoiceActive = pending?.control === spec.control;
    const choicePreviewActive = hoveredChoiceActive || pendingChoiceActive;
    const itemHovered = this.hoveredInteractiveKey === key;
    const itemPending = Boolean(
      pendingChoiceActive && String(pending.value) === String(item.value),
    );
    const maxLabelWidth = Math.max(1, options.maxLabelWidth || 24);
    const label = visibleLength(item.label) <= maxLabelWidth
      ? item.label
      : maxLabelWidth >= 4
        ? truncateText(item.label, maxLabelWidth)
        : truncateAnsiText(item.label, maxLabelWidth);
    return renderComposerFooterChoice(
      label,
      {
        control: spec.control,
        // Expanded groups own exactly one bright accent. Hover (or an ACP
        // selection in flight) previews that candidate; leaving the group
        // restores the canonical current value.
        current: item.current && !choicePreviewActive,
        hovered: itemHovered || itemPending,
        pending: itemPending,
        disabled: Boolean(
          pendingChoiceActive && String(pending.value) !== String(item.value),
        ),
        palette: this.themePalette(),
      },
    );
  }

  // A transient expanded group owns the footer's horizontal budget. It keeps
  // the input/card geometry fixed, suppresses volatile diagnostics, and pages
  // only when all adapter-advertised values cannot fit on the same row.
  composerExpandedFooterLayout(width, segments, spec) {
    const constrained = Number.isFinite(width);
    const available = constrained ? Math.max(1, Math.floor(width)) : Number.POSITIVE_INFINITY;
    const state = this.composerFooterExpansion || { control: spec.control, offset: 0 };
    const baseLeft = segments.filter((segment) => segment.group === "left");
    const activeIndex = baseLeft.findIndex((segment) => segment.id === spec.control);
    if (activeIndex < 0) return null;

    let siblings = baseLeft.filter((segment) => segment.id !== spec.control);
    const staticText = (segment) => this.composerFooterSegmentText(segment, {
      primary: segment.id === "model",
    });
    const staticWidth = (items) => items.reduce(
      (sum, segment) => sum + visibleLength(staticText(segment)),
      0,
    );
    const groupGapWidth = (items) => Math.max(0, items.length) * 2;
    const fullChoiceWidth = spec.items.reduce(
      (sum, item) => sum + visibleLength(this.composerFooterChoiceText(spec, item)),
      0,
    );

    // Preserve safety/access metadata longer than ordinary sibling controls,
    // but never starve the expanded group below a useful one-choice viewport.
    const desiredGroupBudget = Math.min(fullChoiceWidth, 18);
    const budgetFor = (items) => {
      if (!constrained) return Number.POSITIVE_INFINITY;
      return available - staticWidth(items) - groupGapWidth(items);
    };
    while (siblings.length && budgetFor(siblings) < desiredGroupBudget) {
      const removable = [...siblings].sort((a, b) => a.priority - b.priority)[0];
      siblings = siblings.filter((segment) => segment !== removable);
    }

    const choiceBudget = Math.max(1, budgetFor(siblings));
    const allChoices = spec.items.map((item) => {
      const key = `composer-footer:${spec.control}:option:${item.id}`;
      const text = this.composerFooterChoiceText(spec, item, { key });
      return { item, key, text, width: visibleLength(text) };
    });
    const allChoicesWidth = allChoices.reduce(
      (sum, choice) => sum + choice.width,
      0,
    );

    let choices = allChoices;
    let paged = false;
    let start = 0;
    if (constrained && allChoicesWidth > choiceBudget) {
      paged = choiceBudget >= 9;
      if (paged) {
        const pagerWidth = 6; // adjacent " ‹ " + content + " › " cards
        const itemBudget = Math.max(3, choiceBudget - pagerWidth);
        start = Math.max(0, Math.min(allChoices.length - 1, Number(state.offset) || 0));
        choices = [];
        let used = 0;
        for (let index = start; index < allChoices.length; index += 1) {
          const source = allChoices[index];
          const remaining = Math.max(3, itemBudget - used);
          const maxLabelWidth = Math.max(1, remaining - 2);
          const text = this.composerFooterChoiceText(spec, source.item, {
            key: source.key,
            maxLabelWidth,
          });
          const itemWidth = visibleLength(text);
          const required = itemWidth;
          if (choices.length && used + required > itemBudget) break;
          choices.push({ ...source, text, width: itemWidth });
          used += required;
          if (used >= itemBudget) break;
        }
      } else {
        const item = allChoices[spec.currentIndex] || allChoices[0];
        const maxLabelWidth = Math.max(1, choiceBudget - 2);
        const text = this.composerFooterChoiceText(spec, item.item, {
          key: item.key,
          maxLabelWidth,
        });
        choices = [{ ...item, text, width: visibleLength(text) }];
      }
    }

    const choiceTokens = [];
    if (paged) {
      const previousKey = `composer-footer:${spec.control}:page:previous`;
      const nextKey = `composer-footer:${spec.control}:page:next`;
      const end = start + choices.length;
      const hasPrevious = start > 0;
      const hasNext = end < allChoices.length;
      choiceTokens.push({
        key: previousKey,
        text: renderComposerFooterChoice("‹", {
          control: spec.control,
          hovered: hasPrevious && this.hoveredInteractiveKey === previousKey,
          disabled: !hasPrevious || Boolean(this.composerFooterSelectionPending),
          accentOnHover: false,
          palette: this.themePalette(),
        }),
        action: hasPrevious ? "page-composer-footer-group" : "",
        delta: -1,
      });
      for (const choice of choices) {
        choiceTokens.push({
          ...choice,
          action: "select-composer-footer-option",
          control: spec.control,
          value: choice.item.value,
        });
      }
      choiceTokens.push({
        key: nextKey,
        text: renderComposerFooterChoice("›", {
          control: spec.control,
          hovered: hasNext && this.hoveredInteractiveKey === nextKey,
          disabled: !hasNext || Boolean(this.composerFooterSelectionPending),
          accentOnHover: false,
          palette: this.themePalette(),
        }),
        action: hasNext ? "page-composer-footer-group" : "",
        delta: 1,
      });
    } else {
      for (const choice of choices) {
        choiceTokens.push({
          ...choice,
          action: "select-composer-footer-option",
          control: spec.control,
          value: choice.item.value,
        });
      }
    }

    const siblingSet = new Set(siblings);
    const groups = baseLeft
      .map((segment) => {
        if (segment.id === spec.control) return { kind: "choices", tokens: choiceTokens };
        if (!siblingSet.has(segment)) return null;
        return { kind: "card", segment };
      })
      .filter(Boolean);
    const placements = [];
    let text = "";
    let cursor = 0;
    for (const [groupIndex, group] of groups.entries()) {
      if (groupIndex) {
        text += "  ";
        cursor += 2;
      }
      if (group.kind === "card") {
        const rendered = staticText(group.segment);
        const itemWidth = visibleLength(rendered);
        if (group.segment.control) {
          placements.push({
            key: `composer-footer:${group.segment.id}`,
            action: "open-composer-control",
            control: group.segment.control,
            x1: cursor,
            x2: Math.max(cursor, cursor + itemWidth - 1),
          });
        }
        text += rendered;
        cursor += itemWidth;
        continue;
      }

      for (const token of group.tokens) {
        const tokenWidth = visibleLength(token.text);
        if (token.action) {
          placements.push({
            key: token.key,
            action: token.action,
            control: token.control || spec.control,
            value: token.value,
            delta: token.delta,
            x1: cursor,
            x2: Math.max(cursor, cursor + tokenWidth - 1),
          });
        }
        text += token.text;
        cursor += tokenWidth;
      }
    }

    if (constrained && cursor > available) {
      text = truncateAnsiText(text, available);
      placements.splice(
        0,
        placements.length,
        ...placements
          .filter((region) => region.x1 < available)
          .map((region) => ({ ...region, x2: Math.min(region.x2, available - 1) })),
      );
      cursor = available;
    }
    return {
      text,
      width: cursor,
      placements,
      rightStart: cursor,
      segments: groups,
      expansion: {
        control: spec.control,
        paged,
        start,
        end: start + choices.length,
        total: spec.items.length,
      },
    };
  }

  composerFooterSegmentText(segment, options = {}) {
    if (segment.kind !== "card") return segment.text || "";
    const key = `composer-footer:${segment.id}`;
    return renderComposerMetadataCard(segment.label, {
      primary: options.primary === true,
      hovered: Boolean(segment.control && this.hoveredInteractiveKey === key),
      tone: segment.tone || "",
      control: segment.id,
      palette: this.themePalette(),
    });
  }

  // Build one left-to-right semantic flow. Stable config controls remain first,
  // followed immediately by volatile draft/session diagnostics; there is no
  // synthetic space-between gap. Low-priority diagnostics still disappear one
  // semantic unit at a time instead of being clipped through a value.
  composerFooterLayout(width = Number.POSITIVE_INFINITY) {
    const constrained = Number.isFinite(width);
    const available = constrained ? Math.max(1, Math.floor(width)) : Number.POSITIVE_INFINITY;
    let visible = this.composerFooterSegments();
    const expansion = !this.pendingPermission ? this.composerFooterExpansionSpec() : null;
    if (expansion) {
      const expanded = this.composerExpandedFooterLayout(width, visible, expansion);
      if (expanded) return expanded;
    }
    const separator = c("muted", " · ");

    const compose = (segments) => {
      const placements = [];
      let text = "";
      let cursor = 0;
      let previous = null;
      let rightStart = null;
      for (const segment of segments) {
        if (previous) {
          // Adjacent cards keep their one-cell visual gap. Diagnostics use the
          // ordinary dot separator, including the card→diagnostic boundary.
          const gap = previous.kind === "card" && segment.kind === "card"
            ? " "
            : separator;
          text += gap;
          cursor += visibleLength(gap);
        }
        if (rightStart === null && segment.group === "right") rightStart = cursor;
        const segmentText = this.composerFooterSegmentText(segment, {
          primary: segment.id === "model",
        });
        const segmentWidth = visibleLength(segmentText);
        if (segment.control) {
          placements.push({
            key: `composer-footer:${segment.id}`,
            action: "open-composer-control",
            control: segment.control,
            x1: cursor,
            x2: Math.max(cursor, cursor + segmentWidth - 1),
          });
        }
        text += segmentText;
        cursor += segmentWidth;
        previous = segment;
      }
      return {
        text,
        width: cursor,
        placements,
        rightStart: rightStart ?? cursor,
      };
    };

    let layout = compose(visible);
    while (constrained && layout.width > available && visible.length > 1) {
      const removable = [...visible].sort((a, b) => a.priority - b.priority)[0];
      visible = visible.filter((segment) => segment !== removable);
      layout = compose(visible);
    }

    if (constrained && layout.width > available) {
      layout.text = truncateAnsiText(layout.text, available);
      layout.width = Math.min(layout.width, available);
      layout.placements = layout.placements
        .filter((region) => region.x1 < available)
        .map((region) => ({ ...region, x2: Math.min(region.x2, available - 1) }));
    }
    return { ...layout, segments: visible };
  }

  composerFooter(width = Number.POSITIVE_INFINITY) {
    return this.composerFooterLayout(width).text;
  }

  composerPermissionLabel(chat) {
    const state = chat?.permissionState || {};
    if (state.pending) return c("yellow", "permission pending");
    if (state.activeOnce) {
      return c("yellow", `allow once: ${state.activeOnce.toolKind || "tool"}`);
    }
    const count = state.sessionGrants?.length || 0;
    if (count) return c("yellow", `${count} session grant${count === 1 ? "" : "s"}`);
    if (chat?.permissionPolicy === "deny") return c("green", "approvals denied");
    return "";
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

  submittedInputDisplayText(text) {
    const trimmed = normalizePastedText(text).trim();
    if (trimmed.startsWith("//")) return trimmed.slice(1);
    if (trimmed.startsWith("/agent ")) return trimmed.slice(7).trim();
    return trimmed;
  }

  layoutUserTurnRows(text, width, provider = this.currentChat?.provider || "") {
    const normalized = normalizePastedText(text).trim();
    if (!normalized) return [];

    const reset = colors.reset || "";

    const logicalLines = normalized.split("\n");
    const firstAttachment = logicalLines.findIndex(isSubmittedAttachmentLine);
    // Canonical events already carry this separator. Insert it for optimistic
    // and legacy records too, but never create a leading or duplicate gap.
    if (firstAttachment > 0 && logicalLines[firstAttachment - 1] !== "") {
      logicalLines.splice(firstAttachment, 0, "");
    }
    const contentWidth = Math.max(1, width || 1);
    const contentRows = logicalLines.flatMap((line) => {
      if (!line) return [{ text: "", attachment: false }];
      const attachment = isSubmittedAttachmentLine(line);
      const rows = attachment
        ? wrapAnsiWords(line, contentWidth)
        : layoutEditableLine(line, contentWidth, { atomicRanges: attachmentTokenRanges(line) }).map(
            (segment) => segment.text,
          );
      return rows.map((row) => ({ text: row, attachment }));
    });
    return contentRows.map(({ text: row, attachment }) => {
      const accent = this.themeAccentSeq(provider);
      const styled = attachment
        ? attachmentForeground(row, provider, accent)
        : styleAttachmentTokens(row, provider, accent);
      return `${colors.bold || ""}${styled}${reset}`;
    });
  }

  renderUserTurn(text) {
    // A blank line before the user turn separates it from the previous response;
    // the pending break inserts a gap before the next response starts.
    this.emitUserTurn(text);
    this.pendingResponseBreak = true;
  }

  renderProviderCommand(event) {
    const text = String(event?.text || "").trim();
    if (!text) return;
    this.logProse(c("bold", text), {
      leadingBlank: true,
      firstPrefix: c(providerColorName(this.currentChat?.provider), "⌘ "),
      continuationPrefix: "  ",
    });
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
      text = styleAttachmentTokens(
        text,
        this.currentChat?.provider,
        this.themeAccentSeq(this.currentChat?.provider),
      );
      return {
        text,
        // Cursor column in display columns (wide chars take two).
        cursorColumn: isCursorLine ? stringDisplayWidth(segment.text.slice(0, cursorUnits)) : 0,
      };
    });

    if (!line) {
      rows[0] = {
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

  mcpActionDescriptors() {
    return [
      { name: "list", hint: "show configured and effective servers" },
      { name: "diagnostics", hint: "show inventory and run local preflight" },
      { name: "test", hint: "preflight one server", arguments: true },
      { name: "add", hint: "create a managed server", arguments: true },
      { name: "edit", hint: "replace a managed server definition", arguments: true },
      { name: "enable", hint: "enable a managed server", arguments: true },
      { name: "disable", hint: "disable a managed server", arguments: true },
      { name: "remove", hint: "remove a managed server", arguments: true },
      { name: "apply", hint: "activate pending changes safely" },
    ];
  }

  mcpArgumentAutocomplete(session) {
    const line = session?.line || "";
    const cursor = Math.max(0, Math.min(session?.cursor ?? line.length, line.length));
    if (cursor !== line.length || line.includes("\n")) return null;
    const result = (query, matches, key) => {
      if (!matches.length) return null;
      const exactIndex = matches.findIndex(
        (entry) => entry.name.toLowerCase() === query.toLowerCase(),
      );
      if (exactIndex > 0) matches.unshift(...matches.splice(exactIndex, 1));
      if (
        matches.length === 1 &&
        matches[0].name.toLowerCase() === query.toLowerCase() &&
        !matches[0].trailingSpace
      ) {
        return null;
      }
      return {
        kind: "subcommand",
        token: query,
        matches: matches.slice(0, 6),
        replaceStart: line.length - query.length,
        replaceEnd: line.length,
        key,
      };
    };

    const scopeMatch = line.match(
      /^\/mcp\s+(?:add|edit)\b.*(?:--scope(?:=|\s))([^\s]*)$/i,
    );
    if (scopeMatch) {
      const query = scopeMatch[1];
      return result(
        query,
        ["global", "agent", "project", "agent-project"]
          .filter((name) => name.startsWith(query.toLowerCase()))
          .map((name) => ({ name, hint: "MCP scope", trailingSpace: false })),
        `mcp:scope:${query.toLowerCase()}`,
      );
    }

    const transportMatch = line.match(/^\/mcp\s+add\s+\S+\s+([^\s]*)$/i);
    if (transportMatch) {
      const query = transportMatch[1];
      return result(
        query,
        [
          { name: "stdio", hint: "local executable", trailingSpace: true },
          { name: "http", hint: "streamable HTTP endpoint", trailingSpace: true },
          { name: "sse", hint: "deprecated compatibility transport", trailingSpace: true },
        ].filter((entry) => entry.name.startsWith(query.toLowerCase())),
        `mcp:transport:${query.toLowerCase()}`,
      );
    }

    const serverMatch = line.match(
      /^\/mcp\s+(test|edit|enable|disable|remove)\s+([^\s]*)$/i,
    );
    if (serverMatch) {
      const action = serverMatch[1].toLowerCase();
      const query = serverMatch[2];
      const entries = this.mcpInventory?.entries || this.currentChat?.mcpServers || [];
      return result(
        query,
        entries
          .filter(
            (entry) =>
              (action === "test" || entry.source !== "static") &&
              String(entry.name || "").toLowerCase().startsWith(query.toLowerCase()),
          )
          .map((entry) => ({
            name: entry.name,
            replacement: /\s/.test(entry.name) ? shellQuote(entry.name) : entry.name,
            hint: `${entry.transport || "MCP"} · ${entry.status || entry.source || "configured"}`,
            trailingSpace: action === "edit",
          })),
        `mcp:${action}:${query.toLowerCase()}`,
      );
    }

    const actionMatch = line.match(/^\/mcp\s+([^\s]*)$/i);
    if (!actionMatch) return null;
    const query = actionMatch[1];
    return result(
      query,
      this.mcpActionDescriptors()
        .filter((action) => action.name.startsWith(query.toLowerCase()))
        .map((action) => ({
          name: action.name,
          hint: action.hint,
          trailingSpace: action.arguments === true,
        })),
      `mcp:action:${query.toLowerCase()}`,
    );
  }

  hubArgumentAutocomplete(session) {
    const line = session?.line || "";
    const cursor = Math.max(0, Math.min(session?.cursor ?? line.length, line.length));
    if (cursor !== line.length || line.includes("\n")) return null;

    const providerMatch = line.match(/^\/hub\s+(update|rollback)\s+([^\s]*)$/i);
    if (providerMatch) {
      const action = providerMatch[1].toLowerCase();
      const query = providerMatch[2];
      const providers = Object.entries(this.config?.agents || {})
        .filter(([, agent]) => npxAdapterPin(agent))
        .map(([provider]) => provider);
      if (action === "update" && providers.length) providers.push("all");
      const matches = [...new Set(providers)]
        .filter((provider) => provider.toLowerCase().startsWith(query.toLowerCase()))
        .map((provider) => ({
          name: provider,
          hint: provider === "all" ? "all managed adapters" : "configured agent",
          trailingSpace: false,
        }));
      if (!matches.length) return null;
      if (matches.length === 1 && matches[0].name.toLowerCase() === query.toLowerCase()) return null;
      const exactIndex = matches.findIndex((entry) => entry.name.toLowerCase() === query.toLowerCase());
      if (exactIndex > 0) matches.unshift(...matches.splice(exactIndex, 1));
      return {
        kind: "subcommand",
        token: query,
        matches: matches.slice(0, 5),
        replaceStart: line.length - query.length,
        replaceEnd: line.length,
        key: `hub:${action}:${query.toLowerCase()}`,
      };
    }

    const actionMatch = line.match(/^\/hub\s+([^\s]*)$/i);
    if (!actionMatch) return null;
    const query = actionMatch[1];
    const matches = this.hubActionDescriptors()
      .filter((action) => action.name.startsWith(query.toLowerCase()))
      .map((action) => ({
        name: action.name,
        hint: action.hint,
        trailingSpace: action.provider === true,
      }));
    if (!matches.length) return null;
    if (matches.length === 1 && matches[0].name === query.toLowerCase()) return null;
    const exactIndex = matches.findIndex((entry) => entry.name === query.toLowerCase());
    if (exactIndex > 0) matches.unshift(...matches.splice(exactIndex, 1));
    return {
      kind: "subcommand",
      token: query,
      matches: matches.slice(0, 5),
      replaceStart: line.length - query.length,
      replaceEnd: line.length,
      key: `hub:action:${query.toLowerCase()}`,
    };
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

    if (line.startsWith("/")) {
      const mcpArguments = this.mcpArgumentAutocomplete(session);
      if (mcpArguments) return mcpArguments;
      const hubArguments = this.hubArgumentAutocomplete(session);
      if (hubArguments) return hubArguments;

      const token = line.split(/\s+/)[0];
      const cursor = Math.max(0, Math.min(session.cursor, line.length));
      if (cursor > token.length) return null;

      const normalizedToken = token.toLowerCase();
      const matches = this.chatCommands().filter(
        (command) => command.name.toLowerCase().startsWith(normalizedToken),
      );
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
    if (!(this.shouldUseEnhancedComposer() && session.pinned !== false)) return null;

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
    } else if (dropdown.kind === "subcommand") {
      const replacement = `${entry.replacement || entry.name}${entry.trailingSpace ? " " : ""}`;
      session.line = `${session.line.slice(0, dropdown.replaceStart)}${replacement}${session.line.slice(dropdown.replaceEnd)}`;
      session.cursor = dropdown.replaceStart + replacement.length;
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
      this.repaintComposerUpperPanel(session);
      return true;
    }

    if (key.name === "up" || (key.ctrl && key.name === "p") || (key.name === "tab" && key.shift)) {
      session.autocompleteIndex = (dropdown.index - 1 + count) % count;
      this.repaintComposerUpperPanel(session);
      return true;
    }

    if (key.name === "tab") {
      this.acceptAutocomplete(session, dropdown);
      this.renderRawInput();
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      // An exactly-typed command falls through so Enter still submits.
      const selectedName = dropdown.matches[dropdown.index]?.name || "";
      const exactCommand = dropdown.kind === "command" && selectedName === dropdown.token;
      const exactSubcommand = dropdown.kind === "subcommand" &&
        selectedName.toLowerCase() === String(dropdown.token || "").toLowerCase();
      if (exactCommand || exactSubcommand) {
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
    if (!session.line.startsWith("/")) return;

    const token = session.line.split(/\s+/)[0];
    const normalizedToken = token.toLowerCase();
    const matches = this.chatCommands()
      .map((command) => command.name)
      .filter((name) => name.toLowerCase().startsWith(normalizedToken));

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
    const cancelConfirmation = this.turnCancelConfirmationLabel();
    if (cancelConfirmation) return cancelConfirmation;
    if (this.currentChat?.restoreFailure) {
      return "restore failed · Enter recovery choices · Ctrl+O Chats";
    }
    if (this.rawInput?.mouseSelectionMode) {
      return "selection mode · drag to select · terminal copy · Esc/F4 close";
    }
    if (this.scrollOffsetRows > 0) {
      const percent = Number(this.scrollPagePercent) || DEFAULT_SCROLL_PAGE_PERCENT;
      const page = percent === 50 ? "half-page" : `${percent}% page`;
      return `viewing transcript · PgUp/PgDn ${page} · wheel scroll · Home top · End/Esc latest`;
    }
    if (this.rawInput?.searchActive) {
      const matches = this.rawHistorySearchMatches(this.rawInput.searchQuery);
      const position = matches.length ? `${this.rawInput.searchIndex + 1}/${matches.length}` : "0/0";
      return `history ${position}: ${this.rawInput.searchQuery || "-"}`;
    }
    if (this.rawInput?.pasteActive) return "pasting block...";
    if (this.inlinePicker) {
      return "↑/↓ or j/k select · Enter/l accept · 1-9 direct · Esc/h close";
    }
    const autocomplete = this.activeAutocomplete(this.rawInput);
    if (autocomplete) {
      return "↑/↓ or Ctrl+N/Ctrl+P select · Tab/Enter accept · Esc close";
    }
    const withPlanGuide = (value) =>
      footerParts([
        this.planExpanded ? "Ctrl+P/Esc close plan · input active" : "",
        value,
      ]).join(" · ");
    if (!line && this.pendingAttachments.length) {
      return withPlanGuide(footerParts([
        this.rawInput?.lastPasteSummary,
        "Enter sends attachments",
        "Backspace removes last",
        "/detach all clears",
      ]).join(" · "));
    }
    if (!line && this.hubOperation) {
      if (this.hubOperation.status === "running") {
        return withPlanGuide("adapter maintenance continues · input remains active");
      }
      return withPlanGuide(
        this.hubOperation.status === "failed"
          ? "Enter adapter recovery actions · input remains active"
          : this.hubOperation.result?.requiresRestart
            ? "Enter restart options · input remains active"
            : "Enter dismisses adapter result · input remains active",
      );
    }
    if (this.rawInput?.lastPasteSummary) return withPlanGuide(this.rawInput.lastPasteSummary);
    const mention = this.currentFileMention(this.rawInput);
    if (mention) {
      const matches = this.fileMentionMatches(mention.query, 5);
      if (!matches.length) return withPlanGuide("@ no file matches");
      return withPlanGuide(matches.map((match) => `@${match}`).join(" "));
    }
    if (looksLikePathInput(line)) {
      const pathAttachments = attachmentsFromPathOnlyText(line, this.currentChat?.cwd || this.cwd);
      if (pathAttachments.length) {
        return withPlanGuide(`Enter attaches ${pastedAttachmentSummary(pathAttachments)}`);
      }
    }
    if (line && line.includes("\n")) return withPlanGuide("Enter sends · Ctrl+J newline");
    // Inside a chat the hint row is always kept, so typing never drops it and
    // slides the composer down. Keys are spelled out (Tab, Alt+E) — no glyph
    // soup — and no chat STATE is repeated here: mode/access/model live in
    // the footer above; this row only teaches the keys.
    if (!line) {
      if (!this.currentChat?.id) return "";
      const modes = chatModeEntries(this.currentChat);
      if (modes.length >= 2) {
        return withPlanGuide("← menu · Tab mode · Ctrl+X editor");
      }
      return withPlanGuide("← menu · Ctrl+X editor");
    }
    if (!line.startsWith("/")) {
      return this.currentChat?.id
        ? withPlanGuide("Enter sends · Ctrl+J newline · Ctrl+X editor · Ctrl+O menu")
        : "";
    }

    const token = line.split(/\s+/)[0];
    const normalizedToken = token.toLowerCase();
    const matches = this.chatCommands().filter(
      (command) => command.name.toLowerCase().startsWith(normalizedToken),
    );
    if (!matches.length) return withPlanGuide("unknown command");
    if (matches.length === 1 && matches[0].name === token) {
      return withPlanGuide(matches[0].hint);
    }

    return withPlanGuide(
      matches
        .slice(0, 5)
        .map((command) => command.name)
        .join(" "),
    );
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

  localChatCommands() {
    return [
      { name: "/menu", hint: "open agent/chat menu" },
      { name: "/control", hint: "open command center" },
      { name: "/cmd", hint: "open command center" },
      { name: "/panel", hint: "open command center" },
      { name: "/chats", hint: "show chat selector" },
      { name: "/compose", hint: "multiline prompt; finish with ." },
      { name: "/multiline", hint: "multiline prompt; finish with ." },
      { name: "/edit", hint: "write prompt in $VISUAL or $EDITOR" },
      { name: "/editor", hint: "write prompt in $VISUAL or $EDITOR" },
      { name: "/agent", hint: "send literal text to the provider" },
      { name: "/new", hint: "create another provider chat" },
      { name: "/refresh", hint: "import provider sessions" },
      { name: "/config", hint: "show or set ACP config options" },
      { name: "/model", hint: "set model config option" },
      { name: "/effort", hint: "set effort/reasoning option" },
      { name: "/reasoning", hint: "set effort/reasoning option" },
      { name: "/commands", hint: "show provider commands" },
      { name: "/modes", hint: "show provider modes" },
      { name: "/mode", hint: "set provider mode" },
      { name: "/access", hint: "set access alias" },
      { name: "/permissions", hint: "set access alias" },
      { name: "/plan", hint: "expand or configure the current plan" },
      { name: "/auth", hint: "authenticate with the current provider" },
      { name: "/mcp", hint: "manage, test, and apply MCP servers" },
      { name: "/details", hint: "expand or collapse turn activity" },
      { name: "/roots", hint: "manage additional directories" },
      { name: "/changes", hint: "browse edited files as diffs" },
      { name: "/diff", hint: "browse edited files as diffs" },
      { name: "/edits", hint: "browse edited files as diffs" },
      { name: "/attach", hint: "attach file(s) to next prompt" },
      { name: "/attachments", hint: "show pending attachments" },
      { name: "/files", hint: "show pending attachments" },
      { name: "/detach", hint: "remove pending attachments" },
      { name: "/cancel", hint: "cancel current turn" },
      { name: "/allow", hint: "approve permission option" },
      { name: "/deny", hint: "reject permission" },
      { name: "/rename", hint: "rename this chat" },
      { name: "/title", hint: "rename this chat" },
      { name: "/close", hint: "close this chat and keep its saved session" },
      { name: "/delete", hint: "permanently delete this chat" },
      { name: "/activity", hint: "tool activity: compact, hidden, debug" },
      { name: "/vim", hint: "toggle vim editing mode" },
      { name: "/debug", hint: "toggle hub internals" },
      { name: "/hub", hint: "open adapter versions and update manager" },
      { name: "/restart", hint: "restart the hub daemon (chats kept)" },
      { name: "/help", hint: "show command help" },
      { name: "/exit", hint: "close popup client" },
      { name: "/quit", hint: "close popup client" },
    ];
  }

  hubCommandForToken(token) {
    const normalized = String(token || "").toLowerCase();
    return this.localChatCommands().find(
      (command) => command.name.toLowerCase() === normalized,
    ) || null;
  }

  chatCommands(chat = this.currentChat) {
    return mergeCommandDescriptors(
      this.localChatCommands(),
      chat?.availableCommands || [],
    );
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
    if (this.transcriptPaintSuppressed()) return;
    this.beforeAsyncOutput();
    process.stdout.write(`${text}\n`);
    this.afterAsyncOutput();
  }

  logProse(text = "", options = {}) {
    if (!options.skipChunkFlush) {
      this.flushChunkBuffer({ force: true, preservePendingMarkdownTable: true });
    }
    if (options.leadingBlank) this.logLine("", { skipChunkFlush: true });

    const lines = normalizePastedText(text).split("\n");
    for (const line of lines) {
      if (!line.trim()) {
        this.logLine("", { skipChunkFlush: true });
        continue;
      }
      this.emitTranscriptEntry({
        kind: "prose",
        text: line,
        firstPrefix: options.firstPrefix || "",
        continuationPrefix: options.continuationPrefix,
        dim: options.dim === true,
      });
    }
  }

  hasPendingStreamState() {
    return Boolean(
      this.chunkBuffer || this.mdHeldLine !== null || this.liveTable || this.liveCodeBlock
    );
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
        // Detached/complete Markdown (picker previews and non-streaming
        // surfaces) can size the whole fence immediately. The live transcript
        // uses the incremental semantic block below instead.
        if (!this.markdownFence) {
          const closingIndex = lines.findIndex(
            (candidate, candidateIndex) =>
              candidateIndex > index && /^\s*```\s*$/.test(candidate),
          );
          if (closingIndex !== -1) {
            const targetWidth = Math.max(
              1,
              width ?? Math.max(24, (process.stdout.columns || 80) - 1),
            );
            output.push(
              this.layoutCompactCodeBlockRows(
                {
                  kind: "code-block",
                  lang: fence[1] || "",
                  lines: lines.slice(index + 1, closingIndex),
                },
                targetWidth,
              ).join("\n"),
            );
            index = closingIndex + 1;
            continue;
          }
        }
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
    const entry = this.markdownTranscriptEntry(line);
    if (!entry) return "";
    if (entry.kind === "rule") return c("dim", horizontalRuleLine(width));
    if (entry.kind === "hard") return String(entry.text || "");
    return `${entry.firstPrefix || ""}${entry.text || ""}`;
  }

  markdownTranscriptEntry(line) {
    if (!String(line || "").trim()) return null;

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      return { kind: "prose", text: c("bold", renderInlineMarkdown(heading[2].trim())) };
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) return { kind: "rule" };

    const quote = line.match(/^(\s*)>\s?(.*)$/);
    if (quote) {
      const prefix = `${quote[1]}${c("dim", "|")} `;
      return {
        kind: "prose",
        text: renderInlineMarkdown(quote[2]),
        firstPrefix: prefix,
        continuationPrefix: prefix,
      };
    }

    const task = line.match(/^(\s*)[-*+]\s+\[([ xX-])\]\s+(.+)$/);
    if (task) {
      const marker = /x/i.test(task[2]) ? c("greenStrong", "x") : c("dim", " ");
      const prefix = `${task[1]}[${marker}] `;
      return {
        kind: "prose",
        text: renderInlineMarkdown(task[3]),
        firstPrefix: prefix,
        continuationPrefix: " ".repeat(stringDisplayWidth(prefix)),
      };
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (unordered) {
      const prefix = `${unordered[1]}${c("dim", "-")} `;
      return {
        kind: "prose",
        text: renderInlineMarkdown(unordered[2]),
        firstPrefix: prefix,
        continuationPrefix: " ".repeat(stringDisplayWidth(prefix)),
      };
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      const prefix = `${ordered[1]}${c("dim", `${ordered[2]}.`)} `;
      return {
        kind: "prose",
        text: renderInlineMarkdown(ordered[3]),
        firstPrefix: prefix,
        continuationPrefix: " ".repeat(stringDisplayWidth(prefix)),
      };
    }

    return { kind: "prose", text: renderInlineMarkdown(line) };
  }

  emitMarkdownTranscriptLine(line) {
    let entry = this.markdownTranscriptEntry(line);
    if (!entry) {
      this.emitTranscript("\n");
      return;
    }
    if (this.chunkBufferDim) entry = { ...entry, dim: true };
    this.emitTranscriptEntry(entry);
  }

  flushChunkBuffer(options = {}) {
    // Markdown streamed into the pinned layout goes through the line machine:
    // tables render progressively and are re-painted in place as rows arrive.
    if (this.chunkBufferMarkdown) {
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
      if (!this.transcriptPaintSuppressed()) {
        this.beforeAsyncOutput();
        process.stdout.write(output);
        if (options.force && !output.endsWith("\n")) {
          process.stdout.write("\n");
        }
        this.afterAsyncOutput();
      }
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
      for (const line of lines) this.feedMarkdownLine(line);
      if (trailing) {
        // Active projections are snapshots, not real stream boundaries. A
        // leading pipe, the partial separator after a held header, or the next
        // unfinished row of a confirmed table is still ambiguous here;
        // emitting it as prose produces content that disappears once the table
        // catches up. Code fences are unambiguous and retain literal pipes.
        const pendingTableFragment =
          options.streamingSnapshot === true &&
          !this.markdownFence &&
          Boolean(
            this.liveTable ||
            this.mdHeldLine !== null ||
            /^\s*\|/.test(trailing),
          );
        if (!pendingTableFragment) this.feedMarkdownLine(trailing);
      }
    }

    if (options.force) {
      // A streaming snapshot leaves a possible header in mdHeldLine. Confirmed
      // tables/code are snapshotted by captureEventEntries; a settled turn uses
      // the normal finalizer and releases an unconfirmed candidate as prose.
      if (options.streamingSnapshot !== true) this.finalizeMarkdownStream();
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
      if (this.markdownFence) {
        this.startLiveCodeBlock(this.markdownFenceLang);
      }
      return;
    }

    if (this.markdownFence) {
      if (!this.liveCodeBlock) this.startLiveCodeBlock(this.markdownFenceLang);
      this.liveCodeBlock.entry.lines.push(line);
      this.scheduleLiveCodeBlockPaint();
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
      this.emitMarkdownTranscriptLine(held);
    }

    if (isMarkdownTableRow(line) && !isMarkdownTableSeparator(line)) {
      this.mdHeldLine = line;
      return;
    }

    this.emitMarkdownTranscriptLine(line);
  }

  finalizeMarkdownStream() {
    if (this.mdHeldLine !== null) {
      const held = this.mdHeldLine;
      this.mdHeldLine = null;
      this.emitMarkdownTranscriptLine(held);
    }
    this.finalizeLiveTable();
    this.finalizeLiveCodeBlock();
  }

  startLiveCodeBlock(lang = "") {
    this.finalizeLiveCodeBlock();
    // Keep one Markdown separator above a compact fence: its shaded top row is
    // internal padding, not a replacement for paragraph rhythm. Collapse only
    // excessive blank runs; the closing fence adds no external row below.
    let trailingBlanks = 0;
    while (
      trailingBlanks < this.transcriptEntries.length &&
      this.transcriptEntryIsBlank(this.transcriptEntries[this.transcriptEntries.length - 1 - trailingBlanks])
    ) trailingBlanks += 1;
    // One empty string is the structural append target. Two trailing strings
    // represent exactly one visible separator plus that append target.
    const normalizedBoundaryBlank = trailingBlanks > 2;
    if (normalizedBoundaryBlank) {
      this.transcriptEntries.splice(
        this.transcriptEntries.length - trailingBlanks,
        trailingBlanks - 2,
      );
    }
    const entry = {
      kind: "code-block",
      lang: String(lang || ""),
      lines: [],
      dim: this.chunkBufferDim,
    };
    const rendered = this.transcriptEntryRows(entry, this.transcriptWrapWidth());
    // Projection captures build this semantic block off-screen. Treat them as
    // deferred even when a pinned viewport exists, otherwise finalization can
    // accidentally paint the temporary capture before the canonical frame.
    const deferred = this.transcriptPaintSuppressed() || !this.canPaintPinned();
    const block = {
      entry,
      deferred,
      startIndex: -1,
      lineCount: rendered.length,
      paintedCount: deferred ? 0 : rendered.length,
      paintedSignature: deferred ? "" : rendered.join("\n"),
      rendered,
    };
    if (deferred) {
      this.liveCodeBlock = block;
      return;
    }

    block.startIndex = this.recordTranscriptEntry(entry);
    this.liveCodeBlock = block;
    if (normalizedBoundaryBlank && this.canPaintPinned()) {
      this.repaintPinnedOutput();
    } else if (rendered.length) {
      this.paintTranscriptRows(rendered, `${rendered.join("\n")}\n`);
    }
  }

  syncLiveCodeBlockBuffer() {
    const block = this.liveCodeBlock;
    if (!block) return [];
    const rendered = this.transcriptEntryRows(block.entry, this.transcriptWrapWidth());
    block.lineCount = rendered.length;
    block.rendered = rendered;
    return rendered;
  }

  scheduleLiveCodeBlockPaint() {
    const block = this.liveCodeBlock;
    if (!block) return;
    this.syncLiveCodeBlockBuffer();
    if (this.transcriptPaintSuppressed() || block.deferred) return;
    if (this.liveCodeBlockPaintTimer) {
      this.liveCodeBlockPaintPending = true;
      return;
    }

    this.paintLiveCodeBlock();
    const scheduledBlock = block;
    const timer = setTimeout(() => {
      if (this.liveCodeBlockPaintTimer === timer) this.liveCodeBlockPaintTimer = null;
      if (
        this.liveCodeBlockPaintPending &&
        this.liveCodeBlock === scheduledBlock
      ) {
        this.liveCodeBlockPaintPending = false;
        this.paintLiveCodeBlock();
      }
    }, LIVE_TABLE_PAINT_MS);
    this.liveCodeBlockPaintTimer = timer;
    timer.unref?.();
  }

  paintLiveCodeBlock() {
    const block = this.liveCodeBlock;
    if (!block) return;
    if (this.transcriptPaintSuppressed()) return;
    const previousCount = block.paintedCount;
    const rendered = this.syncLiveCodeBlockBuffer();
    const signature = rendered.join("\n");
    if (signature === block.paintedSignature) return;
    block.paintedCount = block.lineCount;
    block.paintedSignature = signature;

    if (this.activePicker || this.fullscreenOverlay) return;
    if (this.scrollOffsetRows > 0) {
      this.scrollNewRows += Math.max(0, block.lineCount - previousCount);
      if (this.rawInput) this.renderRawInput();
      return;
    }
    if (this.canPaintPinned()) this.repaintPinnedOutput();
  }

  finalizeLiveCodeBlock() {
    const block = this.liveCodeBlock;
    if (!block) return;
    if (this.liveCodeBlockPaintTimer) {
      clearTimeout(this.liveCodeBlockPaintTimer);
      this.liveCodeBlockPaintTimer = null;
    }
    this.liveCodeBlockPaintPending = false;
    this.syncLiveCodeBlockBuffer();

    if (block.deferred) {
      this.liveCodeBlock = null;
      this.emitTranscriptEntry(block.entry);
      return;
    }
    this.paintLiveCodeBlock();
    this.liveCodeBlock = null;
  }

  renderLiveTableLines(sourceLines, width = this.transcriptWrapWidth()) {
    return renderMarkdownTable(sourceLines)
      .split("\n")
      .map((row) => (visibleLength(row) > width ? truncateAnsiText(row, width) : row));
  }

  startLiveTable(sourceLines) {
    const source = [...sourceLines];
    const entry = { kind: "table", sourceLines: source, dim: this.chunkBufferDim };
    const rendered = this.transcriptEntryRows(entry, this.transcriptWrapWidth());
    const deferred = this.transcriptPaintSuppressed() || !this.canPaintPinned();
    const table = {
      sourceLines: source,
      entry,
      deferred,
      startIndex: -1,
      lineCount: rendered.length,
      paintedCount: deferred ? 0 : rendered.length,
      paintedSignature: deferred ? "" : rendered.join("\n"),
      rendered,
    };
    if (deferred) {
      this.liveTable = table;
      return;
    }

    table.startIndex = this.recordTranscriptEntry(entry);
    this.liveTable = table;
    this.paintTranscriptRows(rendered, `${rendered.join("\n")}\n`);
  }

  // Re-renders the streaming table with widths recomputed from all rows so far.
  // The transcript keeps the semantic source entry, so scrollback and resize
  // consume the same data while the live painter only tracks visual rows.
  syncLiveTableBuffer() {
    const table = this.liveTable;
    if (!table) return [];

    const rendered = this.transcriptEntryRows(table.entry, this.transcriptWrapWidth());
    table.lineCount = rendered.length;
    table.rendered = rendered;
    return rendered;
  }

  scheduleLiveTablePaint() {
    if (!this.liveTable) return;
    if (this.transcriptPaintSuppressed()) {
      this.syncLiveTableBuffer();
      return;
    }
    if (this.liveTable.deferred) return;
    this.syncLiveTableBuffer();

    if (this.liveTablePaintTimer) {
      this.liveTablePaintPending = true;
      return;
    }

    this.paintLiveTable();
    const scheduledTable = this.liveTable;
    const timer = setTimeout(() => {
      if (this.liveTablePaintTimer === timer) this.liveTablePaintTimer = null;
      if (
        this.liveTablePaintPending &&
        this.liveTable === scheduledTable
      ) {
        this.liveTablePaintPending = false;
        this.paintLiveTable();
      }
    }, LIVE_TABLE_PAINT_MS);
    this.liveTablePaintTimer = timer;
    timer.unref?.();
  }

  // Paints the current table block in place at the bottom of the scroll
  // region: scrolls up for rows added since the last paint, then rewrites the
  // visible block rows (widths may have changed).
  paintLiveTable() {
    const table = this.liveTable;
    if (!table) return;
    if (this.transcriptPaintSuppressed()) return;

    const rendered = table.rendered || this.syncLiveTableBuffer();
    const delta = table.lineCount - table.paintedCount;
    const signature = rendered.join("\n");
    if (signature === table.paintedSignature) return;
    table.paintedCount = table.lineCount;
    table.paintedSignature = signature;

    if (this.activePicker || this.fullscreenOverlay) return;

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
    this.lastTranscriptFrame = null;
  }

  finalizeLiveTable() {
    if (!this.liveTable) return;
    if (this.liveTable.deferred) {
      const entry = this.liveTable.entry;
      this.liveTable = null;
      this.emitTranscriptEntry(entry);
      return;
    }
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
    if (this.fullscreenOverlay) return;

    if (this.rawInput) {
      if (this.rawInput.pinned) {
        const layout = this.rawInputLayout(this.rawInput);
        const painter = new FramePainter();
        this.enableRawInputLayout(this.rawInput, layout, painter);
        this.clearRawInputLayoutRows([this.lastRawInputLayout, layout], painter);
        painter.to(0, layout.outputBottom - 1).flush();
      } else {
        this.clearRawInputLine();
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
    if (this.fullscreenOverlay) return;

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
      this.lastTranscriptFrame = null;
      process.stdout.write("\x1b[2J\x1b[H");
    }
  }

  composerNonTitleSignature() {
    const session = this.rawInput;
    if (!session?.pinned) return "";
    const layout = this.rawInputLayout(session);
    const planWidth = this.planDrawerContentWidth(layout.columns);
    return JSON.stringify({
      geometry: [
        layout.columns,
        layout.rows,
        layout.outputBottom,
        layout.planRows,
        layout.upperPanelKind,
        layout.upperPanelRows,
        layout.queueRows,
        layout.inputRows,
        layout.attachmentRows,
        layout.dropdownRows,
        layout.footerRow,
        layout.hintRows,
        layout.enhanced,
      ],
      accent: this.composerAccentSeq(),
      footer: this.composerFooter(this.composerCardContentWidth(layout.columns - 1)),
      hint: layout.hintRows ? this.inputHint(session.line) : "",
      suggestions: layout.dropdown
        ? layout.dropdown.kind === "hub-operation"
          ? {
              kind: layout.dropdown.kind,
              rows: layout.dropdownRows,
              operation: [
                layout.dropdown.operation?.id || "",
                layout.dropdown.operation?.status || "",
                layout.dropdown.operation?.phase || "",
                layout.dropdown.operation?.progressProvider || "",
                layout.dropdown.operation?.version || "",
                layout.dropdown.operation?.error || "",
                JSON.stringify(layout.dropdown.operation?.result || null),
              ],
            }
          : {
              kind: layout.dropdown.kind,
              key: layout.dropdown.key || "",
              title: layout.dropdown.title || "",
              index: layout.dropdown.index,
              rows: layout.dropdownRows,
              matches: (layout.dropdown.matches || [])
                .map((entry) => [stripAnsi(entry.name || entry.label || ""), Boolean(entry.current)]),
            }
        : null,
      plan: this.planDisplayLines(planWidth, layout.planRows),
      queue: layout.queueRows
        ? this.queueShelfLines(planWidth, layout.queueRows)
        : [],
    });
  }

  handleHubEvent(message) {
    if (this.closed) return;

    if (message.type === "adapter_operation") {
      this.setHubOperation(message.operation || null);
      return;
    }

    if (message.type === "adapter_update_progress") {
      // New daemons emit the durable operation snapshot before this legacy
      // compatibility event. Avoid a second transient notification that can
      // overwrite the phase shelf and make the UI look unresponsive.
      if (this.hubOperation) return;
      const update = message.update || {};
      const labels = {
        download: "downloading",
        verify: "verifying cached install",
        handshake: "testing ACP handshake",
        ready: "ready for restart",
      };
      this.notify(
        `${update.provider || "adapter"}@${update.version || "?"} · ${labels[update.phase] || update.phase || "updating"}`,
      );
      return;
    }

    if (message.type === "adapter_update_notice") {
      const updates = message.updates || [];
      if (updates.length) {
        const label = updates
          .map((entry) => `${entry.provider} ${entry.activeVersion}→${entry.availableVersion || "deprecated"}`)
          .join(" · ");
        this.notify(`adapter update available · ${label} · /hub updates`);
      }
      return;
    }

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
      // Mount the request in the composer's shared upper panel. If a full-screen
      // overlay currently owns the pane, resumeComposerFromOverlay retries it.
      this.maybeOpenPermissionPanel();
      return;
    }

    if (this.activePicker?.onEvent) {
      this.activePicker.onEvent(message);
    }

    if (message.type === "chat_state" && message.chat?.id === this.currentChat?.id) {
      const previousComposerSignature = this.composerNonTitleSignature();
      const titleChanged =
        message.chat.title && message.chat.title !== this.currentChat?.title;
      this.currentChat = message.chat;
      if (!this.currentChat.restoreFailure) this.autoShownRestoreFailureKey = null;
      if (!this.canCancelCurrentTurn()) {
        this.clearTurnCancelConfirmation(this.rawInput, { render: false });
      }
      if (!this.currentChat.plan?.entries?.length) {
        this.planExpanded = false;
      } else if (
        this.planExpanded &&
        this.planCompletedBehavior === "collapse" &&
        this.currentPlanPresentation()?.lifecycle === "completed"
      ) {
        this.planExpanded = false;
      }
      // Keep the bounded window name (#W, the tab's fallback) in step with
      // first-prompt, ACP, and manual title changes.
      if (titleChanged) this.syncTmuxWindow(this.currentChat, { force: true });
      this.refreshRawInputPrompt({ render: false });
      if (isSettledChatStatus(this.currentChat.status)) {
        this.flushChunkBuffer({ force: true });
      }
      if (titleChanged && this.rawInput?.pinned && this.canPaintPinned()) {
        this.renderRawInput({ forceOutput: true });
      } else if (
        previousComposerSignature &&
        previousComposerSignature === this.composerNonTitleSignature()
      ) {
        this.paintComposerHeaderRow();
      } else {
        this.renderRawInput();
      }
      if (
        this.currentChat.restoreFailure &&
        this.autoShownRestoreFailureKey !== this.restoreFailureKey()
      ) {
        queueMicrotask(() => this.maybeOpenRestoreRecoveryPanel());
      }
      if (titleChanged && !this.rawInput && this.canPaintPinned()) this.repaintPinnedOutput();
      return;
    }

    if (message.type === "chat_event" && message.chatId === this.currentChat?.id) {
      const previousQueueSignature = JSON.stringify(this.queuedRequestItems());
      const permissionDecision = message.event?.type === "permission_decision";
      if (permissionDecision) {
        // Another popup/client may have answered the request. Drop a matching
        // local picker before composing the next frame so Plan/queue is restored
        // without flashing a stale permission menu.
        this.clearPendingPermissionUi(message.event?.permissionId || "", { render: false });
      }
      this.currentChat = message.chat || this.currentChat;
      this.refreshRawInputPrompt({ render: false });
      this.appendHistoryEvent(message.event);
      this.reconcilePromptSubmission(message.event);
      if (message.event?.type === "queue_dropped") {
        for (const clientPromptId of message.event.clientPromptIds || []) {
          this.discardPromptSubmission(clientPromptId, { render: false });
        }
      }
      const queueChanged =
        previousQueueSignature !== JSON.stringify(this.queuedRequestItems());
      const permissionChanged = ["permission", "permission_decision"].includes(
        message.event?.type,
      );
      const projectionImmediate = [
        "user",
        "command",
        "turn_done",
        "error",
        "permission_decision",
      ].includes(message.event?.type);
      this.scheduleTranscriptProjection({
        // A raw permission request has no normal transcript projection. Its
        // dedicated permission_request message immediately mounts the shelf,
        // avoiding a header-only frame just before the choices appear.
        immediate: projectionImmediate,
        renderComposer: queueChanged || permissionChanged,
      });
      if (
        this.rawInput &&
        (queueChanged || permissionChanged) &&
        !projectionImmediate &&
        message.event?.type !== "permission" &&
        !["user", "command"].includes(message.event?.type)
      ) {
        // Non-immediate queue changes may be batched on the transcript timer;
        // the shelf itself should still react immediately. Immediate
        // projections already paint transcript and composer atomically.
        this.renderRawInput();
      }
    }
  }

  refreshRawInputPrompt(options = {}) {
    if (!this.rawInput) return;
    this.rawInput.prompt = this.inputPrompt();
    this.syncComposerAnimation();
    if (options.render !== false) this.renderRawInput();
  }

  composerStatusAnimationMode() {
    return STATUS_ANIMATION_MODES.includes(this.statusAnimation)
      ? this.statusAnimation
      : DEFAULT_STATUS_ANIMATION;
  }

  composerStatusCanAnimate(status = this.currentChat?.status) {
    return ANIMATED_COMPOSER_STATUSES.has(normalizeToken(status || ""));
  }

  composerStatusAnimationInterval() {
    return Math.max(
      80,
      Math.min(600, Number(this.statusAnimationIntervalMs) || DEFAULT_STATUS_ANIMATION_INTERVAL_MS),
    );
  }

  composerStatusAnimationPauseFrames() {
    const configuredPause = Number(this.statusAnimationPauseMs);
    const pauseMs = Number.isFinite(configuredPause)
      ? Math.max(0, Math.min(3000, configuredPause))
      : DEFAULT_STATUS_ANIMATION_PAUSE_MS;
    return Math.ceil(pauseMs / this.composerStatusAnimationInterval());
  }

  syncComposerAnimation() {
    const status = normalizeToken(this.currentChat?.status || "");
    const mode = this.composerStatusAnimationMode();
    const animationKey = `${status}:${mode}`;
    if (animationKey !== this.composerAnimationKey) {
      this.composerAnimationKey = animationKey;
      this.composerAnimationFrame = 0;
    }

    if (
      this.fullscreenOverlay ||
      !this.rawInput?.pinned ||
      mode === "off" ||
      !this.composerStatusCanAnimate(status)
    ) {
      this.stopComposerAnimation();
      return;
    }

    if (this.composerAnimationTimer) return;
    const interval = this.composerStatusAnimationInterval();
    this.composerAnimationTimer = setInterval(() => {
      if (
        this.fullscreenOverlay ||
        !this.rawInput?.pinned ||
        this.composerStatusAnimationMode() === "off" ||
        !this.composerStatusCanAnimate()
      ) {
        this.stopComposerAnimation();
        if (this.rawInput) this.paintComposerHeaderRow();
        return;
      }

      this.composerAnimationFrame += 1;
      this.paintComposerHeaderRow();
    }, interval);
    this.composerAnimationTimer.unref?.();
  }

  stopComposerAnimation() {
    if (!this.composerAnimationTimer) return;
    clearInterval(this.composerAnimationTimer);
    this.composerAnimationTimer = null;
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
    // window yet. That left the chat window's metadata (including the id the
    // daemon keys its own sync on) unset until a reattach forced a refresh.
    const ownPane = process.env.TMUX_PANE || "";
    const values = tmuxWindowOptionValues(chat);
    setTmuxWindowOptions(values, ownPane);
    // Re-assert the session's ACP status format too — the popup/daemon boot
    // race can revert it to the theme default; then the tab falls back to the
    // bounded window name, so it remains safe even during that fallback.
    applyAcpStatusFormat(ownPane);

    // Keep #W bounded too, so a temporary fallback to the raw window name can
    // never let the canonical title monopolise the tab strip.
    const windowName = values["@acp_hub_tab_title"];
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
          this.logProse(c("red", event.text), {
            leadingBlank: true,
            firstPrefix: c("red", "✗ "),
            continuationPrefix: "  ",
          });
        } else if (event.level === "warn") {
          this.logProse(c("yellow", event.text), {
            leadingBlank: true,
            firstPrefix: c("yellow", "⚠ "),
            continuationPrefix: "  ",
          });
        } else if (this.showInternalEvents) {
          const prefix = c("dim", `[${event.level || "info"}] `);
          this.logProse(c("dim", event.text), {
            firstPrefix: prefix,
            continuationPrefix: " ".repeat(stringDisplayWidth(prefix)),
          });
        }
        break;
      case "adapter_log":
        if (!options.replay && this.showInternalEvents) {
          const prefix = c("dim", "[adapter] ");
          this.logProse(c("dim", event.text), {
            firstPrefix: prefix,
            continuationPrefix: " ".repeat(stringDisplayWidth(prefix)),
          });
        }
        break;
      case "user":
        if (options.replay) this.renderUserTurn(event.text);
        break;
      case "command":
        if (options.replay) this.renderProviderCommand(event);
        break;
      case "command_result":
        this.logProse(event.text || "Command completed", {
          leadingBlank: true,
          firstPrefix: c("dim", "  "),
          continuationPrefix: "  ",
        });
        break;
      case "agent_chunk":
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
        this.renderPermission(event, options);
        break;
      case "permission_decision":
        this.renderPermissionDecision(event);
        break;
      case "auth_required":
        this.logProse(c("yellow", event.text || "Authentication required"), {
          leadingBlank: true,
          firstPrefix: c("yellow", "⏸ "),
          continuationPrefix: "  ",
        });
        break;
      case "history_boundary":
        this.logProse(
          c(
            "dim",
            event.partialTurn
              ? "Earlier history is incomplete; this restored turn began before the retained transcript."
              : "Earlier turns were omitted by the configured history retention limit.",
          ),
          {
            leadingBlank: true,
            firstPrefix: c("dim", "… "),
            continuationPrefix: "  ",
          },
        );
        break;
      case "turn_done":
        this.flushChunkBuffer({ force: true });
        this.pendingResponseBreak = false;
        this.lastStreamEventKey = "";
        this.markdownFence = false;
        if (this.showInternalEvents || event.stopReason === "cancelled") {
          this.logLine(c("dim", `\n[done] ${event.stopReason}`));
        }
        break;
      case "error":
        this.logProse(c("red", event.text), {
          leadingBlank: true,
          firstPrefix: c("red", "✗ "),
          continuationPrefix: "  ",
        });
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
      if (!this.transcriptPaintSuppressed()) {
        this.beforeAsyncOutput();
        process.stdout.write("\n");
        this.afterAsyncOutput();
      }
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
      const prefix = `${c("red", "✗")} `;
      this.logProse(`${c("red", status)}${kind ? ` ${kind}` : ""} ${cleanInline(title)}`, {
        leadingBlank: true,
        firstPrefix: prefix,
        continuationPrefix: "  ",
      });
      if (event.summary) this.logProse(c("dim", event.summary));
      return;
    }

    if (this.showInternalEvents || this.activityMode === "debug") {
      const color = failed ? "red" : "yellow";
      const prefix = `${c(color, "[tool]")} `;
      this.logProse(`${status}${kind ? ` ${kind}` : ""} ${title}`, {
        leadingBlank: true,
        firstPrefix: prefix,
        continuationPrefix: " ".repeat(stringDisplayWidth(prefix)),
      });
      if (event.summary) this.logProse(c("dim", event.summary));
      return;
    }

    // Compact mode projects tool lifecycles into semantic activity groups
    // before renderEvent is called. Hidden mode deliberately emits nothing;
    // debug mode returned above with the raw lifecycle event.
  }

  // One file's unified diff: a "path (+A -B)" header, then colored rows —
  // green additions, red deletions, dim context, "⋮" between hunks.
  renderDiff(diff) {
    const added = c("greenStrong", `+${diff.added}`);
    const removed = c("red", `-${diff.removed}`);
    this.logLine(`      ${c("bold", diff.path)} ${c("dim", "(")}${added} ${removed}${c("dim", ")")}`);

    diff.hunks.forEach((hunk, index) => {
      if (index > 0) this.logLine(c("dim", "      ⋮"));
      for (const row of hunk.rows) {
        if (row.sign === "+") this.logLine(c("greenStrong", `      + ${row.text}`));
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
      label: `${diff.path}  ${c("greenStrong", `+${diff.added}`)} ${c("red", `-${diff.removed}`)}`,
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

  renderPlan(entries, options = {}) {
    if (!entries.length) return;

    const signature = entries.map((entry) => `${entry.status}\x00${cleanInline(entry.content)}`).join("\x01");
    // ACP re-sends the whole plan on every status change; skip identical repeats
    // so the transcript shows progression instead of duplicate blocks.
    if (!options.replay && signature === this.lastPlanSignature) return;
    this.lastPlanSignature = signature;

    const done = entries.filter((entry) => entry.status === "completed").length;
    this.logLine(`\n${c("bold", "Plan")} ${c("dim", `(${done}/${entries.length})`)}`);
    for (const entry of entries) {
      const prefix = `  ${planMarker(entry.status)} `;
      this.logProse(renderInlineMarkdown(cleanInline(entry.content)), {
        firstPrefix: prefix,
        continuationPrefix: " ".repeat(stringDisplayWidth(prefix)),
      });
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

  handlePlanCommand(argument = "") {
    const [action = "", value = ""] = String(argument).trim().toLowerCase().split(/\s+/, 2);
    if (!action || action === "open" || action === "expand") {
      if (this.shouldUsePinnedInput()) this.togglePlanExpanded(true);
      else this.showPlan();
      return;
    }
    if (action === "close" || action === "collapse") {
      this.togglePlanExpanded(false);
      return;
    }
    if (action === "toggle") {
      this.togglePlanExpanded();
      return;
    }

    let mode = null;
    if (action === "show") mode = "on";
    else if (action === "hide") mode = "off";
    else if (action === "pin") mode = value || "auto";
    if (mode && ["auto", "on", "off"].includes(mode)) {
      this.planPinMode = mode;
      if (mode === "off") this.planExpanded = false;
      this.notify(`plan pin: ${mode}`);
      if (this.rawInput) this.renderRawInput();
      return;
    }

    if (action === "awaiting" && ["auto", "on", "off"].includes(value)) {
      this.planAwaitingPolicy = value;
      this.notify(`plan awaiting: ${value}`);
      if (this.rawInput) this.renderRawInput();
      return;
    }

    this.notify(
      "usage: /plan [open|close|toggle|pin auto|pin on|pin off|awaiting auto|on|off]",
    );
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
      this.logProse(c("red", `Auth failed: ${error.message}`));
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

  mcpStatusGlyph(status) {
    const value = normalizeToken(status);
    if (value === "applied" || value === "ready") return c("greenStrong", "●");
    if (value === "pending" || value === "applying") return c("yellow", "◐");
    if (value === "failed" || value === "invalid") return c("red", "!");
    if (value === "unsupported" || value === "overridden" || value === "out-of-scope") {
      return c("muted", "○");
    }
    if (value === "disabled") return c("muted", "◌");
    return c("muted", "·");
  }

  mcpScopeLabel(entry) {
    const type = entry?.scopeType || "global";
    if (type === "agent+project") return `${entry.scope?.provider || "agent"} · project`;
    if (type === "agent") return entry.scope?.provider || "agent";
    if (type === "project") return "project";
    return "global";
  }

  async fetchMcpInventory() {
    const chatId = this.currentChat?.id;
    if (!chatId) throw new Error("No active chat");
    const inventory = await this.hub.call("mcp_list", { chatId });
    this.mcpInventory = inventory;
    return inventory;
  }

  mcpEntryFor(inventory, token) {
    const value = String(token || "").trim().toLowerCase();
    if (!value) return null;
    return (inventory.entries || []).find(
      (entry) =>
        String(entry.id).toLowerCase() === value ||
        String(entry.name).toLowerCase() === value,
    ) || null;
  }

  parseMcpDefinitionArguments(text, existing = null) {
    const words = Array.isArray(text) ? text.map(String) : splitCommandWords(text);
    if (words.length < 3) {
      throw new Error(
        "usage: /mcp add <name> <stdio command|http url> [args] [--scope global|agent|project|agent-project]",
      );
    }
    const [name, transportRaw, target, ...tail] = words;
    const transport = normalizeToken(transportRaw);
    if (!["stdio", "http", "sse"].includes(transport)) {
      throw new Error("MCP transport must be stdio, http, or sse");
    }
    const args = [];
    const env = [];
    const headers = [];
    let scopeName = "project";
    for (let index = 0; index < tail.length; index += 1) {
      const item = tail[index];
      if (item === "--scope") {
        scopeName = normalizeToken(tail[++index] || "");
        continue;
      }
      if (item.startsWith("--scope=")) {
        scopeName = normalizeToken(item.slice(8));
        continue;
      }
      if (item === "--env" || item === "--header") {
        const pair = tail[++index] || "";
        const equals = pair.indexOf("=");
        if (equals < 1) throw new Error(`${item} requires NAME=value`);
        const record = { name: pair.slice(0, equals), value: pair.slice(equals + 1) };
        (item === "--env" ? env : headers).push(record);
        continue;
      }
      args.push(item);
    }
    const scopes = {
      global: { provider: null, project: null },
      agent: { provider: "current", project: null },
      project: { provider: null, project: "current" },
      "agent-project": { provider: "current", project: "current" },
      "agent+project": { provider: "current", project: "current" },
    };
    if (!scopes[scopeName]) throw new Error(`unknown MCP scope: ${scopeName}`);
    return {
      ...(existing?.id ? { id: existing.id } : {}),
      name,
      transport,
      scope: scopes[scopeName],
      ...(transport === "stdio"
        ? { command: target, args, env }
        : { url: target, headers }),
    };
  }

  async applyMcpConfiguration() {
    const chatId = this.currentChat?.id;
    if (!chatId) return false;
    const result = await this.hub.call("mcp_apply", { chatId });
    if (result.chat) this.currentChat = result.chat;
    if (result.pending) {
      if (result.requiresNewSession) {
        this.notify("MCP is pending · this adapter cannot reload the current session; open a new chat to activate it");
      } else {
        this.notify("MCP change queued · it will apply when the current turn becomes idle");
      }
    } else if (result.ok && result.changed) {
      this.notify("MCP configuration applied");
    } else if (result.ok) {
      this.notify("MCP configuration already applied");
    } else {
      this.notify(`MCP apply failed: ${result.error || "unknown error"}`);
    }
    if (this.rawInput) this.renderRawInput();
    return result.ok === true;
  }

  seedMcpAddDraft() {
    const session = this.rawInput;
    if (!session || session.done) return false;
    if (session.line.trim()) {
      this.notify("current draft kept · clear it before inserting an MCP add template");
      return true;
    }
    const template = "/mcp add server-name stdio command --scope project";
    session.line = template;
    session.cursor = template.indexOf("server-name");
    session.selection = null;
    this.saveRawDraft(session);
    this.renderRawInput();
    this.notify("edit the MCP template, then press Enter");
    return true;
  }

  async testMcpEntry(entry = null) {
    const result = await this.hub.call("mcp_test", {
      chatId: this.currentChat.id,
      id: entry?.id || null,
    });
    const failed = (result.results || []).filter((item) => !item.ok);
    const warnings = (result.results || []).flatMap((item) => item.warnings || []);
    if (failed.length) {
      this.notify(
        failed.map((item) => `${item.name}: ${item.errors.join("; ")}`).join(" · "),
      );
      return false;
    }
    this.notify(
      `MCP preflight ready${warnings.length ? ` · ${warnings.join("; ")}` : ""}`,
    );
    return true;
  }

  async showMcpEntryActions(entry) {
    const managed = entry.source === "managed";
    const items = [
      {
        label: `${this.mcpStatusGlyph(entry.status)} Test preflight${c("muted", " · config, executable and capabilities")}`,
        value: "test",
      },
      ...(managed
        ? [
            {
              label: entry.enabled
                ? `Disable${c("muted", " · keep configuration")}`
                : `Enable${c("muted", " · mark pending")}`,
              value: entry.enabled ? "disable" : "enable",
            },
            {
              label: c("red", `Remove · ${entry.name}`),
              value: "remove",
            },
          ]
        : []),
      {
        label: `Apply pending changes${c("muted", " · reconnect ACP session safely")}`,
        value: "apply",
      },
    ];
    const action = await this.quickSelect({
      title: `MCP · ${entry.name} · ${entry.source}`,
      hint: "j/k move · Enter/l · Esc/h back",
      items,
      purpose: "mcp-actions",
      requestId: entry.id,
    });
    if (action === null) return true;
    if (action === "test") return this.testMcpEntry(entry);
    if (action === "apply") return this.applyMcpConfiguration();
    if (action === "enable" || action === "disable") {
      const result = await this.hub.call("mcp_toggle", {
        chatId: this.currentChat.id,
        id: entry.id,
        enabled: action === "enable",
      });
      this.notify(`${entry.name} ${action === "enable" ? "enabled" : "disabled"} · pending apply`);
      if (result.inventory?.pending && this.rawInput) this.renderRawInput();
      return true;
    }
    if (action === "remove") {
      const confirmed = await this.quickSelect({
        title: `Remove MCP · ${entry.name}?`,
        hint: "Enter confirms · Esc keeps it",
        items: [
          { label: c("red", "Remove managed configuration"), value: "remove" },
          { label: "Keep server", current: true, value: "keep" },
        ],
        purpose: "mcp-remove",
        requestId: entry.id,
      });
      if (confirmed !== "remove") return true;
      await this.hub.call("mcp_remove", {
        chatId: this.currentChat.id,
        id: entry.id,
      });
      this.notify(`${entry.name} removed · pending apply`);
      return true;
    }
    return true;
  }

  async showMcpAdminPicker() {
    if (!this.currentChat?.id) return false;
    let inventory;
    try {
      inventory = await this.fetchMcpInventory();
    } catch (error) {
      this.notify(`MCP inventory failed: ${error.message || String(error)}`);
      return false;
    }
    const entries = inventory.entries || [];
    const items = entries.map((entry) => ({
      label: `${this.mcpStatusGlyph(entry.status)} ${entry.name}  ${c("muted", `${entry.transport} · ${this.mcpScopeLabel(entry)} · ${entry.status}`)}`,
      searchText: `${entry.name} ${entry.transport} ${entry.scopeType} ${entry.source} ${entry.status}`,
      current: entry.applied === true,
      value: `entry:${entry.id}`,
    }));
    if (inventory.pending) {
      items.unshift({
        label: `${c("yellow", "◐")} Apply pending MCP changes${c("muted", " · reconnect safely")}`,
        value: "apply",
      });
    }
    if (inventory.registry?.recovered) {
      items.unshift({
        label: `${c("yellow", "!")} MCP registry recovered${c("muted", inventory.registry.backupFile ? " · corrupt file preserved" : " · inspect /mcp diagnostics")}`,
        value: "registry-recovery",
      });
    }
    items.push({
      label: `＋ Add server${c("muted", " · /mcp add <name> <stdio|http> <target>")}`,
      value: "help-add",
    });
    if (!entries.length) {
      items.unshift({
        label: c("muted", "No MCP servers configured"),
        value: "help-add",
      });
    }
    const picked = await this.quickSelect({
      title: `MCP · ${inventory.provider} · ${entries.length} configured`,
      hint: "j/k move · Enter actions · / filter · Esc/h",
      items,
      purpose: "mcp-admin",
      requestId: this.currentChat.id,
    });
    if (picked === null) return true;
    if (picked === "apply") return this.applyMcpConfiguration();
    if (picked === "registry-recovery") {
      this.notify(
        inventory.registry?.backupFile
          ? `corrupt MCP registry preserved at ${inventory.registry.backupFile}`
          : `MCP registry recovered: ${inventory.registry?.recoveryReason || "invalid data"}`,
      );
      return true;
    }
    if (picked === "help-add") {
      return this.seedMcpAddDraft();
    }
    const entry = entries.find((candidate) => `entry:${candidate.id}` === picked);
    if (entry) return this.showMcpEntryActions(entry);
    return true;
  }

  printMcpInventory(inventory) {
    this.logLine("");
    this.logLine(c("bold", `MCP · ${inventory.provider}`));
    for (const entry of inventory.entries || []) {
      const target = entry.url || entry.command || "";
      this.logLine(
        `${this.mcpStatusGlyph(entry.status)} ${c("bold", entry.name)}  ${c("muted", `${entry.transport} · ${this.mcpScopeLabel(entry)} · ${entry.source} · ${entry.status}`)}`,
      );
      if (target) this.logLine(c("muted", `   ${target}`));
      if (entry.statusDetail) this.logLine(c("yellow", `   ${entry.statusDetail}`));
    }
    if (inventory.pending) this.logLine(c("yellow", "Pending changes · /mcp apply"));
    if (inventory.registry?.recovered) {
      this.logLine(
        c(
          "yellow",
          inventory.registry.backupFile
            ? `Registry recovered · backup: ${inventory.registry.backupFile}`
            : `Registry recovered · ${inventory.registry.recoveryReason || "invalid data"}`,
        ),
      );
    }
  }

  async handleMcpCommand(argument = "") {
    const words = splitCommandWords(argument);
    const action = normalizeToken(words[0] || "");
    try {
      if (!action) {
        if (await this.showMcpAdminPicker()) return true;
        this.printMcpInventory(await this.fetchMcpInventory());
        return true;
      }
      if (action === "list" || action === "diagnostics") {
        const inventory = await this.fetchMcpInventory();
        this.printMcpInventory(inventory);
        if (action === "diagnostics") await this.testMcpEntry();
        return true;
      }
      if (action === "apply") return this.applyMcpConfiguration();
      if (action === "test") {
        const inventory = await this.fetchMcpInventory();
        const entry = words[1] ? this.mcpEntryFor(inventory, words[1]) : null;
        if (words[1] && !entry) throw new Error(`unknown MCP server: ${words[1]}`);
        return this.testMcpEntry(entry);
      }
      if (action === "add") {
        const server = this.parseMcpDefinitionArguments(words.slice(1));
        const result = await this.hub.call("mcp_upsert", {
          chatId: this.currentChat.id,
          server,
        });
        this.notify(`${result.server.name} added · /mcp apply`);
        return true;
      }
      if (action === "edit") {
        const inventory = await this.fetchMcpInventory();
        const entry = this.mcpEntryFor(inventory, words[1]);
        if (!entry) throw new Error(`unknown MCP server: ${words[1] || ""}`);
        if (entry.source !== "managed") throw new Error("static MCP entries are edited in agents.json");
        if (words.length < 5) {
          throw new Error("usage: /mcp edit <name|id> <name> <transport> <target> ...");
        }
        const server = this.parseMcpDefinitionArguments(words.slice(2), entry);
        await this.hub.call("mcp_upsert", { chatId: this.currentChat.id, server });
        this.notify(`${server.name} updated · /mcp apply`);
        return true;
      }
      if (["enable", "disable", "remove"].includes(action)) {
        const inventory = await this.fetchMcpInventory();
        const entry = this.mcpEntryFor(inventory, words[1]);
        if (!entry) throw new Error(`unknown MCP server: ${words[1] || ""}`);
        if (entry.source !== "managed") throw new Error("static MCP entries are managed in agents.json");
        await this.hub.call(action === "remove" ? "mcp_remove" : "mcp_toggle", {
          chatId: this.currentChat.id,
          id: entry.id,
          ...(action === "remove" ? {} : { enabled: action === "enable" }),
        });
        this.notify(`${entry.name} ${action}d · /mcp apply`);
        return true;
      }
      throw new Error(
        "usage: /mcp [list|add|edit|enable|disable|remove|test|apply|diagnostics]",
      );
    } catch (error) {
      this.notify(`MCP: ${error.message || String(error)}`);
      return false;
    }
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
    this.rebuildTranscriptProjection();
  }

  handleTurnDetailsCommand(argument = "") {
    const action = String(argument || "").trim().toLowerCase() || "toggle";
    if (["auto", "expanded", "hidden"].includes(action)) {
      this.turnDetailsMode = action;
      this.turnDetailOverrides.clear();
      this.uiSettings.turnDetailsMode = action;
      saveUiSettings(this.uiSettings);
      this.notify(`turn details: ${action}`);
      if (this.canPaintPinned()) this.repaintPinnedOutput();
      return true;
    }

    if (["toggle", "open", "expand", "close", "collapse"].includes(action)) {
      const force = ["open", "expand"].includes(action)
        ? true
        : ["close", "collapse"].includes(action)
          ? false
          : null;
      return this.toggleLatestTurnDetails(force);
    }

    if (["all", "expand-all", "collapse-all"].includes(action)) {
      const expand = action !== "collapse-all";
      let changed = 0;
      for (const entry of this.transcriptEntries) {
        if (entry?.kind !== "turn-card" || !this.turnCardCanExpand(entry)) continue;
        if (expand === this.turnCardDefaultExpanded(entry)) {
          this.turnDetailOverrides.delete(entry.turn.id);
        } else {
          this.turnDetailOverrides.set(entry.turn.id, expand);
        }
        changed += 1;
      }
      this.notify(`${expand ? "expanded" : "collapsed"} ${changed} turn${changed === 1 ? "" : "s"}`);
      if (this.canPaintPinned()) this.repaintPinnedOutput();
      return true;
    }

    this.notify("usage: /details [toggle|open|close|all|collapse-all|auto|expanded|hidden]");
    return false;
  }

  // Permission requests are persisted for audit/recovery, but normal UI owns
  // them exclusively in the interactive composer shelf. Debug mode may still
  // project the raw request into the transcript when protocol inspection is
  // explicitly requested.
  renderPermission(event, renderOptions = {}) {
    if (!this.showInternalEvents) return;
    const tool = event.toolCall || {};
    const rail = c("yellow", "▎");
    const title = tool.title || tool.toolCallId || "Agent request";
    this.logLine("");
    const permissionPrefix = `${rail} ${c("yellow", "⏸ Permission · ")}`;
    this.logProse(`${c("yellow", cleanInline(title))}${tool.kind ? `  ${c("dim", tool.kind)}` : ""}`, {
      firstPrefix: permissionPrefix,
      continuationPrefix: `${rail} `,
    });

    const options = event.options || [];
    const choices = options
      .map((option, index) => `${c("bold", String(index + 1))} ${option.name}`)
      .join("   ");
    if (choices) this.logProse(choices, { firstPrefix: `${rail} `, continuationPrefix: `${rail} ` });
    if (!renderOptions.replay) {
      const span = options.length > 1 ? `1-${options.length}` : "1";
      this.logProse(c("dim", `Type ${span} + Enter · Enter opens menu · /deny`), {
        firstPrefix: `${rail} `,
        continuationPrefix: `${rail} `,
      });
    }
  }

  renderPermissionDecision(event) {
    const allowed = event.scope === "once" || event.scope === "session";
    const rejected = String(event.scope || "").startsWith("reject");
    const color = allowed ? "green" : rejected ? "red" : "muted";
    const glyph = allowed ? "✓" : rejected ? "✕" : "○";
    const choice = event.optionName || event.optionId || event.reason || "Cancelled";
    const scope = event.scope === "once"
      ? "once"
      : event.scope === "session"
        ? "session"
        : "";
    const tool = event.toolKind || event.toolTitle || "";
    const glyphColor = allowed ? "greenStrong" : color;
    const label = `Permission · ${choice}${scope ? ` · ${scope}` : ""}${tool ? ` · ${tool}` : ""}`;
    this.logProse(`${c(glyphColor, glyph)} ${c(color, label)}`, {
      firstPrefix: "  ",
      continuationPrefix: "  ",
    });
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

    const permissionId = this.pendingPermission.permissionId;
    const result = await this.hub.call("permission_response", {
      permissionId,
      optionId: option?.optionId || null,
    });
    if (result?.chat) this.currentChat = result.chat;
    this.clearPendingPermissionUi(permissionId);
  }
}


export {
  FramePainter,
  PopupUi,
};
