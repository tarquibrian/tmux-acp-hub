#!/usr/bin/env node
// Unit tests for the adapter pin currency helpers behind `acp-hub.mjs health`:
// pin parsing from npx-style agent configs, semver comparison, and the two
// output shapes `npm view <pkg> version deprecated --json` can produce.
// Pure functions only — no network.
import assert from "node:assert/strict";
import {
  npxAdapterPin,
  compareSemver,
  parseNpmViewInfo,
  acpProtocolMismatch,
  configCredentialEnvNames,
  redactCommandArgs,
  mergeConfig,
} from "../lib/core.mjs";

// Partial user overrides inherit the tested command/pin instead of forcing
// users to copy it forever. Nested env/default maps merge independently.
{
  const merged = mergeConfig(
    {
      defaultAgent: "codex",
      agents: {
        codex: {
          command: "npx",
          args: ["-y", "@scope/codex-acp@1.2.3"],
          env: { KEEP: "1", REPLACE: "old" },
          configDefaults: { model: "default", effort: "medium" },
        },
      },
    },
    {
      agents: {
        codex: {
          env: { REPLACE: "new" },
          configDefaults: { effort: "high" },
        },
      },
    },
  );
  assert.equal(merged.agents.codex.command, "npx");
  assert.deepEqual(merged.agents.codex.args, ["-y", "@scope/codex-acp@1.2.3"]);
  assert.deepEqual(merged.agents.codex.env, { KEEP: "1", REPLACE: "new" });
  assert.deepEqual(merged.agents.codex.configDefaults, { model: "default", effort: "high" });
}

// npxAdapterPin: scoped package with exact pin.
{
  const pin = npxAdapterPin({
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
  });
  assert.deepEqual(pin, { pkg: "@agentclientprotocol/codex-acp", version: "1.1.4" });
}

// npxAdapterPin: unscoped package and prerelease pins parse too.
{
  const pin = npxAdapterPin({ command: "npx", args: ["-y", "some-adapter@2.0.0-beta.1"] });
  assert.deepEqual(pin, { pkg: "some-adapter", version: "2.0.0-beta.1" });
}

// npxAdapterPin: flags are skipped, first pinned arg wins.
{
  const pin = npxAdapterPin({
    command: "npx",
    args: ["--yes", "--quiet", "@scope/pkg@0.1.0", "--flag-after"],
  });
  assert.deepEqual(pin, { pkg: "@scope/pkg", version: "0.1.0" });
}

// npxAdapterPin: null for custom commands, unpinned npx, tags, and junk.
{
  assert.equal(npxAdapterPin({ command: "codex-acp", args: [] }), null);
  assert.equal(npxAdapterPin({ command: "npx", args: ["-y", "@scope/pkg"] }), null);
  assert.equal(npxAdapterPin({ command: "npx", args: ["-y", "@scope/pkg@latest"] }), null);
  assert.equal(npxAdapterPin({ command: "npx", args: ["-y", "@scope/pkg@1.2"] }), null);
  assert.equal(npxAdapterPin({ command: "npx" }), null);
  assert.equal(npxAdapterPin(null), null);
}

// compareSemver: ordering across major/minor/patch.
{
  assert.equal(compareSemver("0.16.0", "1.1.4"), -1);
  assert.equal(compareSemver("1.1.4", "0.16.0"), 1);
  assert.equal(compareSemver("0.57.0", "0.59.0"), -1);
  assert.equal(compareSemver("0.59.0", "0.59.0"), 0);
  assert.equal(compareSemver("0.59.1", "0.59.0"), 1);
  assert.equal(compareSemver("0.9.9", "0.10.0"), -1, "numeric compare, not lexicographic");
}

// compareSemver: prerelease sorts before its release.
{
  assert.equal(compareSemver("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareSemver("1.0.0-beta.10", "1.0.0-beta.2"), 1);
  assert.equal(compareSemver("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareSemver("1.0.0-beta", "1.0.0-beta"), 0);
}

// parseNpmViewInfo: bare string when only `version` has a value.
{
  assert.deepEqual(parseNpmViewInfo('"1.1.4"\n'), { latest: "1.1.4", deprecated: undefined });
}

// parseNpmViewInfo: keyed object when `deprecated` is set.
{
  const info = parseNpmViewInfo(
    JSON.stringify({ version: "0.16.0", deprecated: "This package has been replaced." }),
  );
  assert.deepEqual(info, { latest: "0.16.0", deprecated: "This package has been replaced." });
}

// parseNpmViewInfo: garbage in, null out.
{
  assert.equal(parseNpmViewInfo("npm ERR! network"), null);
  assert.equal(parseNpmViewInfo(""), null);
  assert.equal(parseNpmViewInfo("null"), null);
}

// acpProtocolMismatch: matching, omitted, and null versions are fine.
{
  assert.equal(acpProtocolMismatch(1), null);
  assert.equal(acpProtocolMismatch(undefined), null);
  assert.equal(acpProtocolMismatch(null), null);
}

// acpProtocolMismatch: a different negotiated version warns, naming both sides.
{
  const warning = acpProtocolMismatch(2);
  assert.ok(warning.includes("v2"));
  assert.ok(warning.includes("v1"));
  assert.equal(acpProtocolMismatch(0) === null, false, "v0 also mismatches");
}

// Config safety inspection reports names only and ignores ordinary env vars.
{
  assert.deepEqual(
    configCredentialEnvNames({
      agents: {
        codex: {
          env: {
            OPENAI_API_KEY: "secret-value",
            NO_BROWSER: "1",
            EMPTY_TOKEN: "",
          },
        },
        claude: { env: { ANTHROPIC_TOKEN: "another-secret" } },
      },
    }),
    ["ANTHROPIC_TOKEN", "OPENAI_API_KEY"],
  );
  assert.deepEqual(configCredentialEnvNames(null), []);
}

// Health command arguments preserve useful package/version information while
// redacting common flag, header, URL-userinfo, and query credential forms.
{
  assert.deepEqual(
    redactCommandArgs([
      "-y",
      "@agentclientprotocol/codex-acp@1.1.4",
      "--api-key",
      "secret-one",
      "--token=secret-two",
      "Authorization: Bearer secret-three",
      "OPENAI_API_KEY=secret-env",
      "https://user:pass@example.test/acp?access_token=secret-four&mode=test",
    ]),
    [
      "-y",
      "@agentclientprotocol/codex-acp@1.1.4",
      "--api-key",
      "[redacted]",
      "--token=[redacted]",
      "Authorization: [redacted]",
      "OPENAI_API_KEY=[redacted]",
      "https://redacted@example.test/acp?access_token=%5Bredacted%5D&mode=test",
    ],
  );
}

console.log("health test passed");
