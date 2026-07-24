#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  applyChatTitleCandidate,
  chatTabTitle,
  inferLegacyTitleState,
  loadTitleSettings,
  normalizeTitlePolicy,
  promptChatTitle,
  tmuxWindowOptionValues,
} from "../lib/core.mjs";
import {
  graphemeStringDisplayWidth,
  truncatePlainTextToWidth,
} from "../lib/render.mjs";

assert.equal(normalizeTitlePolicy("invalid"), "agent-first");
const previousPolicy = process.env.ACP_HUB_TITLE_POLICY;
const previousWidth = process.env.ACP_HUB_TAB_TITLE_MAX_WIDTH;
process.env.ACP_HUB_TITLE_POLICY = "manual-only";
process.env.ACP_HUB_TAB_TITLE_MAX_WIDTH = "200";
assert.deepEqual(loadTitleSettings(), { policy: "manual-only", tabMaxWidth: 80 });
if (previousPolicy === undefined) delete process.env.ACP_HUB_TITLE_POLICY;
else process.env.ACP_HUB_TITLE_POLICY = previousPolicy;
if (previousWidth === undefined) delete process.env.ACP_HUB_TAB_TITLE_MAX_WIDTH;
else process.env.ACP_HUB_TAB_TITLE_MAX_WIDTH = previousWidth;

assert.equal(promptChatTitle("[Image 1]\n  Mejorar la barra de tmux"), "Mejorar la barra de tmux");
assert.equal(promptChatTitle("[Image #2] revisar el navbar"), "revisar el navbar");
assert.equal(promptChatTitle("\n\n"), "", "an attachment/blank-only prompt has no fallback title");

const family = "👨‍👩‍👧‍👦";
assert.equal(truncatePlainTextToWidth("abc", 0), "");
assert.equal(graphemeStringDisplayWidth("©"), 1);
assert.equal(graphemeStringDisplayWidth("©️"), 2);
const emojiTitle = truncatePlainTextToWidth(`aaaa ${family} bbbb`, 8);
assert.equal(emojiTitle, `aaaa ${family}…`, "a ZWJ grapheme is never split");
assert.equal(graphemeStringDisplayWidth(emojiTitle), 8);
assert.equal(
  truncatePlainTextToWidth("palabra completa final", 17),
  "palabra completa…",
  "normal titles truncate at a word boundary",
);
assert.ok(
  graphemeStringDisplayWidth(chatTabTitle("日本語で非常に長い会話タイトルです", 12)) <= 12,
  "CJK labels respect terminal columns",
);

const initial = {
  title: "New chat",
  titleSource: "default",
  defaultTitle: "New chat",
  fallbackTitle: "",
};
const prompt = applyChatTitleCandidate(initial, { title: "Mejorar tabs", source: "prompt" });
assert.equal(prompt.title, "Mejorar tabs");
assert.equal(prompt.titleSource, "prompt");

const laterPrompt = applyChatTitleCandidate(prompt, { title: "Otro mensaje", source: "prompt" });
assert.deepEqual(laterPrompt, prompt, "agent-first keeps the first prompt fallback stable");

const agent = applyChatTitleCandidate(prompt, { title: "Mejorar títulos de tabs", source: "agent" });
assert.equal(agent.titleSource, "agent");
assert.equal(agent.title, "Mejorar títulos de tabs");
assert.equal(
  applyChatTitleCandidate(agent, { title: "Un prompt posterior", source: "prompt" }).title,
  agent.title,
  "later prompts cannot overwrite an ACP title",
);
assert.equal(
  applyChatTitleCandidate(agent, { title: "Título ACP evolucionado", source: "agent" }).title,
  "Título ACP evolucionado",
  "ACP may evolve its own title",
);

const manual = applyChatTitleCandidate(agent, { title: "Mi nombre", source: "manual" });
assert.equal(manual.titleSource, "manual");
assert.equal(
  applyChatTitleCandidate(manual, { title: "Título del agente", source: "agent" }).title,
  "Mi nombre",
  "manual always wins",
);

const clearedAgent = applyChatTitleCandidate(agent, { title: null, source: "agent" });
assert.equal(clearedAgent.title, "Mejorar tabs", "an ACP clear falls back to the first prompt");
assert.equal(clearedAgent.titleSource, "prompt");

const firstPrompt = applyChatTitleCandidate(
  initial,
  { title: "Primero", source: "prompt" },
  "first-prompt",
);
assert.equal(
  applyChatTitleCandidate(firstPrompt, { title: "Agente", source: "agent" }, "first-prompt").title,
  "Primero",
);
assert.equal(
  applyChatTitleCandidate(prompt, { title: "Último", source: "prompt" }, "latest-prompt").title,
  "Último",
);
assert.deepEqual(
  applyChatTitleCandidate(initial, { title: "Automático", source: "agent" }, "manual-only"),
  initial,
);

assert.equal(
  inferLegacyTitleState({ title: "Prompt guardado", history: [{ type: "user", text: "Prompt guardado" }] }).titleSource,
  "prompt",
);
assert.equal(
  inferLegacyTitleState({ title: "Nombre posiblemente manual", history: [] }).titleSource,
  "legacy",
);
assert.equal(
  inferLegacyTitleState({ title: "Título del proveedor", source: "agent-list" }).titleSource,
  "agent",
);

const canonical = "Revisar cuidadosamente la generación automática de nombres para los tabs de tmux";
const tabTitle = chatTabTitle(canonical, 24);
const values = tmuxWindowOptionValues({
  id: "chat-1",
  provider: "codex",
  providerLabel: "Codex ACP",
  title: canonical,
  titleSource: "agent",
  tabTitle,
  active: true,
});
assert.equal(values["@acp_hub_title"], canonical, "tmux keeps the canonical title separately");
assert.equal(values["@acp_hub_tab_title"], tabTitle);
assert.ok(graphemeStringDisplayWidth(tabTitle) <= 24);
assert.equal(values["@acp_hub_title_source"], "agent");

console.log("title policy test passed");
