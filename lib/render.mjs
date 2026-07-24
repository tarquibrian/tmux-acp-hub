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

let graphemeSegmenter;

function segmentGraphemes(value) {
  const text = String(value ?? "");
  if (!text) return [];

  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    } catch {
      graphemeSegmenter = null;
    }
  }

  if (!graphemeSegmenter) return [...text];
  return [...graphemeSegmenter.segment(text)].map((entry) => entry.segment);
}

// Width for one user-perceived character. ZWJ emoji sequences occupy one
// terminal cell cluster (normally two columns), even though summing each code
// point would substantially over-count them. This helper is intentionally
// separate from the renderer's older code-point math so title clipping can be
// corrected without changing transcript/composer layout semantics.
export function graphemeDisplayWidth(value) {
  const grapheme = String(value ?? "");
  if (!grapheme) return 0;
  if (grapheme.includes("\u200d")) return 2;

  let width = 0;
  for (const char of grapheme) width += charDisplayWidth(char);
  if (grapheme.includes("\ufe0f")) return Math.max(2, width);
  return width;
}

export function graphemeStringDisplayWidth(value) {
  const text = stripAnsi(value);
  return segmentGraphemes(text).reduce((width, grapheme) => width + graphemeDisplayWidth(grapheme), 0);
}

// Plain, single-line labels (tmux titles, picker labels) need a different
// truncation contract from prose: never split a grapheme, prefer a word
// boundary, and fall back to clipping an indivisible long token only when it
// cannot fit. The return value never exceeds maxWidth display columns.
export function truncatePlainTextToWidth(value, maxWidth, ellipsis = "…") {
  const text = stripAnsi(value);
  const limit = Math.max(0, Number(maxWidth) || 0);
  if (limit === 0) return "";
  if (graphemeStringDisplayWidth(text) <= limit) return text;

  const ellipsisWidth = graphemeStringDisplayWidth(ellipsis);
  if (ellipsisWidth > limit) return "";
  const budget = Math.max(0, limit - ellipsisWidth);
  let prefix = "";
  let width = 0;
  let cutIndex = 0;

  for (const grapheme of segmentGraphemes(text)) {
    const nextWidth = graphemeDisplayWidth(grapheme);
    if (width + nextWidth > budget) break;
    prefix += grapheme;
    width += nextWidth;
    cutIndex += grapheme.length;
  }

  let body = prefix.trimEnd();
  const endedInsideToken = body && !/\s$/u.test(prefix) && !/^\s/u.test(text.slice(cutIndex));
  if (endedInsideToken) {
    const partialToken = body.match(/\S+$/u);
    if (partialToken?.index > 0) body = body.slice(0, partialToken.index).trimEnd();
  }

  // A single token wider than the budget has no word boundary to use. Keep
  // the grapheme-safe hard clip rather than returning only an ellipsis.
  if (!body && prefix) body = prefix.trimEnd();
  return `${body}${ellipsis}`;
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

// Shared ANSI row writer. Wrapping policies decide *where* to break; this
// object owns the common column accounting, SGR carry-over, and hard fallback
// used by every policy.
class AnsiRowWriter {
  constructor(width, continuationWidth = width) {
    this.maxWidth = Math.max(1, width || 1);
    this.continuationWidth = Math.max(1, continuationWidth || 1);
    this.rows = [];
    this.sgr = new SgrState();
    this.row = "";
    this.rowWidth = 0;
    this.rowHasStyles = false;
  }

  appendRaw(raw) {
    for (const token of String(raw ?? "").split(ANSI_SPLIT)) {
      if (!token) continue;
      if (token.startsWith("\x1b[")) {
        this.sgr.see(token);
        if (!isSgrReset(token) || this.rowHasStyles || this.row.length > 0) {
          this.row += token;
          if (!isSgrReset(token)) this.rowHasStyles = true;
        }
      } else {
        this.row += token;
        this.rowWidth += stringDisplayWidth(token);
      }
    }
  }

  appendHard(raw) {
    for (const token of String(raw ?? "").split(ANSI_SPLIT)) {
      if (!token) continue;
      if (token.startsWith("\x1b[")) {
        this.appendRaw(token);
        continue;
      }
      for (const char of token) {
        const charWidth = charDisplayWidth(char);
        if (this.rowWidth > 0 && this.rowWidth + charWidth > this.maxWidth) this.breakRow();
        this.appendRaw(char);
      }
    }
  }

  pushRow() {
    this.rows.push(this.rowHasStyles ? `${this.row}${SGR_RESET}` : this.row);
  }

  breakRow() {
    this.pushRow();
    this.row = this.sgr.prefix();
    this.maxWidth = this.continuationWidth;
    this.rowWidth = 0;
    this.rowHasStyles = this.row.length > 0;
  }

  finish() {
    this.pushRow();
    return this.rows;
  }
}

// Central rendered-text layout entry point. Callers choose semantics instead
// of selecting unrelated wrapping implementations at the paint site.
export function layoutAnsiText(
  value,
  width,
  { mode = "hard", ellipsis = "…", continuationWidth = width } = {},
) {
  const maxWidth = Math.max(1, width || 1);
  const text = String(value ?? "");
  if (!text) return [""];

  if (mode === "truncate") return [truncateAnsiToWidth(text, maxWidth, ellipsis)];

  const writer = new AnsiRowWriter(maxWidth, continuationWidth);
  if (mode === "hard") {
    writer.appendHard(text);
    return writer.finish();
  }
  if (mode !== "word") throw new Error(`Unknown ANSI layout mode: ${mode}`);

  const normalized = text.replace(/\t/g, "    ");
  let pendingWhitespace = "";
  for (const token of normalized.split(/(\s+)/u)) {
    if (!token) continue;
    if (/^\s+$/u.test(token)) {
      pendingWhitespace += token;
      continue;
    }

    let separator = writer.rowWidth > 0 || writer.rows.length === 0 ? pendingWhitespace : "";
    let separatorWidth = stringDisplayWidth(separator);
    const tokenWidth = stringDisplayWidth(token);

    // A long first-row prefix can leave too little room for even one normal
    // word. Emit a prefix-only row and use the wider continuation budget
    // instead of hard-splitting a word that fits there intact.
    if (
      writer.rows.length === 0 &&
      writer.rowWidth === 0 &&
      separatorWidth + tokenWidth > writer.maxWidth &&
      tokenWidth <= writer.continuationWidth &&
      writer.continuationWidth > writer.maxWidth
    ) {
      writer.breakRow();
      separator = "";
      separatorWidth = 0;
    }

    if (writer.rowWidth > 0 && writer.rowWidth + separatorWidth + tokenWidth > writer.maxWidth) {
      writer.breakRow();
      separator = "";
      separatorWidth = 0;
    }

    // Preserve indentation on an original logical line. If indentation plus
    // the first word cannot fit, consume it with hard column accounting, then
    // begin the word on the next row when needed.
    if (writer.rowWidth === 0 && separator && separatorWidth + tokenWidth > writer.maxWidth) {
      writer.appendHard(separator);
      if (writer.rowWidth > 0 && writer.rowWidth + tokenWidth > writer.maxWidth) writer.breakRow();
      separator = "";
    }

    if (separator) writer.appendRaw(separator);

    if (tokenWidth > writer.maxWidth) {
      if (writer.rowWidth > 0) writer.breakRow();
      writer.appendHard(token);
    } else {
      writer.appendRaw(token);
    }
    pendingWhitespace = "";
  }

  // Whitespace at a soft boundary is intentionally omitted, like conventional
  // terminal word wrapping. A whitespace-only logical line remains blank.
  return writer.finish();
}

// Hard-wraps one logical line into visual rows of at most `width` display
// columns. ANSI sequences carry zero width; styles active at a break point are
// re-applied at the start of the continuation row, and every row that carries
// styles is closed with a reset so rows stay self-contained.
export function wrapAnsiLine(value, width) {
  return layoutAnsiText(value, width, { mode: "hard" });
}

// Wraps prose at whitespace boundaries while keeping the same ANSI/style and
// display-width guarantees as wrapAnsiLine. A token is hard-wrapped only when
// it cannot fit on an otherwise empty row (URLs, hashes, long identifiers).
// Explicit newlines remain the caller's responsibility: this function lays
// out one logical line.
export function wrapAnsiWords(value, width) {
  return layoutAnsiText(value, width, { mode: "word" });
}

function isWhitespaceAt(value, index) {
  if (index < 0 || index >= value.length) return false;
  const codePoint = value.codePointAt(index);
  return codePoint !== undefined && /\s/u.test(String.fromCodePoint(codePoint));
}

function consumeWhitespace(value, index) {
  let end = index;
  while (end < value.length && isWhitespaceAt(value, end)) {
    const codePoint = value.codePointAt(end);
    end += String.fromCodePoint(codePoint).length;
  }
  return end;
}

function lastWhitespaceRun(value, start, end, atomicRanges = []) {
  let run = null;
  let index = start;
  const atomicByStart = new Map(atomicRanges.map((range) => [range.start, range]));
  while (index < end) {
    const atomic = atomicByStart.get(index);
    if (atomic) {
      index = Math.min(end, atomic.end);
      continue;
    }
    const codePoint = value.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    const next = index + char.length;
    if (/\s/u.test(char)) {
      const runStart = index;
      index = consumeWhitespace(value, next);
      run = { start: runStart, end: Math.min(index, end) };
      continue;
    }
    index = next;
  }
  return run;
}

// Word-aware layout for editable plain text. Source ranges remain contiguous
// even when boundary whitespace between words is visually omitted. Trailing
// whitespace stays visible so the painted cursor advances as spaces are typed.
export function layoutEditableLine(value, width, { mode = "word", atomicRanges = [] } = {}) {
  const maxWidth = Math.max(1, width || 1);
  const text = String(value ?? "");
  if (!text) return [{ text: "", start: 0, end: 0, contentEnd: 0, width: 0 }];
  if (mode !== "word" && mode !== "hard") throw new Error(`Unknown editable layout mode: ${mode}`);

  const rows = [];
  const normalizedAtomicRanges = (atomicRanges || [])
    .map((range) => ({
      start: Math.max(0, Math.min(Number(range?.start) || 0, text.length)),
      end: Math.max(0, Math.min(Number(range?.end) || 0, text.length)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const atomicByStart = new Map(normalizedAtomicRanges.map((range) => [range.start, range]));
  let start = 0;
  while (start < text.length) {
    let fitEnd = start;
    let displayWidth = 0;
    while (fitEnd < text.length) {
      const atomic = atomicByStart.get(fitEnd);
      if (atomic) {
        const atomicWidth = stringDisplayWidth(text.slice(atomic.start, atomic.end));
        if (displayWidth > 0 && displayWidth + atomicWidth > maxWidth) break;
        fitEnd = atomic.end;
        displayWidth += atomicWidth;
        continue;
      }
      const codePoint = text.codePointAt(fitEnd);
      const char = String.fromCodePoint(codePoint);
      const charWidth = charDisplayWidth(char);
      if (displayWidth > 0 && displayWidth + charWidth > maxWidth) break;
      fitEnd += char.length;
      displayWidth += charWidth;
    }

    let end = fitEnd;
    let contentEnd = fitEnd;
    if (fitEnd < text.length && mode === "word") {
      if (isWhitespaceAt(text, fitEnd)) {
        const separatorEnd = consumeWhitespace(text, fitEnd);
        // Consume and omit a separator only when more content follows it.
        // If it reaches the input's end, leave it for the next visual row so
        // every newly typed trailing space has a real cursor column.
        if (separatorEnd < text.length) end = separatorEnd;
      } else {
        const boundary = lastWhitespaceRun(text, start, fitEnd, normalizedAtomicRanges);
        // A leading indentation run is content, not a useful word boundary.
        if (boundary && boundary.start > start) {
          contentEnd = boundary.start;
          end = boundary.end;
        }
      }
    }

    // A zero-width/control-only run must still consume input.
    if (end <= start) {
      const codePoint = text.codePointAt(start);
      end = start + String.fromCodePoint(codePoint).length;
      contentEnd = end;
    }

    const visible = text.slice(start, contentEnd);
    rows.push({
      text: visible,
      start,
      end,
      contentEnd,
      width: stringDisplayWidth(visible),
    });
    start = end;
  }

  return rows;
}

export function textOffsetAtDisplayColumn(value, targetColumn) {
  const text = String(value ?? "");
  const target = Math.max(0, targetColumn || 0);
  let offset = 0;
  let width = 0;
  while (offset < text.length) {
    const codePoint = text.codePointAt(offset);
    const char = String.fromCodePoint(codePoint);
    const charWidth = charDisplayWidth(char);
    if (width + charWidth > target) break;
    offset += char.length;
    width += charWidth;
  }
  return offset;
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
