#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  McpRegistry,
  expandPairValues,
  inspectMcpRegistry,
  materializeMcpDefinition,
  normalizeMcpDefinition,
  publicMcpDefinition,
  redactMcpArgs,
  redactMcpUrl,
  resolveEffectiveMcp,
  scopeType,
  validateMcpDefinition,
} from "../lib/mcp.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-hub-mcp-admin-"));
const registryFile = path.join(temp, "config", "mcp.json");

try {
  const registry = new McpRegistry({ file: registryFile });
  assert.deepEqual(registry.list(), []);

  const global = registry.upsert({
    name: "filesystem",
    transport: "stdio",
    command: process.execPath,
    args: ["server.mjs"],
    env: { API_TOKEN: "${MCP_TEST_TOKEN}" },
  });
  assert.equal(scopeType(global.scope), "global");
  assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(registryFile)).mode & 0o777, 0o700);

  const project = registry.upsert({
    name: "filesystem",
    transport: "stdio",
    command: process.execPath,
    args: ["project-server.mjs"],
    scope: { provider: "codex", project: temp },
  });
  assert.equal(scopeType(project.scope), "agent+project");

  const config = {
    mcpServers: [{ name: "filesystem", command: process.execPath, args: ["static-global"] }],
    agents: {
      codex: {
        mcpServers: [{ name: "filesystem", command: process.execPath, args: ["static-codex"] }],
      },
    },
  };
  const effective = resolveEffectiveMcp(config, registry.value, {
    provider: "codex",
    cwd: temp,
    capabilities: { mcpCapabilities: { http: true } },
    env: { ...process.env, MCP_TEST_TOKEN: "secret-value" },
  });
  assert.equal(effective.entries.length, 1, "same-name entries collapse by scope");
  assert.equal(effective.entries[0].id, project.id, "the most specific managed entry wins");
  assert.equal(effective.servers[0].command, process.execPath);
  assert.deepEqual(effective.servers[0].args, ["project-server.mjs"]);

  registry.toggle(project.id, false);
  const fallback = resolveEffectiveMcp(config, registry.value, {
    provider: "codex",
    cwd: temp,
    capabilities: {},
    env: { ...process.env, MCP_TEST_TOKEN: "secret-value" },
  });
  assert.equal(fallback.entries[0].source, "static", "disabled specific entries reveal the next scope");
  assert.deepEqual(fallback.servers[0].args, ["static-codex"], "agent scope outranks global scope");

  const publicView = publicMcpDefinition(global);
  assert.deepEqual(publicView.envNames, ["API_TOKEN"]);
  assert.equal(Object.hasOwn(publicView, "env"), false, "public projections never expose secret values");

  const argumentSecret = "mcp-argument-secret-canary";
  const querySecret = "mcp-query-secret-canary";
  const privateStdio = normalizeMcpDefinition({
    name: "private stdio",
    command: process.execPath,
    args: [
      "server.mjs",
      "--token",
      argumentSecret,
      `--api-key=${argumentSecret}`,
      `https://example.test/mcp?access_token=${querySecret}&page=2`,
      `--url=https://example.test/mcp?api_key=${querySecret}`,
      `--header=Authorization: Bearer ${argumentSecret}`,
      `--header=Cookie: session=${argumentSecret}`,
      `--env=PRIVATE_TOKEN=${argumentSecret}`,
      "ordinary-value",
    ],
    env: { PRIVATE_TOKEN: "mcp-env-secret-canary" },
  });
  const publicStdio = publicMcpDefinition(privateStdio);
  const publicStdioJson = JSON.stringify(publicStdio);
  assert.doesNotMatch(publicStdioJson, new RegExp(argumentSecret));
  assert.doesNotMatch(publicStdioJson, new RegExp(querySecret));
  assert.match(publicStdioJson, /redacted/);
  assert.match(publicStdioJson, /ordinary-value/, "non-sensitive arguments remain useful");
  assert.deepEqual(
    materializeMcpDefinition(privateStdio, { capabilities: {}, env: process.env }).server.args,
    privateStdio.args,
    "the adapter payload preserves private argument values",
  );
  assert.deepEqual(redactMcpArgs(["--token", argumentSecret]), ["--token", "[redacted]"]);
  assert.deepEqual(
    redactMcpArgs([`-HAuthorization: Bearer ${argumentSecret}`]),
    ["-HAuthorization: [redacted]"],
  );
  assert.doesNotMatch(
    redactMcpUrl(`https://example.test/mcp?api_key=${querySecret}`),
    new RegExp(querySecret),
  );
  assert.doesNotMatch(
    redactMcpUrl(`not-a-valid-url?access_token=${querySecret}`),
    new RegExp(querySecret),
  );
  assert.doesNotMatch(
    redactMcpUrl(`https://example.test/mcp#signature=${querySecret}`),
    new RegExp(querySecret),
  );

  const http = normalizeMcpDefinition({
    name: "docs",
    type: "http",
    url: `https://example.test/mcp?api_key=${querySecret}&format=json`,
    headers: { Authorization: "${MCP_HTTP_TOKEN}" },
  });
  const publicHttp = publicMcpDefinition(http);
  assert.doesNotMatch(JSON.stringify(publicHttp), new RegExp(querySecret));
  assert.match(publicHttp.url, /format=json/, "non-sensitive query parameters remain visible");
  assert.equal(
    materializeMcpDefinition(http, {
      capabilities: { mcpCapabilities: {} },
      env: { MCP_HTTP_TOKEN: "hidden" },
    }).status,
    "unsupported",
  );
  const supportedHttp = materializeMcpDefinition(http, {
    capabilities: { mcpCapabilities: { http: true } },
    env: { MCP_HTTP_TOKEN: "hidden" },
  });
  assert.equal(supportedHttp.ok, true);
  assert.equal(supportedHttp.server.url, http.url, "the adapter receives the canonical private URL");
  assert.equal(supportedHttp.server.headers[0].value, "hidden");

  const literalSecret = validateMcpDefinition({
    name: "literal",
    type: "http",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer visible" },
  });
  assert.match(literalSecret.warnings.join(" "), /environment variable/);
  assert.match(validateMcpDefinition(http).warnings.join(" "), /public views will redact/);

  for (const [definition, message] of [
    [{ name: "bad command", command: "node\nmalicious" }, /command contains invalid/],
    [{ name: "bad arg", command: process.execPath, args: ["ok", "bad\narg"] }, /argument 2/],
    [
      { name: "bad env", command: process.execPath, env: { "BAD-NAME": "value" } },
      /invalid environment variable name/,
    ],
    [
      {
        name: "bad header",
        type: "http",
        url: "https://example.test/mcp",
        headers: [{ name: "Bad Header", value: "value" }],
      },
      /invalid header name/,
    ],
    [
      {
        name: "header injection",
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "safe\r\nInjected: value" },
      },
      /invalid control characters/,
    ],
  ]) {
    assert.match(validateMcpDefinition(definition).errors.join(" "), message);
  }

  assert.deepEqual(
    expandPairValues([{ name: "TOKEN", value: "${ABSENT_TOKEN}" }], {}),
    { values: [{ name: "TOKEN", value: "" }], missing: ["ABSENT_TOKEN"] },
  );

  assert.throws(
    () =>
      registry.upsert({
        name: "broken",
        transport: "http",
        url: "file:///tmp/server",
      }),
    /http or https/,
  );
  assert.throws(
    () =>
      registry.upsert({
        name: "filesystem",
        transport: "stdio",
        command: process.execPath,
      }),
    /already exists/,
  );

  registry.remove(global.id);
  assert.equal(registry.list().length, 1);

  const invalidFile = path.join(temp, "corrupt", "mcp.json");
  fs.mkdirSync(path.dirname(invalidFile), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(invalidFile), 0o755);
  fs.writeFileSync(invalidFile, "{ definitely-not-json", { mode: 0o644 });
  assert.equal(inspectMcpRegistry(invalidFile).ok, false);
  const recovered = new McpRegistry({ file: invalidFile });
  assert.equal(recovered.status().recovered, true);
  assert.ok(recovered.status().backupFile);
  assert.equal(fs.existsSync(recovered.status().backupFile), true);
  assert.equal(fs.statSync(recovered.status().backupFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(invalidFile)).mode & 0o777, 0o700);
  assert.deepEqual(recovered.list(), []);

  fs.writeFileSync(invalidFile, JSON.stringify({ schemaVersion: 999, servers: [] }));
  assert.throws(
    () => new McpRegistry({ file: invalidFile, recover: false }),
    /unsupported MCP registry schema/,
  );

  const permissiveFile = path.join(temp, "permissive", "mcp.json");
  fs.mkdirSync(path.dirname(permissiveFile), { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    permissiveFile,
    JSON.stringify({ schemaVersion: 1, updatedAt: null, servers: [] }),
    { mode: 0o644 },
  );
  fs.chmodSync(path.dirname(permissiveFile), 0o755);
  fs.chmodSync(permissiveFile, 0o644);
  new McpRegistry({ file: permissiveFile });
  assert.equal(fs.statSync(path.dirname(permissiveFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(permissiveFile).mode & 0o777, 0o600);
  console.log("mcp admin tests passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
