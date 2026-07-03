// Terminal rendering primitives shared by the popup UI: display-width math
// (wcwidth approximation), ANSI-aware soft wrapping, and style-preserving
// truncation. Pure functions, no process/tty state.

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SPLIT = /(\x1B\[[0-?]*[ -/]*[@-~])/;
const SGR_RESET = "\x1b[0m";

// East Asian Wide/Fullwidth plus the common emoji planes. An approximation:
// terminals disagree on emoji sequences (ZWJ, flags), but this matches how
// most modern terminal emulators size the common cases.
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1b000, 0x1b001],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const COMBINING_PATTERN = /\p{M}/u;

export function stripAnsi(value) {
  return String(value || "").replace(ANSI_PATTERN, "");
}

export function charDisplayWidth(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;

  // Zero-width: combining marks, variation selectors, zero-width spaces/joiners.
  if (COMBINING_PATTERN.test(char)) return 0;
  if (codePoint >= 0x200b && codePoint <= 0x200f) return 0;
  if (codePoint === 0x2060 || codePoint === 0xfeff) return 0;
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0;

  // Other control characters have no useful width in a rendered line.
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;

  for (const [start, end] of WIDE_RANGES) {
    if (codePoint < start) break;
    if (codePoint <= end) return 2;
  }

  return 1;
}

export function stringDisplayWidth(value) {
  const text = stripAnsi(value);
  let width = 0;
  for (const char of text) width += charDisplayWidth(char);
  return width;
}

function isSgrSequence(token) {
  return token.startsWith("\x1b[") && token.endsWith("m");
}

function isSgrReset(token) {
  return token === "\x1b[m" || token === "\x1b[0m";
}

// Tracks the SGR sequences active at a point in a line so wrapped continuation
// rows can re-open the same styles. Raw-sequence accumulation (cleared on
// reset) rather than a full SGR state machine: the renderer always closes
// styles with a full reset, so the list stays short.
class SgrState {
  constructor() {
    this.active = [];
  }

  see(token) {
    if (!isSgrSequence(token)) return;
    if (isSgrReset(token)) {
      this.active = [];
    } else {
      this.active.push(token);
    }
  }

  prefix() {
    return this.active.join("");
  }
}

// Hard-wraps one logical line into visual rows of at most `width` display
// columns. ANSI sequences carry zero width; styles active at a break point are
// re-applied at the start of the continuation row, and every row that carries
// styles is closed with a reset so rows stay self-contained.
export function wrapAnsiLine(value, width) {
  const maxWidth = Math.max(1, width || 1);
  const text = String(value ?? "");
  if (!text) return [""];

  const rows = [];
  const sgr = new SgrState();
  let row = "";
  let rowWidth = 0;
  let rowHasStyles = false;

  const pushRow = () => {
    rows.push(rowHasStyles ? `${row}${SGR_RESET}` : row);
  };

  const breakRow = () => {
    pushRow();
    row = sgr.prefix();
    rowHasStyles = row.length > 0;
    rowWidth = 0;
  };

  for (const token of text.split(ANSI_SPLIT)) {
    if (!token) continue;

    if (token.startsWith("\x1b[")) {
      sgr.see(token);
      if (!isSgrReset(token) || rowHasStyles || row.length > 0) {
        row += token;
        if (!isSgrReset(token)) rowHasStyles = true;
      }
      continue;
    }

    for (const char of token) {
      const charWidth = charDisplayWidth(char);
      if (rowWidth > 0 && rowWidth + charWidth > maxWidth) breakRow();
      row += char;
      rowWidth += charWidth;
    }
  }

  pushRow();
  return rows;
}

// Truncates to at most `maxWidth` display columns, keeping ANSI styles and
// appending an ellipsis when content was cut. Always emits a reset after a cut
// so dangling styles never leak into the next write.
export function truncateAnsiToWidth(value, maxWidth, ellipsis = "…") {
  const text = String(value ?? "");
  const limit = Math.max(0, maxWidth || 0);
  if (stringDisplayWidth(text) <= limit) return text;

  const ellipsisWidth = stringDisplayWidth(ellipsis);
  const budget = Math.max(0, limit - ellipsisWidth);
  let output = "";
  let width = 0;

  for (const token of text.split(ANSI_SPLIT)) {
    if (!token) continue;

    if (token.startsWith("\x1b[")) {
      output += token;
      continue;
    }

    for (const char of token) {
      const charWidth = charDisplayWidth(char);
      if (width + charWidth > budget) {
        return `${output}${SGR_RESET}${ellipsis}`;
      }
      output += char;
      width += charWidth;
    }
  }

  return `${output}${SGR_RESET}${ellipsis}`;
}

export function padAnsiToWidth(value, width) {
  const text = String(value ?? "");
  const padding = Math.max(0, width - stringDisplayWidth(text));
  return `${text}${" ".repeat(padding)}`;
}
