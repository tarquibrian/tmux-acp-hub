#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AdapterVersionManager,
  adapterDescriptor,
  adapterPackageKey,
  normalizeManifest,
  normalizeUpdateSettings,
  parseDurationMs,
  projectAdapterVersionStates,
  registryTarget,
  formatVersionState,
  withAdapterLock,
} from "../lib/versions.mjs";

const config = {
  defaultAgent: "codex",
  agents: {
    codex: {
      label: "Codex ACP",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
    },
    custom: { label: "Custom", command: "/opt/custom-acp", args: [] },
  },
};

async function fakeAdapterInstall(args) {
  const prefix = args[args.indexOf("--prefix") + 1];
  const spec = args.at(-1);
  const version = spec.match(/@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)[1];
  const packageDir = path.join(prefix, "node_modules", "@agentclientprotocol", "codex-acp");
  const binDir = path.join(prefix, "node_modules", ".bin");
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@agentclientprotocol/codex-acp",
      version,
      bin: { "codex-acp": "dist/index.js" },
    }),
  );
  await fsp.writeFile(path.join(binDir, "codex-acp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { code: 0, stdout: "installed", stderr: "" };
}

assert.deepEqual(adapterDescriptor("codex", config.agents.codex), {
  provider: "codex",
  label: "Codex ACP",
  managed: true,
  package: "@agentclientprotocol/codex-acp",
  configuredVersion: "1.1.4",
  runtimePackage: "@openai/codex",
  globalCommand: "codex",
});
assert.equal(adapterDescriptor("custom", config.agents.custom).managed, false);
assert.equal(adapterPackageKey("@agentclientprotocol/codex-acp"), "agentclientprotocol__codex-acp");

assert.equal(parseDurationMs("30m"), 30 * 60 * 1000);
assert.equal(parseDurationMs("24h"), 24 * 60 * 60 * 1000);
assert.equal(parseDurationMs("2d"), 2 * 24 * 60 * 60 * 1000);
assert.equal(normalizeUpdateSettings({ channel: "unknown" }).channel, "stable");
assert.equal(normalizeUpdateSettings({ notify: "off" }).notify, false);
assert.equal(normalizeUpdateSettings({ keepVersions: 99 }).keepVersions, 5);
assert.equal(normalizeUpdateSettings({ checkIntervalMs: 24 * 60 * 60 * 1000 }).checkIntervalMs, 24 * 60 * 60 * 1000);
assert.equal(registryTarget({ distTags: { latest: "1.2.0", next: "2.0.0-beta.1" } }, "stable"), "1.2.0");
assert.equal(registryTarget({ distTags: { latest: "1.2.0", next: "2.0.0-beta.1" } }, "edge"), "2.0.0-beta.1");
assert.match(
  formatVersionState(projectAdapterVersionStates(config, { providers: {} })[0]),
  /1\.1\.4 via npx.*npx fallback/,
);
assert.doesNotMatch(
  formatVersionState(projectAdapterVersionStates(config, { providers: {} })[0]),
  /not prepared/,
);
assert.match(
  formatVersionState({
    provider: "codex",
    managed: true,
    configuredVersion: "1.1.4",
    activeVersion: "1.1.4",
    pendingVersion: "1.2.0",
    deprecated: "package retired",
    state: "pending",
  }),
  /deprecated · review before restart/,
);

{
  const states = projectAdapterVersionStates(
    config,
    {
      schemaVersion: 1,
      providers: {
        codex: {
          package: "@agentclientprotocol/codex-acp",
          activeVersion: "1.1.3",
          previousVersion: "1.1.2",
          installed: [
            { package: "@agentclientprotocol/codex-acp", version: "1.1.3", binName: "codex-acp" },
          ],
        },
      },
    },
    {
      "@agentclientprotocol/codex-acp": { targetVersion: "1.1.4" },
    },
  );
  assert.equal(states[0].state, "outdated");
  assert.equal(states[0].previousVersion, "1.1.2");
  assert.equal(states[1].state, "unmanaged");
}

{
  const normalized = normalizeManifest({
    schemaVersion: 99,
    providers: {
      codex: {
        package: "@agentclientprotocol/codex-acp",
        activeVersion: "1.1.4",
        pendingVersion: "1.2.0",
        installed: [{ version: "1.1.4", package: "@agentclientprotocol/codex-acp", binName: "codex-acp" }],
      },
    },
  });
  assert.equal(normalized.schemaVersion, 1);
  const state = projectAdapterVersionStates(config, normalized)[0];
  assert.equal(state.state, "pending");
  assert.equal(state.pendingVersion, "1.2.0");
}

// Installer/activation/rollback with a fake npm runner. It creates the same
// package layout npm would, while the injected smoke test keeps the suite
// offline and deterministic.
{
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "acp-versions-"));
  const fakeRun = async (command, args) => {
    if (args[0] === "view") {
      return {
        code: 0,
        stdout: JSON.stringify({
          version: "1.1.5",
          "dist-tags": { latest: "1.1.5", next: "1.2.0-beta.1" },
        }),
        stderr: "",
      };
    }
    if (args[0] === "install") {
      return fakeAdapterInstall(args);
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const manager = new AdapterVersionManager({
    config,
    home: temp,
    settings: { channel: "stable", checkInterval: "24h", keepVersions: 2 },
    runCommand: fakeRun,
    smokeTest: async () => ({ protocolVersion: 1 }),
  });
  try {
    const update = await manager.update("codex", { force: true });
    assert.equal(update.pendingVersion, "1.1.5");
    let manifest = await manager.readManifest();
    assert.equal(manifest.providers.codex.activeVersion, "1.1.4");
    assert.equal(manifest.providers.codex.pendingVersion, "1.1.5");

    const promoted = await manager.promotePending();
    assert.deepEqual(promoted.promoted, [{ provider: "codex", from: "1.1.4", to: "1.1.5" }]);
    manifest = await manager.readManifest();
    assert.equal(manifest.providers.codex.activeVersion, "1.1.5");
    assert.equal(manifest.providers.codex.previousVersion, "1.1.4");

    const resolved = manager.resolveAgent("codex", config.agents.codex, manifest);
    assert.match(resolved.command, /adapters\/packages\/agentclientprotocol__codex-acp\/1\.1\.5/);
    assert.deepEqual(resolved.args, []);

    const current = await manager.update("codex", { force: true });
    assert.equal(current.alreadyCurrent, true);
    assert.equal(current.requiresRestart, false);

    const rollback = await manager.rollback("codex");
    assert.equal(rollback.pendingVersion, "1.1.4");

    const cancelledRollback = await manager.update("codex", { force: true });
    assert.equal(cancelledRollback.alreadyCurrent, true);
    assert.equal(cancelledRollback.requiresRestart, false);
    assert.equal((await manager.readManifest()).providers.codex.pendingVersion, null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// A registry tag older than the configured fallback can never turn an update
// command into an accidental downgrade.
{
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "acp-versions-downgrade-"));
  const installed = [];
  const manager = new AdapterVersionManager({
    config,
    home: temp,
    runCommand: async (_command, args) => {
      if (args[0] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({ version: "1.1.3", "dist-tags": { latest: "1.1.3" } }),
          stderr: "",
        };
      }
      installed.push(args.at(-1));
      return fakeAdapterInstall(args);
    },
    smokeTest: async () => ({ protocolVersion: 1 }),
  });
  try {
    const update = await manager.update("codex", { force: true });
    assert.equal(update.pendingVersion, "1.1.4");
    assert.deepEqual(installed, ["@agentclientprotocol/codex-acp@1.1.4"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Batch updates report every provider outcome instead of hiding an earlier
// success when a later adapter fails.
{
  const batchConfig = {
    agents: {
      codex: config.agents.codex,
      claude: {
        command: "npx",
        args: ["-y", "@agentclientprotocol/claude-agent-acp@0.59.0"],
      },
    },
  };
  const manager = new AdapterVersionManager({ config: batchConfig });
  manager.update = async (provider) => {
    if (provider === "claude") throw new Error("handshake rejected");
    return { ok: true, provider, pendingVersion: "1.1.5", requiresRestart: true };
  };
  const result = await manager.updateAll();
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map((entry) => entry.provider), ["codex"]);
  assert.deepEqual(result.errors, [{ provider: "claude", error: "handshake rejected" }]);
  assert.equal(result.requiresRestart, true);
}

// Registry failures retain a labelled stale result instead of converting an
// offline machine into an update failure.
{
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "acp-versions-cache-"));
  let offline = false;
  const manager = new AdapterVersionManager({
    config,
    home: temp,
    runCommand: async (_command, args) => {
      if (offline) throw new Error("network unavailable");
      assert.equal(args[0], "view");
      return {
        code: 0,
        stdout: JSON.stringify({ version: "1.1.5", "dist-tags": { latest: "1.1.5" } }),
        stderr: "",
      };
    },
  });
  try {
    const descriptor = manager.descriptor("codex");
    const online = await manager.queryRegistry(descriptor, { force: true });
    assert.equal(online.targetVersion, "1.1.5");
    offline = true;
    const stale = await manager.queryRegistry(descriptor, { force: true });
    assert.equal(stale.targetVersion, "1.1.5");
    assert.equal(stale.stale, true);
    assert.match(stale.error, /network unavailable/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// A failed/incompatible handshake never creates an active or pending record.
{
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "acp-versions-bad-"));
  const manager = new AdapterVersionManager({
    config,
    home: temp,
    runCommand: async (_command, args) => {
      if (args[0] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({ version: "1.1.4", "dist-tags": { latest: "1.1.4" } }),
          stderr: "",
        };
      }
      return fakeAdapterInstall(args);
    },
    smokeTest: async () => {
      throw new Error("adapter negotiated ACP protocol v2; this hub requires v1");
    },
  });
  try {
    await assert.rejects(
      manager.update("codex", { force: true }),
      /protocol v2.*requires v1/,
    );
    const manifest = await manager.readManifest();
    assert.equal(manifest.providers.codex, undefined);
    const staging = path.join(temp, "adapters", ".staging");
    const entries = await fsp.readdir(staging).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Two processes cannot mutate the manifest simultaneously; the second waits
// and acquires the same lock after the first releases it.
{
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "acp-versions-lock-"));
  const lockPath = path.join(temp, "update.lock");
  const order = [];
  try {
    const first = withAdapterLock(async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 80));
      order.push("first:end");
    }, { lockPath, timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = withAdapterLock(async () => {
      order.push("second:start");
      order.push("second:end");
    }, { lockPath, timeoutMs: 1000 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log("versions test passed");
