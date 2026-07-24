// Adapter version discovery, private installs, activation, and rollback.
//
// This module deliberately owns only the ACP processes launched by the Hub.
// Standalone `codex` / `claude` installations are reported for diagnostics but
// are never modified.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  HUB_DIR,
  HUB_VERSION,
  compareSemver,
  npxAdapterPin,
  nowIso,
  readJsonIfExists,
  writeJsonFileSync,
} from "./core.mjs";
import { AcpPeer } from "./rpc.mjs";

const ADAPTER_STORE_DIR = path.join(HUB_DIR, "adapters");
const ADAPTER_PACKAGES_DIR = path.join(ADAPTER_STORE_DIR, "packages");
const ADAPTER_STAGING_DIR = path.join(ADAPTER_STORE_DIR, ".staging");
const ADAPTER_MANIFEST_PATH = path.join(ADAPTER_STORE_DIR, "manifest.json");
const ADAPTER_CHECKS_PATH = path.join(ADAPTER_STORE_DIR, "checks.json");
const ADAPTER_LOCK_PATH = path.join(ADAPTER_STORE_DIR, "update.lock");
const ADAPTER_MANIFEST_SCHEMA = 1;
const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_UPDATE_CHANNEL = "stable";
const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPDATE_KEEP_VERSIONS = 2;
const REGISTRY_TIMEOUT_MS = 5000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 20000;
const LOCK_TIMEOUT_MS = 15000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

const PROVIDER_RUNTIME_PACKAGES = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-agent-sdk",
};
const PROVIDER_GLOBAL_COMMANDS = { codex: "codex", claude: "claude" };

function safeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function parseDurationMs(value, fallback = DEFAULT_UPDATE_CHECK_INTERVAL_MS) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  const match = text.match(/^(\d+)(m|h|d)?$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const multiplier = match[2] === "m"
    ? 60 * 1000
    : match[2] === "d"
      ? 24 * 60 * 60 * 1000
      : 60 * 60 * 1000;
  return Math.max(5 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, amount * multiplier));
}

function normalizeUpdateSettings(raw = {}) {
  const channel = ["stable", "edge"].includes(String(raw.channel || "").toLowerCase())
    ? String(raw.channel).toLowerCase()
    : DEFAULT_UPDATE_CHANNEL;
  const notifyText = String(raw.notify ?? "on").toLowerCase();
  return {
    channel,
    checkIntervalMs: Number.isFinite(Number(raw.checkIntervalMs))
      ? Math.max(
          5 * 60 * 1000,
          Math.min(30 * 24 * 60 * 60 * 1000, Number(raw.checkIntervalMs)),
        )
      : parseDurationMs(raw.checkInterval),
    notify: !["0", "off", "false", "no"].includes(notifyText),
    keepVersions: safeInteger(
      raw.keepVersions,
      DEFAULT_UPDATE_KEEP_VERSIONS,
      1,
      5,
    ),
  };
}

