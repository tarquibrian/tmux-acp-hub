#!/usr/bin/env node
// Tests for the restart / reset recovery commands. Everything runs against an
// isolated state dir (ACP_HUB_HOME) and an isolated tmux socket dir
// (TMUX_TMPDIR pointing at an empty temp dir, so no tmux server exists and
// the kill-workspace-sessions step is a safe no-op) — the user's real state
// and tmux server are never touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "acp-hub.mjs");
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib.sh");

function makeStateDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reset-"));
  fs.writeFileSync(
    path.join(home, "registry.json"),
    JSON.stringify({ version: 1, chats: [{ id: "a" }, { id: "b" }], current: [], tombstones: [] }),
  );
  fs.writeFileSync(path.join(home, "state.json"), "{}");
  fs.writeFileSync(path.join(home, "drafts.json"), "{}");
  fs.writeFileSync(path.join(home, "input-history.json"), "[]");
  fs.writeFileSync(path.join(home, "daemon.log"), "log\n");
  fs.mkdirSync(path.join(home, "pastes"));
  fs.writeFileSync(path.join(home, "pastes", "p1.txt"), "paste");
  return home;
}

function runCli(home, tmuxDir, args, input = null, extraEnv = {}) {
  const env = { ...process.env, ACP_HUB_HOME: home, TMUX_TMPDIR: tmuxDir, ...extraEnv };
  delete env.TMUX;
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env,
    input: input === null ? undefined : input,
  });
}

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-notmux-"));

// restart with no daemon running: reports it, keeps every chat file.
{
  const home = makeStateDir();
  const result = runCli(home, tmuxDir, ["restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /daemon: was not running/);
  assert.match(result.stdout, /chats kept/);
  assert.ok(fs.existsSync(path.join(home, "registry.json")), "restart keeps the registry");
  assert.ok(fs.existsSync(path.join(home, "drafts.json")), "restart keeps drafts");
  assert.ok(!fs.existsSync(path.join(home, "restart.lock")), "restart releases its transaction lock");
  fs.rmSync(home, { recursive: true, force: true });
}

// The popup creates the marker before detaching the restart child. The child
// must claim that exact token (rather than rejecting its own transaction) and
// always release it when cleanup finishes.
{
  const home = makeStateDir();
  const token = "popup-owned-restart";
  fs.writeFileSync(
    path.join(home, "restart.lock"),
    JSON.stringify({ token, pid: process.pid, state: "requested", startedAt: Date.now() }),
  );
  const result = runCli(home, tmuxDir, ["restart"], null, {
    ACP_HUB_RESTART_TOKEN: token,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(path.join(home, "restart.lock")), "inherited restart lock released");
  fs.rmSync(home, { recursive: true, force: true });
}

// prefix+m sources this helper before it creates/selects a workspace. Prove it
// waits for the detached restart transaction instead of racing into cleanup.
{
  const home = makeStateDir();
  const lock = path.join(home, "restart.lock");
  fs.writeFileSync(
    lock,
    JSON.stringify({ token: "wait-test", state: "running", startedAt: Date.now() }),
  );
  const started = Date.now();
  const result = spawnSync(
    "sh",
    ["-c", '(sleep 0.25; rm -f "$ACP_HUB_HOME/restart.lock") & . "$ACP_TEST_LIB"; wait_for_hub_restart'],
    {
      encoding: "utf8",
      env: { ...process.env, ACP_HUB_HOME: home, ACP_TEST_LIB: LIB },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started >= 150, "workspace launch waited for restart completion");
  fs.rmSync(home, { recursive: true, force: true });
}

// reset without --yes on a non-TTY refuses and deletes nothing.
{
  const home = makeStateDir();
  const result = runCli(home, tmuxDir, ["reset"], "");
  assert.equal(result.status, 2, "non-interactive reset without --yes exits 2");
  assert.match(result.stderr, /--yes/);
  assert.ok(fs.existsSync(path.join(home, "registry.json")), "refused reset keeps the registry");
  fs.rmSync(home, { recursive: true, force: true });
}

// reset --yes wipes chats, composer state, log, and pastes — but not the dir.
{
  const home = makeStateDir();
  const result = runCli(home, tmuxDir, ["reset", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wiped 2 chat\(s\)/);
  assert.match(result.stdout, /agents\.json .*not touched/);
  for (const file of ["registry.json", "state.json", "drafts.json", "input-history.json", "daemon.log"]) {
    assert.ok(!fs.existsSync(path.join(home, file)), `${file} deleted`);
  }
  assert.ok(!fs.existsSync(path.join(home, "pastes")), "pastes dir deleted");
  assert.ok(fs.existsSync(home), "state dir itself survives");
  fs.rmSync(home, { recursive: true, force: true });
}

fs.rmSync(tmuxDir, { recursive: true, force: true });
console.log("reset test passed");
