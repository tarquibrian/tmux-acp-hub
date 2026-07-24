#!/usr/bin/env node
// Canonical plan lifecycle plus the compact/expanded composer presentation.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;
delete process.env.TMUX;

const {
  advancePlanTurn,
  latestPlanFromHistory,
  normalizePlanState,
  planPresentation,
  settlePlanState,
  updatePlanState,
} = await import("../lib/core.mjs");
const { PopupUi } = await import("../bin/acp-hub.mjs");
const { stripAnsi } = await import("../lib/render.mjs");

const entries = [
  { content: "Inspect the current implementation", status: "completed", priority: "high" },
  { content: "Build the pinned plan panel", status: "in_progress", priority: "medium" },
  { content: "Run the complete test suite", status: "pending", priority: "low" },
];

// ACP updates are whole snapshots. Each replacement advances the local
// revision and remains associated with the active local turn.
const first = updatePlanState(null, entries, {
  turnSequence: 4,
  updatedAt: "2026-07-18T12:00:00.000Z",
});
assert.equal(first.revision, 1);
assert.equal(first.turnSequence, 4);
assert.equal(first.lifecycle, "active");
assert.deepEqual(first.entries.map((entry) => entry.status), ["completed", "in_progress", "pending"]);

const complete = updatePlanState(
  first,
  entries.map((entry) => ({ ...entry, status: "completed" })),
  { turnSequence: 4, updatedAt: "2026-07-18T12:01:00.000Z" },
);
assert.equal(complete.revision, 2);
assert.equal(complete.lifecycle, "completed");

// Turn-level outcomes decorate the plan without inventing non-standard ACP
// entry statuses.
const cancelled = settlePlanState(first, "cancelled", "2026-07-18T12:02:00.000Z");
assert.equal(cancelled.lifecycle, "cancelled");
assert.equal(cancelled.entries[1].status, "in_progress");
const interrupted = settlePlanState(first, "error", "2026-07-18T12:02:00.000Z");
assert.equal(interrupted.lifecycle, "interrupted");

const previous = advancePlanTurn(complete, 5, "2026-07-18T12:03:00.000Z");
assert.equal(previous.lifecycle, "previous");
assert.equal(previous.previousLifecycle, "completed");
assert.equal(previous.turnSequence, 4, "the plan remains owned by the turn that produced it");
assert.equal(settlePlanState(previous, "end_turn").lifecycle, "previous");
const incomplete = settlePlanState(first, "end_turn", "2026-07-18T12:02:30.000Z");
const carriedCanonical = advancePlanTurn(incomplete, 5, "2026-07-18T12:03:00.000Z");
assert.equal(carriedCanonical.lifecycle, "previous");
assert.equal(carriedCanonical.previousLifecycle, "incomplete");

// Registry migration can recover the newest structured plan event from the
// persisted transcript, but never presents an old incomplete plan as active.
const migrated = latestPlanFromHistory([
  { type: "plan", entries: entries.slice(0, 2), at: "2026-07-18T11:00:00.000Z" },
  { type: "agent_chunk", text: "working" },
  { type: "plan", entries, at: "2026-07-18T11:01:00.000Z" },
]);
assert.equal(migrated.lifecycle, "previous");
assert.equal(migrated.previousLifecycle, "incomplete");
assert.equal(migrated.entries.length, 3);
assert.equal(
  latestPlanFromHistory([
    { type: "plan", entries, at: "2026-07-18T11:01:00.000Z" },
    { type: "plan", entries: [], at: "2026-07-18T11:02:00.000Z" },
  ]),
  null,
  "an empty ACP replacement remains a tombstone during history recovery",
);
assert.equal(normalizePlanState({ entries: [] }), null);
assert.equal(
  normalizePlanState({ entries, lifecycle: "previous" }).previousLifecycle,
  "incomplete",
  "legacy registry plans infer a safe retired lifecycle without migration",
);

const activeView = planPresentation({
  plan: first,
  status: "working",
  turnActive: true,
});
assert.equal(activeView.done, 1);
assert.equal(activeView.total, 3);
assert.equal(activeView.percent, 33);
assert.equal(activeView.currentIndex, 1);
assert.equal(activeView.tone, "active");

