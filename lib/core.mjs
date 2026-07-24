// Shared constants and pure helpers for tmux-acp-hub (daemon, UI, CLI).
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
  truncatePlainTextToWidth,
  wrapAnsiWords,
  layoutEditableLine,
  truncateAnsiToWidth,
  padAnsiToWidth,
  stripAnsi as stripAnsiSequences,
} from "./render.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The CLI entry point, used when building tmux run-shell commands. Must not be
// import.meta.url here: lib/core.mjs is not the executable.
const HUB_CLI_PATH = path.join(PLUGIN_DIR, "bin", "acp-hub.mjs");
const BIN_PATH = path.join(PLUGIN_DIR, "bin", "acp-hub.mjs");
// Single source of truth for the version advertised in the ACP clientInfo:
// package.json, so a release bump can't leave a stale hardcoded copy behind.
const HUB_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const ADAPTER_COMPATIBILITY_PATH = path.join(PLUGIN_DIR, "compatibility", "adapters.json");
const ADAPTER_COMPATIBILITY = (() => {
  try {
    return JSON.parse(fs.readFileSync(ADAPTER_COMPATIBILITY_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read adapter compatibility manifest: ${error.message || error}`);
  }
})();
const DEFAULT_CONFIG = {
  defaultAgent: ADAPTER_COMPATIBILITY.defaultAgent,
  agents: Object.fromEntries(
    Object.entries(ADAPTER_COMPATIBILITY.adapters || {}).map(([provider, adapter]) => [
      provider,
      {
        label: adapter.label || provider,
        command: "npx",
        args: ["-y", `${adapter.package}@${adapter.defaultVersion}`],
      },
    ]),
  ),
};

const CACHE_BASE = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
const CONFIG_BASE = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const HUB_DIR = process.env.ACP_HUB_HOME || path.join(CACHE_BASE, "tmux-acp-hub");
const USER_CONFIG_PATH =
  process.env.ACP_HUB_CONFIG || path.join(CONFIG_BASE, "tmux-acp-hub", "agents.json");

// One-time migration from the short-lived "vanzi" brand (tmux-vanzi-hub): move
// the state dir (registry with saved chats, drafts, history) and copy the user
// config. Users on the original tmux-acp-hub name are already in HUB_DIR.
{
  const legacyHubDir = path.join(CACHE_BASE, "tmux-vanzi-hub");
  if (!fs.existsSync(HUB_DIR) && fs.existsSync(legacyHubDir)) {
    try {
      fs.renameSync(legacyHubDir, HUB_DIR);
    } catch {
      // Fall through to a fresh state dir.
    }
  }
  const legacyConfig = path.join(CONFIG_BASE, "tmux-vanzi-hub", "agents.json");
  if (!fs.existsSync(USER_CONFIG_PATH) && fs.existsSync(legacyConfig)) {
    try {
      fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
      fs.copyFileSync(legacyConfig, USER_CONFIG_PATH);
    } catch {
      // Plugin defaults still apply.
    }
  }
}
const PLUGIN_CONFIG_PATH = path.join(PLUGIN_DIR, "agents.json");
const SOCKET_PATH = process.env.ACP_HUB_SOCKET || path.join(HUB_DIR, "hub.sock");
const PID_PATH = path.join(HUB_DIR, "daemon.pid");
const RESTART_LOCK_PATH = path.join(HUB_DIR, "restart.lock");
const LOG_PATH = path.join(HUB_DIR, "daemon.log");
const STATE_PATH = path.join(HUB_DIR, "state.json");
const REGISTRY_PATH = path.join(HUB_DIR, "registry.json");
const DRAFTS_PATH = path.join(HUB_DIR, "drafts.json");
const INPUT_HISTORY_PATH = path.join(HUB_DIR, "input-history.json");
const PASTES_DIR = path.join(HUB_DIR, "pastes");
// Conversation history is bounded by events (not terminal rows). Keep one
// shared default for the live daemon and the persisted registry so reopening a
// chat never applies a smaller, hidden second cutoff.
const HISTORY_LIMIT = 2000;
const HISTORY_PERSIST_LIMIT = HISTORY_LIMIT;
const MIN_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 20000;
const INPUT_HISTORY_LIMIT = 200;
const DRAFT_SAVE_DEBOUNCE_MS = 200;
const INPUT_HISTORY_SAVE_DEBOUNCE_MS = 300;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EMBEDDED_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_AUTO_ATTACH_PASTE_PATHS = 12;
const PASTE_TEXT_ATTACHMENT_MIN_CHARS = 8000;
const PASTE_TEXT_ATTACHMENT_MIN_LINES = 40;
const TRANSCRIPT_SCREEN_LINE_LIMIT = 4000;
const MAX_COMPOSER_INPUT_ROWS = 6;
const MIN_COMPOSER_INPUT_ROWS = 1;
const COMPOSER_CARD_RAIL_WIDTH = 1;
const COMPOSER_CARD_GAP = 2;
const COMPOSER_CARD_RIGHT_PADDING = 2;
const COMPOSER_META_SIDE_PADDING = 1;
const COMPOSER_INPUT_VERTICAL_PADDING = 0;
const COMPOSER_ANIMATION_INTERVAL_MS = 180;
const LIVE_TABLE_PAINT_MS = 40;
const COMPOSER_PLACEHOLDER = "Write a message · / commands · @ files";

// Codex = characteristic blue, Claude = characteristic orange.
const PROVIDER_ACCENT_CODES = { claude: 173, codex: 39 };
const PROVIDER_ACCENT_FALLBACK = 39;

// Plain-Unicode provider marks (no Nerd Font required): Anthropic's starburst,
// OpenAI's hexagon. Overridable per agent with an `icon` field in agents.json.
const PROVIDER_ICONS = { claude: "❋", codex: "⬡" };
const PROVIDER_ICON_FALLBACK = "◆";

function providerIconFor(provider, chat = null) {
  if (chat?.providerIcon) return chat.providerIcon;
  return PROVIDER_ICONS[normalizeToken(provider)] || PROVIDER_ICON_FALLBACK;
}

function resolvedAgentIcon(config, provider) {
  return config?.agents?.[provider]?.icon || providerIconFor(provider);
}

function coloredProviderIcon(chat) {
  const icon = providerIconFor(chat?.provider, chat);
  const accent = providerAccentSeq(chat?.provider);
  return accent ? `${accent}${icon}${colors.reset || ""}` : icon;
}

// Render a transcript tail into wrapped lines for the picker preview pane.
// Streaming chunks are coalesced and, when a markdown renderer is provided,
// formatted like the chat view (tables, code fences, headings); reasoning,
// tool updates, and adapter logs are noise at this zoom level and are skipped.
function formatChatPreview(events, width, maxLines, renderMarkdown = null) {
  if (!Array.isArray(events) || width < 8 || maxLines < 1) return [];

  const out = [];
  const push = (line) => {
    out.push(line);
    // Keep the working set bounded; only the tail survives anyway.
    if (out.length > maxLines * 4) out.splice(0, out.length - maxLines * 2);
  };
  const pushWrapped = (text) => {
    for (const paragraph of String(text || "").split("\n")) {
      if (!paragraph.trim()) continue;
      for (const line of wrapAnsiWords(paragraph, width)) push(line);
    }
  };
  // Table and box-drawing rows lose their alignment when soft-wrapped; clip
  // them to the pane instead. Everything else wraps like the transcript.
  const pushRendered = (rendered) => {
    for (const line of String(rendered || "").split("\n")) {
      if (!line.trim()) {
        if (out.length && out[out.length - 1] !== "") push("");
        continue;
      }
      if (/[│┃┼├┤┌┐└┘─╭╮╰╯]/.test(stripAnsi(line))) {
        push(truncateAnsiToWidth(line, width));
      } else {
        for (const wrapped of wrapAnsiWords(line, width)) push(wrapped);
      }
    }
  };

  let agentBuffer = "";
  const flushAgent = () => {
    if (agentBuffer.trim()) {
      if (renderMarkdown) pushRendered(renderMarkdown(agentBuffer));
      else pushWrapped(agentBuffer);
    }
    agentBuffer = "";
  };

  for (const event of events) {
    switch (event?.type) {
      case "user":
        flushAgent();
        if (out.length) push("");
        pushWrapped(`${c("cyan", "❯")} ${event.text || ""}`);
        push("");
        break;
      case "agent_chunk":
        agentBuffer += event.text || "";
        break;
      case "tool_call":
        flushAgent();
        push(c("dim", truncateAnsiToWidth(`⚙ ${cleanInline(event.title || event.kind || "tool")}`, width)));
        break;
      case "plan":
        flushAgent();
        push(c("dim", `▸ plan · ${(event.entries || []).length} steps`));
        break;
      case "error":
        flushAgent();
        pushWrapped(c("red", `✗ ${cleanInline(event.text || "")}`));
        break;
      default:
        break;
    }
  }
  flushAgent();

  while (out.length && !out[out.length - 1]) out.pop();
  const tail = out.slice(-maxLines);
  while (tail.length && !tail[0]) tail.shift();
  return tail;
}

// Compact relative age for chat lists: now, 37m, 8h, 2d, 3w, 2mo, 1y.
function formatRelativeAge(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";

  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function providerAccentSeq(provider) {
  if (!process.stdout.isTTY) return "";
  const code = PROVIDER_ACCENT_CODES[normalizeToken(provider)] || PROVIDER_ACCENT_FALLBACK;
  return `\x1b[38;5;${code}m`;
}

// Optional UI accent from the @acp_hub_accent tmux option ("#rrggbb" or a
// 256-color number). When set it tints the composer rule instead of the
// provider accent, so the hub matches the user's tmux theme.
let cachedHubAccentSeq;
function hubAccentSeq() {
  if (cachedHubAccentSeq !== undefined) return cachedHubAccentSeq;
  cachedHubAccentSeq = "";
  if (process.env.TMUX && process.stdout.isTTY) {
    const result = spawnSync("tmux", ["show-option", "-gqv", "@acp_hub_accent"], {
      encoding: "utf8",
    });
    const value = result.status === 0 ? (result.stdout || "").trim() : "";
    const hex = value.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const number = Number.parseInt(hex[1], 16);
      cachedHubAccentSeq = `\x1b[38;2;${(number >> 16) & 255};${(number >> 8) & 255};${number & 255}m`;
    } else if (/^\d{1,3}$/.test(value)) {
      cachedHubAccentSeq = `\x1b[38;5;${value}m`;
    }
  }
  return cachedHubAccentSeq;
}

// --- Lightweight syntax highlighting for fenced code blocks -----------------------
//
// Zero-dependency, per-line regex tokenizer: comments, strings, numbers, and
// per-language keywords. Tokens use foreground-only SGR codes closed with
// \x1b[39m (never a full reset) so the shaded code-block background survives.
// Per-line means multi-line constructs (block comments, triple-quoted strings)
// lose their color on continuation lines — an accepted trade-off.

const CODE_TOKEN_COLORS = {
  keyword: "\x1b[38;5;176m",
  string: "\x1b[38;5;114m",
  number: "\x1b[38;5;179m",
  comment: "\x1b[38;5;245m",
  special: "\x1b[38;5;81m",
  end: "\x1b[39m",
};

const CODE_STRINGS = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\``;
const CODE_NUMBERS = "\\b\\d(?:[\\d_]*\\.?[\\d_]*)?(?:[eE][+-]?\\d+)?\\b";
const COMMENT_SLASH = "//.*$|/\\*.*?\\*/";
const COMMENT_HASH = "#.*$";
const COMMENT_DASH = "--.*$";
const COMMENT_TMUX = "#(?!\\{).*$";

const CODE_FAMILIES = {
  cfamily: {
    comment: COMMENT_SLASH,
    keywords:
      "const|let|var|function|return|if|else|for|while|do|class|extends|implements|interface|type|enum|import|export|from|as|async|await|new|try|catch|finally|throw|typeof|instanceof|switch|case|break|continue|default|null|undefined|true|false|this|of|in|yield|static|get|set|readonly|void|int|char|float|double|long|short|unsigned|struct|public|private|protected|final|abstract|package|nullptr|delete|namespace|using|template|virtual|override",
  },
  python: {
    comment: COMMENT_HASH,
    keywords:
      "def|return|if|elif|else|for|while|class|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|nonlocal|yield|async|await|not|and|or|in|is|None|True|False|del|assert|match|case",
  },
  shell: {
    comment: COMMENT_HASH,
    keywords:
      "if|then|else|elif|fi|for|while|until|do|done|case|esac|function|local|return|export|readonly|declare|set|unset|shift|exit|in|select|trap|source|alias|echo|printf|read|cd|test",
  },
  tmux: {
    comment: COMMENT_TMUX,
    // Formats, user options, environment variables and command flags are the
    // tmux-specific atoms that a generic shell grammar cannot distinguish.
    special:
      "['\"]?#\\{[^}]*\\}['\"]?|@[A-Za-z0-9_-]+|\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?|-[A-Za-z]+",
    keywords:
      "set-window-option|show-window-options|set-option|show-options|show-option|bind-key|unbind-key|new-session|attach-session|switch-client|kill-session|rename-session|list-sessions|new-window|select-window|kill-window|rename-window|move-window|link-window|swap-window|split-window|select-pane|resize-pane|swap-pane|join-pane|break-pane|kill-pane|capture-pane|pipe-pane|display-popup|display-menu|display-message|run-shell|if-shell|send-keys|source-file|list-keys|command-prompt|confirm-before|refresh-client|copy-mode|paste-buffer|load-buffer|save-buffer|choose-tree|wait-for|set|setw|bind|unbind|on|off",
  },
  go: {
    comment: COMMENT_SLASH,
    keywords:
      "func|return|if|else|for|range|package|import|type|struct|interface|map|chan|go|defer|select|switch|case|break|continue|fallthrough|var|const|nil|true|false|make|new|append|len|cap|error|string|int|int64|float64|bool|byte|rune",
  },
  rust: {
    comment: COMMENT_SLASH,
    keywords:
      "fn|let|mut|return|if|else|for|while|loop|match|impl|trait|struct|enum|pub|use|mod|crate|self|super|where|async|await|move|ref|dyn|Box|Vec|String|Some|None|Ok|Err|Result|Option|true|false|const|static|unsafe|as|in|break|continue",
  },
  sql: {
    comment: COMMENT_DASH,
    caseInsensitive: true,
    keywords:
      "select|from|where|insert|update|delete|into|values|join|left|right|inner|outer|full|cross|on|group|by|order|limit|offset|having|as|and|or|not|null|is|in|like|between|exists|union|all|distinct|create|table|drop|alter|add|column|index|primary|foreign|key|references|constraint|default|unique|begin|commit|rollback|case|when|then|else|end|count|sum|avg|min|max",
  },
  css: { comment: "/\\*.*?\\*/", keywords: "" },
  html: { comment: "<!--.*?-->", keywords: "" },
  yaml: { comment: COMMENT_HASH, keywords: "true|false|null|yes|no" },
  json: { comment: "", keywords: "true|false|null" },
  lua: {
    comment: COMMENT_DASH,
    keywords:
      "function|local|return|if|then|else|elseif|end|for|while|repeat|until|do|break|and|or|not|nil|true|false|in",
  },
};

const CODE_LANG_ALIASES = {
  js: "cfamily", jsx: "cfamily", ts: "cfamily", tsx: "cfamily",
  javascript: "cfamily", typescript: "cfamily", mjs: "cfamily", cjs: "cfamily",
  java: "cfamily", c: "cfamily", h: "cfamily", cpp: "cfamily", cc: "cfamily",
  hpp: "cfamily", csharp: "cfamily", cs: "cfamily", swift: "cfamily",
  kotlin: "cfamily", kt: "cfamily", scala: "cfamily", php: "cfamily",
  python: "python", py: "python", ruby: "python", rb: "python",
  shell: "shell", sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  console: "shell", shellsession: "shell",
  tmux: "tmux", tmuxconf: "tmux",
  go: "go", golang: "go",
  rust: "rust", rs: "rust",
  sql: "sql", mysql: "sql", postgres: "sql", postgresql: "sql", sqlite: "sql",
  css: "css", scss: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
  yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", conf: "yaml",
  dockerfile: "shell", makefile: "shell",
  json: "json", jsonc: "json", json5: "json",
  lua: "lua",
};

const CODE_BASENAME_LANGUAGES = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "shell",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".profile": "sh",
  ".zshrc": "zsh",
  ".zprofile": "zsh",
  ".env": "sh",
  "tmux.conf": "tmux",
  ".tmux.conf": "tmux",
};

// Diffs do not carry a Markdown fence language, but their path usually does.
// Return only aliases understood by the existing highlighter; unknown files
// intentionally remain plain text instead of receiving a misleading grammar.
function codeLanguageForPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  const basename = path.basename(normalized).toLowerCase();
  if (!basename) return "";
  if (CODE_BASENAME_LANGUAGES[basename]) return CODE_BASENAME_LANGUAGES[basename];
  const extension = path.extname(basename).slice(1).toLowerCase();
  return CODE_LANG_ALIASES[extension] ? extension : "";
}

const codeTokenRegexCache = new Map();
function codeTokenRegex(familyName) {
  let regex = codeTokenRegexCache.get(familyName);
  if (regex !== undefined) return regex;

  const family = CODE_FAMILIES[familyName];
  const parts = [];
  if (family.comment) parts.push(`(?<comment>${family.comment})`);
  if (family.special) parts.push(`(?<special>${family.special})`);
  parts.push(`(?<string>${CODE_STRINGS})`);
  parts.push(`(?<number>${CODE_NUMBERS})`);
  if (family.keywords) parts.push(`\\b(?<keyword>${family.keywords})\\b`);
  regex = new RegExp(parts.join("|"), family.caseInsensitive ? "gi" : "g");
  codeTokenRegexCache.set(familyName, regex);
  return regex;
}

// Tints one code line for the given fence language. Unknown languages pass
// through untouched; so does non-TTY output (replay into pipes, tests).
function highlightCode(line, lang) {
  if (!line || !process.stdout.isTTY) return line;
  const familyName = CODE_LANG_ALIASES[String(lang || "").toLowerCase()];
  if (!familyName) return line;

  return line.replace(codeTokenRegex(familyName), (match, ...args) => {
    const groups = args[args.length - 1];
    const kind =
      groups.comment !== undefined
        ? "comment"
        : groups.special !== undefined
          ? "special"
          : groups.string !== undefined
            ? "string"
            : groups.keyword !== undefined
              ? "keyword"
              : "number";
    return `${CODE_TOKEN_COLORS[kind]}${match}${CODE_TOKEN_COLORS.end}`;
  });
}

// One shaded full-width row of a fenced code block. The background carries
// across soft-wrapped continuations (wrapAnsiLine re-opens SGR state), so long
// code lines stay inside the band.
function codeBlockLine(content, { dim = false, width = null } = {}) {
  if (!process.stdout.isTTY) return content;
  const target = width ?? Math.max(24, (process.stdout.columns || 80) - 1);
  // Fixed-width targets (picker preview pane) clip long code lines so the
  // padded background never spills into a soft-wrap.
  const body = width ? truncateAnsiToWidth(` ${content}`, target) : ` ${content}`;
  const padded = padAnsiToWidth(body, target);
  return `${colors.codeBg}${dim ? colors.dim : ""}${padded}${colors.reset}`;
}

function codeFenceHeader(lang, width = null) {
  if (!lang) return "";
  return codeBlockLine(lang, { dim: true, width });
}
const MAX_ATTACHMENT_CHIP_ROWS = 2;
const FILE_MENTION_LIMIT = 3000;
const FILE_MENTION_CACHE_MS = 15000;
const KILL_RING_LIMIT = 20;
const COMPOSER_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const colors = process.stdout.isTTY
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      italic: "\x1b[3m",
      strike: "\x1b[9m",
      cyan: "\x1b[36m",
      // Stable semantic colors instead of terminal-defined ANSI green/red.
      // Success shares colour114 with the syntax palette; colour78 is the
      // restrained higher-contrast variant for diffs and current selections.
      green: "\x1b[38;5;114m",
      greenStrong: "\x1b[38;5;78m",
      yellow: "\x1b[33m",
      red: "\x1b[38;5;168m",
      magenta: "\x1b[35m",
      blue: "\x1b[34m",
      inputMuted: "\x1b[38;5;245m",
      // Readable secondary text: a real mid gray instead of ANSI dim, which
      // many dark themes render nearly invisible.
      muted: "\x1b[38;5;245m",
      // Low-contrast structural rails: visible on the dark surface without
      // competing with labels, state icons, or semantic content.
      faint: "\x1b[38;5;240m",
      // Vanzi's readable inactive-window foreground. Chat-menu titles use it
      // between selected white and truly secondary metadata gray.
      menuText: "\x1b[38;2;185;185;185m",
      codeBg: "\x1b[48;5;235m",
      codeLabel: "\x1b[38;5;246m",
      userBg: "\x1b[48;5;235m",
      hoverBg: "\x1b[48;5;236m",
      hoverFg: "\x1b[38;5;252m",
    }
  : {
      reset: "",
      bold: "",
      dim: "",
      italic: "",
      strike: "",
      cyan: "",
      green: "",
      greenStrong: "",
      yellow: "",
      red: "",
      magenta: "",
      blue: "",
      inputMuted: "",
      muted: "",
      faint: "",
      menuText: "",
      codeBg: "",
      codeLabel: "",
      userBg: "",
      hoverBg: "",
      hoverFg: "",
    };

function c(color, text) {
  return `${colors[color] || ""}${text}${colors.reset}`;
}

function nowIso() {
  return new Date().toISOString();
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function parseArgs(argv) {
  const result = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }

    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    i += 1;
  }

  return result;
}

async function mkdirp(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readJsonIfExistsSync(file, options = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (options.backupCorrupt === true) backupCorruptJsonFileSync(file);
    return null;
  }
}

function backupCorruptJsonFileSync(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(file, `${file}.bad-${stamp}`);
  } catch {}
}

function writeJsonFileSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // Rename inside the same directory is atomic: readers see either the
    // complete previous JSON or the complete replacement, never a truncated
    // file while a busy daemon persists an event.
    fs.renameSync(temporary, file);
    // `mode` only applies at creation: heal files that predate the 0600 policy.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort — the containing cache directory is already private.
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The successful rename already consumed the temporary path.
    }
  }
}

