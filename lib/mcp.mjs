// Managed MCP registry, validation, scope resolution, and safe public
// projections. The ACP adapter owns the actual MCP connection; the Hub tracks
// whether a descriptor is valid, supported, tested, pending, or applied.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_BASE = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const MCP_REGISTRY_PATH =
  process.env.ACP_HUB_MCP_CONFIG ||
  path.join(CONFIG_BASE, "tmux-acp-hub", "mcp.json");
const MCP_REGISTRY_SCHEMA = 1;
const MCP_TRANSPORTS = new Set(["stdio", "http", "sse"]);
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS?)$/i;
const CREDENTIAL_ARG_NAME =
  /(?:api[-_]?key|(?:access[-_]?)?token|auth(?:orization)?|bearer|(?:client[-_]?)?secret|password|private[-_]?key|credential)/i;
const CREDENTIAL_EXACT_NAME =
  /^(?:key|sig|signature|signed|jwt|passwd|passphrase|session|sessionid|cookie|set-cookie|code)$/i;
const CONTROL_CHARACTERS = /[\r\n\0]/;
const NUL_CHARACTER = /\0/;

function nowIso() {
  return new Date().toISOString();
}

function emptyRegistry() {
  return { schemaVersion: MCP_REGISTRY_SCHEMA, updatedAt: null, servers: [] };
}

function chmodPrivateFile(file) {
  try {
    if (fs.lstatSync(file).isFile()) fs.chmodSync(file, 0o600);
  } catch {}
}

function hardenRegistryStorage(file, options = {}) {
  const directory = path.dirname(file);
  if (options.createDirectory === true) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  try {
    if (fs.statSync(directory).isDirectory()) fs.chmodSync(directory, 0o700);
  } catch {}
  chmodPrivateFile(file);
}

