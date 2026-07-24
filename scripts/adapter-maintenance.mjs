#!/usr/bin/env node
// Maintainer-only adapter release discovery, compatibility probing, and pin
// synchronization. Runtime users update their private store through /hub;
// this script changes repository defaults only after a real ACP probe passes.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_COMPATIBILITY_PATH,
  compareSemver,
} from "../lib/core.mjs";
import {
  AdapterVersionManager,
  launchForInstall,
  packageRoot,
  smokeAdapterLaunch,
} from "../lib/versions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_PATH = path.join(ROOT, "agents.json");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateCompatibilityManifest(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("Unsupported compatibility manifest schema");
  if (value.acpProtocolVersion !== 1) throw new Error("This release line currently requires ACP v1");
  if (!value.defaultAgent || !value.adapters?.[value.defaultAgent]) {
    throw new Error("defaultAgent must reference a declared adapter");
  }
  if (!Object.keys(value.adapters).length) throw new Error("At least one adapter is required");

  for (const [provider, adapter] of Object.entries(value.adapters)) {
    if (!adapter.package || !adapter.defaultVersion) {
      throw new Error(`${provider} requires package and defaultVersion`);
    }
    if (!SEMVER.test(adapter.defaultVersion)) {
      throw new Error(`${provider} has an invalid defaultVersion: ${adapter.defaultVersion}`);
    }
    if (!Array.isArray(adapter.testedVersions) || !adapter.testedVersions.length) {
      throw new Error(`${provider} requires at least one testedVersions entry`);
    }
    if (!adapter.testedVersions.includes(adapter.defaultVersion)) {
      throw new Error(`${provider} defaultVersion must be present in testedVersions`);
    }
    for (const version of adapter.testedVersions) {
      if (!SEMVER.test(version)) throw new Error(`${provider} has an invalid tested version: ${version}`);
    }
  }
  return value;
}

function loadCompatibility(file = ADAPTER_COMPATIBILITY_PATH) {
  return validateCompatibilityManifest(readJson(file));
}

function defaultConfigFromCompatibility(manifest) {
  return {
    defaultAgent: manifest.defaultAgent,
    agents: Object.fromEntries(
      Object.entries(manifest.adapters).map(([provider, adapter]) => [
        provider,
        {
          label: adapter.label || provider,
          command: "npx",
          args: ["-y", `${adapter.package}@${adapter.defaultVersion}`],
        },
      ]),
    ),
  };
}

function compatibilityMatrix(manifest, options = {}) {
  const include = [];
  for (const [provider, adapter] of Object.entries(manifest.adapters)) {
    const versions = options.defaultsOnly ? [adapter.defaultVersion] : adapter.testedVersions;
    for (const version of versions) {
      include.push({
        provider,
        version,
        node: String(manifest.supportPolicy?.adapterProbeNode || 22),
      });
    }
  }
  return { include };
}

function npmRegistryInfo(adapter) {
  const result = spawnSync(
    "npm",
    ["view", adapter.package, "dist-tags", "version", "deprecated", "engines", "--json"],
    {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `npm exited ${result.status}`).trim());
  }
  const parsed = JSON.parse(result.stdout || "null");
  const tag = adapter.registryTag || "latest";
  const latestVersion = parsed?.["dist-tags"]?.[tag] || parsed?.version || null;
  if (!latestVersion || !SEMVER.test(latestVersion)) {
    throw new Error(`registry tag ${tag} did not resolve to an exact semantic version`);
  }
  return {
    latestVersion,
    deprecated: parsed?.deprecated || null,
    engines: parsed?.engines || null,
  };
}