let draftsCache = null;
let draftsDirty = false;
let draftsFlushTimer = null;

function loadDrafts() {
  if (!draftsCache) {
    const value = readJsonIfExistsSync(DRAFTS_PATH, { backupCorrupt: true });
    draftsCache = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  return draftsCache;
}

function scheduleDraftsFlush() {
  if (draftsFlushTimer) clearTimeout(draftsFlushTimer);
  draftsFlushTimer = setTimeout(flushDraftsSync, DRAFT_SAVE_DEBOUNCE_MS);
  draftsFlushTimer.unref?.();
}

function flushDraftsSync() {
  if (draftsFlushTimer) {
    clearTimeout(draftsFlushTimer);
    draftsFlushTimer = null;
  }
  if (!draftsDirty || !draftsCache) return;

  try {
    writeJsonFileSync(DRAFTS_PATH, draftsCache);
    draftsDirty = false;
  } catch {}
}

function draftKey(chatId, cwd) {
  return shortHash(`${chatId || "chat"}:${path.resolve(cwd || process.cwd())}`);
}

function loadDraft(key) {
  const drafts = loadDrafts();
  return typeof drafts[key] === "string" ? drafts[key] : "";
}

function saveDraft(key, text) {
  if (!key) return;
  const drafts = loadDrafts();
  if (text) {
    drafts[key] = text;
  } else {
    delete drafts[key];
  }
  draftsDirty = true;
  scheduleDraftsFlush();
}

function clearDraft(key) {
  saveDraft(key, "");
}

let inputHistoryCache = null;
let inputHistoryDirty = false;
let inputHistoryFlushTimer = null;

const UI_SETTINGS_PATH = path.join(HUB_DIR, "ui-settings.json");

// Small per-user UI preferences (e.g. vim mode). Separate from agents.json so
// runtime toggles never rewrite the agent roster.
function loadUiSettings() {
  const value = readJsonIfExistsSync(UI_SETTINGS_PATH, { backupCorrupt: true });
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function saveUiSettings(settings) {
  try {
    writeJsonFileSync(UI_SETTINGS_PATH, settings || {});
  } catch {}
}

function normalizeInputHistory(value) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  return entries
    .map((entry) => (typeof entry === "string" ? entry : ""))
    .filter((entry) => entry.trim())
    .slice(-INPUT_HISTORY_LIMIT);
}

function loadInputHistory() {
  if (!inputHistoryCache) {
    inputHistoryCache = normalizeInputHistory(
      readJsonIfExistsSync(INPUT_HISTORY_PATH, { backupCorrupt: true }),
    );
  }
  return [...inputHistoryCache];
}

function scheduleInputHistoryFlush() {
  if (inputHistoryFlushTimer) clearTimeout(inputHistoryFlushTimer);
  inputHistoryFlushTimer = setTimeout(flushInputHistorySync, INPUT_HISTORY_SAVE_DEBOUNCE_MS);
  inputHistoryFlushTimer.unref?.();
}

function flushInputHistorySync() {
  if (inputHistoryFlushTimer) {
    clearTimeout(inputHistoryFlushTimer);
    inputHistoryFlushTimer = null;
  }
  if (!inputHistoryDirty || !inputHistoryCache) return;

  try {
    writeJsonFileSync(INPUT_HISTORY_PATH, inputHistoryCache);
    inputHistoryDirty = false;
  } catch {}
}

function saveInputHistory(entries) {
  inputHistoryCache = normalizeInputHistory(entries);
  inputHistoryDirty = true;
  scheduleInputHistoryFlush();
}

function flushLocalInputStateSync() {
  flushDraftsSync();
  flushInputHistorySync();
}

function mergeConfig(base, next) {
  if (!next) return base;

  const agents = { ...(base.agents || {}) };
  for (const [provider, override] of Object.entries(next.agents || {})) {
    const inherited = agents[provider];
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      agents[provider] = override;
      continue;
    }
    const merged = { ...(inherited || {}), ...override };
    for (const key of ["env", "configDefaults"]) {
      if (!Object.hasOwn(override, key)) continue;
      merged[key] = override[key] && typeof override[key] === "object"
        ? { ...(inherited?.[key] || {}), ...override[key] }
        : {};
    }
    agents[provider] = merged;
  }

  return {
    ...base,
    ...next,
    agents,
  };
}

const CREDENTIAL_ENV_NAME_PATTERN = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS?)$/i;
const CREDENTIAL_ARG_NAME_PATTERN = /(?:api[-_]?key|(?:access[-_]?)?token|auth(?:orization)?|bearer|(?:client[-_]?)?secret|password|private[-_]?key|credential)/i;