function writeJsonAtomic(file, value) {
  hardenRegistryStorage(file, { createDirectory: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    chmodPrivateFile(file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function readRegistry(file = MCP_REGISTRY_PATH) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || value.schemaVersion !== MCP_REGISTRY_SCHEMA || !Array.isArray(value.servers)) {
      throw new Error("unsupported MCP registry schema");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyRegistry();
    }
    throw error;
  }
}

function recoverRegistry(file, error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.corrupt-${stamp}`;
  let backupFile = null;
  hardenRegistryStorage(file);
  try {
    fs.renameSync(file, backup);
    chmodPrivateFile(backup);
    backupFile = backup;
  } catch {}
  return {
    value: emptyRegistry(),
    recovery: {
      recovered: true,
      reason: error?.message || String(error),
      backupFile,
      at: nowIso(),
    },
  };
}

function inspectMcpRegistry(file = MCP_REGISTRY_PATH) {
  try {
    const value = readRegistry(file);
    let mode = null;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {}
    return {
      ok: true,
      exists: fs.existsSync(file),
      file,
      mode,
      count: value.servers.length,
      updatedAt: value.updatedAt || null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      exists: fs.existsSync(file),
      file,
      mode: null,
      count: 0,
      updatedAt: null,
      error: error?.message || String(error),
    };
  }
}

function normalizePairs(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value).map(([name, item]) => ({ name, value: item }))
      : [];
  return entries
    .filter((entry) => entry && typeof entry.name === "string" && entry.name.trim())
    .map((entry) => ({
      name: entry.name.trim(),
      value: String(entry.value ?? ""),
    }));
}

function credentialLikeName(value) {
  const name = String(value || "");
  return CREDENTIAL_EXACT_NAME.test(name) ||
    CREDENTIAL_ENV_NAME.test(name.replace(/-/g, "_")) ||
    CREDENTIAL_ARG_NAME.test(name);
}

function redactMcpUrl(value) {
  const raw = String(value || "");
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = "[redacted]";
    if (parsed.password) parsed.password = "[redacted]";
    for (const key of [...parsed.searchParams.keys()]) {
      if (credentialLikeName(key)) parsed.searchParams.set(key, "[redacted]");
    }
    if (parsed.hash.includes("=")) {
      const hash = new URLSearchParams(parsed.hash.slice(1));
      let changed = false;
      for (const key of [...hash.keys()]) {
        if (!credentialLikeName(key)) continue;
        hash.set(key, "[redacted]");
        changed = true;
      }
      if (changed) parsed.hash = hash.toString();
    }
    return parsed.toString();
  } catch {
    return raw
      .replace(/^(https?:\/\/)[^/@\s]+@/i, "$1[redacted]@")
      .replace(/([?&#])([^=&#]+)=([^&#]*)/g, (match, separator, key) =>
        credentialLikeName(key)
          ? `${separator}${key}=[redacted]`
          : match);
  }
}

function redactMcpArgs(args = []) {
  const redacted = [];
  let redactNext = false;
  for (const value of args) {
    const argument = String(value);
    if (redactNext) {
      redacted.push("[redacted]");
      redactNext = false;
      continue;
    }

    const separator = argument.indexOf("=");
    const flagName = separator >= 0 ? argument.slice(0, separator) : argument;
    const optionValue = separator >= 0 ? argument.slice(separator + 1) : "";
    const headerValue = /^(?:(-H|--header)=?)?([^:\s]+)\s*:/i.exec(argument);
    if (
      headerValue &&
      (headerValue[1] || /^(?:authorization|proxy-authorization|x-api-key)$/i.test(headerValue[2])) &&
      credentialLikeName(headerValue[2])
    ) {
      const prefix = argument.slice(0, argument.toLowerCase().indexOf(headerValue[2].toLowerCase()));
      redacted.push(`${prefix}${headerValue[2]}: [redacted]`);
      continue;
    }
    if (argument.startsWith("-") && credentialLikeName(flagName)) {
      if (separator >= 0) redacted.push(`${flagName}=[redacted]`);
      else {
        redacted.push(argument);
        redactNext = true;
      }
      continue;
    }
    if (/^bearer\s+/i.test(argument)) {
      redacted.push("Bearer [redacted]");
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argument);
    if (assignment && credentialLikeName(assignment[1])) {
      redacted.push(`${assignment[1]}=[redacted]`);
      continue;
    }
    const nestedAssignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(optionValue);
    if (separator >= 0 && nestedAssignment && credentialLikeName(nestedAssignment[1])) {
      redacted.push(`${flagName}=${nestedAssignment[1]}=[redacted]`);
      continue;
    }
    if (separator >= 0 && /^https?:\/\//i.test(optionValue)) {
      redacted.push(`${flagName}=${redactMcpUrl(optionValue)}`);
      continue;
    }
    if (/^https?:\/\//i.test(argument)) {
      redacted.push(redactMcpUrl(argument));
      continue;
    }
    redacted.push(argument);
  }
  return redacted;
}

function normalizeScope(value = {}, fallback = {}) {
  const source = typeof value === "string" ? { type: value } : value || {};
  const provider = String(source.provider || fallback.provider || "").trim();
  const rawProject = String(source.project || source.cwd || fallback.project || "").trim();
  return {
    provider: provider || null,
    project: rawProject ? path.resolve(rawProject) : null,
  };
}

function scopeType(scope = {}) {
  if (scope.provider && scope.project) return "agent+project";
  if (scope.project) return "project";
  if (scope.provider) return "agent";
  return "global";
}

function scopeScore(scope = {}) {
  return (scope.provider ? 20 : 0) + (scope.project ? 40 : 0);
}

function scopeMatches(scope, context = {}) {
  if (scope.provider && scope.provider !== context.provider) return false;
  if (scope.project && path.resolve(scope.project) !== path.resolve(context.cwd || process.cwd())) {
    return false;
  }
  return true;
}

function inferredTransport(input = {}) {
  const requested = String(input.transport || input.type || "").toLowerCase();
  if (requested) return requested;
  if (input.url) return "http";
  return "stdio";
}

function normalizeMcpDefinition(input = {}, options = {}) {
  const transport = inferredTransport(input);
  const scope = normalizeScope(input.scope, {
    provider: input.provider || options.provider,
    project: input.project || input.cwd || options.project,
  });
  const source = options.source || input.source || "managed";
  const name = String(input.name || "").trim();
  const stableSeed = [
    source,
    options.sourceKey || "",
    scope.provider || "",
    scope.project || "",
    name.toLowerCase(),
  ].join("\0");
  const id =
    String(input.id || "").trim() ||
    (source === "managed"
      ? `mcp-${crypto.randomUUID()}`
      : `mcp-static-${crypto.createHash("sha256").update(stableSeed).digest("hex").slice(0, 16)}`);
  return {
    id,
    name,
    transport,
    enabled: input.enabled !== false,
    scope,
    source,
    command: transport === "stdio" ? String(input.command || "").trim() : "",
    args: transport === "stdio" && Array.isArray(input.args) ? input.args.map(String) : [],
    env: transport === "stdio" ? normalizePairs(input.env) : [],
    url: transport === "http" || transport === "sse" ? String(input.url || "").trim() : "",
    headers:
      transport === "http" || transport === "sse" ? normalizePairs(input.headers) : [],
    createdAt: input.createdAt || options.createdAt || nowIso(),
    updatedAt: options.touch === false ? input.updatedAt || null : nowIso(),
  };
}

function validateMcpDefinition(input, options = {}) {
  const server = normalizeMcpDefinition(input, { ...options, touch: false });
  const errors = [];
  const warnings = [];
  if (!server.name) errors.push("name is required");
  if (/[\r\n\0]/.test(server.name)) errors.push("name contains invalid control characters");
  if (!MCP_TRANSPORTS.has(server.transport)) {
    errors.push(`unsupported transport: ${server.transport || "empty"}`);
  }
  if (server.transport === "stdio" && !server.command) errors.push("stdio command is required");
  if (server.transport === "stdio" && CONTROL_CHARACTERS.test(server.command)) {
    errors.push("stdio command contains invalid control characters");
  }
  for (const [index, argument] of server.args.entries()) {
    if (CONTROL_CHARACTERS.test(argument)) {
      errors.push(`argument ${index + 1} contains invalid control characters`);
    }
  }
  if (server.transport === "http" || server.transport === "sse") {
    if (CONTROL_CHARACTERS.test(server.url)) {
      errors.push(`${server.transport} URL contains invalid control characters`);
    }
    try {
      const parsed = new URL(server.url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        errors.push(`${server.transport} URL must use http or https`);
      }
      if (parsed.username || parsed.password) {
        errors.push("credentials must not be embedded in the URL");
      }
      for (const key of parsed.searchParams.keys()) {
        if (credentialLikeName(key)) {
          warnings.push(
            `${key} is a credential-like URL parameter; public views will redact its value`,
          );
        }
      }
    } catch {
      errors.push(`${server.transport} URL is invalid`);
    }
  }
  if (server.transport === "sse") warnings.push("SSE is deprecated by MCP; prefer HTTP");
  const duplicate = (pairs, label, validatePair) => {
    const seen = new Set();
    for (const pair of pairs) {
      const key = pair.name.toLowerCase();
      if (seen.has(key)) errors.push(`duplicate ${label}: ${pair.name}`);
      seen.add(key);
      validatePair(pair);
      if (!pair.value) warnings.push(`${label} ${pair.name} has an empty value`);
    }
  };
  duplicate(server.env, "environment variable", (pair) => {
    if (!ENV_NAME.test(pair.name)) {
      errors.push(`invalid environment variable name: ${pair.name}`);
    }
    if (NUL_CHARACTER.test(pair.value)) {
      errors.push(`environment variable ${pair.name} contains a NUL character`);
    }
  });
  duplicate(server.headers, "header", (pair) => {
    if (!HEADER_NAME.test(pair.name)) errors.push(`invalid header name: ${pair.name}`);
    if (CONTROL_CHARACTERS.test(pair.value)) {
      errors.push(`header ${pair.name} contains invalid control characters`);
    }
  });
  for (const header of server.headers) {
    if (/authorization|token|secret|api[-_]?key|cookie/i.test(header.name) && !ENV_REFERENCE.test(header.value)) {
      warnings.push(`${header.name} should reference an environment variable instead of a literal secret`);
    }
  }
  return { server, errors, warnings, ok: errors.length === 0 };
}

function resolveExecutable(command, env = process.env) {
  const value = String(command || "").trim();
  if (!value) return null;
  if (value.includes("/") || value.includes(path.sep)) {
    const absolute = path.resolve(value.replace(/^~(?=$|\/)/, os.homedir()));
    try {
      fs.accessSync(absolute, fs.constants.X_OK);
      return absolute;
    } catch {
      return null;
    }
  }
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, value);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function expandPairValues(pairs, env = process.env) {
  const missing = [];
  const values = pairs.map((pair) => {
    const match = ENV_REFERENCE.exec(pair.value);
    if (!match) return { ...pair };
    if (!Object.hasOwn(env, match[1])) {
      missing.push(match[1]);
      return { ...pair, value: "" };
    }
    return { ...pair, value: String(env[match[1]]) };
  });
  return { values, missing };
}

function capabilitySupport(server, capabilities = {}) {
  const mcp = capabilities?.mcpCapabilities || {};
  if (server.transport === "http" && mcp.http !== true) {
    return { ok: false, reason: "adapter does not advertise MCP HTTP" };
  }
  if (server.transport === "sse" && mcp.sse !== true) {
    return { ok: false, reason: "adapter does not advertise MCP SSE" };
  }
  return { ok: true, reason: null };
}

function materializeMcpDefinition(server, options = {}) {
  const validation = validateMcpDefinition(server, { source: server.source, touch: false });
  if (!validation.ok) {
    return { ok: false, status: "invalid", errors: validation.errors, warnings: validation.warnings };
  }
  const support = capabilitySupport(server, options.capabilities);
  if (!support.ok) {
    return {
      ok: false,
      status: "unsupported",
      errors: [support.reason],
      warnings: validation.warnings,
    };
  }
  if (server.transport === "stdio") {
    const command = resolveExecutable(server.command, options.env);
    if (!command) {
      return {
        ok: false,
        status: "failed",
        errors: [`executable not found: ${server.command}`],
        warnings: validation.warnings,
      };
    }
    const expanded = expandPairValues(server.env, options.env);
    if (expanded.missing.length) {
      return {
        ok: false,
        status: "failed",
        errors: [`missing environment variables: ${expanded.missing.join(", ")}`],
        warnings: validation.warnings,
      };
    }
    return {
      ok: true,
      status: "ready",
      server: { name: server.name, command, args: server.args, env: expanded.values },
      errors: [],
      warnings: validation.warnings,
    };
  }
  const expanded = expandPairValues(server.headers, options.env);
  if (expanded.missing.length) {
    return {
      ok: false,
      status: "failed",
      errors: [`missing environment variables: ${expanded.missing.join(", ")}`],
      warnings: validation.warnings,
    };
  }
  return {
    ok: true,
    status: "ready",
    server: {
      type: server.transport,
      name: server.name,
      url: server.url,
      headers: expanded.values,
    },
    errors: [],
    warnings: validation.warnings,
  };
}

function staticMcpDefinitions(config = {}) {
  const entries = [];
  for (const [index, server] of (config.mcpServers || []).entries()) {
    entries.push(
      normalizeMcpDefinition(server, {
        source: "static",
        sourceKey: `global:${index}`,
        touch: false,
      }),
    );
  }
  for (const [provider, agent] of Object.entries(config.agents || {})) {
    for (const [index, server] of (agent?.mcpServers || []).entries()) {
      entries.push(
        normalizeMcpDefinition(server, {
          source: "static",
          sourceKey: `${provider}:${index}`,
          provider,
          touch: false,
        }),
      );
    }
  }
  return entries;
}

function resolveEffectiveMcp(config, managed, context = {}) {
  const candidates = [
    ...staticMcpDefinitions(config),
    ...(managed?.servers || []).map((server) =>
      normalizeMcpDefinition(server, { source: "managed", touch: false }),
    ),
  ].filter((server) => server.enabled && scopeMatches(server.scope, context));
  const selected = new Map();
  for (const [index, server] of candidates.entries()) {
    const score = scopeScore(server.scope) + (server.source === "managed" ? 1 : 0);
    const key = server.name.toLowerCase();
    const previous = selected.get(key);
    if (!previous || score > previous.score || (score === previous.score && index > previous.index)) {
      selected.set(key, { server, score, index });
    }
  }

  const entries = [...selected.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ server }) => server);
  const servers = [];
  const skipped = [];
  const diagnostics = [];
  for (const server of entries) {
    const result = materializeMcpDefinition(server, {
      capabilities: context.capabilities,
      env: context.env,
    });
    diagnostics.push({ id: server.id, name: server.name, ...result, server: undefined });
    if (result.ok) servers.push(result.server);
    else skipped.push({ id: server.id, name: server.name, reason: result.errors.join("; "), status: result.status });
  }
  return { entries, servers, skipped, diagnostics };
}

function publicMcpDefinition(server, options = {}) {
  const validation = validateMcpDefinition(server, { source: server.source, touch: false });
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    scope: server.scope,
    scopeType: scopeType(server.scope),
    source: server.source,
    command: server.command || "",
    args: redactMcpArgs(server.args || []),
    envNames: (server.env || []).map((pair) => pair.name),
    url: redactMcpUrl(server.url || ""),
    headerNames: (server.headers || []).map((pair) => pair.name),
    createdAt: server.createdAt || null,
    updatedAt: server.updatedAt || null,
    errors: validation.errors,
    warnings: validation.warnings,
    effective: options.effective === true,
    status: options.status || (server.enabled ? "configured" : "disabled"),
    statusDetail: options.statusDetail || "",
    applied: options.applied === true,
  };
}

class McpRegistry {
  constructor(options = {}) {
    this.file = options.file || MCP_REGISTRY_PATH;
    this.recovery = null;
    try {
      this.value = readRegistry(this.file);
      hardenRegistryStorage(this.file);
    } catch (error) {
      if (options.recover === false) throw error;
      const recovered = recoverRegistry(this.file, error);
      this.value = recovered.value;
      this.recovery = recovered.recovery;
    }
  }

  reload() {
    try {
      this.value = readRegistry(this.file);
      hardenRegistryStorage(this.file);
      this.recovery = null;
    } catch (error) {
      const recovered = recoverRegistry(this.file, error);
      this.value = recovered.value;
      this.recovery = recovered.recovery;
    }
    return this.value;
  }

  save() {
    this.value.updatedAt = nowIso();
    writeJsonAtomic(this.file, this.value);
    return this.value;
  }

  list() {
    return this.value.servers.map((server) =>
      normalizeMcpDefinition(server, { source: "managed", touch: false }),
    );
  }

  status() {
    return {
      file: this.file,
      count: this.value.servers.length,
      recovered: this.recovery?.recovered === true,
      recoveryReason: this.recovery?.reason || null,
      backupFile: this.recovery?.backupFile || null,
    };
  }

  upsert(input) {
    const existing = input.id
      ? this.value.servers.find((server) => server.id === input.id)
      : null;
    const validation = validateMcpDefinition(
      { ...(existing || {}), ...input, source: "managed" },
      { source: "managed" },
    );
    if (!validation.ok) {
      const error = new Error(validation.errors.join("; "));
      error.code = "MCP_INVALID";
      error.details = validation;
      throw error;
    }
    const duplicate = this.value.servers.find(
      (server) =>
        server.id !== validation.server.id &&
        server.name.toLowerCase() === validation.server.name.toLowerCase() &&
        JSON.stringify(normalizeScope(server.scope)) === JSON.stringify(validation.server.scope),
    );
    if (duplicate) throw new Error(`MCP server already exists in this scope: ${validation.server.name}`);
    const index = this.value.servers.findIndex((server) => server.id === validation.server.id);
    if (index >= 0) this.value.servers[index] = validation.server;
    else this.value.servers.push(validation.server);
    this.save();
    return validation.server;
  }

  toggle(id, enabled) {
    const server = this.value.servers.find((entry) => entry.id === id);
    if (!server) throw new Error(`Unknown managed MCP server: ${id}`);
    server.enabled = enabled === true;
    server.updatedAt = nowIso();
    this.save();
    return normalizeMcpDefinition(server, { source: "managed", touch: false });
  }

  remove(id) {
    const index = this.value.servers.findIndex((server) => server.id === id);
    if (index < 0) throw new Error(`Unknown managed MCP server: ${id}`);
    const [removed] = this.value.servers.splice(index, 1);
    this.save();
    return normalizeMcpDefinition(removed, { source: "managed", touch: false });
  }
}

export {
  MCP_REGISTRY_PATH,
  MCP_REGISTRY_SCHEMA,
  normalizePairs,
  normalizeScope,
  scopeType,
  scopeScore,
  scopeMatches,
  normalizeMcpDefinition,
  redactMcpArgs,
  redactMcpUrl,
  validateMcpDefinition,
  resolveExecutable,
  expandPairValues,
  capabilitySupport,
  materializeMcpDefinition,
  staticMcpDefinitions,
  resolveEffectiveMcp,
  publicMcpDefinition,
  readRegistry,
  inspectMcpRegistry,
  McpRegistry,
};
