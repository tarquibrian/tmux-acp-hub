#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  applyVerifiedReport,
  buildReleaseReport,
  compatibilityMatrix,
  defaultConfigFromCompatibility,
  loadCompatibility,
  missingRequiredCapabilities,
  reportTable,
  syncRepositoryDefaults,
  validateCompatibilityManifest,
} from "../scripts/adapter-maintenance.mjs";

const manifest = loadCompatibility();

assert.equal(manifest.acpProtocolVersion, 1);
assert.deepEqual(defaultConfigFromCompatibility(manifest).agents.codex.args, [
  "-y",
  `${manifest.adapters.codex.package}@${manifest.adapters.codex.defaultVersion}`,
]);
assert.deepEqual(
  compatibilityMatrix(manifest).include.map(({ provider, version }) => `${provider}@${version}`),
  Object.entries(manifest.adapters).flatMap(([provider, adapter]) =>
    adapter.testedVersions.map((version) => `${provider}@${version}`),
  ),
);
assert.equal(syncRepositoryDefaults(manifest, { check: true }).changed, false);

assert.throws(
  () => validateCompatibilityManifest({ ...manifest, defaultAgent: "missing" }),
  /defaultAgent/,
);
assert.deepEqual(
  missingRequiredCapabilities(
    { loadSession: true, sessionCapabilities: { resume: {} }, disabled: false },
    ["loadSession", "sessionCapabilities.resume", "sessionCapabilities.list", "disabled"],
  ),
  ["sessionCapabilities.list", "disabled"],
);

const fixture = structuredClone(manifest);
fixture.adapters.codex.defaultVersion = "1.1.4";
fixture.adapters.codex.testedVersions = ["1.1.4"];
fixture.adapters.claude.defaultVersion = "0.59.0";
fixture.adapters.claude.testedVersions = ["0.59.0"];
const report = await buildReleaseReport(fixture, async (_adapter, provider) => ({
  latestVersion: provider === "codex" ? "1.1.5" : "0.60.0",
  deprecated: null,
  engines: provider === "claude" ? { node: ">=22" } : null,
}));
assert.equal(report.providers.every((entry) => entry.updateAvailable), true);
assert.match(reportTable(report), /codex\s+1\.1\.4\s+1\.1\.5\s+update/);
assert.throws(
  () => applyVerifiedReport(fixture, report),
  /No successful ACP probe/,
  "a registry result alone can never change repository pins",
);
const deprecatedReport = structuredClone(report);
deprecatedReport.providers[0].deprecated = "use another package";
deprecatedReport.probes = [{
  provider: "codex",
  package: fixture.adapters.codex.package,
  version: "1.1.5",
  ok: true,
  protocolVersion: 1,
  agentInfo: { name: fixture.adapters.codex.package },
  requiredCapabilities: Object.fromEntries(
    fixture.adapters.codex.requiredCapabilities.map((name) => [name, true]),
  ),
}];
assert.throws(() => applyVerifiedReport(fixture, deprecatedReport), /deprecated.*manual review/);

report.probes = report.providers.map((entry) => ({
  provider: entry.provider,
  package: entry.package,
  version: entry.latestVersion,
  ok: true,
  protocolVersion: 1,
  agentInfo: { name: entry.package },
  requiredCapabilities: Object.fromEntries(
    fixture.adapters[entry.provider].requiredCapabilities.map((name) => [name, true]),
  ),
}));
const applied = applyVerifiedReport(fixture, report);
assert.deepEqual(applied.changes, [
  { provider: "codex", from: "1.1.4", to: "1.1.5" },
  { provider: "claude", from: "0.59.0", to: "0.60.0" },
]);
assert.equal(applied.manifest.adapters.codex.defaultVersion, "1.1.5");
assert.deepEqual(applied.manifest.adapters.codex.testedVersions, ["1.1.5", "1.1.4"]);
assert.equal(fixture.adapters.codex.defaultVersion, "1.1.4", "the source manifest is not mutated");

console.log("adapter maintenance tests passed");