const errorView = planPresentation({ plan: first, status: "error", turnActive: false });
assert.equal(errorView.tone, "error");
assert.match(errorView.stateLabel, /interrupted/i);
assert.equal(errorView.currentEntry.status, "in_progress");
const permissionView = planPresentation({ plan: first, status: "permission", turnActive: true });
assert.equal(permissionView.tone, "waiting");
assert.match(permissionView.stateLabel, /permission/i);
const completeView = planPresentation({ plan: complete, status: "idle", turnActive: false });
assert.equal(completeView.tone, "complete");
assert.equal(completeView.percent, 100);

function makeUi(plan = first) {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo/demo",
    currentChat: {
      id: "c1",
      provider: "codex",
      providerLabel: "Codex ACP",
      projectName: "demo",
      status: "working",
      turnActive: true,
      cwd: "/repo/demo",
      plan,
    },
    rawInput: null,
    pendingAttachments: [],
    pendingPermission: null,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    composerAnimationFrame: 0,
    activePicker: null,
    inlinePicker: null,
    lastRawInputLayout: null,
    lastRawScrollBottom: null,
    planPinMode: "auto",
    planCompletedBehavior: "collapse",
    planAwaitingPolicy: "auto",
    planExpanded: false,
  });
  return ui;
}

const session = (line = "") => ({ pinned: true, line, cursor: line.length });

// Completion text uses the same soft green as syntax strings, while its solid
// progress markers use the restrained stronger icon variant.
{
  const ui = makeUi(complete);
  const header = ui.planHeaderLine(completeView, 100);
  assert.ok(header.includes("\x1b[38;5;114m"));
  assert.ok(header.includes("\x1b[38;5;78m"));
}

// The smart header is one left-aligned sequence. Active work replaces the
// provider label with its live state, while idle sessions restore the label;
// Plan detail degrades before the primary identity is truncated.
{
  const ui = makeUi();
  const active = stripAnsi(ui.composerHeaderLine(99));
  assert.match(active, /⠋ working  Plan/);
  assert.doesNotMatch(active, /⬡|Codex/, "active state replaces provider icon and label");

  ui.currentChat.status = "idle";
  const wide = stripAnsi(ui.composerHeaderLine(99));
  assert.match(wide, /⬡ Codex  Plan/);
  assert.match(wide, /Plan.*1\/3.*33%.*In progress/i);
  assert.ok(wide.indexOf("Plan") > wide.indexOf("Codex"));
  assert.doesNotMatch(wide, /Codex\s{3,}Plan/, "Plan follows the provider instead of right-aligning");

  ui.rawInput = { searchActive: true };
  const withBadge = stripAnsi(ui.composerHeaderLine(99));
  assert.match(withBadge, /⬡ Codex  Plan.*\[SEARCH\]/, "secondary badges follow inline Plan");
  ui.rawInput = null;

  const medium = stripAnsi(ui.composerHeaderLine(39));
  assert.match(medium, /⬡ Codex  Plan/);
  assert.match(medium, /Plan.*1\/3/);

  const constrained = stripAnsi(ui.composerHeaderLine(13));
  assert.match(constrained, /⬡ Codex/);
  assert.doesNotMatch(constrained, /Plan/, "provider identity wins at the hard minimum");
}

// Collapsed progress is header-only, so an ACP snapshot can use the one-row
// repaint path instead of invalidating the card/transcript. Once Ctrl+P is
// open, phase changes correctly enter the non-title signature.
{
  const ui = makeUi();
  ui.rawInput = session("stable draft");
  const collapsedBefore = ui.composerNonTitleSignature();
  ui.currentChat.plan = updatePlanState(
    ui.currentChat.plan,
    entries.map((entry, index) => ({
      ...entry,
      status: index < 2 ? "completed" : "in_progress",
    })),
    { turnSequence: 4 },
  );
  assert.equal(
    ui.composerNonTitleSignature(),
    collapsedBefore,
    "collapsed ACP progress repaints only the smart header",
  );
  ui.planExpanded = true;
  assert.notEqual(
    ui.composerNonTitleSignature(),
    collapsedBefore,
    "open drawer content participates in differential rendering",
  );
}

