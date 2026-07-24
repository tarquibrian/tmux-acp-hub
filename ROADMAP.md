# tmux-acp-hub Roadmap

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

## Phase 4: ACP Capabilities - in progress

- Implement safe client `fs/*` capabilities.
- Add terminal capabilities where useful.
- [x] Surface modes, config options, available commands, and auth flows.
- [x] Add scoped MCP administration, secret-safe diagnostics, capability
  gating, transactional apply/rollback, and inline composer management.

## Phase 5: Release Quality - done in 0.2.0

- [x] Add automated tests for protocol, renderer, input, persistence, and tmux edge cases.
- [x] Add health checks, logs, upgrade notes, and troubleshooting commands.
- [x] Package the plugin with documented install/update flows and CI validation.
- [x] Add verified private adapter installs, version checks, staged activation,
  rollback, and popup/CLI management commands.

## Next

- Implement ACP client filesystem capabilities with explicit workspace scoping.
- Evaluate terminal capabilities behind an opt-in permission boundary.
- Add adapter compatibility fixtures as more ACP agents expose structured
  message roles, plans, commands, and capabilities. Initial Codex/Claude
  package, handshake, and required-capability matrices are complete.
- Expand MCP preflight into an optional protocol-level connectivity probe when
  ACP standardizes a safe adapter-owned diagnostic call.
