# Maintainer guide

Runtime adapter updates and plugin releases are deliberately separate.
`/hub update` manages a user's verified private adapter store; it never changes
this repository, the plugin version, or a global Codex/Claude installation.
Plugin releases are distributed from GitHub through TPM or a manual clone.
`package.json` is a private development/test manifest; do not publish the Hub
itself to npm.

## Supported surface

[`compatibility/adapters.json`](compatibility/adapters.json) is the canonical
maintenance contract. It owns:

- the default ACP package and exact version for each bundled provider;
- the default and previous release tested by CI;
- the Node major used for adapter probes and the Node majors supported by the
  dependency-free Hub;
- ACP protocol v1 and the provider capabilities the current UI depends on.

`agents.json` is a generated portable fallback. `lib/core.mjs` derives its
built-in defaults directly from the compatibility manifest, and release tests
fail if the generated file drifts.

"Tested" means that CI installed the exact npm package in an isolated private
store, verified package name/version/executable, completed ACP `initialize`,
negotiated protocol v1, and observed every required capability. It does not
guarantee provider availability, authentication, model behavior, or upstream
service uptime.

The support window is the current default plus the previous verified default.
Older versions may continue to work but are best-effort. Custom commands and
pins in the user's `agents.json` remain user-owned and are never rewritten.

## Routine workflow

Inspect registry state without changing files:

```sh
npm run adapters:check
npm run adapters:matrix
```

Probe all versions in the supported matrix:

```sh
npm run adapters:probe
```

Probe one candidate explicitly:

```sh
npm run adapters:probe -- codex 1.2.0
```

Every Monday, `adapter-maintenance.yml` performs this automatically:

1. A read-only job queries the configured npm tags.
2. New packages execute only inside that read-only job.
3. Exact package metadata, ACP handshake, and required capabilities are checked.
4. A separate write-capable job consumes the verified report and opens or
   refreshes `automation/adapter-pins`.
5. The pull request runs the complete plugin suite and never merges itself.

This permission split is intentional: an unreviewed npm candidate never runs
with repository write or pull-request authority.

## Reviewing an adapter PR

Before merging:

1. Read the upstream release notes and dependency/deprecation changes.
2. Confirm the automated probe and complete CI matrix passed.
3. Manually exercise session creation, restore/resume, streaming/final roles,
   Plan, permissions, commands, modes/config, MCP, cancellation, and restart.
   For MCP, cover stdio plus every transport capability newly advertised by the
   adapter, pending apply, rollback, and the no-restore/new-chat path.
4. Check both a fresh private install and rollback to the retained version.
5. Update the plugin changelog when behavior or minimum requirements changed.
6. Merge the pin PR, then publish a normal plugin release when appropriate.

If a candidate drops ACP v1, a required capability, or its exact executable,
the probe must fail. Adapt the plugin in a reviewed development change or keep
the previous pin; never weaken the contract merely to make automation green.

## Publishing a plugin release

1. Freeze the candidate and mark its changelog section `Unreleased`.
2. Run `npm run adapters:check`; probe and review any newer candidate before
   deciding whether to update the canonical compatibility window.
3. Run `npm run check`, `npm run adapters:probe`, ShellCheck, a secret scan,
   and `git diff --check`.
4. Validate the candidate from a clean checkout in a path containing spaces,
   including TPM/manual installation, first chat, restore, permissions, MCP,
   `/hub`, `/restart`, and uninstall-with-state-preserved.
5. Push the candidate branch and require every Linux, macOS, shell, bundle and
   ACP matrix job to pass on the exact commit.
6. Replace `Unreleased` with the actual date, rerun the release test, merge,
   and create an annotated `v<package-version>` tag on that commit.
7. Push the tag and create the GitHub Release from the matching changelog
   section. Do not attach state/config files or publish an npm package.
8. Reinstall from GitHub with TPM and a manual clone, then verify
   `bin/acp-hub.mjs --version` and `health`.

If a released tag is faulty, do not move it silently. Document the issue and
publish a new patch version; users may pin the prior Git tag in TPM meanwhile.

## Responsibility boundaries

| Layer | Owner | Update path |
|---|---|---|
| Plugin code, UI, persistence and ACP semantics | Maintainers | reviewed plugin release |
| Bundled default pins and compatibility policy | Maintainers | verified automated/manual PR |
| User's private adapter runtime | User | `/hub update` or `acp-hub update` |
| Global `codex` / `claude` executables | User/upstream | external package manager |
| Models, modes and commands exposed at runtime | Adapter/provider | ACP discovery; no Hub hardcoding |
| MCP registry, scope resolution, redaction and apply UX | Maintainers | reviewed plugin release |
| MCP server packages, credentials and endpoint lifecycle | User/upstream MCP project | `/mcp` plus the server's own update path |

MCP release checks must include canary values in a named credential argument,
a sensitive URL query parameter, an environment value, and an HTTP header.
Assert that the adapter receives its private descriptor unchanged while RPC
results, daemon events, persisted chat summaries, diagnostics, and rendered UI
never contain the canaries. Also verify `0700` registry directories and `0600`
active/corrupt registry files after both normal load and recovery.