// The Plan drawer remains one cell before ordinary transcript content; the
// default three-cell transcript inset therefore places phases at column two.
{
  const ui = makeUi();
  ui.transcriptPadding = 3;
  ui.planDisplayLines = () => ["Plan 1/3"];
  const operations = [];
  const painter = {
    to(column, row) {
      operations.push(["to", column, row]);
      return this;
    },
    clearLine() {
      operations.push(["clear"]);
      return this;
    },
    text(value) {
      operations.push(["text", String(value)]);
      return this;
    },
  };
  ui.paintPlanSection(painter, { planRows: 1, planRow: 4 }, 80);
  assert.deepEqual(operations[0], ["to", 2, 4]);
}

// An unfinished plan remains visible, but explicitly provisional, between the
// new prompt and the first ACP snapshot. The authoritative replacement keeps
// its geometry when it is equivalent and may replace every entry dynamically.
{
  const ui = makeUi(carriedCanonical);
  ui.currentChat.turnSequence = 5;
  ui.currentChat.planSupported = true;
  ui.currentChat.mode = "default";
  const carried = ui.currentPlanPresentation();
  assert.equal(carried.lifecycle, "carried");
  assert.equal(carried.canonicalLifecycle, "previous");
  assert.match(carried.stateLabel, /awaiting update/i);
  assert.equal(carried.total, 3);
  assert.deepEqual(carried.entries, carriedCanonical.entries);
  const carriedLayout = ui.rawInputLayout(session());
  assert.equal(carriedLayout.planRows, 0, "collapsed plans consume no physical rows");
  assert.match(stripAnsi(ui.composerHeaderLine(99)), /Plan.*1\/3.*Awaiting update/);
  assert.deepEqual(ui.planDisplayLines(carriedLayout.columns - 1, carriedLayout.planRows), []);

  ui.currentChat.plan = updatePlanState(carriedCanonical, entries, { turnSequence: 5 });
  const active = ui.currentPlanPresentation();
  assert.equal(active.lifecycle, "active");
  assert.equal(active.total, 3);
  const activeLayout = ui.rawInputLayout(session());
  assert.equal(activeLayout.planRows, carriedLayout.planRows);
  assert.equal(activeLayout.planRow, carriedLayout.planRow);
  assert.equal(activeLayout.outputBottom, carriedLayout.outputBottom);

  const replacement = [
    { content: "Re-evaluate the changed request", status: "in_progress", priority: "high" },
    { content: "Implement the revised scope", status: "pending", priority: "medium" },
  ];
  ui.currentChat.plan = updatePlanState(ui.currentChat.plan, replacement, { turnSequence: 5 });
  assert.deepEqual(ui.currentPlanPresentation().entries, replacement);

  ui.currentChat.plan = updatePlanState(ui.currentChat.plan, [], { turnSequence: 5 });
  assert.equal(ui.currentChat.plan, null, "an empty complete snapshot clears the canonical plan");
  assert.equal(ui.currentPlanPresentation(), null);

  const noUpdate = makeUi(carriedCanonical);
  noUpdate.currentChat.turnSequence = 5;
  assert.equal(noUpdate.currentPlanPresentation().lifecycle, "carried");
  noUpdate.currentChat.turnActive = false;
  noUpdate.currentChat.status = "idle";
  assert.equal(noUpdate.currentPlanPresentation().lifecycle, "previous");
  assert.equal(noUpdate.rawInputLayout(session()).planRows, 0);
  noUpdate.currentChat.turnSequence = 6;
  noUpdate.currentChat.turnActive = true;
  noUpdate.currentChat.status = "thinking";
  assert.equal(
    noUpdate.currentPlanPresentation().lifecycle,
    "previous",
    "a plan is carried only into the immediately following turn",
  );
  assert.equal(noUpdate.rawInputLayout(session()).planRows, 0);

  // A permission/auth/cancellation pause belongs to the new turn. It may
  // relabel the carried presentation, but it never mutates or re-owns the
  // canonical plan from the preceding turn.
  for (const [status, label] of [
    ["permission", /waiting for permission/i],
    ["auth", /waiting for authentication/i],
    ["cancelling", /cancelling/i],
  ]) {
    const paused = makeUi(carriedCanonical);
    paused.currentChat.turnSequence = 5;
    paused.currentChat.status = status;
    const pausedView = paused.currentPlanPresentation();
    assert.equal(pausedView.lifecycle, "carried");
    assert.equal(pausedView.canonicalLifecycle, "previous");
    assert.match(pausedView.stateLabel, label);
    assert.equal(paused.currentChat.plan.lifecycle, "previous");
  }

  // A topic change, cancellation, or error without an ACP plan snapshot is
  // indistinguishable at protocol level: after the turn settles, retire the
  // provisional view and keep the old plan inspectable only as history.
  for (const [outcome, status] of [
    ["cancelled", "idle"],
    ["error", "error"],
  ]) {
    const settled = makeUi(settlePlanState(carriedCanonical, outcome));
    settled.currentChat.turnActive = false;
    settled.currentChat.status = status;
    assert.equal(settled.currentPlanPresentation().lifecycle, "previous");
    assert.equal(settled.currentChat.plan.previousLifecycle, "incomplete");
    assert.equal(settled.rawInputLayout(session()).planRows, 0);
  }

  // Observed support is a diagnostic fact, not evidence that every later
  // prompt intends to create a plan.
  const observed = makeUi(null);
  observed.currentChat.planSupported = true;
  observed.currentChat.mode = "default";
  assert.equal(observed.currentPlanPresentation(), null);
  assert.equal(observed.rawInputLayout(session()).planRows, 0);

  const unsupported = makeUi(null);
  unsupported.currentChat.provider = "claude";
  unsupported.currentChat.planSupported = false;
  unsupported.currentChat.mode = "default";
  assert.equal(unsupported.currentPlanPresentation(), null);
  assert.equal(unsupported.rawInputLayout(session()).planRows, 0);

  unsupported.currentChat.mode = "plan";
  assert.equal(unsupported.currentPlanPresentation().lifecycle, "awaiting");
  unsupported.currentChat.turnActive = false;
  unsupported.currentChat.status = "idle";
  assert.equal(unsupported.currentPlanPresentation(), null);

  const forced = makeUi(null);
  forced.currentChat.mode = "default";
  forced.planAwaitingPolicy = "on";
  assert.equal(forced.currentPlanPresentation().lifecycle, "awaiting");
}

