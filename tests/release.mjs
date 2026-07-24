#!/usr/bin/env node
// Release-facing regressions: public CLI, package metadata/docs, and a clean
// tmux load from an install path containing spaces. No user tmux server or
// hub state is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_COMPATIBILITY, DEFAULT_CONFIG } from "../lib/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "acp-hub.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

// The installed CLI has a discoverable, version-synchronized public surface.
for (const flag of ["--help", "-h", "help"]) {
  const result = run(process.execPath, [BIN, flag]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:\s+acp-hub <command>/);
  assert.match(result.stdout, /health/);
  assert.match(result.stdout, /restart/);
  assert.match(result.stdout, /versions/);
  assert.match(result.stdout, /update <agent>/);
  assert.match(result.stdout, /rollback <id>/);
}
for (const flag of ["--version", "-v", "version"]) {
  const result = run(process.execPath, [BIN, flag]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
}
{
  const result = run(process.execPath, [BIN, "not-a-command"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--help/);
}

assert.match(pkg.version, /^0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(pkg.private, true, "GitHub-only releases must not be publishable to npm");
assert.match(
  pkg.scripts?.prepublishOnly || "",
  /distributed from GitHub\/TPM, not npm/,
  "an explicit publish guard must backstop npm clients that ignore private metadata",
);
assert.deepEqual(pkg.files, [
  "acp-hub.tmux",
  "agents.json",
  "assets/*.svg",
  "bin/",
  "CHANGELOG.md",
  "compatibility/",
  "lib/",
  "MAINTENANCE.md",
  "scripts/",
]);

// agents.json and the built-in fallback cannot silently drift apart.
{
  const agents = JSON.parse(fs.readFileSync(path.join(ROOT, "agents.json"), "utf8"));
  assert.deepEqual(agents, DEFAULT_CONFIG);
  assert.equal(ADAPTER_COMPATIBILITY.defaultAgent, DEFAULT_CONFIG.defaultAgent);
  for (const [provider, adapter] of Object.entries(ADAPTER_COMPATIBILITY.adapters)) {
    assert.deepEqual(DEFAULT_CONFIG.agents[provider].args, [
      "-y",
      `${adapter.package}@${adapter.defaultVersion}`,
    ]);
    assert.ok(adapter.testedVersions.includes(adapter.defaultVersion));
  }
}

// Health warns about permissive plaintext credential config without leaking
// the value, and accepts a user-only file mode.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-health-"));
  const configPath = path.join(temp, "agents.json");
  const statePath = path.join(temp, "state");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        codex: {
          command: "true",
          args: ["--api-key", "do-not-print-arg"],
          env: { OPENAI_API_KEY: "do-not-print-this" },
        },
        claude: { command: "true", args: [] },
      },
    }),
  );
  try {
    fs.chmodSync(configPath, 0o644);
    const exposed = run(process.execPath, [BIN, "health"], {
      env: { ...process.env, ACP_HUB_CONFIG: configPath, ACP_HUB_HOME: statePath },
    });
    assert.equal(exposed.status, 0, exposed.stderr);
    assert.match(exposed.stdout, /config permissions.*chmod 600/);
    assert.doesNotMatch(exposed.stdout, /do-not-print-this/);
    assert.doesNotMatch(exposed.stdout, /do-not-print-arg/);

    fs.chmodSync(configPath, 0o600);
    const protectedResult = run(process.execPath, [BIN, "health"], {
      env: { ...process.env, ACP_HUB_CONFIG: configPath, ACP_HUB_HOME: statePath },
    });
    assert.equal(protectedResult.status, 0, protectedResult.stderr);
    assert.match(protectedResult.stdout, /config permissions.*600/);
    assert.doesNotMatch(protectedResult.stdout, /do-not-print-this/);
    assert.doesNotMatch(protectedResult.stdout, /do-not-print-arg/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Local README links resolve in the package/repository.
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
    assert.ok(fs.existsSync(path.join(ROOT, target)), `missing README target: ${target}`);
  }
  assert.doesNotMatch(readme, /Vanzi red/i);
  assert.doesNotMatch(readme, /\(`x` done, `>` in progress, `-` pending\)/);
  assert.match(readme, /GitHub is the canonical distribution source/);
  assert.match(readme, /### Uninstalling/);
  assert.doesNotMatch(
    readme,
    /npm (?:install|i)(?:\s+--global|\s+-g)?\s+tmux-acp-hub/i,
    "0.2.0 must not document npm as a distribution channel",
  );

  const pluginEntry = fs.readFileSync(path.join(ROOT, "acp-hub.tmux"), "utf8");
  for (const match of pluginEntry.matchAll(/set_default\s+(@acp_hub_[A-Za-z0-9_]+)/g)) {
    assert.ok(readme.includes(`\`${match[1]}\``), `undocumented tmux option: ${match[1]}`);
  }

  const runtimeSources = [
    path.join(ROOT, "bin", "acp-hub.mjs"),
    ...["core.mjs", "daemon.mjs", "render.mjs", "rpc.mjs", "ui.mjs"].map((name) =>
      path.join(ROOT, "lib", name),
    ),
    ...fs.readdirSync(path.join(ROOT, "scripts"))
      .filter((name) => name.endsWith(".sh"))
      .map((name) => path.join(ROOT, "scripts", name)),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const runtimeEnvNames = new Set(runtimeSources.match(/ACP_HUB_[A-Za-z0-9_]+/g) || []);
  for (const name of runtimeEnvNames) {
    assert.ok(readme.includes(`\`${name}`) || readme.includes(`${name}=`), `undocumented env: ${name}`);
  }
}

// Public runtime strings are English; legacy migration identifiers remain
// allowed in core/resurrect documentation.
{
  const switcher = fs.readFileSync(path.join(ROOT, "scripts", "switcher.sh"), "utf8");
  assert.doesNotMatch(switcher, /no hay chats/i);
}

// Load the complete plugin from a path with spaces on an isolated tmux server.
// This catches nested run-shell quoting that syntax checks cannot see.
{
  const probe = run("tmux", ["-V"]);
  assert.equal(probe.status, 0, "tmux is required for the release integration test");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "acp release "));
  const linkedRoot = path.join(temp, "plugin with spaces");
  const socket = `acp-release-${process.pid}-${Date.now()}`;
  fs.symlinkSync(ROOT, linkedRoot, "dir");
  const tmux = (...args) => run("tmux", ["-L", socket, ...args]);

  try {
    assert.equal(tmux("-f", "/dev/null", "new-session", "-d", "-s", "audit").status, 0);
    assert.equal(tmux("set-option", "-gq", "@acp_hub_key_toggle", "off").status, 0);
    assert.equal(tmux("set-option", "-gq", "@acp_hub_key_menu", "C-a").status, 0);
    assert.equal(tmux("set-option", "-gq", "@acp_hub_key_control", "").status, 0);
    const load = tmux("run-shell", `sh ${shellQuote(path.join(linkedRoot, "acp-hub.tmux"))}`);
    assert.equal(load.status, 0, load.stderr);

    const rename = tmux("list-keys", "-T", "prefix", ",");
    assert.equal(rename.status, 0, rename.stderr);
    assert.match(rename.stdout, /send-keys.*C-g/);
    assert.doesNotMatch(rename.stdout, /send-keys.*C-t/);
    assert.doesNotMatch(
      rename.stdout,
      /send-keys.*-t.*#\{pane_id\}/,
      "the active-pane rename must not pass a deferred format as a literal target",
    );

    const menu = tmux("list-keys", "-T", "prefix", "C-a");
    assert.equal(menu.status, 0, menu.stderr);
    assert.match(menu.stdout, /workspace\.sh/);
    assert.match(menu.stdout, /plugin with spaces/);

    const toggle = tmux("list-keys", "-T", "prefix", "m");
    assert.doesNotMatch(toggle.stdout, /tmux-acp-hub|plugin with spaces|workspace\.sh/);

    const control = tmux("list-keys", "-T", "prefix", "y");
    assert.doesNotMatch(control.stdout, /tmux-acp-hub|plugin with spaces|tmux-menu\.sh/);

    const close = tmux("list-keys", "-T", "prefix", "x");
    assert.equal(close.status, 0, close.stderr);
    assert.match(close.stdout, /close-menu\.sh/);
    assert.match(close.stdout, /plugin with spaces/);

    const nativeDrag = tmux("list-keys", "-T", "root", "MouseDrag1Pane");
    assert.equal(nativeDrag.status, 0, nativeDrag.stderr);
    assert.match(nativeDrag.stdout, /@acp_hub_chat_id/);
    assert.match(nativeDrag.stdout, /copy-mode -M/);
    assert.match(nativeDrag.stdout, /mouse_any_flag/);
    assert.equal(
      tmux("show-option", "-gqv", "@acp_hub_mouse_native_select_status").stdout.trim(),
      "enabled",
    );

    // Turning the feature off restores tmux's stock behavior.
    assert.equal(tmux("set-option", "-gq", "@acp_hub_mouse_native_select", "off").status, 0);
    assert.equal(tmux("run-shell", `sh ${shellQuote(path.join(linkedRoot, "acp-hub.tmux"))}`).status, 0);
    const restoredDrag = tmux("list-keys", "-T", "root", "MouseDrag1Pane");
    assert.doesNotMatch(restoredDrag.stdout, /@acp_hub_chat_id/);
    assert.match(restoredDrag.stdout, /mouse_any_flag/);

    // A custom root drag remains user-owned in normal `on` mode.
    assert.equal(tmux("bind-key", "-T", "root", "MouseDrag1Pane", "display-message", "custom-drag").status, 0);
    assert.equal(tmux("set-option", "-gq", "@acp_hub_mouse_native_select", "on").status, 0);
    assert.equal(tmux("run-shell", `sh ${shellQuote(path.join(linkedRoot, "acp-hub.tmux"))}`).status, 0);
    const customDrag = tmux("list-keys", "-T", "root", "MouseDrag1Pane");
    assert.match(customDrag.stdout, /custom-drag/);
    assert.doesNotMatch(customDrag.stdout, /@acp_hub_chat_id/);
    assert.equal(
      tmux("show-option", "-gqv", "@acp_hub_mouse_native_select_status").stdout.trim(),
      "custom-binding",
    );

    // `force` is the explicit escape hatch for users who want ACP routing to
    // replace their customized root drag.
    assert.equal(tmux("set-option", "-gq", "@acp_hub_mouse_native_select", "force").status, 0);
    assert.equal(tmux("run-shell", `sh ${shellQuote(path.join(linkedRoot, "acp-hub.tmux"))}`).status, 0);
    assert.match(tmux("list-keys", "-T", "root", "MouseDrag1Pane").stdout, /@acp_hub_chat_id/);
  } finally {
    tmux("kill-server");
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log("release test passed");