async function buildReleaseReport(manifest, lookup = npmRegistryInfo) {
  const providers = [];
  for (const [provider, adapter] of Object.entries(manifest.adapters)) {
    try {
      const registry = await lookup(adapter, provider);
      providers.push({
        provider,
        package: adapter.package,
        currentVersion: adapter.defaultVersion,
        latestVersion: registry.latestVersion,
        updateAvailable: compareSemver(adapter.defaultVersion, registry.latestVersion) < 0,
        deprecated: registry.deprecated || null,
        engines: registry.engines || null,
        error: null,
      });
    } catch (error) {
      providers.push({
        provider,
        package: adapter.package,
        currentVersion: adapter.defaultVersion,
        latestVersion: null,
        updateAvailable: false,
        deprecated: null,
        engines: null,
        error: error.message || String(error),
      });
    }
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    acpProtocolVersion: manifest.acpProtocolVersion,
    providers,
    probes: [],
  };
}

function propertyAt(value, dottedPath) {
  let current = value;
  for (const part of String(dottedPath).split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function missingRequiredCapabilities(capabilities, required = []) {
  return required.filter((name) => {
    const resolved = propertyAt(capabilities, name);
    if (!resolved.found) return true;
    return resolved.value === false || resolved.value === null;
  });
}

function assertProbeNode(adapter) {
  const match = String(adapter.node || "").match(/>=\s*(\d+)/);
  if (!match) return;
  const required = Number(match[1]);
  const current = Number(process.versions.node.split(".")[0]);
  if (current < required) {
    throw new Error(`adapter requires Node ${required}+; current runtime is ${process.versions.node}`);
  }
}

async function probeAdapter(manifest, provider, version, options = {}) {
  const adapter = manifest.adapters?.[provider];
  if (!adapter) throw new Error(`Unknown compatibility provider: ${provider}`);
  if (!SEMVER.test(version)) throw new Error(`Invalid probe version: ${version}`);
  assertProbeNode(adapter);

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), `acp-hub-${provider}-compat-`));
  const storeDir = path.join(temp, "adapters");
  const config = {
    defaultAgent: provider,
    agents: {
      [provider]: {
        label: adapter.label || provider,
        command: "npx",
        args: ["-y", `${adapter.package}@${version}`],
      },
    },
  };
  try {
    const manager = new AdapterVersionManager({
      config,
      home: temp,
      storeDir,
      manifestPath: path.join(storeDir, "manifest.json"),
      checksPath: path.join(storeDir, "checks.json"),
      lockPath: path.join(storeDir, "update.lock"),
      settings: { channel: "stable", notify: false, keepVersions: 2 },
    });
    const update = await manager.update(provider, {
      version,
      onProgress: options.onProgress,
    });
    const stored = await manager.readManifest();
    const providerRecord = stored.providers?.[provider];
    const installed = providerRecord?.installed?.find((entry) => entry.version === version);
    if (!installed) throw new Error("verified install was not recorded in the private manifest");

    const inspection = await smokeAdapterLaunch(
      launchForInstall(packageRoot(storeDir, adapter.package, version), installed),
      { timeoutMs: options.timeoutMs || 30_000 },
    );
    if (inspection.protocolVersion !== manifest.acpProtocolVersion) {
      throw new Error(
        `negotiated ACP v${inspection.protocolVersion}; expected v${manifest.acpProtocolVersion}`,
      );
    }
    if (inspection.agentInfo?.name && inspection.agentInfo.name !== adapter.package) {
      throw new Error(`agentInfo.name=${inspection.agentInfo.name}; expected ${adapter.package}`);
    }
    const missing = missingRequiredCapabilities(
      inspection.agentCapabilities,
      adapter.requiredCapabilities,
    );
    if (missing.length) throw new Error(`missing required capabilities: ${missing.join(", ")}`);

    return {
      provider,
      package: adapter.package,
      version,
      ok: true,
      protocolVersion: inspection.protocolVersion,
      agentInfo: inspection.agentInfo,
      requiredCapabilities: Object.fromEntries(
        (adapter.requiredCapabilities || []).map((name) => [name, true]),
      ),
      dependencies: update.dependencies || {},
      error: null,
    };
  } catch (error) {
    return {
      provider,
      package: adapter.package,
      version,
      ok: false,
      protocolVersion: null,
      agentInfo: null,
      requiredCapabilities: {},
      dependencies: {},
      error: error.message || String(error),
    };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

function applyVerifiedReport(manifest, report) {
  const next = structuredClone(manifest);
  const changes = [];
  const keep = Math.max(1, Number(next.supportPolicy?.testedVersionWindow) || 2);
  for (const candidate of report.providers || []) {
    if (!candidate.updateAvailable || !candidate.latestVersion || candidate.error) continue;
    if (candidate.deprecated) {
      throw new Error(`${candidate.provider}@${candidate.latestVersion} is deprecated and requires manual review`);
    }
    const adapter = next.adapters?.[candidate.provider];
    if (!adapter || adapter.package !== candidate.package) continue;
    const proof = (report.probes || []).find(
      (probe) =>
        probe.provider === candidate.provider &&
        probe.package === candidate.package &&
        probe.version === candidate.latestVersion &&
        probe.ok === true &&
        probe.protocolVersion === next.acpProtocolVersion &&
        probe.agentInfo?.name === candidate.package &&
        (adapter.requiredCapabilities || []).every(
          (capability) => probe.requiredCapabilities?.[capability] === true,
        ),
    );
    if (!proof) throw new Error(`No successful ACP probe for ${candidate.provider}@${candidate.latestVersion}`);
    if (compareSemver(adapter.defaultVersion, candidate.latestVersion) >= 0) continue;

    const previous = adapter.defaultVersion;
    adapter.defaultVersion = candidate.latestVersion;
    adapter.testedVersions = [candidate.latestVersion, previous, ...adapter.testedVersions]
      .filter((version, index, values) => values.indexOf(version) === index)
      .slice(0, keep);
    changes.push({ provider: candidate.provider, from: previous, to: candidate.latestVersion });
  }
  validateCompatibilityManifest(next);
  return { manifest: next, changes };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, stableJson(value));
  fs.renameSync(temporary, file);
}