// Completed, cancelled, and interrupted plans remain inspectable history, but
// never masquerade as a carried execution plan in an unrelated new turn.
for (const terminalPlan of [complete, cancelled, interrupted]) {
  const retired = advancePlanTurn(terminalPlan, 5, "2026-07-18T12:04:00.000Z");
  const ui = makeUi(retired);
  ui.currentChat.turnSequence = 5;
  ui.currentChat.planSupported = true;
  ui.currentChat.mode = "default";
  assert.equal(ui.currentPlanPresentation().lifecycle, "previous");
  assert.equal(ui.rawInputLayout(session()).planRows, 0);
}

// A collapsed plan is summarized by the smart header and consumes no drawer
// rows. Expanding grows upward, leaving every card row and cursor coordinate
// stable.
{
  const ui = makeUi();
  const collapsed = ui.rawInputLayout(session("draft"));
  assert.equal(collapsed.planRows, 0);
  assert.equal(collapsed.upperPanelKind, null);
  assert.equal(collapsed.gapRow, collapsed.outputBottom);
  assert.equal(collapsed.headerTopGapRow, collapsed.gapRow);
  const header = stripAnsi(ui.composerHeaderLine(collapsed.columns - 1));
  assert.match(header, /⠋ working  Plan.*1\/3/);
  assert.doesNotMatch(header, /⬡|Codex/);
  assert.match(header, /In progress/i);

  ui.planExpanded = true;
  const expanded = ui.rawInputLayout(session("draft"));
  assert.equal(expanded.upperPanelKind, "plan");
  assert.ok(expanded.planRows > 0);
  assert.equal(expanded.upperPanelPadRow, expanded.headerRow + 1);
  assert.equal(expanded.planRow, expanded.headerRow + 2);
  assert.equal(expanded.headerGapRow, expanded.planRow + expanded.planRows);
  for (const key of [
    "headerGapRow",
    "cardTopRow",
    "inputRow",
    "cardMetaGapRow",
    "footerRow",
    "cardBottomRow",
    "infoGapTopRow",
    "hintRow",
    "infoGapBottomRow",
  ]) {
    assert.equal(expanded[key], collapsed[key], `${key} stays fixed when Ctrl+P opens`);
  }
  const drawer = ui.planDisplayLines(
    ui.planDrawerContentWidth(expanded.columns),
    expanded.planRows,
  ).map(stripAnsi);
  assert.ok(drawer.some((line) => line.includes("Build the pinned plan panel")));
  assert.ok(drawer.every((line) => !/^\s*Plan\s+\d/.test(line)), "drawer does not duplicate its header");
  assert.doesNotMatch(
    stripAnsi(ui.composerHeaderLine(expanded.columns - 1)),
    /\[PLAN\]/,
    "expanded state has no legacy focus badge",
  );
  assert.match(
    ui.inputHint("draft"),
    /Ctrl\+P\/Esc close plan · input active/,
    "the non-modal close gesture is taught in the external guide",
  );
}

