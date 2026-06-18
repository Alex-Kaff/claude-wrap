# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-06-18

### Fixed
- **Headless launch on Linux/macOS.** `claude-wrap new --headless` (and the
  standalone wrapper) hardcoded the Windows command shell (`cmd.exe /c claude`)
  with no platform branch, so on non-Windows the child exec'd a non-existent
  `cmd.exe` and immediately exited 1, never staying registered. The wrapper now
  spawns `claude` directly off `PATH` everywhere except Windows, mirroring the
  in-process `ClaudeInstance` path. `useConpty` (a Windows-only ConPTY flag) is
  likewise gated to Windows.

## [0.2.0] - 2026-06-17

Adds a second way to drive Claude — the structured headless protocol — plus an
OpenAI-compatible gateway and a verb-based CLI, alongside the existing PTY client.

### Added
- **Print client (`ClaudeManager.print()` / `PrintSession`).** Drives the
  official headless JSON protocol (`claude -p`) over stdin/stdout instead of
  screen-scraping — persistent (warm, multi-turn) and one-shot transports,
  normalized `TurnResult` (text, structured output, tool calls, usage, cost),
  `isolate` cheap-clean profile, structured output (`jsonSchema`), cross-process
  `resume`, turn timeouts with resume-recovery, and an on-disk registry entry
  (`kind:"print"`). Windows runs `claude` over `cmd /c` for a real stdin pipe.
- **SDK control protocol.** Dynamic per-tool permissions via `canUseTool` + the
  `permission:request` event, `interrupt()`, and in-process functions Claude can
  call directly (`functions: [...]`, hosted as an SDK-MCP server over the control
  channel).
- **OpenAI-compatible chat gateway (`ChatGateway`) + `claude-wrap-serve` bin.**
  An in-process OpenAI-shaped client and an HTTP server (`/v1/chat/completions`
  JSON + SSE, `/v1/models`, `/health`). Isolated by default; supports
  `response_format` (json schema / json object), `max_tokens` enforcement,
  streaming with usage, client-side function calling (`tools` → `tool_calls`),
  and `replay` / `session` / `diff` history strategies. OpenAI-shaped errors.
- **Verb-based `claude-wrap` CLI** (`new` / `list` / `ask` / `status` / `send` /
  `stop`) for managing instances from the shell, mirroring the MCP surface.
- Opt-in per-row foreground colors in the snapshot protocol (carried over from
  0.1.4).

### Changed
- **Breaking:** `ClaudeManager.get()` / `.list()` now return the shared
  `ManagedSession` type (PTY + print) rather than `ClaudeInstance`. `spawn()`
  still returns `ClaudeInstance`; the new `print()` returns `PrintSession`.

## [0.1.3] - 2026-06-05

### Fixed
- **Headful windows no longer render Unicode as mojibake / `?`.** The wrapper
  mirrors the child PTY's UTF-8 output to its own stdout, which in a `start`-
  spawned `cmd` window goes out the byte path. With the default OEM code page
  (e.g. 437) the console mis-decodes those bytes, so the banner blocks, `❯`,
  `⏵`, `…`, etc. came out as garbage or `?`. The wrapper now sets the console to
  UTF-8 (`chcp 65001`) at startup. The `chcp` child is spawned with
  `windowsHide:false` so it inherits — and therefore reconfigures — the visible
  console, instead of getting its own detached one (verified: the window's
  console output CP becomes 65001).

## [0.1.2] - 2026-06-05

Repairs spawned/headful sessions against Claude Code v2.1.165. Backward
compatible.

### Fixed
- **Spawned sessions no longer hijack the launching agent's IDE.** When
  claude-wrap runs from inside another Claude Code session (e.g. an MCP server),
  the child `claude` inherited `CLAUDE_CODE_SSE_PORT` and auto-connected to the
  parent's VS Code / Cursor extension, so every Write/Edit popped an editor diff
  and stalled on "Save file to continue…". The new `childEnv()` helper strips the
  parent's Claude Code / IDE-integration variables (`CLAUDE_CODE_*`, `CLAUDECODE`,
  `CLAUDE_EFFORT`, `AI_AGENT`) from every spawn (`ClaudeInstance` headless +
  windowed, and the standalone `wrapper`), so a spawned session behaves like a
  clean standalone `claude` invocation. PATH/HOME/auth are preserved.
- **Permission title no longer absorbs the IDE diff header.** When a session is
  attached to an editor terminal, a Write/Edit prompt grows an
  "Opened changes in <IDE> ⧉" / "Save file to continue…" block; the parser used
  to report that as the permission `title`. Those IDE-noise lines are now skipped
  (the reliable `question` is unaffected).

### Added
- `childEnv(extra?, base?)` is exported from the package root.
- `"./package.json"` is exposed in the `exports` map so tooling that does
  `require.resolve("claude-wrap/package.json")` no longer hits
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## [0.1.1] - 2026-06-01

### Fixed
- Repaired parsed-state detection against Claude Code v2.1.159: option-anchored
  permission/trust-dialog detection, busy keyed off the "esc to interrupt" bar
  hint, mode/tokens decoupled, and a separate-write submit to beat the
  type-then-Enter race. Added `permissionPrompt.question`, `status.effort`, and a
  top-level `remoteUrl`; `keys.ts` gained `shift-tab` and more.

## [0.1.0] - 2026-06-01

Initial release — client library for spawning and driving the Claude Code CLI
(headless or in a visible terminal), reading screen/parsed state, subscribing to
status events, sending input, and controlling out-of-process instances over a
pipe or loopback HTTP.

[0.2.0]: https://github.com/Alex-Kaff/claude-wrap/compare/v0.1.4...v0.2.0
[0.1.3]: https://github.com/Alex-Kaff/claude-wrap/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Alex-Kaff/claude-wrap/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Alex-Kaff/claude-wrap/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Alex-Kaff/claude-wrap/releases/tag/v0.1.0