function syncRepositoryDefaults(manifest, options = {}) {
  const expected = defaultConfigFromCompatibility(manifest);
  const actual = fs.existsSync(AGENTS_PATH) ? readJson(AGENTS_PATH) : null;
  const matches = JSON.stringify(actual) === JSON.stringify(expected);
  if (options.check) {
    if (!matches) throw new Error("agents.json drifted from compatibility/adapters.json; run npm run adapters:sync -- --write");
    return { changed: false, config: expected };
  }
  if (!matches) writeJsonAtomic(AGENTS_PATH, expected);
  return { changed: !matches, config: expected };
}

function parseCli(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags.set(name, argv[++index]);
    else flags.set(name, true);
  }
  return { flags, positionals };
}

function reportTable(report) {
  const rows = report.providers.map((entry) => ({
    provider: entry.provider,
    current: entry.currentVersion,
    latest: entry.latestVersion || "unknown",
    state: entry.error ? "registry error" : entry.deprecated ? "deprecated" : entry.updateAvailable ? "update" : "current",
  }));
  const widths = {
    provider: Math.max(8, ...rows.map((row) => row.provider.length)),
    current: Math.max(7, ...rows.map((row) => row.current.length)),
    latest: Math.max(6, ...rows.map((row) => row.latest.length)),
  };
  const line = (row) =>
    `${row.provider.padEnd(widths.provider)}  ${row.current.padEnd(widths.current)}  ${row.latest.padEnd(widths.latest)}  ${row.state}`;
  return [line({ provider: "Adapter", current: "Current", latest: "Latest", state: "State" }), ...rows.map(line)].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const command = argv.shift() || "help";
  const { flags, positionals } = parseCli(argv);
  const manifest = loadCompatibility();

  if (command === "matrix") {
    const matrix = flags.has("hub-nodes")
      ? { node: (manifest.supportPolicy?.hubNodeMajors || []).map(String) }
      : compatibilityMatrix(manifest, { defaultsOnly: flags.has("defaults-only") });
    console.log(flags.has("github") ? JSON.stringify(matrix) : stableJson(matrix).trimEnd());
    return;
  }

  if (command === "check") {
    const report = await buildReleaseReport(manifest);
    if (flags.get("report")) writeJsonAtomic(path.resolve(String(flags.get("report"))), report);
    if (flags.has("json")) console.log(stableJson(report).trimEnd());
    else console.log(reportTable(report));
    if (report.providers.some((entry) => entry.error)) process.exitCode = 2;
    else if (flags.has("strict") && report.providers.some((entry) => entry.updateAvailable || entry.deprecated)) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "probe") {
    let targets;
    let report = null;
    const reportPath = flags.get("report") ? path.resolve(String(flags.get("report"))) : null;
    if (reportPath) {
      report = readJson(reportPath);
      targets = (report.providers || [])
        .filter((entry) => entry.updateAvailable && entry.latestVersion && !entry.error && !entry.deprecated)
        .map((entry) => ({ provider: entry.provider, version: entry.latestVersion }));
    } else if (positionals[0]) {
      const provider = positionals[0];
      targets = [{ provider, version: positionals[1] || manifest.adapters?.[provider]?.defaultVersion }];
    } else {
      targets = compatibilityMatrix(manifest).include;
    }

    const probes = [];
    for (const target of targets) {
      const label = `${target.provider}@${target.version}`;
      if (!flags.has("json")) console.error(`Probing ${label}`);
      const probe = await probeAdapter(manifest, target.provider, target.version, {
        onProgress: flags.has("json")
          ? null
          : (progress) => console.error(`  ${progress.phase} ${progress.version || ""}`.trimEnd()),
      });
      probes.push(probe);
      if (!flags.has("json")) console.error(probe.ok ? `✓ ${label} compatible` : `✗ ${label}: ${probe.error}`);
    }
    if (reportPath) {
      report.probes = probes;
      writeJsonAtomic(reportPath, report);
    }
    if (flags.has("json")) console.log(stableJson({ probes }).trimEnd());
    if (probes.some((probe) => !probe.ok)) process.exitCode = 1;
    return;
  }

  if (command === "apply") {
    const reportPath = flags.get("report");
    if (!reportPath) throw new Error("apply requires --report <verified-report.json>");
    const { manifest: next, changes } = applyVerifiedReport(manifest, readJson(path.resolve(String(reportPath))));
    if (!changes.length) {
      console.log("No verified adapter pin changes");
      return;
    }
    writeJsonAtomic(ADAPTER_COMPATIBILITY_PATH, next);
    syncRepositoryDefaults(next);
    for (const change of changes) console.log(`${change.provider}: ${change.from} -> ${change.to}`);
    return;
  }

  if (command === "sync") {
    const result = syncRepositoryDefaults(manifest, { check: flags.has("check") && !flags.has("write") });
    console.log(result.changed ? "agents.json synchronized" : "adapter defaults are synchronized");
    return;
  }

  console.log(`Usage:
  adapter-maintenance.mjs check [--json] [--strict] [--report file]
  adapter-maintenance.mjs matrix [--github] [--defaults-only]
  adapter-maintenance.mjs probe [provider] [version] [--json]
  adapter-maintenance.mjs probe --report verified-report.json
  adapter-maintenance.mjs apply --report verified-report.json
  adapter-maintenance.mjs sync --check|--write`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`adapter maintenance: ${error.message || error}`);
    process.exitCode = 2;
  });
}

export {
  validateCompatibilityManifest,
  loadCompatibility,
  defaultConfigFromCompatibility,
  compatibilityMatrix,
  buildReleaseReport,
  missingRequiredCapabilities,
  probeAdapter,
  applyVerifiedReport,
  syncRepositoryDefaults,
  reportTable,
};