// No structured plan means no summary. Completed plans remain a header-only
// summary by default, while the expanded drawer wraps every full phase.
{
  const ui = makeUi(null);
  assert.equal(ui.rawInputLayout(session()).planRows, 0);

  ui.currentChat.plan = complete;
  assert.equal(ui.rawInputLayout(session()).planRows, 0);
  assert.match(stripAnsi(ui.composerHeaderLine(99)), /Plan.*3\/3.*Complete/);

  ui.planExpanded = true;
  const layout = ui.rawInputLayout(session());
  assert.ok(layout.planRows > 1);
  const lines = ui.planDisplayLines(ui.planDrawerContentWidth(layout.columns), layout.planRows);
  assert.ok(lines.some((line) => String(line).includes("Inspect the current implementation")));
  assert.ok(lines.some((line) => String(line).includes("Build the pinned plan panel")));
}

// Expansion prefers the complete phase list over an unused transcript reserve.
// A six-step Plan is exactly six body rows: there is no navigation footer.
{
  const sixEntries = Array.from({ length: 6 }, (_, index) => ({
    content: `Phase ${index + 1}`,
    status: index < 5 ? "completed" : "in_progress",
    priority: "medium",
  }));
  const sixPlan = updatePlanState(null, sixEntries, { turnSequence: 4 });
  const ui = makeUi(sixPlan);
  ui.planExpanded = true;
  process.stdout.rows = 30;
  const layout = ui.rawInputLayout(session());
  assert.equal(layout.planRows, 6, "all six phases are visible");
  const lines = ui.planDisplayLines(
    ui.planDrawerContentWidth(layout.columns),
    layout.planRows,
  ).map(stripAnsi);
  for (let index = 1; index <= 6; index += 1) {
    assert.ok(lines.some((line) => line.includes(`Phase ${index}`)));
  }
  assert.equal(lines.length, 6);
}

// Expanded Plan is visibility, not focus: the composer remains editable. Only
// Ctrl+P/Esc close it; q, arrows, Home/End, and ordinary text keep their normal
// input behavior. PgUp/PgDn return to the transcript's global scroll.
{
  const ui = makeUi();
  const draft = session("keep this draft");
  ui.rawInput = draft;
  ui.inputHistory = [];
  ui.saveRawDraft = () => {};
  let repaints = 0;
  ui.renderRawInput = () => { repaints += 1; };
  ui.notify = () => {};
  assert.equal(ui.togglePlanExpanded(true), true);
  assert.equal(ui.planExpanded, true);
  assert.equal(ui.handlePlanViewerKey(draft, "q", { name: "q" }), false);
  assert.equal(ui.handlePlanViewerKey(draft, "", { name: "left" }), false);
  ui.handleRawKeypress(draft, "q", { name: "q" }, () => {});
  assert.equal(draft.line, "keep this draftq", "typing continues with Plan visible");
  assert.equal(ui.planExpanded, true);
  assert.equal(ui.handlePlanViewerKey(draft, "", { name: "pagedown" }), false);
  assert.equal(ui.planExpanded, true);
  let transcriptScroll = 0;
  ui.transcriptPageRows = () => 4;
  ui.scrollTranscript = (delta) => { transcriptScroll += delta; };
  ui.handleRawKeypress(draft, "", { name: "pagedown" }, () => {});
  assert.equal(transcriptScroll, -4, "PgDn retains global transcript scrolling");
  assert.equal(ui.handlePlanViewerKey(draft, "", { name: "p", ctrl: true }), true);
  assert.equal(ui.planExpanded, false);
  assert.equal(draft.line, "keep this draftq");
  assert.equal(draft.cursor, draft.line.length);

  assert.equal(ui.togglePlanExpanded(true), true);
  assert.equal(ui.handlePlanViewerKey(draft, "", { name: "escape" }), true);
  assert.equal(ui.planExpanded, false);
  assert.ok(repaints >= 2);
}

