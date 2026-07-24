#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  normalizeHubTheme,
  resolveHubThemePalette,
} from "../lib/theme.mjs";

const pink = "\x1b[38;2;242;98;134m";

assert.equal(normalizeHubTheme("VANZI"), "vanzi");
assert.equal(normalizeHubTheme("agent"), "agent");
assert.equal(normalizeHubTheme("unknown"), "vanzi");

const vanziCodex = resolveHubThemePalette({
  variant: "vanzi",
  provider: "codex",
  vanziAccentSeq: pink,
  tty: true,
});
const vanziClaude = resolveHubThemePalette({
  variant: "vanzi",
  provider: "claude",
  vanziAccentSeq: pink,
  tty: true,
});
assert.equal(vanziCodex.accentForeground, pink);
assert.equal(vanziClaude.accentForeground, pink);
assert.equal(vanziCodex.accentBackground, "\x1b[48;2;242;98;134m");

const agentCodex = resolveHubThemePalette({
  variant: "agent",
  provider: "codex",
  vanziAccentSeq: pink,
  tty: true,
});
const agentClaude = resolveHubThemePalette({
  variant: "agent",
  provider: "claude",
  vanziAccentSeq: pink,
  tty: true,
});
const agentUnknown = resolveHubThemePalette({
  variant: "agent",
  provider: "future-agent",
  vanziAccentSeq: pink,
  tty: true,
});
assert.equal(agentCodex.accentForeground, "\x1b[38;5;39m");
assert.equal(agentClaude.accentForeground, "\x1b[38;5;173m");
assert.equal(agentUnknown.accentForeground, pink);

for (const key of [
  "surfaceBackground",
  "surfaceHoverBackground",
  "surfaceSelectedBackground",
  "text",
  "textStrong",
  "textDisabled",
]) {
  assert.equal(agentCodex[key], vanziCodex[key], `${key} is variant-independent`);
}

console.log("theme test passed");