function tmuxOption(name) {
  if (!process.env.TMUX) return "";
  try {
    const result = spawnSync("tmux", ["show-option", "-gqv", name], {
      encoding: "utf8",
      timeout: 250,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

function configuredValue(envName, optionName, fallback = "") {
  if (Object.hasOwn(process.env, envName)) return String(process.env[envName] || "").trim();
  return tmuxOption(optionName) || fallback;
}

function loadAdapterUpdateSettings() {
  return normalizeUpdateSettings({
    channel: configuredValue(
      "ACP_HUB_UPDATE_CHANNEL",
      "@acp_hub_update_channel",
      DEFAULT_UPDATE_CHANNEL,
    ),
    checkInterval: configuredValue(
      "ACP_HUB_UPDATE_CHECK_INTERVAL",
      "@acp_hub_update_check_interval",
      "24h",
    ),
    notify: configuredValue(
      "ACP_HUB_UPDATE_NOTIFY",
      "@acp_hub_update_notify",
      "on",
    ),
    keepVersions: configuredValue(
      "ACP_HUB_UPDATE_KEEP_VERSIONS",
      "@acp_hub_update_keep_versions",
      String(DEFAULT_UPDATE_KEEP_VERSIONS),
    ),
  });
}

function adapterPackageKey(pkg) {
  return String(pkg || "")
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/gi, "__");
}

function adapterDescriptor(provider, agent) {
  const pin = npxAdapterPin(agent);
  if (!pin) {
    return {
      provider,
      label: agent?.label || provider,
      managed: false,
      reason: "custom or unpinned command",
      command: agent?.command || "",
    };
  }
  return {
    provider,
    label: agent?.label || provider,
    managed: true,
    package: pin.pkg,
    configuredVersion: pin.version,
    runtimePackage: PROVIDER_RUNTIME_PACKAGES[provider] || null,
    globalCommand: PROVIDER_GLOBAL_COMMANDS[provider] || null,
  };
}

function emptyManifest() {
  return { schemaVersion: ADAPTER_MANIFEST_SCHEMA, updatedAt: null, providers: {} };
}

function normalizeInstalledRecord(record) {
  if (!record || typeof record !== "object" || !record.version) return null;
  return {
    version: String(record.version),
    package: String(record.package || ""),
    binName: String(record.binName || ""),
    installedAt: record.installedAt || null,
    protocolVersion: Number(record.protocolVersion) || ACP_PROTOCOL_VERSION,
    dependencies:
      record.dependencies && typeof record.dependencies === "object" ? record.dependencies : {},
  };
}

function normalizeManifest(raw) {
  const result = emptyManifest();
  if (!raw || typeof raw !== "object") return result;
  result.updatedAt = raw.updatedAt || null;
  for (const [provider, value] of Object.entries(raw.providers || {})) {
    if (!value || typeof value !== "object") continue;
    const installed = (Array.isArray(value.installed) ? value.installed : [])
      .map(normalizeInstalledRecord)
      .filter(Boolean);
    result.providers[provider] = {
      package: String(value.package || ""),
      activeVersion: value.activeVersion ? String(value.activeVersion) : null,
      pendingVersion: value.pendingVersion ? String(value.pendingVersion) : null,
      previousVersion: value.previousVersion ? String(value.previousVersion) : null,
      installed,
    };
  }
  return result;
}

function providerManifest(manifest, provider, descriptor) {
  const current = manifest.providers?.[provider];
  if (current?.package && current.package !== descriptor.package) {
    return {
      package: descriptor.package,
      activeVersion: null,
      pendingVersion: null,
      previousVersion: null,
      installed: [],
    };
  }
  return {
    package: descriptor.package,
    activeVersion: current?.activeVersion || null,
    pendingVersion: current?.pendingVersion || null,
    previousVersion: current?.previousVersion || null,
    installed: Array.isArray(current?.installed) ? [...current.installed] : [],
  };
}

function registryTarget(info, channel = DEFAULT_UPDATE_CHANNEL) {
  if (!info || typeof info !== "object") return null;
  if (channel === "edge") {
    return info.distTags?.next || info.distTags?.beta || info.distTags?.latest || info.latest || null;
  }
  return info.distTags?.latest || info.latest || null;
}

function versionState(descriptor, record = {}, registry = null) {
  if (!descriptor.managed) {
    return { ...descriptor, state: "unmanaged", availableVersion: null };
  }
  const activeVersion = record.activeVersion || null;
  const pendingVersion = record.pendingVersion || null;
  const availableVersion = registry?.targetVersion || null;
  const baseline = pendingVersion || activeVersion || descriptor.configuredVersion;
  const updateAvailable = Boolean(
    availableVersion && compareSemver(baseline, availableVersion) < 0,
  );
  let state = "current";
  if (pendingVersion) state = "pending";
  else if (registry?.deprecated) state = "deprecated";
  else if (updateAvailable) state = "outdated";
  else if (!activeVersion) state = "not_prepared";
  return {
    ...descriptor,
    state,
    activeVersion,
    pendingVersion,
    previousVersion: record.previousVersion || null,
    availableVersion,
    updateAvailable,
    deprecated: registry?.deprecated || null,
    registryError: registry?.error || null,
    registryStale: registry?.stale === true,
    installed: Array.isArray(record.installed) ? record.installed : [],
  };
}

function projectAdapterVersionStates(config, manifestRaw, registryByPackage = {}) {
  const manifest = normalizeManifest(manifestRaw);
  return Object.entries(config?.agents || {}).map(([provider, agent]) => {
    const descriptor = adapterDescriptor(provider, agent);
    const record = descriptor.managed
      ? providerManifest(manifest, provider, descriptor)
      : {};
    return versionState(descriptor, record, registryByPackage[descriptor.package] || null);
  });
}

function commandVersion(text) {
  const match = String(text || "").match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match?.[0] || String(text || "").trim() || null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const append = (current, chunk) => `${current}${chunk}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0) finish(null, result);
      else {
        const detail = String(stderr || stdout || signal || code).trim().slice(-1000);
        const error = new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
        error.result = result;
        finish(error);
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
      finish(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs || INSTALL_TIMEOUT_MS);
    timer.unref?.();
  });
}

async function readChecks(file = ADAPTER_CHECKS_PATH) {
  try {
    const raw = await readJsonIfExists(file);
    return raw && typeof raw === "object" ? raw : { packages: {} };
  } catch {
    return { packages: {} };
  }
}

async function withAdapterLock(action, options = {}) {
  const lockPath = options.lockPath || ADAPTER_LOCK_PATH;
  const timeoutMs = options.timeoutMs || LOCK_TIMEOUT_MS;
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  let handle = null;
  while (!handle) {
    try {
      handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${nowIso()}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.unlink(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) {
        throw new Error("another adapter update is already running");
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  try {
    return await action();
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
}

function packageRoot(storeDir, pkg, version) {
  return path.join(storeDir, "packages", adapterPackageKey(pkg), version);
}

function packageJsonPath(root, pkg) {
  return path.join(root, "node_modules", ...pkg.split("/"), "package.json");
}

function packageBinName(pkgJson) {
  if (typeof pkgJson?.bin === "string") return String(pkgJson.name || "").split("/").pop();
  if (pkgJson?.bin && typeof pkgJson.bin === "object") return Object.keys(pkgJson.bin)[0] || "";
  return "";
}

async function installedDependencyVersions(root, names = []) {
  const result = {};
  for (const name of names.filter(Boolean)) {
    try {
      const pkg = JSON.parse(await fsp.readFile(packageJsonPath(root, name), "utf8"));
      if (pkg.version) result[name] = String(pkg.version);
    } catch {}
  }
  return result;
}

function launchForInstall(root, record) {
  const executable = path.join(root, "node_modules", ".bin", record.binName);
  return { command: executable, args: [] };
}

async function smokeAdapterLaunch(launch, options = {}) {
  const grouped = process.platform !== "win32";
  const child = spawn(launch.command, launch.args || [], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, NO_BROWSER: "1", ...(options.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: grouped,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const peer = new AcpPeer(child);
  try {
    const init = await peer.call(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: "tmux-acp-hub-update-check",
          title: "tmux ACP Hub update check",
          version: HUB_VERSION,
        },
      },
      { timeoutMs: options.timeoutMs || HANDSHAKE_TIMEOUT_MS },
    );
    const protocolVersion = init?.protocolVersion ?? ACP_PROTOCOL_VERSION;
    if (protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `adapter negotiated ACP protocol v${protocolVersion}; this hub requires v${ACP_PROTOCOL_VERSION}`,
      );
    }
    return {
      protocolVersion,
      agentInfo: init?.agentInfo || null,
      agentCapabilities: init?.agentCapabilities || {},
      authMethods: Array.isArray(init?.authMethods) ? init.authMethods : [],
    };
  } catch (error) {
    const detail = stderr.trim().split("\n").slice(-3).join(" · ");
    if (detail && !String(error.message).includes(detail)) error.message += `: ${detail}`;
    throw error;
  } finally {
    peer.close();
    await stopChildTree(child, { grouped });
  }
}

async function stopChildTree(child, options = {}) {
  if (!child?.pid) return;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const onExit = new Promise((resolve) => {
    if (exited) return resolve();
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const signal = (name) => {
    try {
      if (options.grouped) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {}
  };
  signal("SIGTERM");
  await Promise.race([
    onExit,
    new Promise((resolve) => setTimeout(resolve, 750)),
  ]);
  if (!exited) {
    signal("SIGKILL");
    await Promise.race([
      onExit,
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

class AdapterVersionManager {
  constructor(options = {}) {
    this.config = options.config || { agents: {} };
    this.home = options.home || HUB_DIR;
    this.storeDir = options.storeDir || path.join(this.home, "adapters");
    this.manifestPath = options.manifestPath || path.join(this.storeDir, "manifest.json");
    this.checksPath = options.checksPath || path.join(this.storeDir, "checks.json");
    this.lockPath = options.lockPath || path.join(this.storeDir, "update.lock");
    this.settings = normalizeUpdateSettings(options.settings || loadAdapterUpdateSettings());
    this.run = options.runCommand || runCommand;
    this.smoke = options.smokeTest || smokeAdapterLaunch;
    this.now = options.now || (() => Date.now());
    this.npmCommand = options.npmCommand || "npm";
  }

  descriptor(provider) {
    const agent = this.config?.agents?.[provider];
    if (!agent) throw new Error(`Unknown ACP agent: ${provider}`);
    return adapterDescriptor(provider, agent);
  }

  async readManifest() {
    try {
      return normalizeManifest(await readJsonIfExists(this.manifestPath));
    } catch {
      return emptyManifest();
    }
  }

  saveManifest(manifest) {
    const normalized = normalizeManifest(manifest);
    normalized.updatedAt = nowIso();
    writeJsonFileSync(this.manifestPath, normalized);
    return normalized;
  }

  async queryRegistry(descriptor, options = {}) {
    if (!descriptor.managed) return null;
    const checks = await readChecks(this.checksPath);
    const key = `${descriptor.package}:${this.settings.channel}`;
    const cached = checks.packages?.[key];
    const fresh = cached && this.now() - Date.parse(cached.checkedAt || 0) < this.settings.checkIntervalMs;
    if (fresh && options.force !== true) return { ...cached, stale: false };

    try {
      const result = await this.run(
        this.npmCommand,
        ["view", descriptor.package, "dist-tags", "version", "deprecated", "--json"],
        { timeoutMs: REGISTRY_TIMEOUT_MS },
      );
      const parsed = JSON.parse(result.stdout || "null");
      const info = typeof parsed === "string"
        ? { latest: parsed, distTags: { latest: parsed } }
        : {
            latest: parsed?.version || parsed?.["dist-tags"]?.latest || null,
            distTags: parsed?.["dist-tags"] || {},
            deprecated: parsed?.deprecated || null,
          };
      const value = {
        package: descriptor.package,
        checkedAt: new Date(this.now()).toISOString(),
        latest: info.latest,
        distTags: info.distTags,
        deprecated: info.deprecated,
        targetVersion: registryTarget(info, this.settings.channel),
      };
      checks.packages = { ...(checks.packages || {}), [key]: value };
      writeJsonFileSync(this.checksPath, checks);
      return { ...value, stale: false };
    } catch (error) {
      if (cached) return { ...cached, stale: true, error: error.message };
      return { error: error.message, targetVersion: null, stale: false };
    }
  }

  async globalCliInfo(descriptor) {
    if (!descriptor.globalCommand) return null;
    try {
      const which = await this.run("sh", ["-c", `command -v ${descriptor.globalCommand}`], {
        timeoutMs: 1500,
      });
      const executable = String(which.stdout || "").trim().split("\n")[0];
      if (!executable) return null;
      const result = await this.run(executable, ["--version"], { timeoutMs: 3000 });
      return {
        command: descriptor.globalCommand,
        path: executable,
        version: commandVersion(result.stdout || result.stderr),
      };
    } catch {
      return null;
    }
  }

  async versions(options = {}) {
    const manifest = await this.readManifest();
    const registryByPackage = {};
    if (options.check === true) {
      // Each successful query updates one shared cache file. Keep these
      // writes sequential so two providers cannot overwrite each other's
      // freshly-fetched registry entry.
      for (const [provider, agent] of Object.entries(this.config?.agents || {})) {
        const descriptor = adapterDescriptor(provider, agent);
        if (!descriptor.managed || registryByPackage[descriptor.package]) continue;
        registryByPackage[descriptor.package] = await this.queryRegistry(descriptor, options);
      }
    }
    const states = projectAdapterVersionStates(this.config, manifest, registryByPackage);
    if (options.globals === true) {
      await Promise.all(states.map(async (state) => {
        state.globalCli = await this.globalCliInfo(state);
      }));
    }
    return { settings: this.settings, manifest, providers: states };
  }

  async verifyInstall(root, descriptor, requestedVersion) {
    const packageJson = JSON.parse(await fsp.readFile(packageJsonPath(root, descriptor.package), "utf8"));
    if (packageJson.name !== descriptor.package || packageJson.version !== requestedVersion) {
      throw new Error(
        `installed ${packageJson.name || "unknown"}@${packageJson.version || "unknown"}; expected ${descriptor.package}@${requestedVersion}`,
      );
    }
    const binName = packageBinName(packageJson);
    if (!binName) throw new Error(`${descriptor.package}@${requestedVersion} exports no executable`);
    const executable = path.join(root, "node_modules", ".bin", binName);
    await fsp.access(executable, fs.constants.X_OK);
    const dependencies = await installedDependencyVersions(root, [
      "@agentclientprotocol/sdk",
      descriptor.runtimePackage,
    ]);
    return {
      version: requestedVersion,
      package: descriptor.package,
      binName,
      installedAt: nowIso(),
      protocolVersion: ACP_PROTOCOL_VERSION,
      dependencies,
    };
  }

  async installExact(descriptor, version, progress = () => {}) {
    const report = typeof progress === "function" ? progress : () => {};
    const finalRoot = packageRoot(this.storeDir, descriptor.package, version);
    try {
      const existing = await this.verifyInstall(finalRoot, descriptor, version);
      report({ phase: "verify", provider: descriptor.provider, version, reused: true });
      const smoke = await this.smoke(launchForInstall(finalRoot, existing), {
        env: this.config.agents?.[descriptor.provider]?.env || {},
      });
      return { ...existing, protocolVersion: smoke.protocolVersion, reused: true };
    } catch {
      // Missing or incomplete directory: recreate it through staging below.
    }

    await fsp.mkdir(path.join(this.storeDir, ".staging"), { recursive: true, mode: 0o700 });
    const stage = path.join(
      this.storeDir,
      ".staging",
      `${adapterPackageKey(descriptor.package)}-${version}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    );
    await fsp.mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      report({ phase: "download", provider: descriptor.provider, version });
      await this.run(
        this.npmCommand,
        [
          "install",
          "--prefix",
          stage,
          "--no-save",
          "--omit=dev",
          "--include=optional",
          "--no-audit",
          "--no-fund",
          "--package-lock=true",
          `${descriptor.package}@${version}`,
        ],
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      const record = await this.verifyInstall(stage, descriptor, version);
      report({ phase: "handshake", provider: descriptor.provider, version });
      const smoke = await this.smoke(launchForInstall(stage, record), {
        env: this.config.agents?.[descriptor.provider]?.env || {},
      });
      record.protocolVersion = smoke.protocolVersion;
      await fsp.mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      await fsp.rm(finalRoot, { recursive: true, force: true });
      await fsp.rename(stage, finalRoot);
      return record;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  async update(provider, options = {}) {
    return withAdapterLock(async () => {
      const descriptor = this.descriptor(provider);
      if (!descriptor.managed) {
        throw new Error(`${provider} uses a custom or unpinned command and is not managed by the Hub`);
      }
      const registry = options.version
        ? null
        : await this.queryRegistry(descriptor, { force: options.force === true });
      const registryVersion = registry?.targetVersion || null;

      let manifest = await this.readManifest();
      let record = providerManifest(manifest, provider, descriptor);
      const baseline = record.pendingVersion || record.activeVersion || descriptor.configuredVersion;
      // Registry checks are allowed to advance the effective version, never to
      // downgrade it. Rollback is the explicit, locally-verified downgrade path.
      const targetVersion = options.version || (
        registryVersion && compareSemver(baseline, registryVersion) < 0
          ? registryVersion
          : baseline
      );
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
        throw new Error(`no valid ${this.settings.channel} version is available for ${descriptor.package}`);
      }

      const targetInstall = record.installed.find((entry) => entry.version === targetVersion);
      let targetReady = false;
      if (targetInstall) {
        try {
          await this.verifyInstall(
            packageRoot(this.storeDir, descriptor.package, targetVersion),
            descriptor,
            targetVersion,
          );
          targetReady = true;
        } catch {
          // A manifest entry without a complete executable is repaired below.
        }
      }
      if (record.pendingVersion === targetVersion && targetReady) {
        return {
          ok: true,
          provider,
          package: descriptor.package,
          configuredVersion: descriptor.configuredVersion,
          activeVersion: record.activeVersion,
          pendingVersion: targetVersion,
          alreadyPending: true,
          requiresRestart: true,
          dependencies: targetInstall.dependencies || {},
          manifest,
        };
      }
      if (record.activeVersion === targetVersion && targetReady) {
        // A normal update after staging a rollback to an older version means
        // "stay current"; cancel that pending rollback without a restart.
        if (record.pendingVersion) {
          record.pendingVersion = null;
          manifest.providers[provider] = record;
          manifest = this.saveManifest(manifest);
        }
        return {
          ok: true,
          provider,
          package: descriptor.package,
          configuredVersion: descriptor.configuredVersion,
          activeVersion: targetVersion,
          pendingVersion: null,
          alreadyCurrent: true,
          requiresRestart: false,
          dependencies: targetInstall.dependencies || {},
          manifest,
        };
      }
      // Preserve a real rollback target on the first managed update. The
      // configured pin is materialized before a newer registry version.
      if (!record.activeVersion && targetVersion !== descriptor.configuredVersion) {
        const baseline = await this.installExact(
          descriptor,
          descriptor.configuredVersion,
          options.onProgress,
        );
        record.activeVersion = descriptor.configuredVersion;
        record.installed = [
          ...record.installed.filter((entry) => entry.version !== baseline.version),
          baseline,
        ];
      }

      const installed = await this.installExact(descriptor, targetVersion, options.onProgress);
      record.installed = [
        ...record.installed.filter((entry) => entry.version !== targetVersion),
        installed,
      ];
      record.pendingVersion = targetVersion;
      manifest.providers[provider] = record;
      manifest = this.saveManifest(manifest);
      options.onProgress?.({ phase: "ready", provider, version: targetVersion });
      return {
        ok: true,
        provider,
        package: descriptor.package,
        configuredVersion: descriptor.configuredVersion,
        activeVersion: record.activeVersion,
        pendingVersion: targetVersion,
        requiresRestart: true,
        dependencies: installed.dependencies,
        manifest,
      };
    }, { lockPath: this.lockPath });
  }

  async updateAll(options = {}) {
    const results = [];
    const errors = [];
    for (const [provider, agent] of Object.entries(this.config?.agents || {})) {
      if (!adapterDescriptor(provider, agent).managed) continue;
      try {
        results.push(await this.update(provider, options));
      } catch (error) {
        errors.push({ provider, error: error.message || String(error) });
      }
    }
    return {
      ok: errors.length === 0,
      results,
      errors,
      requiresRestart: results.some((result) => result.requiresRestart),
    };
  }

  async rollback(provider) {
    return withAdapterLock(async () => {
      const descriptor = this.descriptor(provider);
      if (!descriptor.managed) throw new Error(`${provider} is not managed by the Hub`);
      const manifest = await this.readManifest();
      const record = providerManifest(manifest, provider, descriptor);
      if (!record.previousVersion) throw new Error(`no rollback version is available for ${provider}`);
      if (!record.installed.some((entry) => entry.version === record.previousVersion)) {
        throw new Error(`rollback version ${record.previousVersion} is no longer installed`);
      }
      record.pendingVersion = record.previousVersion;
      manifest.providers[provider] = record;
      this.saveManifest(manifest);
      return {
        ok: true,
        provider,
        activeVersion: record.activeVersion,
        pendingVersion: record.pendingVersion,
        requiresRestart: true,
      };
    }, { lockPath: this.lockPath });
  }

  async promotePending(options = {}) {
    return withAdapterLock(async () => {
      const manifest = await this.readManifest();
      const promoted = [];
      for (const [provider, record] of Object.entries(manifest.providers || {})) {
        if (!record.pendingVersion) continue;
        const installed = record.installed.some((entry) => entry.version === record.pendingVersion);
        if (!installed) continue;
        const oldActive = record.activeVersion || null;
        record.activeVersion = record.pendingVersion;
        record.pendingVersion = null;
        record.previousVersion = oldActive && oldActive !== record.activeVersion ? oldActive : record.previousVersion;
        promoted.push({ provider, from: oldActive, to: record.activeVersion });
      }
      if (promoted.length) this.saveManifest(manifest);
      await this.prune(manifest);
      return { manifest, promoted };
    }, { lockPath: this.lockPath, timeoutMs: options.lockTimeoutMs || LOCK_TIMEOUT_MS });
  }

  async prune(manifestRaw = null) {
    const manifest = normalizeManifest(manifestRaw || await this.readManifest());
    for (const record of Object.values(manifest.providers || {})) {
      const protectedVersions = new Set(
        [record.activeVersion, record.pendingVersion, record.previousVersion].filter(Boolean),
      );
      const ordered = [...record.installed].sort((a, b) =>
        String(b.installedAt || "").localeCompare(String(a.installedAt || "")),
      );
      const keep = new Set(ordered.slice(0, this.settings.keepVersions).map((entry) => entry.version));
      for (const entry of ordered) {
        if (protectedVersions.has(entry.version) || keep.has(entry.version)) continue;
        await fsp.rm(packageRoot(this.storeDir, record.package, entry.version), {
          recursive: true,
          force: true,
        });
        record.installed = record.installed.filter((candidate) => candidate.version !== entry.version);
      }
    }
    this.saveManifest(manifest);
  }

  resolveAgent(provider, agent, manifestRaw) {
    const descriptor = adapterDescriptor(provider, agent);
    if (!descriptor.managed) return agent;
    const manifest = normalizeManifest(manifestRaw);
    const record = providerManifest(manifest, provider, descriptor);
    const installed = record.installed.find((entry) => entry.version === record.activeVersion);
    if (!installed) return agent;
    const root = packageRoot(this.storeDir, descriptor.package, installed.version);
    const launch = launchForInstall(root, installed);
    if (!fs.existsSync(launch.command)) return agent;
    return {
      ...agent,
      command: launch.command,
      args: [],
      managedAdapter: {
        package: descriptor.package,
        version: installed.version,
        dependencies: installed.dependencies,
      },
    };
  }
}

function formatVersionState(state) {
  if (!state.managed) return `${state.provider}: external (${state.reason})`;
  const active = state.activeVersion || `${state.configuredVersion} via npx`;
  const available = state.availableVersion ? ` · available ${state.availableVersion}` : "";
  const pending = state.pendingVersion ? ` · pending ${state.pendingVersion}` : "";
  const previous = state.previousVersion ? ` · rollback ${state.previousVersion}` : "";
  const status = state.deprecated
    ? "deprecated · review before restart"
    : state.pendingVersion
      ? "restart required"
      : state.updateAvailable
        ? "update available"
        : state.activeVersion
          ? "current"
          : "npx fallback";
  return `${state.provider}: ${active}${available}${pending}${previous} · ${status}`;
}

export {
  ACP_PROTOCOL_VERSION,
  ADAPTER_STORE_DIR,
  ADAPTER_PACKAGES_DIR,
  ADAPTER_STAGING_DIR,
  ADAPTER_MANIFEST_PATH,
  ADAPTER_CHECKS_PATH,
  ADAPTER_LOCK_PATH,
  ADAPTER_MANIFEST_SCHEMA,
  DEFAULT_UPDATE_CHANNEL,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_KEEP_VERSIONS,
  parseDurationMs,
  normalizeUpdateSettings,
  loadAdapterUpdateSettings,
  adapterPackageKey,
  adapterDescriptor,
  normalizeManifest,
  registryTarget,
  versionState,
  projectAdapterVersionStates,
  commandVersion,
  withAdapterLock,
  packageRoot,
  packageJsonPath,
  packageBinName,
  launchForInstall,
  smokeAdapterLaunch,
  AdapterVersionManager,
  formatVersionState,
};