// Small popups keep the collapsed summary in the header. Opening Ctrl+P grants
// at least one phase row without overlapping the transcript or card.
{
  const ui = makeUi();
  process.stdout.rows = 12;
  const collapsed = ui.rawInputLayout(session());
  assert.equal(collapsed.planRows, 0);
  assert.ok(collapsed.outputBottom >= 1);
  assert.equal(collapsed.gapRow, collapsed.outputBottom);

  ui.planExpanded = true;
  const layout = ui.rawInputLayout(session());
  assert.equal(layout.planRows, 2);
  assert.ok(layout.outputBottom >= 1);
  assert.equal(layout.planRow, layout.headerRow + 2);

  // When the input itself needs most of a very small popup, preserving useful
  // transcript space wins over the decorative separator.
  const constrained = ui.rawInputLayout(session("one\ntwo\nthree\nfour\nfive\nsix\nseven"));
  assert.equal(constrained.planRows, 1);
  assert.equal(constrained.gapRow, constrained.outputBottom);
  process.stdout.rows = 30;
}

// The expanded drawer spends otherwise-unused transcript rows on the complete
// phase list, retaining one transcript row and its visual separator. Its
// summary remains in the smart header and is never counted again inside it.
{
  const ui = makeUi();
  ui.planExpanded = true;

  const cases = [
    { rows: 10, planRows: 1, gap: true, topGap: false, outputBottom: 1 },
    { rows: 11, planRows: 1, gap: true, topGap: true, outputBottom: 1 },
    { rows: 12, planRows: 2, gap: true, topGap: true, outputBottom: 1 },
    { rows: 13, planRows: 3, gap: true, topGap: true, outputBottom: 1 },
    { rows: 14, planRows: 3, gap: true, topGap: true, outputBottom: 2 },
    { rows: 15, planRows: 3, gap: true, topGap: true, outputBottom: 1 },
    { rows: 16, planRows: 3, gap: true, topGap: true, outputBottom: 2 },
    { rows: 17, planRows: 3, gap: true, topGap: true, outputBottom: 3 },
    { rows: 18, planRows: 3, gap: true, topGap: true, outputBottom: 4 },
    { rows: 19, planRows: 3, gap: true, topGap: true, outputBottom: 5 },
    { rows: 20, planRows: 3, gap: true, topGap: true, outputBottom: 6 },
  ];

  for (const expected of cases) {
    process.stdout.rows = expected.rows;
    const layout = ui.rawInputLayout(session());
    assert.equal(layout.planRows, expected.planRows, `plan rows at height ${expected.rows}`);
    assert.equal(layout.gapRow !== null, expected.gap, `separator at height ${expected.rows}`);
    assert.equal(layout.outputBottom, expected.outputBottom, `transcript rows at height ${expected.rows}`);
    if (expected.gap) {
      assert.equal(layout.gapRow, layout.outputBottom);
    }
    assert.equal(Boolean(layout.upperPanelPadRow !== null), expected.topGap);
    assert.equal(layout.planRow, layout.headerRow + (expected.topGap ? 2 : 1));
    assert.ok(layout.planRow >= 0);
    assert.ok(layout.headerRow < layout.rows);

    if (expected.rows === 12) {
      const lines = ui.planDisplayLines(ui.planDrawerContentWidth(layout.columns), layout.planRows);
      assert.equal(lines.length, 2);
      assert.match(String(lines[0]), /Inspect the current implementation/);
      assert.match(String(lines[1]), /Build the pinned plan panel/);
      assert.doesNotMatch(String(lines[0]), /^\s*Plan\s/);
    }
  }

  process.stdout.rows = 30;
}