// Return only variable names, never values. `health` uses this to warn when a
// user chose to keep credentials in agents.json but the file is readable by
// group/other users. Ordinary adapter options are intentionally ignored.
function configCredentialEnvNames(config) {
  const names = new Set();
  for (const agent of Object.values(config?.agents || {})) {
    for (const [name, value] of Object.entries(agent?.env || {})) {
      if (value !== null && value !== undefined && String(value) && CREDENTIAL_ENV_NAME_PATTERN.test(name)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

// Keep health output useful for normal adapter pins while preventing common
// flag/header/query credential forms from reaching terminals or issue logs.
function redactCommandArgs(args = []) {
  const redacted = [];
  let redactNext = false;
  for (const value of Array.isArray(args) ? args : []) {
    const argument = String(value);
    if (redactNext) {
      redacted.push("[redacted]");
      redactNext = false;
      continue;
    }

    const separator = argument.indexOf("=");
    const flagName = separator >= 0 ? argument.slice(0, separator) : argument;
    if (argument.startsWith("-") && CREDENTIAL_ARG_NAME_PATTERN.test(flagName)) {
      if (separator >= 0) redacted.push(`${argument.slice(0, separator + 1)}[redacted]`);
      else {
        redacted.push(argument);
        redactNext = true;
      }
      continue;
    }

    if (/^(?:authorization|proxy-authorization|x-api-key)\s*[:=]/i.test(argument)) {
      redacted.push(`${argument.split(/\s*[:=]\s*/, 1)[0]}: [redacted]`);
      continue;
    }
    if (/^bearer\s+/i.test(argument)) {
      redacted.push("Bearer [redacted]");
      continue;
    }

    const envAssignment = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (envAssignment && CREDENTIAL_ENV_NAME_PATTERN.test(envAssignment[1])) {
      redacted.push(`${envAssignment[1]}=[redacted]`);
      continue;
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(argument)) {
      try {
        const url = new URL(argument);
        if (url.username || url.password) {
          url.username = "redacted";
          url.password = "";
        }
        for (const name of [...url.searchParams.keys()]) {
          if (CREDENTIAL_ARG_NAME_PATTERN.test(name)) url.searchParams.set(name, "[redacted]");
        }
        redacted.push(url.toString());
        continue;
      } catch {
        // Preserve a malformed/non-URL argument below.
      }
    }

    redacted.push(argument);
  }
  return redacted;
}

async function loadConfig() {
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config = mergeConfig(config, await readJsonIfExists(PLUGIN_CONFIG_PATH));
  config = mergeConfig(config, await readJsonIfExists(USER_CONFIG_PATH));
  return config;
}

// Parse "pkg@x.y.z" out of an npx-style agent ("npx -y @scope/pkg@1.2.3").
// Custom-command agents (own binaries, unpinned npx) return null.
function npxAdapterPin(agent) {
  if (!agent || agent.command !== "npx" || !Array.isArray(agent.args)) return null;
  for (const arg of agent.args) {
    if (typeof arg !== "string" || arg.startsWith("-")) continue;
    const match = arg.match(
      /^(@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?)@(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)$/i,
    );
    if (match) return { pkg: match[1], version: match[2] };
  }
  return null;
}

// -1/0/1 semver comparison; a prerelease sorts before its release.
function compareSemver(a, b) {
  const parse = (value) => {
    const text = String(value).split("+", 1)[0];
    const dash = text.indexOf("-");
    const core = dash === -1 ? text : text.slice(0, dash);
    const pre = dash === -1 ? "" : text.slice(dash + 1);
    return {
      nums: core.split(".").map((n) => Number(n) || 0),
      pre: pre ? pre.split(".") : [],
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const delta = (left.nums[i] || 0) - (right.nums[i] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const count = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < count; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const leftNumeric = /^\d+$/.test(l);
    const rightNumeric = /^\d+$/.test(r);
    if (leftNumeric && rightNumeric) return Number(l) < Number(r) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// Interpret `npm view <pkg> version deprecated --json` output: npm prints a
// bare JSON string when only `version` has a value, and a keyed object when
// `deprecated` is set too. Returns { latest, deprecated } or null.
function parseNpmViewInfo(stdout) {
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof info === "string") return { latest: info, deprecated: undefined };
  if (info && typeof info === "object") {
    return { latest: info.version, deprecated: info.deprecated };
  }
  return null;
}

// The hub speaks ACP protocol v1. Agents answer `initialize` with the version
// they will actually use; a different number means the adapter dropped v1 and
// the conversation will misbehave in subtle ways. Older agents (and the test
// fake) omit the field — treat that as v1, not an error.
const ACP_PROTOCOL_VERSION = 1;

function acpProtocolMismatch(agentProtocolVersion, supported = ACP_PROTOCOL_VERSION) {
  if (agentProtocolVersion == null || agentProtocolVersion === supported) return null;
  return (
    `Adapter negotiated ACP protocol v${agentProtocolVersion}, but this hub speaks ` +
    `v${supported} — expect breakage. Update tmux-acp-hub, or pin an older adapter ` +
    `in agents.json.`
  );
}

function resolveProjectRoot(cwd) {
  let current = path.resolve(cwd);

  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function projectName(cwd) {
  return path.basename(cwd) || cwd;
}

function defaultChatTitle() {
  return "New chat";
}

function newChatTitle(providerLabel, cwd, number) {
  return number > 1 ? `New chat ${number}` : "New chat";
}

function savedSessionTitle() {
  return "Saved chat";
}

function projectKey(provider, cwd) {
  return `${provider}\0${path.resolve(cwd)}`;
}

function chatIdFor(provider, cwd, sessionId = null, seed = null) {
  const identity = sessionId || seed || path.resolve(cwd);
  return `${provider}-${shortHash(`${path.resolve(cwd)}\0${identity}`)}`;
}

function agentEntries(config) {
  return Object.entries(config.agents || {}).map(([id, agent]) => ({
    id,
    label: agent.label || id,
    icon: agent.icon || "",
    command: agent.command,
    args: Array.isArray(agent.args) ? agent.args : [],
  }));
}


// fzf-style filtering for interactive picker entries: every whitespace-
// separated word must appear in the entry's search text. Section headers
// (disabled entries) are dropped while a query is active so results read as a
// flat list.
// ============================== Picker list primitives ==============================
function pickerFilterEntries(entries, query) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return entries;

  const words = text.split(/\s+/);
  return entries.filter((entry) => {
    if (entry.disabled) return false;
    const haystack = String(entry.searchText || stripAnsi(entry.label || "")).toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// Moves the picker selection by `delta`, skipping disabled section headers.
// Returns the new index, or the first selectable index when the current one is
// invalid; -1 when nothing is selectable.
function pickerNextIndex(entries, index, delta) {
  const selectable = entries.some((entry) => !entry.disabled);
  if (!selectable) return -1;

  if (index < 0 || index >= entries.length || entries[index]?.disabled) {
    return entries.findIndex((entry) => !entry.disabled);
  }

  let next = index;
  const step = delta >= 0 ? 1 : -1;
  let remaining = Math.abs(delta);
  while (remaining > 0) {
    let probe = next + step;
    while (probe >= 0 && probe < entries.length && entries[probe].disabled) probe += step;
    if (probe < 0 || probe >= entries.length) break;
    next = probe;
    remaining -= 1;
  }
  return next;
}

function pickerValueEquals(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

// Collects cursor movements and text into one atomic stdout write so tmux
// repaints each UI update as a single frame instead of flickering through
// intermediate states.
// ============ Status glyphs, text/markdown rendering, attachments, chat metadata ============
function statusGlyph(status) {
  switch (status) {
    case "idle":
      return "●";
    case "responding":
    case "thinking":
    case "working":
    case "planning":
      return "◐";
    case "starting":
    case "cancelling":
      return "◌";
    case "permission":
      return "⏸";
    case "auth":
      return "⊘";
    case "error":
      return "✗";
    case "stopped":
    case "closed":
      return "○";
    case "saved":
      return "·";
    default:
      return "•";
  }
}

function statusColorName(status) {
  switch (status) {
    case "idle":
    case "responding":
      return "green";
    case "error":
      return "red";
    case "permission":
    case "auth":
    case "planning":
    case "working":
    case "thinking":
    case "cancelling":
      return "yellow";
    case "starting":
      return "cyan";
    default:
      return "dim";
  }
}

function statusIndicator(status) {
  const tone = statusColorName(status);
  const glyphTone = tone === "green" ? "greenStrong" : tone;
  return `${c(glyphTone, statusGlyph(status))} ${c(tone, status || "idle")}`;
}

function statusBadge(status) {
  const table = {
    saved: c("dim", "saved"),
    idle: c("green", "idle"),
    responding: c("cyan", "responding"),
    thinking: c("cyan", "thinking"),
    planning: c("yellow", "planning"),
    working: c("yellow", "working"),
    permission: c("yellow", "permission"),
    starting: c("dim", "starting"),
    cancelling: c("yellow", "cancelling"),
    stopped: c("dim", "stopped"),
    closed: c("dim", "closed"),
    error: c("red", "error"),
  };
  return table[status] || status || "unknown";
}

function isSettledChatStatus(status) {
  return ["idle", "error", "stopped", "closed", "saved"].includes(status);
}

function isActiveChatStatus(status) {
  return ["responding", "thinking", "planning", "working", "permission", "cancelling"].includes(
    normalizeToken(status || ""),
  );
}

function normalizeAgentMessageRole(value) {
  const role = normalizeToken(value || "").replace(/[-\s]+/g, "_");
  if (["final", "final_answer"].includes(role)) return "final";
  if (role === "commentary") return "commentary";
  return "unknown";
}

// ACP deliberately leaves provider-specific annotations inside `_meta`.
// Normalize only fields that we understand instead of persisting the entire
// arbitrary metadata object in chat history. Additional provider classifiers
// can be added here without coupling the renderer to any one adapter.
function agentMessageRoleFromUpdate(update = {}) {
  return normalizeAgentMessageRole(update?._meta?.codex?.phase);
}

function canMergeHistoryChunk(previous, next) {
  if (!previous || !next) return false;
  if (!["agent_chunk", "thought_chunk"].includes(next.type)) return false;
  if (previous.type !== next.type) return false;
  if ((previous.messageId || null) !== (next.messageId || null)) return false;
  if (next.type === "agent_chunk") {
    return normalizeAgentMessageRole(previous.messageRole) ===
      normalizeAgentMessageRole(next.messageRole);
  }
  return true;
}

const TURN_SCOPED_EVENT_TYPES = new Set([
  "user",
  "command",
  "command_result",
  "agent_chunk",
  "thought_chunk",
  "tool_call",
  "tool_update",
  "plan",
  "permission",
  "permission_decision",
  "auth_required",
  "error",
  "turn_done",
]);

function eventTurnSequence(event, fallback = 0) {
  const explicit = Number.parseInt(event?.turnSequence, 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(0, Number.parseInt(fallback, 10) || 0);
}

function turnStopStatus(stopReason, completed) {
  if (!completed) return "active";
  const reason = normalizeToken(stopReason || "end_turn");
  if (/cancel|abort|denied|reject/.test(reason)) return "cancelled";
  if (/error|fail/.test(reason)) return "error";
  if (/max.?token|length|incomplete/.test(reason)) return "partial";
  return "completed";
}

function isoDurationMs(startedAt, completedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(completedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// ACP v1 messageId is optional. Exact ids are grouped across the whole turn,
// but a semantic role change is always a hard boundary. Legacy id-less chunks
// are grouped only while contiguous and while their role remains unchanged.
function agentMessageGroups(events = []) {
  const groups = [];
  const byMessageKey = new Map();
  let contiguousLegacy = null;

  events.forEach((event, index) => {
    if (event?.type !== "agent_chunk") {
      contiguousLegacy = null;
      return;
    }

    const messageId = event.messageId || null;
    const messageRole = normalizeAgentMessageRole(event.messageRole);
    const messageKey = messageId ? `${messageRole}\u0000${messageId}` : "";
    let group = messageId
      ? byMessageKey.get(messageKey)
      : contiguousLegacy?.messageRole === messageRole
        ? contiguousLegacy
        : null;
    if (!group) {
      group = {
        messageId,
        messageRole,
        events: [],
        eventIndexes: [],
        firstIndex: index,
        lastIndex: index,
      };
      groups.push(group);
      if (messageId) byMessageKey.set(messageKey, group);
    }

    group.events.push(event);
    group.eventIndexes.push(index);
    group.lastIndex = index;
    if (!messageId) contiguousLegacy = group;
  });

  return groups.sort((left, right) => left.firstIndex - right.firstIndex);
}

function finalAgentMessageGroups(groups = [], completed = false) {
  const explicit = groups.filter((group) => group.messageRole === "final");
  if (explicit.length) return explicit;
  if (!completed) return [];
  const legacy = [...groups].reverse().find((group) => group.messageRole === "unknown");
  return legacy ? [legacy] : [];
}

function buildTurnCard(turn) {
  const events = Array.isArray(turn?.events) ? turn.events : [];
  const doneEvent = turn?.doneEvent || null;
  const groups = agentMessageGroups(events);
  const finalGroups = finalAgentMessageGroups(groups, Boolean(doneEvent));
  const finalIndexes = new Set(finalGroups.flatMap((group) => group.eventIndexes));
  events.forEach((event, index) => {
    if (event?.type === "command_result") finalIndexes.add(index);
  });
  const finalEvents = events.filter((_event, index) => finalIndexes.has(index));
  const detailEvents = events.filter((event, index) => !finalIndexes.has(index));
  const finalGroup = finalGroups.at(-1) || null;
  const startedAt =
    turn?.userEvent?.startedAt || turn?.userEvent?.at || events[0]?.startedAt || events[0]?.at || null;
  const completedAt = doneEvent?.completedAt || doneEvent?.at || null;
  const hasExplicitDuration = doneEvent?.durationMs !== null && doneEvent?.durationMs !== undefined;
  const explicitDuration = Number(doneEvent?.durationMs);
  const durationMs = hasExplicitDuration && Number.isFinite(explicitDuration)
    ? Math.max(0, explicitDuration)
    : isoDurationMs(startedAt, completedAt);
  const stopReason = doneEvent?.stopReason || null;
  const toolIds = new Set();
  const changedFiles = new Set();

  events.forEach((event, index) => {
    if (event?.type === "tool_call" || event?.type === "tool_update") {
      toolIds.add(event.toolCallId || `tool-${index}`);
    }
    for (const diff of event?.diffs || []) {
      if (diff?.path) changedFiles.add(diff.path);
    }
  });

  const sequence = Math.max(1, Number.parseInt(turn?.turnSequence, 10) || 1);
  const stableStart = startedAt || turn?.userEvent?.at || `sequence-${sequence}`;
  return {
    kind: "turn",
    id: `turn-${sequence}-${String(stableStart).replace(/[^a-z0-9]+/gi, "-")}`,
    turnSequence: sequence,
    status: turnStopStatus(stopReason, Boolean(doneEvent)),
    userEvent: turn?.userEvent || null,
    requestEvent: turn?.userEvent || null,
    requestKind: turn?.userEvent?.type === "command" ? "command" : "prompt",
    startedAt,
    completedAt,
    durationMs,
    stopReason,
    events,
    detailEvents,
    finalEvents,
    finalMessageId: finalGroup?.messageId || null,
    finalText: finalEvents.map((event) => event.text || "").join(""),
    actionCount: toolIds.size,
    changedFiles: [...changedFiles],
  };
}

// Produces a stable transcript projection while leaving the canonical event
// history untouched. Old histories without turnSequence are inferred from
// user/turn_done boundaries; a history truncated mid-turn gets a synthetic
// turn as soon as a scoped event with a sequence appears.
function projectTranscriptTurns(history = []) {
  const items = [];
  let active = null;
  let inferredSequence = 0;

  const closeActive = (doneEvent = null) => {
    if (!active) return;
    active.doneEvent = doneEvent;
    items.push(buildTurnCard(active));
    active = null;
  };

  for (const event of Array.isArray(history) ? history : []) {
    if (!event || typeof event !== "object") continue;
    const explicitSequence = eventTurnSequence(event);

    if (event.type === "user" || event.type === "command") {
      closeActive();
      inferredSequence = Math.max(inferredSequence + 1, explicitSequence);
      active = {
        turnSequence: explicitSequence || inferredSequence,
        userEvent: event,
        events: [],
        doneEvent: null,
      };
      continue;
    }

    if (
      explicitSequence > 0 &&
      TURN_SCOPED_EVENT_TYPES.has(event.type) &&
      (!active || active.turnSequence !== explicitSequence)
    ) {
      closeActive();
      inferredSequence = Math.max(inferredSequence, explicitSequence);
      active = {
        turnSequence: explicitSequence,
        userEvent: null,
        events: [],
        doneEvent: null,
      };
    }

    if (active && event.type === "turn_done") {
      closeActive(event);
      continue;
    }

    if (active) {
      active.events.push(event);
      continue;
    }

    items.push({ kind: "event", event });
  }

  closeActive();
  return items;
}

function historyRetentionUnits(history = []) {
  const units = [];
  let active = null;

  const closeActive = () => {
    if (!active) return;
    units.push(active);
    active = null;
  };

  for (const event of Array.isArray(history) ? history : []) {
    if (!event || typeof event !== "object" || event.type === "history_boundary") continue;
    const sequence = eventTurnSequence(event);

    if (event.type === "user" || event.type === "command") {
      closeActive();
      active = {
        kind: "turn",
        turnSequence: sequence,
        hasUser: true,
        events: [event],
      };
      continue;
    }

    if (TURN_SCOPED_EVENT_TYPES.has(event.type)) {
      const belongsToActive = Boolean(
        active &&
        (sequence === 0 || active.turnSequence === 0 || active.turnSequence === sequence),
      );
      if (!belongsToActive) {
        closeActive();
        active = {
          kind: "turn",
          turnSequence: sequence,
          hasUser: false,
          events: [],
        };
      }
      active.events.push(event);
      if (event.type === "turn_done") closeActive();
      continue;
    }

    if (active) {
      // Informational events emitted while a turn is active stay with it so a
      // retention boundary cannot separate them from their causal prompt.
      active.events.push(event);
    } else {
      units.push({ kind: "metadata", turnSequence: 0, hasUser: false, events: [event] });
    }
  }

  closeActive();
  return units;
}

function compactHistoryTurn(events = [], budget = 1) {
  let source = Array.isArray(events) ? events.slice() : [];
  const maxEvents = Math.max(1, Number.parseInt(budget, 10) || 1);
  if (source.length <= maxEvents) return source.slice();

  // ACP may split the final logical message around tool activity. Collapse
  // those chunks into one canonical event before applying the event budget so
  // preserving the final answer does not crowd out the user/plan/turn_done
  // invariants of an oversized turn.
  const completed = source.some((event) => event.type === "turn_done");
  const originalFinalGroups = finalAgentMessageGroups(agentMessageGroups(source), completed);
  const originalFinalEvents = originalFinalGroups
    .flatMap((group) => group.events)
    .sort((left, right) => source.indexOf(left) - source.indexOf(right));
  if (originalFinalEvents.length > 1) {
    const finalSet = new Set(originalFinalEvents);
    const firstFinalIndex = source.findIndex((event) => finalSet.has(event));
    const mergedFinal = {
      ...originalFinalEvents[0],
      text: originalFinalEvents.map((event) => event.text || "").join(""),
      at: originalFinalEvents.at(-1)?.at || originalFinalEvents[0]?.at,
      compacted: true,
    };
    source = source.filter((event) => !finalSet.has(event));
    source.splice(Math.max(0, firstFinalIndex), 0, mergedFinal);
  }

  const required = new Set();
  const firstRequest = source.findIndex(
    (event) => event.type === "user" || event.type === "command",
  );
  if (firstRequest >= 0) required.add(firstRequest);

  for (const type of ["plan", "error", "turn_done"]) {
    const index = source.findLastIndex((event) => event.type === type);
    if (index >= 0) required.add(index);
  }

  const finalGroups = finalAgentMessageGroups(agentMessageGroups(source), completed);
  const finalEvents = [
    ...finalGroups.flatMap((group) => group.events),
    ...source.filter((event) => event.type === "command_result"),
  ];
  for (const event of finalEvents) {
    const index = source.indexOf(event);
    if (index >= 0) required.add(index);
  }

  // If an unusually tiny budget cannot fit every invariant, prioritize the
  // user boundary, final response tail, latest plan, and durable close.
  const priority = [
    firstRequest,
    source.findLastIndex((event) => event.type === "plan"),
    ...finalEvents.map((event) => source.indexOf(event)).reverse(),
    source.findLastIndex((event) => event.type === "turn_done"),
    source.findLastIndex((event) => event.type === "error"),
  ].filter((index) => index >= 0);
  const selected = new Set();
  for (const index of priority) {
    if (selected.size >= maxEvents) break;
    selected.add(index);
  }
  for (const index of [...required].sort((a, b) => a - b)) {
    if (selected.size >= maxEvents) break;
    selected.add(index);
  }
  for (let index = source.length - 1; index >= 0 && selected.size < maxEvents; index -= 1) {
    selected.add(index);
  }

  return [...selected].sort((a, b) => a - b).map((index) => source[index]);
}

// `limit` is a soft event budget: complete turns are atomic. A single latest
// turn may be compacted, but its prompt, latest plan, final answer, and closing
// event survive. The leading marker makes both intentional retention and old
// already-truncated registries explicit to the renderer.
function retainHistoryByTurns(history = [], limit = HISTORY_LIMIT) {
  const maxEvents = Math.max(1, Number.parseInt(limit, 10) || HISTORY_LIMIT);
  const input = (Array.isArray(history) ? history : []).filter(
    (event) => event && typeof event === "object",
  );
  const existingBoundary = input.find((event) => event.type === "history_boundary") || null;
  const source = input.filter((event) => event.type !== "history_boundary");
  const units = historyRetentionUnits(source);
  const startsPartial = units[0]?.kind === "turn" && !units[0].hasUser;
  const needsTrim = source.length + (existingBoundary || startsPartial ? 1 : 0) > maxEvents;
  const needsBoundary = Boolean(existingBoundary || startsPartial || needsTrim);

  if (!needsBoundary) return source.slice();

  const budget = Math.max(1, maxEvents - 1);
  let remaining = budget;
  const retainedUnits = [];
  let retainedTurn = false;
  let trimmed = needsTrim;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit.events.length <= remaining) {
      retainedUnits.unshift(unit.events);
      if (unit.kind === "turn") retainedTurn = true;
      remaining -= unit.events.length;
      continue;
    }

    trimmed = true;
    if (!retainedTurn && remaining > 0) {
      retainedUnits.unshift(
        unit.kind === "turn"
          ? compactHistoryTurn(unit.events, remaining)
          : unit.events.slice(-remaining),
      );
      if (unit.kind === "turn") retainedTurn = true;
    }
    break;
  }

  const retained = retainedUnits.flat();
  const firstRetainedUnit = historyRetentionUnits(retained)[0];
  const partialTurn = Boolean(
    existingBoundary?.partialTurn ||
    startsPartial ||
    (firstRetainedUnit?.kind === "turn" && !firstRetainedUnit.hasUser),
  );
  const boundary = {
    type: "history_boundary",
    reason: existingBoundary?.reason || (partialTurn ? "legacy_partial" : "retention"),
    partialTurn,
    droppedEvents: Math.max(
      Number(existingBoundary?.droppedEvents) || 0,
      source.length - retained.length,
    ),
    ...(partialTurn
      ? { turnSequence: firstRetainedUnit?.turnSequence || existingBoundary?.turnSequence || 0 }
      : {}),
    at: existingBoundary?.at || retained[0]?.at || source[0]?.at || null,
  };

  if (!trimmed && existingBoundary) return [boundary, ...source].slice(0, maxEvents);
  return [boundary, ...retained].slice(0, maxEvents);
}

function cleanInline(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const TITLE_POLICIES = new Set(["agent-first", "first-prompt", "latest-prompt", "manual-only"]);
const TITLE_SOURCES = new Set(["default", "prompt", "agent", "manual", "legacy"]);
const DEFAULT_TAB_TITLE_MAX_WIDTH = 32;
const CHAT_TITLE_MAX_WIDTH = 256;
const PROMPT_TITLE_MAX_WIDTH = 96;

function normalizeTitlePolicy(value) {
  const policy = String(value || "").trim().toLowerCase();
  return TITLE_POLICIES.has(policy) ? policy : "agent-first";
}

function normalizeTitleSource(value, fallback = "default") {
  const source = String(value || "").trim().toLowerCase();
  return TITLE_SOURCES.has(source) ? source : fallback;
}

function configuredCoreValue(envName, tmuxOption) {
  if (Object.hasOwn(process.env, envName)) return String(process.env[envName] || "").trim();
  if (!process.env.TMUX) return "";

  try {
    const result = spawnSync("tmux", ["show-option", "-gqv", tmuxOption], {
      encoding: "utf8",
      timeout: 250,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

function loadTitleSettings() {
  const parsedWidth = Number.parseInt(
    configuredCoreValue("ACP_HUB_TAB_TITLE_MAX_WIDTH", "@acp_hub_tab_title_max_width"),
    10,
  );
  return {
    policy: normalizeTitlePolicy(
      configuredCoreValue("ACP_HUB_TITLE_POLICY", "@acp_hub_title_policy"),
    ),
    tabMaxWidth: Number.isFinite(parsedWidth)
      ? Math.max(12, Math.min(80, parsedWidth))
      : DEFAULT_TAB_TITLE_MAX_WIDTH,
  };
}

function loadHistorySettings() {
  const parsed = Number.parseInt(
    configuredCoreValue("ACP_HUB_HISTORY_LIMIT", "@acp_hub_history_limit"),
    10,
  );
  return {
    eventLimit: Number.isFinite(parsed)
      ? Math.max(MIN_HISTORY_LIMIT, Math.min(MAX_HISTORY_LIMIT, parsed))
      : HISTORY_LIMIT,
  };
}

const PERMISSION_POLICIES = new Set(["prompt", "deny"]);

function normalizePermissionPolicy(value) {
  const policy = normalizeToken(value);
  return PERMISSION_POLICIES.has(policy) ? policy : "prompt";
}

function loadPermissionSettings() {
  return {
    policy: normalizePermissionPolicy(
      configuredCoreValue("ACP_HUB_PERMISSION_POLICY", "@acp_hub_permission_policy"),
    ),
  };
}

function sanitizeChatTitle(value, maxWidth = CHAT_TITLE_MAX_WIDTH) {
  const normalized = cleanInline(stripAnsiSequences(value))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .normalize("NFC");
  if (!normalized) return "";
  return truncatePlainTextToWidth(normalized, maxWidth);
}

function promptChatTitle(value) {
  const attachmentMarker = /\[(?:image|file|attachment)\s*#?\d+\]/giu;
  for (const logicalLine of String(value || "").split(/\r?\n/u)) {
    const candidate = sanitizeChatTitle(logicalLine.replace(attachmentMarker, " "), PROMPT_TITLE_MAX_WIDTH);
    if (candidate) return candidate;
  }
  return "";
}

function legacyPromptTitle(value) {
  const firstLine = cleanInline(String(value || "").split("\n", 1)[0] || "");
  if (!firstLine) return "";
  return firstLine.length > 72 ? `${firstLine.slice(0, 72).trimEnd()}...` : firstLine;
}

function firstPromptTitleFromHistory(history = []) {
  for (const event of history) {
    if (event?.type !== "user") continue;
    const title = promptChatTitle(event.text);
    if (title) return title;
  }
  return "";
}

// Old registry rows did not persist title provenance. Match prompt-derived
// titles against the saved transcript; preserve everything else as `legacy`
// so a possible manual title is never silently overwritten during migration.
function inferLegacyTitleState(raw = {}, resolvedTitle = "") {
  const title = sanitizeChatTitle(resolvedTitle || raw.title || "") || defaultChatTitle();
  const defaultTitle =
    sanitizeChatTitle(raw.defaultTitle || (/^New chat(?: \d+)?$/u.test(title) ? title : "")) ||
    defaultChatTitle();
  const history = Array.isArray(raw.history) ? raw.history : [];
  const firstFallback = sanitizeChatTitle(raw.fallbackTitle || firstPromptTitleFromHistory(history));

  if (raw.titlePinned === true) {
    return { title, titleSource: "manual", fallbackTitle: firstFallback, defaultTitle };
  }
  if (TITLE_SOURCES.has(raw.titleSource)) {
    return {
      title,
      titleSource: raw.titleSource,
      fallbackTitle: firstFallback,
      defaultTitle,
    };
  }
  if (/^(?:New chat(?: \d+)?|Saved chat)$/u.test(title)) {
    return { title, titleSource: "default", fallbackTitle: firstFallback, defaultTitle: title };
  }
  if (raw.source === "agent-list") {
    return {
      title,
      titleSource: raw.title ? "agent" : "default",
      fallbackTitle: firstFallback,
      defaultTitle,
    };
  }

  const matchesPrompt = history.some((event) => {
    if (event?.type !== "user") return false;
    const candidates = [promptChatTitle(event.text), legacyPromptTitle(event.text)]
      .map((candidate) => sanitizeChatTitle(candidate))
      .filter(Boolean);
    return candidates.includes(title);
  });
  if (matchesPrompt) {
    return { title, titleSource: "prompt", fallbackTitle: title, defaultTitle };
  }
  return { title, titleSource: "legacy", fallbackTitle: firstFallback, defaultTitle };
}

function applyChatTitleCandidate(current = {}, candidate = {}, policyValue = "agent-first") {
  const policy = normalizeTitlePolicy(policyValue);
  const source = normalizeTitleSource(candidate.source, "default");
  const defaultTitle = sanitizeChatTitle(current.defaultTitle) || defaultChatTitle();
  const currentTitle = sanitizeChatTitle(current.title) || defaultTitle;
  const currentSource = normalizeTitleSource(current.titleSource, "default");
  const currentFallback = sanitizeChatTitle(current.fallbackTitle);
  const title = sanitizeChatTitle(candidate.title);
  const state = {
    title: currentTitle,
    titleSource: currentSource,
    fallbackTitle: currentFallback,
    defaultTitle,
  };

  if (source === "manual") {
    if (!title) return state;
    return { ...state, title, titleSource: "manual" };
  }

  // Legacy rows may contain a manual rename from before provenance was
  // persisted. Only an explicit new manual rename may replace them.
  if (currentSource === "manual" || currentSource === "legacy") return state;
  if (policy === "manual-only") return state;

  if (source === "prompt") {
    if (!title) return state;
    if (policy === "latest-prompt") {
      return { ...state, title, titleSource: "prompt", fallbackTitle: title };
    }
    if (currentFallback) return state;

    const withFallback = { ...state, fallbackTitle: title };
    if (policy === "first-prompt" || currentSource === "default" || currentSource === "prompt") {
      return { ...withFallback, title, titleSource: "prompt" };
    }
    return withFallback;
  }

  if (source === "agent") {
    if (policy === "first-prompt") return state;
    if (!title) {
      if (currentSource !== "agent") return state;
      return currentFallback
        ? { ...state, title: currentFallback, titleSource: "prompt" }
        : { ...state, title: defaultTitle, titleSource: "default" };
    }
    return { ...state, title, titleSource: "agent" };
  }

  return state;
}

function chatTabTitle(value, maxWidth = DEFAULT_TAB_TITLE_MAX_WIDTH) {
  const title = sanitizeChatTitle(value) || defaultChatTitle();
  const width = Math.max(12, Math.min(80, Number(maxWidth) || DEFAULT_TAB_TITLE_MAX_WIDTH));
  return truncatePlainTextToWidth(title, width);
}

function rawLogicalLines(value) {
  return String(value || "").split("\n");
}

function rawLinePositions(value) {
  const text = String(value || "");
  const lines = rawLogicalLines(text);
  let offset = 0;

  return lines.map((line) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    return { start, end };
  });
}

function normalizePastedText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function shouldStorePasteAsAttachment(text) {
  const value = normalizePastedText(text);
  const lineCount = value.split("\n").length;
  return (
    Buffer.byteLength(value, "utf8") >= PASTE_TEXT_ATTACHMENT_MIN_CHARS ||
    lineCount >= PASTE_TEXT_ATTACHMENT_MIN_LINES
  );
}

function pastedTextSummary(text) {
  const value = normalizePastedText(text);
  const lineCount = value.split("\n").length;
  if (lineCount <= 1 && value.length < 1200) return "";
  return `pasted ${lineCount} line${lineCount === 1 ? "" : "s"} / ${formatBytes(
    Buffer.byteLength(value, "utf8"),
  )}`;
}

function pastedAttachmentSummary(attachments) {
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  const fileCount = attachments.length - imageCount;
  return [
    imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "",
    fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function createPastedTextAttachment(text) {
  const value = normalizePastedText(text);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `paste-${stamp}-${shortHash(value)}.txt`;
  const filePath = path.join(PASTES_DIR, name);
  fs.mkdirSync(PASTES_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 });
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    name,
    size: stat.size,
    mimeType: "text/plain",
    kind: "file",
    generated: true,
    lineCount: value.split("\n").length,
  };
}

function attachmentsFromPathOnlyText(text, cwd) {
  const lines = normalizePastedText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length || lines.length > MAX_AUTO_ATTACH_PASTE_PATHS) return [];

  const attachments = [];
  const seen = new Set();
  for (const line of lines) {
    const lineAttachments = attachmentsFromPathLine(line, cwd);
    if (!lineAttachments.length) return [];

    for (const attachment of lineAttachments) {
      if (seen.has(attachment.path)) continue;
      seen.add(attachment.path);
      attachments.push(attachment);
      if (attachments.length > MAX_AUTO_ATTACH_PASTE_PATHS) return [];
    }
  }

  return attachments;
}

function attachmentsFromPathLine(line, cwd) {
  const direct = attachmentFromPathToken(line, cwd);
  if (direct) return [direct];

  const words = splitCommandWords(line);
  if (!words.length || words.length > MAX_AUTO_ATTACH_PASTE_PATHS) return [];

  const attachments = [];
  for (const word of words) {
    const attachment = attachmentFromPathToken(word, cwd);
    if (!attachment) return [];
    attachments.push(attachment);
  }
  return attachments;
}

function attachmentFromPathToken(token, cwd) {
  const resolved = resolvePastedPathToken(token, cwd);
  if (!resolved) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    const mimeType = mimeTypeForPath(resolved);
    return {
      path: resolved,
      name: path.basename(resolved),
      size: stat.size,
      mimeType,
      kind: mimeType.startsWith("image/") ? "image" : "file",
    };
  } catch {
    return null;
  }
}

function resolvePastedPathToken(token, cwd) {
  const value = normalizePastedPathToken(token);
  if (!value) return null;
  return path.resolve(cwd || process.cwd(), value.replace(/^~(?=$|\/)/, os.homedir()));
}

function normalizePastedPathToken(token) {
  let value = stripMatchingQuotes(String(token || "").trim());
  if (!value) return "";

  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      try {
        value = decodeURIComponent(value.replace(/^file:\/\//i, ""));
      } catch {}
    }
  }

  return stripMatchingQuotes(value).replace(/\\(.)/g, "$1");
}

function looksLikePathInput(value) {
  const text = stripMatchingQuotes(String(value || "").trim());
  return /^(?:file:\/\/|~(?:\/|$)|\/|\.{1,2}\/)/i.test(text);
}

function stripMatchingQuotes(value) {
  const text = String(value || "").trim();
  const quoted =
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")));
  if (quoted) {
    return text.slice(1, -1);
  }
  return text;
}

function rawInputVisualLines(value, width) {
  const text = String(value || "");
  const logicalLines = rawLogicalLines(text);
  const positions = rawLinePositions(text);
  const result = [];

  logicalLines.forEach((line, logicalLine) => {
    const base = positions[logicalLine]?.start || 0;

    if (!line) {
      result.push({
        text: "",
        start: base,
        end: base,
        contentEnd: base,
        width: 0,
        logicalLine,
        wrapIndex: 0,
      });
      return;
    }

    // The shared editable layout keeps word boundaries and source offsets.
    // Boundary whitespace belongs to a source range even when it is omitted
    // visually, so cursor/selection mapping remains lossless.
    const atomicRanges = attachmentTokenRanges(line);
    for (const [wrapIndex, segment] of layoutEditableLine(line, width, { atomicRanges }).entries()) {
      result.push({
        text: segment.text,
        start: base + segment.start,
        end: base + segment.end,
        contentEnd: base + segment.contentEnd,
        width: segment.width,
        logicalLine,
        wrapIndex,
      });
    }
  });

  return result.length
    ? result
    : [
        {
          text: "",
          start: 0,
          end: 0,
          contentEnd: 0,
          width: 0,
          logicalLine: 0,
          wrapIndex: 0,
        },
      ];
}

function rawVisualLineIndexAtCursor(visualLines, cursor) {
  const safeCursor = Math.max(0, cursor || 0);
  const startMatch = visualLines.findIndex((line, index) => index > 0 && safeCursor === line.start);
  if (startMatch !== -1) return startMatch;

  const contains = visualLines.findIndex((line) => safeCursor >= line.start && safeCursor < line.end);
  if (contains !== -1) return contains;

  for (let index = visualLines.length - 1; index >= 0; index -= 1) {
    const line = visualLines[index];
    if (safeCursor === line.end || (line.start === line.end && safeCursor === line.start)) return index;
  }

  return Math.max(0, visualLines.length - 1);
}

function rawPreviousWord(text, cursor) {
  let index = Math.max(0, Math.min(cursor, String(text || "").length));
  const value = String(text || "");
  while (index > 0 && /\s/.test(value[index - 1])) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1])) index -= 1;
  return index;
}

function rawNextWord(text, cursor) {
  let index = Math.max(0, Math.min(cursor, String(text || "").length));
  const value = String(text || "");
  while (index < value.length && !/\s/.test(value[index])) index += 1;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function listProjectFiles(root, limit = FILE_MENTION_LIMIT) {
  return listProjectFilesWithRg(root, limit) || listProjectFilesFallback(root, limit);
}

function listProjectFilesWithRg(root, limit) {
  const result = spawnSync("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!vendor"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error || result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function listProjectFilesFallback(root, limit) {
  const ignored = new Set([".git", "node_modules", "vendor", ".next", "dist", "build", ".cache"]);
  const files = [];
  const stack = [root];

  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(relative);
        if (files.length >= limit) break;
      }
    }
  }

  return files;
}

function normalizeMentionQuery(value) {
  return String(value || "")
    .replace(/^@/, "")
    .replace(/\\ /g, " ")
    .toLowerCase();
}

function fileMentionScore(file, query) {
  if (!query) return 1;

  const target = file.toLowerCase();
  const base = path.basename(file).toLowerCase();
  if (target === query) return 1000;
  if (base === query) return 900;
  if (target.startsWith(query)) return 800 - target.length * 0.01;
  if (base.startsWith(query)) return 750 - base.length * 0.01;
  if (target.includes(query)) return 650 - target.indexOf(query) - target.length * 0.01;
  if (base.includes(query)) return 600 - base.indexOf(query) - base.length * 0.01;

  let cursor = 0;
  let score = 0;
  for (const char of query) {
    const index = target.indexOf(char, cursor);
    if (index === -1) return -1;
    score += index === cursor ? 8 : 2;
    cursor = index + 1;
  }
  return score - target.length * 0.02;
}

function commonPathPrefix(paths) {
  if (!paths.length) return "";
  let prefix = paths[0];
  for (const file of paths.slice(1)) {
    while (prefix && !file.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.replace(/[^/]*$/, "");
}

function escapeMentionPath(value) {
  return String(value || "").replace(/\s/g, "\\ ");
}

function unescapeMentionPath(value) {
  return String(value || "").replace(/\\ /g, " ");
}

function extractFileMentions(text) {
  const mentions = [];
  const pattern = /(^|[\s([{,])@((?:\\\s|[^\s])+)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const value = unescapeMentionPath(match[2]).replace(/[),.;:!?]+$/, "");
    if (value && !value.startsWith("@")) mentions.push(value);
  }
  return mentions;
}

function mentionAttachmentsForText(root, text, existingAttachments = []) {
  const existing = new Set();
  for (const attachment of existingAttachments || []) {
    const rawPath = typeof attachment === "string" ? attachment : attachment?.path;
    if (!rawPath) continue;
    existing.add(path.resolve(root || process.cwd(), rawPath));
  }

  const attachments = [];
  for (const mention of extractFileMentions(text)) {
    const resolved = path.resolve(root || process.cwd(), mention);
    if (existing.has(resolved)) continue;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) continue;
      existing.add(resolved);
      const mimeType = mimeTypeForPath(resolved);
      attachments.push({
        path: resolved,
        name: path.basename(resolved),
        size: stat.size,
        mimeType,
        kind: mimeType.startsWith("image/") ? "image" : "file",
      });
    } catch {
      // Unresolved @mentions remain plain prompt text.
    }
  }
  return attachments;
}

function stripAnsi(value) {
  return stripAnsiSequences(value);
}

function visibleLength(value) {
  return stringDisplayWidth(value);
}

function sameRawInputLayout(left, right) {
  if (!left || !right) return false;
  const keys = [
    "rows",
    "columns",
    "enhanced",
    "attachmentRows",
    "hintRows",
    "inputPadRows",
    "inputRows",
    "planRows",
    "planRow",
    "planExpanded",
    "upperPanelKind",
    "upperPanelRows",
    "upperPanelRow",
    "upperPanelPadRow",
    "upperPanelContentRow",
    "queueRows",
    "queueRow",
    "outputBottom",
    "gapRow",
    "headerTopGapRow",
    "headerRow",
    "headerGapRow",
    "cardTopRow",
    "cardMetaGapRow",
    "cardBottomRow",
    "infoGapTopRow",
    "infoGapBottomRow",
    "dropdownRows",
    "dropdownRow",
    "dropdownPadRow",
    "attachmentRow",
    "inputPadTopRow",
    "inputRow",
    "inputPadBottomRow",
    "footerRow",
    "hintRow",
  ];
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }

  const leftRows = left.composerRows || [];
  const rightRows = right.composerRows || [];
  if (leftRows.length !== rightRows.length) return false;
  return leftRows.every((row, index) => row === rightRows[index]);
}

function padVisible(value, width) {
  const text = String(value || "");
  const padding = Math.max(0, width - visibleLength(text));
  return `${text}${" ".repeat(padding)}`;
}

function renderInlineMarkdown(value) {
  const tokens = [];
  const protect = (rendered) => {
    const token = `\x00MD${tokens.length}\x00`;
    tokens.push(rendered);
    return token;
  };
  let text = String(value || "");

  text = text.replace(/`([^`]+)`/g, (_, code) => {
    return protect(c("cyan", code));
  });

  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const label = alt ? `image: ${alt}` : "image";
    return protect(`[${label}] ${c("dim", `(${url})`)}`);
  });
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, url) => protect(`${label} ${c("dim", `(${url})`)}`),
  );
  text = text.replace(/<((?:https?:|file:)[^>\s]+)>/g, (_, url) => protect(c("dim", url)));
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, rendered) => c("bold", rendered));
  text = text.replace(/(^|[^\w_])__([^_\n]+)__(?![\w_])/g, (_, prefix, rendered) => {
    if (/^\w+$/.test(rendered)) return `${prefix}__${rendered}__`;
    return `${prefix}${c("bold", rendered)}`;
  });
  text = text.replace(/~~([^~]+)~~/g, (_, rendered) => c("strike", rendered));
  text = text.replace(/(^|[^\w*])\*([^\s*]|[^\s*][^*\n]*?[^\s*])\*(?![\w*])/g, (_, prefix, rendered) => {
    return `${prefix}${c("italic", rendered)}`;
  });
  text = text.replace(/(^|[^\w_])_([^\s_]|[^\s_][^_\n]*?[^\s_])_(?![\w_])/g, (_, prefix, rendered) => {
    return `${prefix}${c("italic", rendered)}`;
  });

  return text.replace(/\x00MD(\d+)\x00/g, (_, index) => tokens[Number(index)] || "");
}

function isMarkdownTableStart(lines, index) {
  return (
    index + 1 < lines.length &&
    isMarkdownTableRow(lines[index]) &&
    isMarkdownTableSeparator(lines[index + 1])
  );
}

function isMarkdownTableRow(line) {
  const text = String(line || "").trim();
  return text.includes("|") && splitMarkdownTableRow(text).length >= 2;
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function hasPendingMarkdownTable(text) {
  const raw = String(text || "");
  const endsWithNewline = /\n$/.test(raw);
  const segments = raw.split("\n");
  // The trailing segment is a partial (un-terminated) line while streaming.
  const partial = endsWithNewline ? "" : segments[segments.length - 1] || "";
  // Only fully newline-terminated lines are "complete"; detect table structure
  // on those so a partial line (e.g. a separator or row mid-arrival) never lets
  // the header flush ahead of the rest and render raw.
  const lines = segments.slice(0, segments.length - 1);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length && !partial) return false;

  const last = lines.length - 1;

  // A complete table row that isn't a separator and isn't already opening a
  // known table start: a header whose separator/rows may still be streaming.
  if (last >= 0 && isMarkdownTableRow(lines[last]) && !isMarkdownTableSeparator(lines[last])) {
    if (last === 0 || !isMarkdownTableStart(lines, last - 1)) return true;
  }

  // A completed table start (header + separator) followed only by rows: more
  // rows may still stream in.
  for (let index = 0; index < lines.length; index += 1) {
    if (!isMarkdownTableStart(lines, index)) continue;
    let cursor = index + 2;
    while (cursor < lines.length && isMarkdownTableRow(lines[cursor])) cursor += 1;
    if (cursor === lines.length) return true;
  }

  // The buffer ends mid-line with a pipe-ish partial right after a table row or
  // separator: a separator or the next row is still arriving.
  if (partial && /\|/.test(partial) && last >= 0 &&
    (isMarkdownTableRow(lines[last]) || isMarkdownTableSeparator(lines[last]))) {
    return true;
  }

  return false;
}

function splitMarkdownTableRow(line) {
  const escapedPipe = "__ACP_ESCAPED_PIPE__";
  let text = String(line || "").trim().replace(/\\\|/g, escapedPipe);

  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);

  return text.split("|").map((cell) => cell.replaceAll(escapedPipe, "|").trim());
}

function renderMarkdownTable(lines, options = {}) {
  const rows = lines.map(splitMarkdownTableRow);
  const header = rows[0] || [];
  const alignments = (rows[1] || []).map(tableAlignment);
  const body = rows.slice(2);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const renderedRows = [header, ...body].map((row) =>
    Array.from({ length: columnCount }, (_, index) => renderInlineMarkdown(row[index] || "")),
  );
  const naturalWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...renderedRows.map((row) => visibleLength(row[index] || ""))),
  );
  const requestedWidth = typeof options === "number" ? options : options.width;
  const widths = fitMarkdownTableWidths(naturalWidths, requestedWidth);

  const formatRow = (row, options = {}) => {
    const prefix = options.header ? `${c("bold", "•")} ` : "  ";
    return `${prefix}${row
      .map((cell, index) => {
        const width = widths[index] || 3;
        const text = truncateAnsiText(cell, width);
        const value = options.header ? c("bold", stripAnsi(text)) : text;
        const align = alignments[index] || (looksNumeric(stripAnsi(text)) ? "right" : "left");
        return alignVisible(value, widths[index], align);
      })
      .join("  ")}`;
  };

  const separatorWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 2;
  const headerSeparator = () => `  ${c("dim", "━".repeat(separatorWidth))}`;
  const rowSeparator = () => `  ${c("dim", "─".repeat(separatorWidth))}`;
  const output = [formatRow(renderedRows[0] || [], { header: true }), headerSeparator()];

  renderedRows.slice(1).forEach((row, index) => {
    output.push(formatRow(row));
    if (index < renderedRows.length - 2) output.push(rowSeparator());
  });

  return output.join("\n");
}

function fitMarkdownTableWidths(naturalWidths, requestedWidth = null) {
  const columnCount = naturalWidths.length;
  if (!columnCount) return [];

  const explicitWidth = requestedWidth !== null && requestedWidth !== undefined &&
    Number.isFinite(Number(requestedWidth))
    ? Math.max(8, Math.floor(Number(requestedWidth)))
    : null;
  const columns = explicitWidth || Math.max(40, process.stdout.columns || 100);
  const tableWidth = explicitWidth || Math.max(24, Math.min(columns - 1, 160));
  const gapWidth = Math.max(0, columnCount - 1) * 2;
  const prefixWidth = 2;
  const available = Math.max(columnCount, tableWidth - prefixWidth - gapWidth);
  const preferredMinWidth = columnCount <= 3 ? 8 : 5;
  const minWidth = Math.max(1, Math.min(preferredMinWidth, Math.floor(available / columnCount)));
  const singleColumnCap = Math.max(minWidth, Math.floor(available * (columnCount <= 2 ? 0.7 : 0.55)));
  const widths = naturalWidths.map((width) => Math.max(minWidth, Math.min(width, singleColumnCap)));

  let total = widths.reduce((sum, width) => sum + width, 0);
  while (total > available) {
    let widest = -1;
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index] <= minWidth) continue;
      if (widest === -1 || widths[index] > widths[widest]) widest = index;
    }
    if (widest === -1) break;
    widths[widest] -= 1;
    total -= 1;
  }

  while (total < available) {
    let expanded = false;
    for (let index = 0; index < widths.length && total < available; index += 1) {
      if (widths[index] >= naturalWidths[index]) continue;
      widths[index] += 1;
      total += 1;
      expanded = true;
    }
    if (!expanded) break;
  }

  return widths;
}

function tableAlignment(cell) {
  const text = String(cell || "").trim();
  if (text.startsWith(":") && text.endsWith(":")) return "center";
  if (text.endsWith(":")) return "right";
  return "left";
}

function looksNumeric(value) {
  return /^[-+]?\d[\d,]*(?:\.\d+)?%?$/.test(String(value || "").trim());
}

function alignVisible(value, width, align = "left") {
  const text = String(value || "");
  const padding = Math.max(0, width - visibleLength(text));
  if (align === "right") return `${" ".repeat(padding)}${text}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
  }
  return `${text}${" ".repeat(padding)}`;
}

function truncateText(value, maxLength) {
  const text = cleanInline(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function fitPlainLine(value, width) {
  const text = String(value || "").replace(/\s+/g, " ");
  if (text.length === width) return text;
  if (text.length > width) return truncateText(text, width);
  return `${text}${" ".repeat(Math.max(0, width - text.length))}`;
}

function fitAnsiLine(value, width) {
  const text = String(value || "").replace(/\n/g, " ");
  const visible = visibleLength(text);
  if (visible === width) return text;
  if (visible > width) return truncateAnsiText(text, width);
  return `${text}${" ".repeat(Math.max(0, width - visible))}`;
}

function truncateAnsiText(value, maxLength) {
  return truncateAnsiToWidth(String(value || ""), maxLength);
}

function horizontalRuleLine(width = null) {
  const columns = width ?? Math.max(24, (process.stdout.columns || 80) - 1);
  return "─".repeat(Math.max(1, Math.min(columns, 96)));
}

function isCompletedToolStatus(status) {
  return /complete|completed|done|success|succeeded/i.test(String(status || ""));
}

function activityGroupFor(event) {
  const text = `${event.kind || ""} ${event.title || ""} ${event.summary || ""}`.toLowerCase();

  if (/\b(edit|write|patch|modify|create|delete|rename|move|apply)\b/.test(text)) {
    return "Edited";
  }

  if (/\b(exec|execute|run|shell|bash|test|build|check|status)\b/.test(text)) {
    return "Ran";
  }

  if (/\b(read|search|grep|find|list|inspect|open|scan|explore)\b/.test(text)) {
    return "Explored";
  }

  return "Used Tools";
}

function cleanActivitySummary(value, group) {
  const maxLines = group === "Edited" ? 12 : 4;
  return String(value || "")
    .split("\n")
    .map((line) => cleanInline(line))
    .filter(Boolean)
    .filter((line) => line.length > 2)
    .slice(0, maxLines)
    .map((line) => truncateText(line, 120));
}

function isToolActivityEvent(event) {
  return event?.type === "tool_call" || event?.type === "tool_update";
}

function normalizeActivityStatus(status) {
  const value = String(status || "pending").toLowerCase();
  if (/cancel|cancelled|canceled|abort|aborted/.test(value)) return "cancelled";
  if (/fail|failed|error|denied|reject|rejected/.test(value)) return "error";
  if (isCompletedToolStatus(value)) return "completed";
  return "active";
}

function activityStatusForActions(actions = []) {
  const statuses = new Set(actions.map((action) => action.status));
  if (statuses.has("error")) return "error";
  if (statuses.has("active")) return "active";
  if (statuses.has("cancelled")) return "cancelled";
  return "completed";
}

// ACP adapters commonly emit a tool_call followed by one or more
// tool_call_update notifications. Consolidate that lifecycle before creating
// visual groups so the transcript never displays the same action twice.
function activityActionsByFirstIndex(events = []) {
  const actions = new Map();

  (Array.isArray(events) ? events : []).forEach((event, index) => {
    if (!isToolActivityEvent(event)) return;
    const explicitId = String(event.toolCallId || "").trim();
    const id = explicitId || `tool-${index}`;
    const previous = actions.get(id) || {
      id,
      toolCallId: explicitId || null,
      firstIndex: index,
      title: "",
      kind: "",
      rawStatus: "pending",
      summary: "",
      diffs: [],
    };

    if (event.title) previous.title = cleanInline(event.title);
    if (event.kind) previous.kind = String(event.kind);
    if (event.status) previous.rawStatus = String(event.status);
    if (event.summary) previous.summary = String(event.summary);
    if (Array.isArray(event.diffs) && event.diffs.length) previous.diffs = event.diffs;
    previous.lastIndex = index;
    actions.set(id, previous);
  });

  const byFirstIndex = new Map();
  for (const action of actions.values()) {
    action.title = action.title || action.toolCallId || action.kind || "tool";
    action.status = normalizeActivityStatus(action.rawStatus);
    action.group = activityGroupFor(action);
    action.changedFiles = [
      ...new Set((action.diffs || []).map((diff) => diff?.path).filter(Boolean)),
    ];
    byFirstIndex.set(action.firstIndex, action);
  }
  return byFirstIndex;
}

function activityGroupFromActions(actions = []) {
  const first = actions[0];
  const name = first?.group || "Used Tools";
  const changedFiles = [
    ...new Set(actions.flatMap((action) => action.changedFiles || []).filter(Boolean)),
  ];
  return {
    // ACP toolCallId is stable across lifecycle updates, so the first action
    // makes a better UI identity than a projection index that can shift when a
    // provider reclassifies its final message at turn completion.
    id: `activity-${first?.id || `tool-${first?.firstIndex ?? 0}`}`,
    name,
    status: activityStatusForActions(actions),
    actions,
    actionCount: actions.length,
    changedFiles,
  };
}

// Preserve chronological runs and non-tool boundaries. A later return to the
// same category creates a second group rather than pulling distant work out of
// order. Lifecycle updates are folded into the action at its first position.
function projectActivityDetails(events = []) {
  const source = Array.isArray(events) ? events : [];
  const actionsByFirstIndex = activityActionsByFirstIndex(source);
  const projected = [];
  let groupActions = [];

  const flushGroup = () => {
    if (!groupActions.length) return;
    projected.push({
      kind: "activity-group",
      group: activityGroupFromActions(groupActions),
    });
    groupActions = [];
  };

  source.forEach((event, index) => {
    if (!isToolActivityEvent(event)) {
      flushGroup();
      projected.push({ kind: "event", event });
      return;
    }

    const action = actionsByFirstIndex.get(index);
    if (!action) return;
    if (groupActions.length && groupActions[0].group !== action.group) flushGroup();
    groupActions.push(action);
  });
  flushGroup();
  return projected;
}

function buildActivityGroups(events = []) {
  return projectActivityDetails(events)
    .filter((item) => item.kind === "activity-group")
    .map((item) => item.group);
}

function displayPath(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  const home = os.homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, resolved)}`;
  }
  return resolved;
}

function normalizeAdditionalDirectories(directories, cwd) {
  const base = path.resolve(cwd || process.cwd());
  const seen = new Set();
  const result = [];

  for (const entry of directories || []) {
    const text = String(entry || "").trim();
    if (!text) continue;
    const resolved = path.resolve(base, text.replace(/^~(?=$|\/)/, os.homedir()));
    if (resolved === base || seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

function findConfigOptionValue(options, needles) {
  const normalizedNeedles = needles.map((needle) => String(needle).toLowerCase());

  for (const option of options || []) {
    if (!option || typeof option !== "object") continue;

    const haystack = [
      option.id,
      option.optionId,
      option.name,
      option.key,
      option.label,
      option.title,
      option.description,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (!normalizedNeedles.some((needle) => haystack.includes(needle))) continue;

    const value = configOptionDisplayValue(option);
    if (value) return value;
  }

  return "";
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function splitCommandWords(input) {
  const words = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (const char of String(input || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function configOptionId(option) {
  return String(option?.id || option?.optionId || option?.key || option?.name || "option");
}

function configOptionAliases(option) {
  return [
    option?.id,
    option?.optionId,
    option?.key,
    option?.name,
    option?.label,
    option?.title,
  ]
    .filter(Boolean)
    .map(normalizeToken);
}

function resolveConfigOption(options, query) {
  const target = normalizeToken(query);
  if (!target) return null;

  const entries = (options || []).filter((option) => option && typeof option === "object");
  return (
    entries.find((option) => configOptionAliases(option).includes(target)) ||
    entries.find((option) => configOptionAliases(option).some((alias) => alias.includes(target))) ||
    null
  );
}

function sanitizeConfigValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const result = {};

  for (const [key, value] of Object.entries(values)) {
    const id = cleanInline(key);
    if (!id) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "boolean") {
      result[id] = value;
    } else {
      const label = valueLabel(value);
      if (label) result[id] = label;
    }
  }

  return result;
}

function agentDefaultConfigValues(agent) {
  return sanitizeConfigValues(
    agent?.configDefaults ||
      agent?.acpConfigDefaults ||
      agent?.defaultConfig ||
      {},
  );
}

function sortConfigEntries(entries) {
  const priority = (id) => {
    const normalized = normalizeToken(id);
    if (normalized === "model" || normalized.includes("model")) return 0;
    if (normalized === "effort" || normalized.includes("reasoning")) return 1;
    if (normalized === "mode" || normalized.includes("permission")) return 2;
    return 3;
  };

  return [...entries].sort((a, b) => priority(a[0]) - priority(b[0]) || String(a[0]).localeCompare(String(b[0])));
}

function selectedConfigValues(chat, fallback = {}) {
  const result = sanitizeConfigValues(fallback);

  for (const option of chat?.configOptions || []) {
    if (!option || typeof option !== "object") continue;
    const id = configOptionId(option);
    const value = configOptionDisplayValue(option);
    if (id && value) result[id] = value;
  }

  if (chat?.mode && !result.mode) result.mode = chat.mode;
  return result;
}

function chatModel(chat) {
  return (
    findConfigOptionValue(chat?.configOptions || [], ["model"]) ||
    valueLabel(chat?.configValues?.model) ||
    valueLabel(chat?.model)
  );
}

function compactProviderLabel(value) {
  const label = cleanInline(value || "Agent").replace(/\s+ACP$/i, "").trim();
  if (!label) return "Agent";
  if (/^[a-z][a-z0-9_-]*$/.test(label)) return label[0].toUpperCase() + label.slice(1);
  return label;
}

function providerColorName(provider) {
  const id = String(provider || "").toLowerCase();
  if (id.includes("claude")) return "magenta";
  if (id.includes("codex")) return "cyan";
  if (id.includes("gemini")) return "blue";
  return "blue";
}

function coloredProviderLabel(chat) {
  const label = compactProviderLabel(chat.providerLabel || chat.provider || "Agent");
  return c(providerColorName(chat.provider), label);
}

function chatEffort(chat) {
  return (
    findConfigOptionValue(chat?.configOptions || [], ["effort", "reasoning"]) ||
    valueLabel(chat?.configValues?.effort) ||
    valueLabel(chat?.configValues?.reasoning) ||
    valueLabel(chat?.effort)
  );
}

function chatAccessLabel(chat) {
  return chatModeValue(chat);
}

function chatConfigLabel(chat) {
  return [chat?.model || chatModel(chat), chat?.effort || chatEffort(chat)]
    .filter(Boolean)
    .join(" ");
}

function footerParts(parts) {
  const result = [];
  const seen = new Set();

  for (const part of parts) {
    const text = cleanInline(part);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
}

function attachmentKindLabel(attachment) {
  if (attachment.kind === "image") return "Image";
  if (attachment.generated) return "Pasted";
  return "File";
}

function attachmentChip(attachment, index, accentForeground = "") {
  const kind = attachmentKindLabel(attachment);
  const name = truncateText(attachment.name || path.basename(attachment.path || "") || kind.toLowerCase(), 32);
  const accent = accentForeground || hubAccentSeq() || providerAccentSeq(attachment?.provider);
  const label = `[${kind} #${attachment.n ?? index + 1} ${name}]`;
  return accent ? `${accent}${label}\x1b[39m` : label;
}

// Plain-text marker inserted into the composer where an attachment landed, so
// the prompt itself tells the agent (and the user) where each one belongs.
function attachmentToken(attachment) {
  const kind = attachmentKindLabel(attachment);
  const suffix =
    kind === "Pasted" && attachment.lineCount ? ` +${attachment.lineCount} lines` : "";
  return `[${kind} #${attachment.n}${suffix}]`;
}

const ATTACHMENT_TOKEN_PATTERN_SOURCE = String.raw`\[(Image|File|Pasted) #(\d+)(?: \+(\d+) lines)?\]`;

// Composer attachment labels remain plain text for persistence and ACP, but
// their source ranges form atomic editing units in every input mode.
function attachmentTokenRanges(value) {
  const text = String(value || "");
  const pattern = new RegExp(ATTACHMENT_TOKEN_PATTERN_SOURCE, "g");
  const ranges = [];
  let match;
  while ((match = pattern.exec(text))) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      kind: match[1],
      number: Number(match[2]),
    });
  }
  return ranges;
}

function attachmentCursorTarget(value, cursor, direction) {
  const text = String(value || "");
  const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  const step = direction < 0 ? -1 : 1;
  const range = attachmentTokenRanges(text).find((candidate) =>
    step < 0
      ? candidate.start < safeCursor && safeCursor <= candidate.end
      : candidate.start <= safeCursor && safeCursor < candidate.end,
  );
  if (range) return step < 0 ? range.start : range.end;
  return Math.max(0, Math.min(text.length, safeCursor + step));
}

function snapAttachmentCursor(value, cursor, direction = 0) {
  const text = String(value || "");
  const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  const range = attachmentTokenRanges(text).find(
    (candidate) => candidate.start < safeCursor && safeCursor < candidate.end,
  );
  if (!range) return safeCursor;
  if (direction < 0) return range.start;
  if (direction > 0) return range.end;
  return safeCursor - range.start <= range.end - safeCursor ? range.start : range.end;
}

function attachmentDeletionRange(value, cursor, direction) {
  const text = String(value || "");
  const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  const backwards = direction < 0;
  const range = attachmentTokenRanges(text).find((candidate) =>
    backwards
      ? candidate.start < safeCursor && safeCursor <= candidate.end
      : candidate.start <= safeCursor && safeCursor < candidate.end,
  );
  if (range) return range;
  if (backwards && safeCursor > 0) return { start: safeCursor - 1, end: safeCursor };
  if (!backwards && safeCursor < text.length) return { start: safeCursor, end: safeCursor + 1 };
  return null;
}

function expandRangeToAttachmentTokens(value, start, end) {
  const text = String(value || "");
  let expandedStart = Math.max(0, Math.min(Number(start) || 0, text.length));
  let expandedEnd = Math.max(expandedStart, Math.min(Number(end) || 0, text.length));
  for (const range of attachmentTokenRanges(text)) {
    if (expandedEnd <= range.start || expandedStart >= range.end) continue;
    expandedStart = Math.min(expandedStart, range.start);
    expandedEnd = Math.max(expandedEnd, range.end);
  }
  return { start: expandedStart, end: expandedEnd };
}

// Backward-compatible anchored matcher used by older callers/tests.
const ATTACHMENT_TOKEN_BEFORE_CURSOR = new RegExp(`${ATTACHMENT_TOKEN_PATTERN_SOURCE}$`);

function promptDisplayTextFromAttachments(text, attachments = []) {
  const cleanText = String(text || "").trim();
  const attachmentLines = [];
  let imageIndex = 0;
  let fileIndex = 0;
  for (const attachment of attachments || []) {
    const image = attachment?.kind === "image" || String(attachment?.mimeType || "").startsWith("image/");
    const index = image ? ++imageIndex : ++fileIndex;
    const label = image ? "IMAGE" : "FILE";
    const name = attachment?.name || path.basename(attachment?.path || "") || (image ? "image" : "file");
    attachmentLines.push(`[${label}${index}] ${name}`);
  }
  return [cleanText, attachmentLines.length ? attachmentLines.join("\n") : ""]
    .filter(Boolean)
    .join(cleanText && attachmentLines.length ? "\n\n" : "");
}

function wrapAttachmentChips(attachments, width, accentForeground = "") {
  if (!attachments?.length) return [];

  const maxWidth = Math.max(16, width || 80);
  const chips = attachments.map((attachment, index) =>
    attachmentChip(attachment, index, accentForeground));
  const rows = [];
  let row = "";
  let consumed = 0;

  for (let index = 0; index < chips.length; index += 1) {
    const chip = chips[index];
    const next = row ? `${row} ${chip}` : chip;
    if (visibleLength(next) <= maxWidth) {
      row = next;
      consumed = index + 1;
      continue;
    }

    if (row) {
      rows.push(row);
      if (rows.length >= MAX_ATTACHMENT_CHIP_ROWS) break;
    }
    if (visibleLength(chip) <= maxWidth) {
      row = chip;
      consumed = index + 1;
    } else {
      rows.push(truncateAnsiText(chip, maxWidth));
      consumed = index + 1;
      row = "";
      if (rows.length >= MAX_ATTACHMENT_CHIP_ROWS) break;
    }
  }

  if (row && rows.length < MAX_ATTACHMENT_CHIP_ROWS) rows.push(row);

  const hidden = Math.max(0, attachments.length - consumed);
  if (hidden > 0 && rows.length) {
    const suffix = c("dim", `[+${hidden} more]`);
    const last = rows[rows.length - 1];
    const next = `${last} ${suffix}`;
    rows[rows.length - 1] = visibleLength(next) <= maxWidth
      ? next
      : fitAnsiLine(`${truncateAnsiText(last, Math.max(8, maxWidth - visibleLength(suffix) - 1))} ${suffix}`, maxWidth);
  }

  return rows;
}

function configOptionValues(option) {
  const rawValues = option?.values || option?.options || option?.choices || [];
  if (!Array.isArray(rawValues)) return [];

  const values = [];
  const visit = (entry) => {
    if (entry === null || entry === undefined) return;
    if (typeof entry !== "object") {
      values.push({ value: String(entry), label: String(entry), description: "" });
      return;
    }

    if (Array.isArray(entry.options)) {
      for (const child of entry.options) visit(child);
      return;
    }

    const value = valueLabel(entry.value ?? entry.id ?? entry.modelId ?? entry.name ?? entry.label ?? entry.title);
    if (!value) return;

    values.push({
      value,
      label: valueLabel(entry.label ?? entry.title ?? entry.name ?? entry.displayName ?? entry.description) || value,
      description: valueLabel(entry.description),
    });
  };

  for (const entry of rawValues) visit(entry);
  return values;
}

function configOptionMenuValues(option) {
  if (isBooleanConfigOption(option)) {
    return [
      { value: "true", label: "true" },
      { value: "false", label: "false" },
    ];
  }

  return configOptionValues(option);
}

function isBooleanConfigOption(option) {
  return (
    option?.type === "boolean" ||
    typeof option?.value === "boolean" ||
    typeof option?.currentValue === "boolean" ||
    typeof option?.selectedValue === "boolean" ||
    typeof option?.defaultValue === "boolean"
  );
}

function parseBooleanConfigValue(value) {
  const normalized = normalizeToken(value);
  if (["1", "true", "yes", "y", "on", "enabled", "enable"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "disabled", "disable"].includes(normalized)) return false;
  throw new Error(`Expected boolean value, got ${value}`);
}

function resolveConfigOptionValue(option, value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`Value is empty for config option ${configOptionId(option)}`);

  if (isBooleanConfigOption(option)) return parseBooleanConfigValue(raw);

  const values = configOptionValues(option);
  if (!values.length) return raw;

  const target = normalizeToken(raw);
  const exact = values.find((entry) => normalizeToken(entry.value) === target);
  if (exact) return exact.value;

  const labelMatch = values.find(
    (entry) => normalizeToken(entry.label) === target || normalizeToken(entry.description) === target,
  );
  if (labelMatch) return labelMatch.value;

  const includesMatch = values.find((entry) => {
    const haystack = `${entry.value} ${entry.label} ${entry.description}`.toLowerCase();
    return haystack.includes(target);
  });
  if (includesMatch) return includesMatch.value;

  // Some adapters, notably Claude, accept model aliases such as "sonnet" and
  // resolve them server-side. Let the adapter be the final source of truth.
  return raw;
}

function buildSetConfigOptionRequest(sessionId, option, value) {
  const configId = configOptionId(option);
  const resolvedValue = resolveConfigOptionValue(option, value);
  const request = {
    sessionId,
    configId,
    value: resolvedValue,
  };

  if (typeof resolvedValue === "boolean") request.type = "boolean";
  return request;
}

function applyLocalConfigOptionValue(options, configId, value) {
  const target = normalizeToken(configId);
  return (options || []).map((option) => {
    if (!option || typeof option !== "object") return option;
    if (!configOptionAliases(option).includes(target)) return option;

    if (Object.prototype.hasOwnProperty.call(option, "currentValue")) {
      return { ...option, currentValue: value };
    }
    if (Object.prototype.hasOwnProperty.call(option, "selectedValue")) {
      return { ...option, selectedValue: value };
    }
    return { ...option, value };
  });
}

function configOptionValueMatches(option, value) {
  const current = configOptionDisplayValue(option);
  return normalizeToken(current) === normalizeToken(value);
}

function syncChatModeFromConfig(chat) {
  const option = chatModeConfigOption(chat);
  const mode = option ? configOptionDisplayValue(option) : "";
  if (mode) chat.mode = mode;
}

// Session Config Options supersede the legacy `modes` field in ACP v1. A
// category match is authoritative; an exact `mode` id/name is the compatibility
// fallback. Never use resolveConfigOption() here: its generic partial matching
// can make `mode` accidentally resolve to `model`.
function chatModeConfigOption(chat) {
  const options = Array.isArray(chat?.configOptions) ? chat.configOptions : [];
  return (
    options.find((option) => normalizeToken(option?.category) === "mode") ||
    options.find((option) => configOptionAliases(option).includes("mode")) ||
    null
  );
}

function modeEntries(modes) {
  const entries = modes?.availableModes || modes?.modes || modes?.options || [];
  return Array.isArray(entries) ? entries : [];
}

function chatModeEntries(chat) {
  const option = chatModeConfigOption(chat);
  if (option) {
    return configOptionValues(option).map((entry) => ({
      id: entry.value,
      name: entry.label || entry.value,
      description: entry.description || "",
      source: "config",
    }));
  }
  return modeEntries(chat?.modes).map((entry) => ({
    ...(entry && typeof entry === "object" ? entry : { id: String(entry) }),
    source: "legacy",
  }));
}

function chatModeValue(chat) {
  const option = chatModeConfigOption(chat);
  return (
    (option ? configOptionDisplayValue(option) : "") ||
    valueLabel(chat?.mode) ||
    valueLabel(chat?.configValues?.mode)
  );
}

function modeAliases(mode) {
  return [mode?.id, mode?.modeId, mode?.value, mode?.name, mode?.label, mode?.title]
    .filter(Boolean)
    .map(normalizeToken);
}

function resolveModeEntries(entries, query) {
  const target = normalizeToken(query);
  if (!target) return null;

  const source = (entries || []).filter(Boolean);
  const exact = source.find((mode) => modeAliases(mode).includes(target));
  if (exact) return exact;

  const partial = source.filter((mode) => modeAliases(mode).some((alias) => alias.includes(target)));
  return partial.length === 1 ? partial[0] : null;
}

function resolveMode(modes, query) {
  return resolveModeEntries(modeEntries(modes), query);
}

// Kept as a public compatibility helper, but intentionally no longer invents
// cross-provider equivalences such as read-only=plan or full=don'tAsk.
function accessAliases(value) {
  const normalized = normalizeToken(value);
  return normalized ? [normalized] : [];
}

function resolveAccessTarget(chat, value) {
  const option = chatModeConfigOption(chat);
  const match = resolveModeEntries(chatModeEntries(chat), value);
  if (!match) return null;

  const resolved = String(match.id || match.modeId || match.value || match.name || "");
  if (!resolved) return null;
  return option
    ? { kind: "config", configId: configOptionId(option), value: resolved }
    : { kind: "mode", value: resolved };
}

function configOptionDisplayValue(option) {
  for (const key of ["value", "currentValue", "selectedValue", "current", "defaultValue"]) {
    if (!Object.prototype.hasOwnProperty.call(option, key)) continue;
    const value = valueLabel(option[key]);
    if (value) return value;
  }

  return "";
}

function valueLabel(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(valueLabel).filter(Boolean).join(",");
  }
  if (typeof value === "object") {
    return valueLabel(value.value ?? value.id ?? value.name ?? value.label ?? value.title);
  }
  return "";
}

function compactTmuxText(value, maxLength = 80) {
  return truncateText(String(value || "").replace(/[#{}]/g, ""), maxLength);
}

function shortSession(sessionId) {
  if (!sessionId) return "";
  const text = String(sessionId);
  if (text.length <= 12) return text;
  return text.slice(0, 8);
}

function formatConfigOption(option) {
  if (!option || typeof option !== "object") return `- ${String(option)}`;

  const id = option.id || option.optionId || option.name || option.key || "option";
  const label = option.label || option.title || option.name || id;
  const value = option.value ?? option.currentValue ?? option.defaultValue ?? "";
  const values = option.values || option.options || option.choices || [];
  const suffix = [];

  if (value !== "") suffix.push(`value=${JSON.stringify(value)}`);
  if (option.type) suffix.push(`type=${option.type}`);
  if (Array.isArray(values) && values.length) {
    suffix.push(`choices=${values.map((entry) => entry.id || entry.value || entry.name || entry).join(",")}`);
  }

  return `- ${id} ${c("dim", label === id ? "" : label)}${suffix.length ? ` ${c("dim", suffix.join(" "))}` : ""}`;
}

function formatProviderCommand(command) {
  if (!command || typeof command !== "object") return `- ${String(command)}`;

  const name = command.invocation || command.name || command.command || command.id || command.title || "command";
  const description = command.description || command.title || "";
  const inputHint = command.inputHint || command.input?.hint || command.hint || "";
  const aliases = command.aliases || [];
  const aliasText = Array.isArray(aliases) && aliases.length ? ` aliases=${aliases.join(",")}` : "";
  const hintText = inputHint ? ` ${c("dim", inputHint)}` : "";

  return `- ${name}${hintText}${description && description !== name ? ` ${c("dim", description)}` : ""}${c("dim", aliasText)}`;
}

function commandToken(value) {
  const token = String(value || "").trim().replace(/^\/+/, "").split(/\s+/, 1)[0] || "";
  return token;
}

function normalizedCommandAction(command = {}) {
  const candidate = command?.action || command?._meta?.commandAction || command?.commandAction;
  if (!candidate || typeof candidate !== "object") return null;

  if (
    candidate.kind === "setConfigOption" &&
    typeof candidate.configId === "string" &&
    candidate.configId.trim() &&
    Object.hasOwn(candidate, "value")
  ) {
    return {
      kind: "setConfigOption",
      configId: candidate.configId.trim(),
      value: candidate.value,
      ...(Object.hasOwn(candidate, "resetValue") ? { resetValue: candidate.resetValue } : {}),
      ...(candidate.presentation ? { presentation: String(candidate.presentation) } : {}),
    };
  }

  if (candidate.kind === "prefixPrompt") {
    return {
      kind: "prefixPrompt",
      ...(candidate.presentation ? { presentation: String(candidate.presentation) } : {}),
    };
  }

  return null;
}

function providerCommandPresentation(name, action, command = {}) {
  const declared = normalizeToken(
    action?.presentation || command?.presentation || command?._meta?.presentation || "",
  );
  if (["informational", "information", "info"].includes(declared)) return "informational";
  if (["state", "configuration", "config"].includes(declared)) return "state";
  if (["work", "task", "turn"].includes(declared)) return "work";
  if (action?.kind === "setConfigOption") return "state";

  const token = normalizeToken(name).replace(/^\/+/, "");
  if (["status", "usage", "mcp", "skills", "help"].includes(token)) return "informational";
  if (["compact", "logout"].includes(token)) return "state";
  return "work";
}

// ACP reports commands dynamically and deliberately leaves extensions in
// `_meta`. Normalize the stable presentation fields once, retaining only the
// original metadata for forwarding/inspection and interpreting a small safe
// action allow-list. Unknown actions always fall back to session/prompt.
function normalizeProviderCommand(command, index = 0) {
  const source = command && typeof command === "object" ? command : { name: command };
  const token = commandToken(source.name || source.command || source.id || source.title);
  if (!token) return null;

  const aliases = [];
  const seenAliases = new Set([token.toLowerCase()]);
  for (const alias of (Array.isArray(source.aliases) ? source.aliases : []).map(commandToken)) {
    const key = alias.toLowerCase();
    if (!alias || seenAliases.has(key)) continue;
    seenAliases.add(key);
    aliases.push(alias);
  }
  const inputHint = String(source.input?.hint || source.inputHint || source.hint || "").trim();
  const action = normalizedCommandAction(source);
  const presentation = providerCommandPresentation(token, action, source);

  return {
    id: `provider:${token}`,
    origin: token.startsWith("$") ? "skill" : "provider",
    command: token,
    name: `/${token}`,
    invocation: `/${token}`,
    forceInvocation: `//${token}`,
    description: String(source.description || source.title || "").trim(),
    inputHint,
    hint: [inputHint, source.description || source.title || ""].filter(Boolean).join(" — "),
    aliases,
    presentation,
    action,
    metadata:
      source._meta && typeof source._meta === "object"
        ? source._meta
        : source.metadata && typeof source.metadata === "object"
          ? source.metadata
          : null,
  };
}

function normalizeProviderCommands(commands = []) {
  const descriptors = [];
  const seen = new Set();
  for (const [index, command] of (Array.isArray(commands) ? commands : []).entries()) {
    const descriptor = normalizeProviderCommand(command, index);
    const key = descriptor?.command?.toLowerCase();
    if (!descriptor || seen.has(key)) continue;
    seen.add(key);
    descriptors.push(descriptor);
  }
  return descriptors;
}

function mergeCommandDescriptors(localCommands = [], providerCommands = []) {
  const locals = (Array.isArray(localCommands) ? localCommands : [])
    .map((command, index) => {
      if (!command) return null;
      const source = typeof command === "string" ? { name: command } : command;
      const token = commandToken(source.name);
      if (!token) return null;
      return {
        ...source,
        id: source.id || `hub:${token}:${index}`,
        origin: "hub",
        command: token,
        name: `/${token}`,
        invocation: `/${token}`,
        forceInvocation: null,
        description: source.description || source.hint || "",
        inputHint: source.inputHint || "",
        collision: false,
      };
    })
    .filter(Boolean);
  const localNames = new Set(locals.map((command) => command.command.toLowerCase()));
  const providers = normalizeProviderCommands(providerCommands).map((command) => {
    const collision = localNames.has(command.command.toLowerCase());
    return {
      ...command,
      collision,
      name: collision ? command.forceInvocation : command.invocation,
    };
  });

  // Aliases are first-class completion targets, but remain projections of the
  // canonical provider command.  Keeping them in the merged command model
  // makes composer completion and hints consistent without duplicating them in
  // the command palette.  Canonical provider spellings always win over an
  // alias, and aliases colliding with Hub commands use the same // escape.
  const claimedProviderNames = new Set(
    providers.map((command) => command.command.toLowerCase()),
  );
  const aliases = [];
  for (const command of providers) {
    for (const alias of command.aliases || []) {
      const key = alias.toLowerCase();
      if (claimedProviderNames.has(key)) continue;
      claimedProviderNames.add(key);
      const collision = localNames.has(key);
      aliases.push({
        ...command,
        id: `${command.id}:alias:${alias}`,
        command: alias,
        name: collision ? `//${alias}` : `/${alias}`,
        invocation: `/${alias}`,
        forceInvocation: `//${alias}`,
        aliases: [],
        aliasOf: command.command,
        collision,
        hint: [command.inputHint, `Alias for /${command.command}`, command.description]
          .filter(Boolean)
          .join(" — "),
      });
    }
  }

  return [...locals, ...providers, ...aliases];
}

function resolveProviderCommand(input, availableCommands = []) {
  const submitted = String(input || "").trim();
  const force = submitted.startsWith("//");
  if (!(force || submitted.startsWith("/"))) return null;
  const providerText = force ? submitted.slice(1) : submitted;
  const firstWhitespace = providerText.search(/\s/);
  const rawToken = firstWhitespace < 0 ? providerText : providerText.slice(0, firstWhitespace);
  const token = commandToken(rawToken);
  if (!token) return null;
  const argumentsText = firstWhitespace < 0 ? "" : providerText.slice(firstWhitespace).trimStart();
  const descriptors = normalizeProviderCommands(availableCommands);
  // A canonical provider spelling always outranks an alias, independently of
  // report order. Exact casing wins first; tolerant casing remains available
  // for provider-only names after the UI has protected Hub collisions.
  const lowerToken = token.toLowerCase();
  const descriptor =
    descriptors.find((command) => command.command === token) ||
    descriptors.find((command) => command.aliases.includes(token)) ||
    descriptors.find((command) => command.command.toLowerCase() === lowerToken) ||
    descriptors.find((command) =>
      command.aliases.some((alias) => alias.toLowerCase() === lowerToken),
    );
  if (!descriptor) return null;
  return {
    descriptor,
    force,
    arguments: argumentsText,
    text: `${descriptor.invocation}${argumentsText ? ` ${argumentsText}` : ""}`,
  };
}

function planMarker(status) {
  if (status === "completed") return c("greenStrong", "✓");
  if (status === "in_progress") return c("yellow", "▸");
  if (status === "failed") return c("red", "✗");
  if (status === "skipped" || status === "cancelled") return c("dim", "⊘");
  return c("dim", "·");
}

const PLAN_ENTRY_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  // Defensive extensions: ACP v1 currently standardises only the three
  // states above. Preserve richer adapter states if they arrive, but the hub
  // never synthesises them from a turn-level error.
  "failed",
  "skipped",
  "cancelled",
]);
const PLAN_ENTRY_PRIORITIES = new Set(["high", "medium", "low"]);
const PLAN_LIFECYCLES = new Set([
  "active",
  "completed",
  "interrupted",
  "cancelled",
  "incomplete",
  "previous",
]);
const PLAN_PREVIOUS_LIFECYCLES = new Set([
  "completed",
  "interrupted",
  "cancelled",
  "incomplete",
]);

function normalizePlanEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const content = cleanInline(entry?.content || entry?.text || entry?.step || "");
      if (!content) return null;
      let rawStatus = normalizeToken(entry?.status || "pending").replace(/-/g, "_");
      if (rawStatus === "inprogress") rawStatus = "in_progress";
      const status = PLAN_ENTRY_STATUSES.has(rawStatus) ? rawStatus : "pending";
      const rawPriority = normalizeToken(entry?.priority || "medium");
      const priority = PLAN_ENTRY_PRIORITIES.has(rawPriority) ? rawPriority : "medium";
      return { content, status, priority };
    })
    .filter(Boolean);
}

function planEntriesComplete(entries) {
  return entries.length > 0 && entries.every((entry) => entry.status === "completed");
}

function normalizePlanState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entries = normalizePlanEntries(raw.entries);
  if (!entries.length) return null;
  const inferredLifecycle = planEntriesComplete(entries) ? "completed" : "active";
  const lifecycle = PLAN_LIFECYCLES.has(raw.lifecycle) ? raw.lifecycle : inferredLifecycle;
  const revision = Math.max(1, Number.parseInt(raw.revision, 10) || 1);
  const turnSequence = Math.max(0, Number.parseInt(raw.turnSequence, 10) || 0);
  const plan = {
    entries,
    revision,
    turnSequence,
    lifecycle,
    updatedAt: raw.updatedAt || nowIso(),
  };
  if (lifecycle === "previous") {
    // Older registry records predate this provenance field. An all-complete
    // snapshot is unambiguous; every other legacy previous plan gets the only
    // safe resumable interpretation until the agent publishes a replacement.
    plan.previousLifecycle = PLAN_PREVIOUS_LIFECYCLES.has(raw.previousLifecycle)
      ? raw.previousLifecycle
      : planEntriesComplete(entries)
        ? "completed"
        : "incomplete";
  }
  return plan;
}

// ACP sends a complete plan snapshot on every change. Keep a local revision
// and turn association because the v1 PlanEntry shape has neither an entry id
// nor a plan/turn id of its own.
function updatePlanState(previous, entries, options = {}) {
  const normalizedEntries = normalizePlanEntries(entries);
  if (!normalizedEntries.length) return null;
  const current = normalizePlanState(previous);
  return {
    entries: normalizedEntries,
    revision: (current?.revision || 0) + 1,
    turnSequence: Math.max(
      0,
      Number.parseInt(options.turnSequence, 10) || current?.turnSequence || 0,
    ),
    lifecycle: planEntriesComplete(normalizedEntries) ? "completed" : "active",
    updatedAt: options.updatedAt || nowIso(),
  };
}

function settlePlanState(raw, outcome = "end_turn", updatedAt = nowIso()) {
  const plan = normalizePlanState(raw);
  if (!plan) return null;
  // A later turn that emits no plan must not reclassify the archived plan it
  // inherited from an earlier turn.
  if (plan.lifecycle === "previous") return plan;
  let lifecycle;
  if (outcome === "cancelled" || outcome === "cancelling") lifecycle = "cancelled";
  else if (outcome === "error" || outcome === "interrupted") lifecycle = "interrupted";
  else if (planEntriesComplete(plan.entries)) lifecycle = "completed";
  else lifecycle = "incomplete";
  if (plan.lifecycle === lifecycle && plan.updatedAt === updatedAt) return plan;
  return { ...plan, revision: plan.revision + 1, lifecycle, updatedAt };
}

function advancePlanTurn(raw, nextTurnSequence, updatedAt = nowIso()) {
  const plan = normalizePlanState(raw);
  if (!plan) return null;
  // Keep the producing turn id intact. The new sequence only signals that the
  // caller is advancing, so the old plan can no longer masquerade as active.
  if (Number(nextTurnSequence) <= plan.turnSequence || plan.lifecycle === "previous") return plan;
  const previousLifecycle = PLAN_PREVIOUS_LIFECYCLES.has(plan.lifecycle)
    ? plan.lifecycle
    : planEntriesComplete(plan.entries)
      ? "completed"
      : "incomplete";
  return {
    ...plan,
    revision: plan.revision + 1,
    lifecycle: "previous",
    previousLifecycle,
    updatedAt,
  };
}

function latestPlanFromHistory(history = [], options = {}) {
  let latest = null;
  for (const event of history || []) {
    if (event?.type !== "plan" || !Array.isArray(event.entries)) continue;
    // ACP plan updates are full replacements. Preserve an empty snapshot as a
    // tombstone while rebuilding state; otherwise restart/migration would skip
    // it and incorrectly resurrect the preceding non-empty plan.
    if (!normalizePlanEntries(event.entries).length) {
      latest = null;
      continue;
    }
    latest = updatePlanState(latest, event.entries, {
      turnSequence: options.turnSequence || 0,
      updatedAt: event.at || options.updatedAt || nowIso(),
    });
  }
  if (!latest) return null;
  if (latest.lifecycle === "completed") return latest;
  return { ...latest, lifecycle: "previous", previousLifecycle: "incomplete" };
}

function planPresentation(chat) {
  const plan = normalizePlanState(chat?.plan);
  if (!plan) return null;
  const entries = plan.entries;
  const done = entries.filter((entry) => entry.status === "completed").length;
  const total = entries.length;
  const inProgress = entries.findIndex((entry) => entry.status === "in_progress");
  const pending = entries.findIndex((entry) => entry.status === "pending");
  const currentIndex = inProgress !== -1 ? inProgress : pending !== -1 ? pending : total - 1;
  const status = normalizeToken(chat?.status || "");

  let tone = "inactive";
  let stateLabel = "Previous plan";
  if (status === "error" || plan.lifecycle === "interrupted") {
    tone = "error";
    stateLabel = "Interrupted";
  } else if (status === "permission" || status === "auth") {
    tone = "waiting";
    stateLabel = status === "auth" ? "Waiting for authentication" : "Waiting for permission";
  } else if (status === "cancelling") {
    tone = "waiting";
    stateLabel = "Cancelling";
  } else if (plan.lifecycle === "cancelled") {
    tone = "cancelled";
    stateLabel = "Cancelled";
  } else if (plan.lifecycle === "completed") {
    tone = "complete";
    stateLabel = "Complete";
  } else if (plan.lifecycle === "incomplete") {
    tone = "inactive";
    stateLabel = "Incomplete";
  } else if (plan.lifecycle === "active") {
    tone = "active";
    stateLabel = "In progress";
  }

  return {
    ...plan,
    entries,
    done,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
    currentIndex,
    currentEntry: entries[currentIndex] || null,
    tone,
    stateLabel,
  };
}

async function buildPromptContent(chat, text, attachments = []) {
  const prompt = [];
  const cleanText = String(text || "").trim();
  if (cleanText) prompt.push({ type: "text", text: cleanText });

  for (const input of attachments || []) {
    const attachment = await resolvePromptAttachment(input?.path || input, chat.cwd);
    prompt.push(await attachmentContentBlock(chat, attachment));
  }

  return prompt;
}

async function resolvePromptAttachment(input, cwd) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("attachment path is empty");

  const resolved = path.resolve(cwd || process.cwd(), raw.replace(/^~(?=$|\/)/, os.homedir()));
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error("not a regular file");

  const mimeType = mimeTypeForPath(resolved);
  return {
    path: resolved,
    name: path.basename(resolved),
    size: stat.size,
    mimeType,
    kind: mimeType.startsWith("image/") ? "image" : "file",
  };
}

async function attachmentContentBlock(chat, attachment) {
  const capabilities = chat.agentCapabilities?.promptCapabilities || {};
  const uri = pathToFileURL(attachment.path).href;

  if (attachment.kind === "image" && capabilities.image === true && attachment.size <= MAX_IMAGE_ATTACHMENT_BYTES) {
    return {
      type: "image",
      mimeType: attachment.mimeType,
      data: (await fsp.readFile(attachment.path)).toString("base64"),
      uri,
    };
  }

  if (capabilities.embeddedContext === true && attachment.size <= MAX_EMBEDDED_TEXT_ATTACHMENT_BYTES) {
    const embedded = await embeddedResourceForAttachment(attachment, uri);
    if (embedded) return embedded;
  }

  return {
    type: "resource_link",
    uri,
    name: attachment.name,
    title: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

async function embeddedResourceForAttachment(attachment, uri) {
  if (attachment.kind === "image") return null;
  const buffer = await fsp.readFile(attachment.path);
  if (buffer.includes(0)) return null;

  return {
    type: "resource",
    resource: {
      uri,
      mimeType: attachment.mimeType,
      text: buffer.toString("utf8"),
    },
  };
}

function promptDisplayText(text, prompt) {
  const lines = [];
  const attachmentLines = [];
  const cleanText = String(text || "").trim();
  if (cleanText) lines.push(cleanText);

  let imageIndex = 0;
  let fileIndex = 0;
  for (const block of prompt || []) {
    if (block?.type === "text") continue;
    if (block?.type === "image" || contentBlockIsImage(block)) {
      imageIndex += 1;
      attachmentLines.push(`[IMAGE${imageIndex}] ${fileNameFromUri(block.uri) || block.mimeType || "image"}`);
      continue;
    }
    fileIndex += 1;
    attachmentLines.push(`[FILE${fileIndex}] ${contentBlockName(block)}`);
  }

  if (attachmentLines.length) {
    if (lines.length) lines.push("");
    lines.push(...attachmentLines);
  }

  return lines.join("\n");
}

function contentBlockIsImage(block) {
  const mimeType = block?.mimeType || block?.resource?.mimeType || "";
  return String(mimeType).startsWith("image/");
}

function contentBlockName(block) {
  if (block?.type === "resource_link") return block.title || block.name || block.uri || "file";
  if (block?.type === "resource") return fileNameFromUri(block.resource?.uri) || block.resource?.uri || "resource";
  return "file";
}

function fileNameFromUri(uri) {
  if (!uri) return "";
  try {
    return path.basename(new URL(uri).pathname);
  } catch {
    return "";
  }
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".c": "text/x-c",
    ".cc": "text/x-c++",
    ".cpp": "text/x-c++",
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".go": "text/x-go",
    ".h": "text/x-c",
    ".heic": "image/heic",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsx": "text/javascript",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".py": "text/x-python",
    ".rb": "text/x-ruby",
    ".rs": "text/x-rust",
    ".svg": "image/svg+xml",
    ".toml": "application/toml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  return map[ext] || "application/octet-stream";
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Rough LOCAL token estimate for a draft: ~4 chars per token for text, file
// attachments by size on disk, images at a flat cost. Order-of-magnitude
// signal only (the UI marks it "~") — never an API-accurate count.
const IMAGE_TOKEN_ESTIMATE = 1500;

function estimateDraftTokens(text, attachments = []) {
  let tokens = Math.ceil(String(text || "").length / 4);
  for (const attachment of attachments || []) {
    if (!attachment) continue;
    if (attachment.kind === "image" || String(attachment.mimeType || "").startsWith("image/")) {
      tokens += IMAGE_TOKEN_ESTIMATE;
    } else {
      tokens += Math.ceil((Number(attachment.size) || 0) / 4);
    }
  }
  return tokens;
}

function formatTokenEstimate(tokens) {
  if (!tokens || tokens <= 0) return "";
  const label =
    tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
  return `~${label} tok`;
}

function formatTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${(k >= 100 ? Math.round(k) : Number(k.toFixed(1)))}k`;
  }
  const m = n / 1_000_000;
  return `${(m >= 100 ? Math.round(m) : Number(m.toFixed(1)))}M`;
}

function formatCost(cost) {
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount)) return "";
  const amount = cost.amount;
  const text = amount === 0 || amount >= 0.01 ? amount.toFixed(2) : amount.toFixed(4);
  const currency = typeof cost.currency === "string" ? cost.currency : "";
  if (currency === "USD" || currency === "") return `$${text}`;
  return `${text} ${currency}`;
}

// Builds the compact context-window segment for the composer footer from an ACP
// `usage_update` (stable `used`/`size` fields, optional cost).
function formatContextUsage(usage) {
  if (!usage) return "";
  const used = usage.used == null ? NaN : Number(usage.used);
  const size = usage.size == null ? NaN : Number(usage.size);
  const parts = [];

  if (Number.isFinite(size) && size > 0) {
    if (Number.isFinite(used) && used >= 0) {
      const pct = Math.round((used / size) * 100);
      parts.push(`${formatTokenCount(used)}/${formatTokenCount(size)} (${pct}%)`);
    } else {
      parts.push(`ctx ${formatTokenCount(size)}`);
    }
  } else if (Number.isFinite(used) && used >= 0) {
    parts.push(`${formatTokenCount(used)} ctx`);
  }

  const cost = formatCost(usage.cost);
  if (cost) parts.push(cost);

  return parts.join(" ");
}

function planProgressLabel(chat) {
  const entries = chat?.plan?.entries || [];
  if (!entries.length) return "";
  const done = entries.filter((entry) => entry.status === "completed").length;
  return `${done}/${entries.length}`;
}

// Accept ACP `[{name,value}]` lists or ergonomic `{KEY: "value"}` objects.
function normalizeKeyValueList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry && typeof entry.name === "string")
      .map((entry) => ({ name: entry.name, value: String(entry.value ?? "") }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([name, val]) => ({ name, value: String(val ?? "") }));
  }
  return [];
}

function mcpCapabilityFlags(capabilities) {
  const mcp = capabilities?.mcpCapabilities || {};
  return { http: mcp.http === true, sse: mcp.sse === true };
}

function normalizeMcpServer(entry, caps) {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;

  const type = entry.type || (entry.url ? "http" : entry.command ? "stdio" : "");

  if (type === "http" || type === "sse") {
    if (!entry.url) return null;
    if (type === "http" && !caps.http) return { skipped: name, reason: "http unsupported" };
    if (type === "sse" && !caps.sse) return { skipped: name, reason: "sse unsupported" };
    return {
      server: { type, name, url: String(entry.url), headers: normalizeKeyValueList(entry.headers) },
    };
  }

  // stdio transport is mandatory for every agent, so it never needs gating.
  if (!entry.command) return null;
  return {
    server: {
      name,
      command: String(entry.command),
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: normalizeKeyValueList(entry.env),
    },
  };
}

function resolveMcpServers(config, agent, capabilities) {
  const caps = mcpCapabilityFlags(capabilities);
  const raw = [
    ...(Array.isArray(config?.mcpServers) ? config.mcpServers : []),
    ...(Array.isArray(agent?.mcpServers) ? agent.mcpServers : []),
  ];

  const servers = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of raw) {
    const result = normalizeMcpServer(entry, caps);
    if (!result) continue;
    if (result.skipped) {
      skipped.push(result);
      continue;
    }
    if (seen.has(result.server.name)) continue;
    seen.add(result.server.name);
    servers.push(result.server);
  }
  return { servers, skipped };
}

function mcpServerLabel(server) {
  if (server.url) return `${server.name} (${server.type || "http"})`;
  return `${server.name} (stdio)`;
}

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;

  switch (content.type) {
    case "text":
      return content.text || "";
    case "resource_link":
      return `[resource: ${content.title || content.name || content.uri}]`;
    case "resource":
      return "[resource]";
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return JSON.stringify(content);
  }
}

function toolContentText(content) {
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (item.type === "content") return contentText(item.content);
      if (item.type === "diff") return `diff ${item.path}`;
      if (item.type === "terminal") return `terminal ${item.terminalId}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// Split a file's text into lines, dropping the phantom trailing empty line a
// final newline produces so a "\n"-terminated file doesn't diff as +1 line.
function splitTextLines(text) {
  const str = String(text ?? "");
  if (str === "") return [];
  const lines = str.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// LCS line diff of the changed middle (prefix/suffix already trimmed by the
// caller). Falls back to a wholesale replace when the region is too large to
// run the O(n*m) table on. Returns rows tagged " "/"-"/"+" with line numbers.
function diffMiddle(oldMid, newMid, offset, maxCells) {
  const rows = [];
  let oldNo = offset + 1;
  let newNo = offset + 1;

  if (oldMid.length === 0) {
    for (const text of newMid) rows.push({ sign: "+", text, oldNo: null, newNo: newNo++ });
    return rows;
  }
  if (newMid.length === 0) {
    for (const text of oldMid) rows.push({ sign: "-", text, oldNo: oldNo++, newNo: null });
    return rows;
  }
  if (oldMid.length * newMid.length > maxCells) {
    for (const text of oldMid) rows.push({ sign: "-", text, oldNo: oldNo++, newNo: null });
    for (const text of newMid) rows.push({ sign: "+", text, oldNo: null, newNo: newNo++ });
    return rows;
  }

  const n = oldMid.length;
  const m = newMid.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldMid[i] === newMid[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      rows.push({ sign: " ", text: oldMid[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ sign: "-", text: oldMid[i], oldNo: oldNo++, newNo: null });
      i++;
    } else {
      rows.push({ sign: "+", text: newMid[j], oldNo: null, newNo: newNo++ });
      j++;
    }
  }
  while (i < n) rows.push({ sign: "-", text: oldMid[i++], oldNo: oldNo++, newNo: null });
  while (j < m) rows.push({ sign: "+", text: newMid[j++], oldNo: null, newNo: newNo++ });
  return rows;
}

// Group a full row sequence into git-style hunks: runs of changes plus up to
// `context` unchanged lines around them; unchanged gaps wider than that split
// into separate hunks (rendered with a "⋮" gap marker).
function groupHunks(rows, context) {
  const changed = [];
  rows.forEach((row, index) => {
    if (row.sign !== " ") changed.push(index);
  });
  if (!changed.length) return [];

  const hunks = [];
  let k = 0;
  while (k < changed.length) {
    const start = changed[k];
    let end = changed[k];
    let next = k + 1;
    while (next < changed.length && changed[next] - end <= 2 * context + 1) {
      end = changed[next];
      next++;
    }
    const from = Math.max(0, start - context);
    const to = Math.min(rows.length - 1, end + context);
    hunks.push({ rows: rows.slice(from, to + 1) });
    k = next;
  }
  return hunks;
}

// Unified line diff (git-like) between two file texts. Common prefix/suffix are
// trimmed first so a one-line change in a huge file stays cheap. `maxRows` caps
// stored/rendered rows so a massive rewrite can't bloat the registry.
function computeLineDiff(oldText, newText, options = {}) {
  const context = Number.isInteger(options.context) ? options.context : 3;
  const maxRows = Number.isInteger(options.maxRows) ? options.maxRows : 600;
  const maxCells = Number.isInteger(options.maxCells) ? options.maxCells : 1_000_000;

  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);

  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let sufO = oldLines.length;
  let sufN = newLines.length;
  while (sufO > pre && sufN > pre && oldLines[sufO - 1] === newLines[sufN - 1]) {
    sufO--;
    sufN--;
  }

  const rows = [];
  for (let idx = 0; idx < pre; idx++) {
    rows.push({ sign: " ", text: oldLines[idx], oldNo: idx + 1, newNo: idx + 1 });
  }
  rows.push(...diffMiddle(oldLines.slice(pre, sufO), newLines.slice(pre, sufN), pre, maxCells));
  for (let idx = 0; idx < oldLines.length - sufO; idx++) {
    rows.push({ sign: " ", text: oldLines[sufO + idx], oldNo: sufO + idx + 1, newNo: sufN + idx + 1 });
  }

  const added = rows.reduce((total, row) => total + (row.sign === "+" ? 1 : 0), 0);
  const removed = rows.reduce((total, row) => total + (row.sign === "-" ? 1 : 0), 0);

  const grouped = groupHunks(rows, context);
  const hunks = [];
  let truncated = false;
  let kept = 0;
  for (const hunk of grouped) {
    if (kept + hunk.rows.length > maxRows) {
      const room = maxRows - kept;
      if (room > 0) hunks.push({ rows: hunk.rows.slice(0, room) });
      truncated = true;
      break;
    }
    hunks.push(hunk);
    kept += hunk.rows.length;
  }

  return { added, removed, hunks, truncated };
}

// Pull the structured file diffs out of an ACP tool-call content array so the
// UI can render them like git instead of a bare "diff <path>" summary.
function toolContentDiffs(content) {
  if (!Array.isArray(content)) return [];

  const diffs = [];
  for (const item of content) {
    if (!item || item.type !== "diff" || typeof item.path !== "string") continue;
    const { added, removed, hunks, truncated } = computeLineDiff(item.oldText || "", item.newText || "");
    if (!hunks.length) continue;
    diffs.push({ path: item.path, added, removed, hunks, truncated });
  }
  return diffs;
}

function supportsSessionClose(chat) {
  return hasSessionCapability(chat.agentCapabilities, "close");
}

function supportsSessionLoad(chat) {
  const capabilities = chat.agentCapabilities || {};
  return (
    hasSessionCapability(capabilities, "load") ||
    capabilities.loadSession === true ||
    capabilities.sessionLoad === true
  );
}

function supportsSessionResume(chat) {
  const capabilities = chat.agentCapabilities || {};
  return (
    hasSessionCapability(capabilities, "resume") ||
    capabilities.resumeSession === true ||
    capabilities.sessionResume === true
  );
}

function supportsSessionListCapabilities(capabilities) {
  return (
    hasSessionCapability(capabilities, "list") ||
    capabilities?.listSessions === true ||
    capabilities?.sessionList === true
  );
}

function supportsSessionDelete(capabilities) {
  return hasSessionCapability(capabilities, "delete");
}

function hasSessionCapability(capabilities, name) {
  if (!capabilities) return false;
  const sessionCapabilities = capabilities.sessionCapabilities || capabilities.session || {};
  const value = sessionCapabilities[name];
  return value === true || (value && typeof value === "object");
}

function isRestoreUnsupported(error) {
  const message = error?.message || "";
  return (
    message.includes("does not advertise session/resume or session/load") ||
    message.includes("Method not found: session/resume") ||
    message.includes("Method not found: session/load") ||
    message.includes("Resource not found")
  );
}

function isMethodNotFound(error, method) {
  const message = error?.message || "";
  return message.includes(`Method not found: ${method}`) || message.includes("-32601");
}

// ============================== Chat ordering ==============================
function chatAttentionRank(chat) {
  if (!chat.active) return 2;
  if (["permission", "auth", "error"].includes(chat.status)) return 0;
  return 1;
}

function chatActivityTimestamp(chat) {
  const parsed = Date.parse(chat?.updatedAt || chat?.startedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

// Canonical provider-neutral chronology used by the daemon before paging and
// by every UI surface after receiving live replacements. Stable id tie-breaks
// keep selection from jumping when multiple events share a timestamp.
function orderChatsByActivity(chats, order = "recent") {
  const direction = order === "oldest" ? 1 : -1;
  return [...chats].sort((a, b) => {
    const delta = chatActivityTimestamp(a) - chatActivityTimestamp(b);
    if (delta !== 0) return direction * delta;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

function orderProjectChats(chats) {
  return [...chats].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    const rank = chatAttentionRank(a) - chatAttentionRank(b);
    if (rank !== 0) return rank;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

// ============================== tmux command helpers ==============================
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tmuxDoubleQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tmuxMenuTargetAttempts(context = {}) {
  const targetAttempts = [];
  if (context.client && context.pane) targetAttempts.push(["-c", context.client, "-t", context.pane]);
  if (context.pane) targetAttempts.push(["-t", context.pane]);
  if (context.client) targetAttempts.push(["-c", context.client]);
  targetAttempts.push([]);

  const seen = new Set();
  return targetAttempts.filter((targetArgs) => {
    const key = targetArgs.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function displayTmuxMenu(title, items, context = {}) {
  const menuItems = [];
  for (const item of items) {
    if (item.separator) {
      menuItems.push("", "", "");
      continue;
    }

    const label = truncateText(stripAnsi(item.label || ""), 72);
    if (item.disabled) {
      menuItems.push(`- ${label}`, "", "");
    } else {
      menuItems.push(label, item.key || "", item.command || "");
    }
  }

  let lastError = "";
  for (const targetArgs of tmuxMenuTargetAttempts(context)) {
    const tmuxArgs = [
      "display-menu",
      ...targetArgs,
      "-T",
      title,
      "-x",
      "P",
      "-y",
      "P",
      "--",
      ...menuItems,
    ];
    const result = spawnSync("tmux", tmuxArgs, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (!result.error && result.status === 0) return { ok: true, error: "" };
    lastError =
      result.error?.message ||
      String(result.stderr || "").trim() ||
      `tmux exited ${result.status ?? "unknown"}`;
  }

  return { ok: false, error: lastError };
}

function tmuxDisplayMessage(context = {}, message) {
  for (const targetArgs of tmuxMenuTargetAttempts(context)) {
    const tmuxArgs = ["display-message", ...targetArgs, String(message)];
    const result = spawnSync("tmux", tmuxArgs, { stdio: "ignore" });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

function tmuxPaneFormat(pane, format) {
  if (!pane) return "";
  const result = spawnSync("tmux", ["display-message", "-p", "-t", pane, format], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

// Window metadata rendered by the status bar, the prefix+s switcher, and the
// workspace scripts. Takes a chat summary (daemon and popup share the shape).
function tmuxWindowOptionValues(chat) {
  const canonicalTitle = sanitizeChatTitle(chat.title || "") || defaultChatTitle();
  const tabTitle = sanitizeChatTitle(chat.tabTitle || "") || chatTabTitle(canonicalTitle);
  const tmuxTitle = canonicalTitle.replace(/[#{}]/g, "");
  const tmuxTabTitle = tabTitle.replace(/[#{}]/g, "");
  return {
    "@acp_hub_provider": chat.provider || "",
    "@acp_hub_provider_label": chat.providerLabel || chat.provider || "",
    "@acp_hub_provider_short": compactProviderLabel(chat.providerLabel || chat.provider || ""),
    "@acp_hub_provider_icon": providerIconFor(chat.provider, chat),
    "@acp_hub_chat_id": chat.id || "",
    "@acp_hub_session_id": chat.sessionId || "",
    "@acp_hub_project_path": chat.cwd || "",
    "@acp_hub_project_name": chat.projectName || projectName(chat.cwd || ""),
    "@acp_hub_status": chat.status || "",
    "@acp_hub_status_glyph": statusGlyph(chat.status),
    "@acp_hub_status_detail": compactTmuxText(chat.statusDetail || ""),
    "@acp_hub_mode": chat.mode || "",
    "@acp_hub_model": compactTmuxText(chat.model || chatModel(chat) || ""),
    "@acp_hub_effort": compactTmuxText(chat.effort || chatEffort(chat) || ""),
    "@acp_hub_plan": planProgressLabel(chat),
    // Keep the canonical title available to menus/search while the tab gets a
    // separately width-bounded label. Identity remains @acp_hub_chat_id.
    "@acp_hub_title": tmuxTitle || "New chat",
    "@acp_hub_tab_title": tmuxTabTitle || "New chat",
    "@acp_hub_title_source": normalizeTitleSource(chat.titleSource, "default"),
    "@acp_hub_active": chat.active ? "live" : "stored",
    "@acp_hub_updated_at": chat.updatedAt || "",
    // A window that renders a chat is a chat view, whatever action created it.
    // Without this, a menu window that opened a chat kept action=menu and the
    // prefix+9/0 lookups skipped it, spawning a duplicate view of the chat.
    "@acp_hub_action": "chat",
  };
}

// One async tmux invocation with ';'-chained commands: sequential spawnSync
// calls per option blocked the event loop during streaming. `target` optional
// (defaults to the caller's current window).
// Re-assert the ACP window-status-format on the target's session. The option
// intermittently reverts to the theme default during the popup/daemon boot
// race, leaving a chat tab showing its raw canonical window name; re-applying
// on each sync self-heals it. Target may be a session or a window id.
function applyAcpStatusFormat(target) {
  if (!target || !process.env.TMUX) return;
  try {
    const script = path.join(PLUGIN_DIR, "scripts", "apply-status-format.sh");
    const child = spawn("sh", [script, String(target)], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // Cosmetic only.
  }
}

function setTmuxWindowOptions(values, target = "") {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (args.length) args.push(";");
    args.push("set-window-option", "-q");
    if (target) args.push("-t", target);
    args.push(key, String(value));
  }

  try {
    const child = spawn("tmux", args, { stdio: "ignore" });
    child.on("error", () => {});
    child.on("close", () => refreshTmuxStatusLine());
    child.unref?.();
  } catch {
    // Best effort: tmux metadata sync must never break the hub.
  }
}

// Global, theme-agnostic counters for status bars. This is synchronous only
// when a count actually changes (the daemon deduplicates calls), which also
// guarantees that shutdown can clear stale values before exiting.
function setTmuxGlobalOptions(values) {
  if (!process.env.TMUX) return;

  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (args.length) args.push(";");
    args.push("set-option", "-gq", key, String(value));
  }
  if (!args.length) return;

  try {
    const result = spawnSync("tmux", args, { stdio: "ignore" });
    if (!result.error && result.status === 0) refreshTmuxStatusLine();
  } catch {
    // Cosmetic only: status integration must never affect the hub.
  }
}

function acpStatusCounts(chats = []) {
  const counts = { active: 0, busy: 0, idle: 0, waiting: 0, error: 0 };
  const busyStatuses = new Set([
    "responding",
    "thinking",
    "working",
    "planning",
    "starting",
    "cancelling",
  ]);

  for (const chat of chats) {
    if (!chat?.active || ["saved", "stopped", "closed"].includes(chat.status)) continue;

    counts.active += 1;
    if (busyStatuses.has(chat.status)) counts.busy += 1;
    else if (chat.status === "idle") counts.idle += 1;
    else if (["permission", "auth"].includes(chat.status)) counts.waiting += 1;
    else if (chat.status === "error") counts.error += 1;
  }

  return counts;
}

function acpStatusCountOptionValues(chats = []) {
  const counts = acpStatusCounts(chats);
  return {
    "@acp_hub_active_count": counts.active,
    "@acp_hub_busy_count": counts.busy,
    "@acp_hub_idle_count": counts.idle,
    "@acp_hub_waiting_count": counts.waiting,
    "@acp_hub_error_count": counts.error,
  };
}

// tmux does not re-render window-status labels when a user option changes.
// A bare `refresh-client -S` fails without a current client (daemon,
// run-shell), so refresh every attached client explicitly.
function refreshTmuxStatusLine() {
  try {
    const list = spawn("tmux", ["list-clients", "-F", "#{client_name}"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    list.stdout.on("data", (chunk) => {
      out += chunk;
    });
    list.on("close", () => {
      for (const client of out.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const refresh = spawn("tmux", ["refresh-client", "-S", "-t", client], { stdio: "ignore" });
        refresh.on("error", () => {});
        refresh.unref?.();
      }
    });
    list.on("error", () => {});
    list.unref?.();
  } catch {
    // Cosmetic only.
  }
}

// Resolves the tmux window carrying @acp_hub_chat_id == chatId, if any.
function findTmuxWindowForChat(chatId) {
  return new Promise((resolve) => {
    if (!chatId) {
      resolve("");
      return;
    }

    let output = "";
    let child;
    try {
      child = spawn("tmux", ["list-windows", "-a", "-F", "#{window_id}\t#{@acp_hub_chat_id}"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve("");
      return;
    }

    child.on("error", () => resolve(""));
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", () => {
      for (const line of output.split("\n")) {
        const [windowId, id] = line.split("\t");
        if (id === chatId && windowId) {
          resolve(windowId);
          return;
        }
      }
      resolve("");
    });
  });
}

function syncTmuxChatMetadata(context, chat) {
  if (!chat) return;

  const target = tmuxPaneFormat(context?.pane || "", "#{window_id}") || context?.pane || "";
  if (!target) return;

  setTmuxWindowOptions(tmuxWindowOptionValues(chat), target);
}

function isAcpPane(context) {
  return Boolean(tmuxPaneFormat(context?.pane || "", "#{@acp_hub_provider}"));
}

function tmuxSubmitToPane(pane, text) {
  const target = shellQuote(pane || "");
  const literal = shellQuote(text);
  const command = `tmux send-keys -t ${target} -l ${literal}; tmux send-keys -t ${target} Enter`;
  return `run-shell ${tmuxDoubleQuote(command)}`;
}

function submitCommandToTmuxPane(pane, text) {
  if (!pane) return false;
  const input = spawnSync("tmux", ["send-keys", "-t", pane, "-l", String(text || "")], {
    stdio: "ignore",
  });
  if (input.error || input.status !== 0) return false;

  const enter = spawnSync("tmux", ["send-keys", "-t", pane, "Enter"], {
    stdio: "ignore",
  });
  return !enter.error && enter.status === 0;
}

function tmuxInsertToPane(pane, text) {
  return `send-keys -t ${tmuxDoubleQuote(pane || "")} -l ${tmuxDoubleQuote(text)}`;
}

function tmuxConfirmCommand(context, prompt, command) {
  const args = ["confirm-before"];
  if (context.client) args.push("-t", context.client);
  args.push("-p", prompt, command);
  return args.map((arg, index) => (index === 0 ? arg : tmuxDoubleQuote(arg))).join(" ");
}

function tmuxPanelCommand(cwd, context, panel, chatId = "") {
  const command = [
    shellQuote(process.execPath),
    shellQuote(HUB_CLI_PATH),
    "tmux-panel",
    "--cwd",
    shellQuote(cwd || ""),
    "--session",
    shellQuote(context.session || ""),
    "--client",
    shellQuote(context.client || ""),
    "--pane",
    shellQuote(context.pane || ""),
    "--panel",
    shellQuote(panel || "control"),
  ];
  if (chatId) {
    command.push("--chat-id", shellQuote(chatId));
  }
  return `run-shell ${tmuxDoubleQuote(command.join(" "))}`;
}

function planMenuMarker(status) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▸";
  if (status === "skipped" || status === "cancelled") return "⊘";
  return "·";
}

// Native tmux display-menu item builders shared by the tmux-panel subcommand
// and the in-chat /mcp, /auth panel, /plan, /roots fallbacks in the UI.
function buildMcpPanelItems(chat, context) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const servers = chat.mcpServers || [];
  if (!servers.length) {
    return [{ label: "No MCP servers configured for this chat", disabled: true }];
  }

  const items = [
    { label: `MCP servers (${servers.length})`, disabled: true },
    { separator: true },
  ];
  for (const server of servers) {
    const target = server.url || server.command || "";
    items.push({ label: `${mcpServerLabel(server)}  ${compactTmuxText(target, 48)}`, disabled: true });
  }
  return items;
}

function buildAuthPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const methods = chat.authMethods || [];
  if (!methods.length) {
    return [{ label: "No auth methods reported by this adapter", disabled: true }];
  }

  const items = [
    { label: `Authenticate ${chat.providerLabel || chat.provider || ""}`.trim(), disabled: true },
    { separator: true },
  ];
  for (const method of methods) {
    const id = method.id || method.methodId || "";
    const name = method.name || id;
    if (method.type === "env_var") {
      const vars = Array.isArray(method.vars)
        ? method.vars.map((v) => v.name).filter(Boolean).join(", ")
        : "";
      items.push({ label: `${name}  (set ${vars || "env vars"} + reopen)`, disabled: true });
    } else {
      items.push({ label: name, command: tmuxActionCommand(cwd, context, "auth", chat.id, id) });
    }
  }
  return items;
}

function buildPlanPanelItems(chat, context) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const entries = chat.plan?.entries || [];
  if (!entries.length) {
    return [{ label: "No active plan for this chat", disabled: true }];
  }

  const done = entries.filter((entry) => entry.status === "completed").length;
  const items = [
    { label: `Plan  ${done}/${entries.length} done`, disabled: true },
    { separator: true },
  ];
  for (const entry of entries) {
    items.push({
      label: `${planMenuMarker(entry.status)} ${compactTmuxText(cleanInline(entry.content), 64)}`,
      disabled: true,
    });
  }
  return items;
}

function buildRootsPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const roots = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || cwd);
  const items = [
    { label: `main  ${displayPath(chat.cwd || cwd)}`, disabled: true },
    { label: "Changes are applied on next adapter restore", disabled: true },
    { separator: true },
    {
      label: "Add directory...",
      key: "a",
      command: tmuxSubmitToPane(context.pane, "/roots add"),
    },
  ];

  if (roots.length) {
    items.push({ separator: true });
    for (const [index, root] of roots.entries()) {
      items.push({
        label: `Remove ${displayPath(root)}`,
        key: index < 9 ? String(index + 1) : "",
        command: tmuxConfirmActionCommand(
          cwd,
          context,
          "roots-remove",
          chat.id,
          `Remove workspace root ${displayPath(root)}?`,
          root,
        ),
      });
    }
    items.push({ separator: true });
    items.push({
      label: "Clear additional roots",
      key: "x",
      command: tmuxConfirmActionCommand(cwd, context, "roots-clear", chat.id, "Clear all additional roots?"),
    });
  } else {
    items.push({ label: "No additional directories configured", disabled: true });
  }

  return items;
}

function tmuxActionShellCommand(cwd, context, action, chatId = "", valueExpression = null) {
  const command = [
    shellQuote(process.execPath),
    shellQuote(HUB_CLI_PATH),
    "tmux-action",
    "--cwd",
    shellQuote(cwd || ""),
    "--session",
    shellQuote(context.session || ""),
    "--client",
    shellQuote(context.client || ""),
    "--pane",
    shellQuote(context.pane || ""),
    "--action",
    shellQuote(action || ""),
  ];
  if (chatId) {
    command.push("--chat-id", shellQuote(chatId));
  }
  if (valueExpression !== null) {
    command.push("--value", valueExpression);
  }
  return command.join(" ");
}

function actionPayload(value) {
  return JSON.stringify(value);
}

function parseActionPayload(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { value };
  }
}

function tmuxActionCommand(cwd, context, action, chatId = "", value = null) {
  const valueExpression = value === null ? null : shellQuote(value);
  return `run-shell ${tmuxDoubleQuote(tmuxActionShellCommand(cwd, context, action, chatId, valueExpression))}`;
}

function tmuxConfirmActionCommand(cwd, context, action, chatId, prompt, value = null) {
  return tmuxConfirmCommand(context, prompt, tmuxActionCommand(cwd, context, action, chatId, value));
}

function tmuxWorkspaceShellCommand(cwd, context, provider = "", chatId = "", kind = "open") {
  const script = path.join(PLUGIN_DIR, "scripts", "workspace.sh");
  return [
    "sh",
    shellQuote(script),
    shellQuote(cwd),
    shellQuote(context.session || ""),
    shellQuote(context.client || ""),
    shellQuote(context.pane || ""),
    shellQuote(provider || ""),
    shellQuote(chatId || ""),
    shellQuote(kind || ""),
  ].join(" ");
}

function tmuxRunWorkspace(cwd, context, provider = "", chatId = "", kind = "open") {
  return `run-shell ${tmuxDoubleQuote(tmuxWorkspaceShellCommand(cwd, context, provider, chatId, kind))}`;
}


export {
  providerIconFor,
  resolvedAgentIcon,
  coloredProviderIcon,
  formatChatPreview,
  formatRelativeAge,
  providerAccentSeq,
  hubAccentSeq,
  codeBlockLine,
  highlightCode,
  codeLanguageForPath,
  applyAcpStatusFormat,
  HUB_CLI_PATH,
  HUB_VERSION,
  buildMcpPanelItems,
  buildAuthPanelItems,
  buildPlanPanelItems,
  buildRootsPanelItems,
  codeFenceHeader,
  c,
  nowIso,
  shortHash,
  parseArgs,
  mkdirp,
  readJsonIfExists,
  readJsonIfExistsSync,
  backupCorruptJsonFileSync,
  writeJsonFileSync,
  loadDrafts,
  scheduleDraftsFlush,
  flushDraftsSync,
  draftKey,
  loadDraft,
  saveDraft,
  clearDraft,
  normalizeInputHistory,
  loadInputHistory,
  scheduleInputHistoryFlush,
  flushInputHistorySync,
  saveInputHistory,
  flushLocalInputStateSync,
  mergeConfig,
  configCredentialEnvNames,
  redactCommandArgs,
  loadConfig,
  npxAdapterPin,
  compareSemver,
  parseNpmViewInfo,
  acpProtocolMismatch,
  resolveProjectRoot,
  projectName,
  defaultChatTitle,
  newChatTitle,
  savedSessionTitle,
  projectKey,
  chatIdFor,
  agentEntries,
  pickerFilterEntries,
  pickerNextIndex,
  pickerValueEquals,
  statusGlyph,
  statusColorName,
  statusIndicator,
  statusBadge,
  isSettledChatStatus,
  isActiveChatStatus,
  normalizeAgentMessageRole,
  agentMessageRoleFromUpdate,
  canMergeHistoryChunk,
  TURN_SCOPED_EVENT_TYPES,
  eventTurnSequence,
  agentMessageGroups,
  buildTurnCard,
  projectTranscriptTurns,
  retainHistoryByTurns,
  cleanInline,
  normalizeTitlePolicy,
  normalizeTitleSource,
  loadTitleSettings,
  loadHistorySettings,
  normalizePermissionPolicy,
  loadPermissionSettings,
  sanitizeChatTitle,
  promptChatTitle,
  inferLegacyTitleState,
  applyChatTitleCandidate,
  chatTabTitle,
  rawLogicalLines,
  rawLinePositions,
  normalizePastedText,
  shouldStorePasteAsAttachment,
  pastedTextSummary,
  pastedAttachmentSummary,
  createPastedTextAttachment,
  attachmentsFromPathOnlyText,
  attachmentsFromPathLine,
  attachmentFromPathToken,
  resolvePastedPathToken,
  normalizePastedPathToken,
  looksLikePathInput,
  stripMatchingQuotes,
  rawInputVisualLines,
  rawVisualLineIndexAtCursor,
  rawPreviousWord,
  rawNextWord,
  listProjectFiles,
  listProjectFilesWithRg,
  listProjectFilesFallback,
  normalizeMentionQuery,
  fileMentionScore,
  commonPathPrefix,
  escapeMentionPath,
  unescapeMentionPath,
  extractFileMentions,
  mentionAttachmentsForText,
  stripAnsi,
  visibleLength,
  sameRawInputLayout,
  padVisible,
  renderInlineMarkdown,
  isMarkdownTableStart,
  isMarkdownTableRow,
  isMarkdownTableSeparator,
  hasPendingMarkdownTable,
  splitMarkdownTableRow,
  renderMarkdownTable,
  fitMarkdownTableWidths,
  tableAlignment,
  looksNumeric,
  alignVisible,
  truncateText,
  fitPlainLine,
  fitAnsiLine,
  truncateAnsiText,
  horizontalRuleLine,
  isCompletedToolStatus,
  activityGroupFor,
  cleanActivitySummary,
  normalizeActivityStatus,
  buildActivityGroups,
  projectActivityDetails,
  displayPath,
  normalizeAdditionalDirectories,
  findConfigOptionValue,
  normalizeToken,
  splitCommandWords,
  configOptionId,
  configOptionAliases,
  resolveConfigOption,
  sanitizeConfigValues,
  agentDefaultConfigValues,
  sortConfigEntries,
  selectedConfigValues,
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
  attachmentTokenRanges,
  attachmentCursorTarget,
  snapAttachmentCursor,
  attachmentDeletionRange,
  expandRangeToAttachmentTokens,
  promptDisplayTextFromAttachments,
  ATTACHMENT_TOKEN_BEFORE_CURSOR,
  wrapAttachmentChips,
  configOptionValues,
  configOptionMenuValues,
  isBooleanConfigOption,
  parseBooleanConfigValue,
  resolveConfigOptionValue,
  buildSetConfigOptionRequest,
  applyLocalConfigOptionValue,
  configOptionValueMatches,
  syncChatModeFromConfig,
  chatModeConfigOption,
  chatModeEntries,
  chatModeValue,
  modeEntries,
  resolveModeEntries,
  resolveMode,
  accessAliases,
  resolveAccessTarget,
  configOptionDisplayValue,
  valueLabel,
  compactTmuxText,
  shortSession,
  formatConfigOption,
  formatProviderCommand,
  normalizeProviderCommand,
  normalizeProviderCommands,
  mergeCommandDescriptors,
  resolveProviderCommand,
  planMarker,
  normalizePlanEntries,
  normalizePlanState,
  updatePlanState,
  settlePlanState,
  advancePlanTurn,
  latestPlanFromHistory,
  planPresentation,
  buildPromptContent,
  resolvePromptAttachment,
  attachmentContentBlock,
  embeddedResourceForAttachment,
  promptDisplayText,
  contentBlockIsImage,
  contentBlockName,
  fileNameFromUri,
  mimeTypeForPath,
  formatBytes,
  formatTokenCount,
  estimateDraftTokens,
  formatTokenEstimate,
  formatCost,
  formatContextUsage,
  planProgressLabel,
  normalizeKeyValueList,
  mcpCapabilityFlags,
  normalizeMcpServer,
  resolveMcpServers,
  mcpServerLabel,
  contentText,
  toolContentText,
  toolContentDiffs,
  computeLineDiff,
  supportsSessionClose,
  supportsSessionLoad,
  supportsSessionResume,
  supportsSessionListCapabilities,
  supportsSessionDelete,
  hasSessionCapability,
  isRestoreUnsupported,
  isMethodNotFound,
  chatAttentionRank,
  orderChatsByActivity,
  orderProjectChats,
  shellQuote,
  tmuxDoubleQuote,
  tmuxMenuTargetAttempts,
  displayTmuxMenu,
  tmuxDisplayMessage,
  tmuxPaneFormat,
  tmuxWindowOptionValues,
  setTmuxWindowOptions,
  setTmuxGlobalOptions,
  acpStatusCounts,
  acpStatusCountOptionValues,
  findTmuxWindowForChat,
  syncTmuxChatMetadata,
  isAcpPane,
  tmuxSubmitToPane,
  submitCommandToTmuxPane,
  tmuxInsertToPane,
  tmuxConfirmCommand,
  tmuxPanelCommand,
  tmuxActionShellCommand,
  actionPayload,
  parseActionPayload,
  tmuxActionCommand,
  tmuxConfirmActionCommand,
  tmuxWorkspaceShellCommand,
  tmuxRunWorkspace,
  PLUGIN_DIR,
  BIN_PATH,
  DEFAULT_CONFIG,
  ADAPTER_COMPATIBILITY,
  ADAPTER_COMPATIBILITY_PATH,
  CACHE_BASE,
  CONFIG_BASE,
  HUB_DIR,
  USER_CONFIG_PATH,
  PLUGIN_CONFIG_PATH,
  SOCKET_PATH,
  PID_PATH,
  RESTART_LOCK_PATH,
  LOG_PATH,
  STATE_PATH,
  REGISTRY_PATH,
  DRAFTS_PATH,
  INPUT_HISTORY_PATH,
  loadUiSettings,
  saveUiSettings,
  PASTES_DIR,
  HISTORY_LIMIT,
  HISTORY_PERSIST_LIMIT,
  MIN_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  INPUT_HISTORY_LIMIT,
  DRAFT_SAVE_DEBOUNCE_MS,
  INPUT_HISTORY_SAVE_DEBOUNCE_MS,
  PERMISSION_TIMEOUT_MS,
  MAX_EMBEDDED_TEXT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_AUTO_ATTACH_PASTE_PATHS,
  PASTE_TEXT_ATTACHMENT_MIN_CHARS,
  PASTE_TEXT_ATTACHMENT_MIN_LINES,
  TRANSCRIPT_SCREEN_LINE_LIMIT,
  MAX_COMPOSER_INPUT_ROWS,
  MIN_COMPOSER_INPUT_ROWS,
  COMPOSER_CARD_RAIL_WIDTH,
  COMPOSER_CARD_GAP,
  COMPOSER_CARD_RIGHT_PADDING,
  COMPOSER_META_SIDE_PADDING,
  COMPOSER_INPUT_VERTICAL_PADDING,
  COMPOSER_ANIMATION_INTERVAL_MS,
  LIVE_TABLE_PAINT_MS,
  COMPOSER_PLACEHOLDER,
  PROVIDER_ACCENT_CODES,
  PROVIDER_ACCENT_FALLBACK,
  PROVIDER_ICONS,
  PROVIDER_ICON_FALLBACK,
  MAX_ATTACHMENT_CHIP_ROWS,
  FILE_MENTION_LIMIT,
  FILE_MENTION_CACHE_MS,
  KILL_RING_LIMIT,
  COMPOSER_SPINNER_FRAMES,
  colors,
};
