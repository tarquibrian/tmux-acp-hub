#!/usr/bin/env node
// Unit tests for the adapter pin currency helpers behind `acp-hub.mjs health`:
// pin parsing from npx-style agent configs, semver comparison, and the two
// output shapes `npm view <pkg> version deprecated --json` can produce.
// Pure functions only — no network.
import assert from "node:assert/strict";
import { npxAdapterPin, compareSemver, parseNpmViewInfo } from "../lib/core.mjs";

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

console.log("health test passed");
