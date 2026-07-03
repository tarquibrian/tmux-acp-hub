# tmux-vanzi-hub Roadmap

## Phase 1: Protocol Stability - done

- Resolve pending permission requests when a turn is cancelled, a chat is closed,
  or the adapter exits.
- Respect advertised ACP capabilities before optional calls.
- Harden daemon socket lifecycle and permissions.
- Pin default adapter versions.
- Add a smoke test with a fake ACP agent.

## Phase 2: Real ACP Sessions - done

- Use `session/list`, `session/load`, and `session/resume` when supported.
- Persist enough metadata to recover chats after daemon restart.
- Support multiple chats per provider/project.

## Phase 3: Popup UX - done

- Replace the line-based UI with a stable interactive terminal view.
- Keep streaming output from corrupting the input prompt.
- Add filtering, provider grouping, status badges, and easier switching.

## Phase 4: ACP Capabilities

- Implement safe client `fs/*` capabilities.
- Add terminal capabilities where useful.
- Surface modes, config options, available commands, and auth flows.

## Phase 5: Release Quality

- Add automated tests for protocol edge cases.
- Add health checks, logs, upgrade notes, and troubleshooting commands.
- Package the plugin with documented install/update flows.