// If a tall draft makes the ideal transcript budget physically impossible,
// keep only one phase row and surrender draft viewport rows so the transcript
// separator itself never disappears.
{
  const ui = makeUi();
  ui.planExpanded = true;
  process.stdout.rows = 15;
  const layout = ui.rawInputLayout(session("one\ntwo\nthree\nfour\nfive\nsix\nseven"));
  assert.equal(layout.enhanced, true);
  assert.equal(layout.inputRows, 4);
  assert.equal(layout.planRows, 1);
  assert.equal(layout.gapRow, layout.outputBottom);
  assert.equal(layout.outputBottom, 1);
  process.stdout.rows = 30;
}

// Across the supported compact/expanded geometry, every fixed row remains on
// screen and starts after the scroll region. A six-row draft may surrender one
// visible viewport row in the absolute smallest popup rather than overlap the
// transcript and plan bands.
{
  for (const columns of [24, 40, 100]) {
    process.stdout.columns = columns;
    for (let rows = 10; rows <= 30; rows += 1) {
      process.stdout.rows = rows;
      for (const expanded of [false, true]) {
        for (const line of ["draft", "one\ntwo\nthree\nfour\nfive\nsix\nseven"]) {
          const ui = makeUi();
          ui.planExpanded = expanded;
          const layout = ui.rawInputLayout(session(line));
          const fixedStart = layout.gapRow ?? layout.planRow ?? layout.headerRow;
          assert.ok(fixedStart >= layout.outputBottom, `no overlap at ${columns}x${rows}`);
          assert.ok(
            layout.composerRows.every((row) => Number.isInteger(row) && row >= 0 && row < layout.rows),
            `fixed rows stay on screen at ${columns}x${rows}`,
          );
        }
      }
    }
  }
  process.stdout.columns = 100;
  process.stdout.rows = 30;
}

// Layout transitions clear both the previous and next fixed bands and repaint
// the transcript whenever expansion, resize, or plan removal moves its bottom
// boundary. This prevents stale plan/gap rows from surviving a state change.
{
  const ui = makeUi();
  const draft = session("keep draft");
  ui.rawInput = draft;
  ui.lastRawInputLayout = ui.rawInputLayout(draft);

  const clears = [];
  const repaints = [];
  ui.enableRawInputLayout = () => {};
  ui.clearRawInputLayoutRows = (layouts) => { clears.push(layouts); };
  ui.repaintPinnedOutput = (layout) => { repaints.push(layout); };
  ui.renderPinnedRawInput = (_session, layout) => { ui.lastRawInputLayout = layout; };

  const compact = ui.lastRawInputLayout;
  ui.planExpanded = true;
  ui.renderRawInput();
  const expanded = ui.lastRawInputLayout;
  assert.ok(expanded.planRows > compact.planRows);
  assert.deepEqual(clears.at(-1), [compact, expanded]);
  assert.equal(repaints.at(-1), expanded);

  process.stdout.rows = 15;
  const beforeResize = ui.lastRawInputLayout;
  ui.renderRawInput();
  const resized = ui.lastRawInputLayout;
  assert.equal(resized.outputBottom, 1, "expanded resize prioritizes the visible Plan safely");
  assert.deepEqual(clears.at(-1), [beforeResize, resized]);
  assert.equal(repaints.at(-1), resized);

  const beforeRemoval = ui.lastRawInputLayout;
  ui.planExpanded = false;
  ui.currentChat.plan = null;
  ui.renderRawInput();
  const removed = ui.lastRawInputLayout;
  assert.equal(removed.planRows, 0);
  assert.equal(removed.gapRow, removed.outputBottom, "the smart header keeps its ordinary gap");
  assert.deepEqual(clears.at(-1), [beforeRemoval, removed]);
  assert.equal(repaints.at(-1), removed);

  process.stdout.rows = 30;
}

console.log("plan panel tests: ok");
