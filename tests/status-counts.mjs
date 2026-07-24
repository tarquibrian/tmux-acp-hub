#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  acpStatusCounts,
  acpStatusCountOptionValues,
} from "../lib/core.mjs";

function resolveShellTheme(theme, accent = "#f26286") {
  return spawnSync(
    "sh",
    [
      "-c",
      `. ./scripts/lib.sh
tmux() {
  case "$*" in
    "show-option -gqv @acp_hub_theme") printf '%s\\n' '${theme}' ;;
    "show-option -gqv @acp_hub_accent") printf '%s\\n' '${accent}' ;;
  esac
}
resolve_acp_theme_styles
printf '%s\\n%s\\n' "$ACP_THEME_PROVIDER_STYLE" "$ACP_THEME_PROVIDER_CURRENT_STYLE"`,
    ],
    { encoding: "utf8" },
  );
}

const chats = [
  { active: true, status: "thinking" },
  { active: true, status: "idle" },
  { active: true, status: "permission" },
  { active: true, status: "auth" },
  { active: true, status: "error" },
  { active: true, status: "saved" },
  { active: true, status: "stopped" },
  { active: false, status: "working" },
];

assert.deepEqual(acpStatusCounts(chats), {
  active: 5,
  busy: 1,
  idle: 1,
  waiting: 2,
  error: 1,
});

assert.deepEqual(acpStatusCountOptionValues(chats), {
  "@acp_hub_active_count": 5,
  "@acp_hub_busy_count": 1,
  "@acp_hub_idle_count": 1,
  "@acp_hub_waiting_count": 2,
  "@acp_hub_error_count": 1,
});

assert.deepEqual(acpStatusCounts(), {
  active: 0,
  busy: 0,
  idle: 0,
  waiting: 0,
  error: 0,
});

// The shell-side resolver mirrors lib/theme.mjs for native tmux window tabs
// and the switcher without touching a developer's live tmux server.
{
  const vanzi = resolveShellTheme("vanzi");
  assert.equal(vanzi.status, 0, vanzi.stderr);
  assert.match(vanzi.stdout, /#\[fg=#f26286\]/);
  assert.match(vanzi.stdout, /#\[fg=black\]#\[bg=#f26286\]/);
  assert.doesNotMatch(vanzi.stdout, /colour39|colour173/);

  const agent = resolveShellTheme("agent");
  assert.equal(agent.status, 0, agent.stderr);
  assert.match(agent.stdout, /colour173/);
  assert.match(agent.stdout, /colour39/);
  assert.match(agent.stdout, /#f26286/, "unknown providers retain the Vanzi fallback");
}

// A valid-looking format string is insufficient: commas inside a conditional
// are branch separators. Expand every provider/current-state combination with
// tmux's real parser so a malformed active tab cannot silently disappear.
{
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  assert.equal(probe.status, 0, "tmux is required for format integration tests");
  const socket = `acp-status-${process.pid}-${Date.now()}`;
  const tmux = (...args) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

  try {
    assert.equal(tmux("-f", "/dev/null", "new-session", "-d", "-s", "theme", "-n", "codex").status, 0);
    assert.equal(tmux("new-window", "-d", "-t", "theme", "-n", "claude").status, 0);
    const windows = [
      { target: "theme:codex", provider: "codex", icon: "⬡", title: "Codex title", bg: "colour39" },
      { target: "theme:claude", provider: "claude", icon: "❋", title: "Claude title", bg: "colour173" },
    ];
    for (const window of windows) {
      for (const [name, value] of [
        ["@acp_hub_provider", window.provider],
        ["@acp_hub_provider_icon", window.icon],
        ["@acp_hub_tab_title", window.title],
      ]) {
        assert.equal(tmux("set-option", "-w", "-t", window.target, name, value).status, 0);
      }
    }

    for (const variant of ["vanzi", "agent"]) {
      const resolved = resolveShellTheme(variant);
      assert.equal(resolved.status, 0, resolved.stderr);
      const [inactiveStyle, currentStyle] = resolved.stdout.trimEnd().split("\n");
      for (const window of windows) {
        const inactive = tmux(
          "display-message",
          "-t",
          window.target,
          "-p",
          `${inactiveStyle} #{@acp_hub_provider_icon} #{@acp_hub_tab_title} #[default]`,
        );
        const current = tmux(
          "display-message",
          "-t",
          window.target,
          "-p",
          `${currentStyle} #{@acp_hub_provider_icon} #{@acp_hub_tab_title} #[default]`,
        );
        assert.equal(inactive.status, 0, inactive.stderr);
        assert.equal(current.status, 0, current.stderr);
        assert.match(inactive.stdout, new RegExp(`${window.icon} ${window.title}`));
        assert.match(current.stdout, new RegExp(`${window.icon} ${window.title}`));
        if (variant === "agent") {
          assert.match(current.stdout, new RegExp(`bg=${window.bg}`));
        } else {
          assert.match(current.stdout, /bg=#f26286/);
        }
      }
    }
  } finally {
    tmux("kill-server");
  }
}

// The busy suffix owns its trailing cell before resetting style. Otherwise the
// glyph appears glued to the following tab even though a default-bg space is
// technically present.
{
  const result = spawnSync(
    "sh",
    [
      "-c",
      '. ./scripts/lib.sh\ntmux() { printf "%s\\n" "$*"; }\napply_acp_status_format test-session',
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const inactive = result.stdout.split("\n").find((line) => line.includes("window-status-format"));
  const active = result.stdout
    .split("\n")
    .find((line) => line.includes("window-status-current-format"));
  assert.match(inactive, /status_glyph\} #\[default\]/);
  assert.match(active, /status_glyph\} , \}/);
}

console.log("status counts test passed");
