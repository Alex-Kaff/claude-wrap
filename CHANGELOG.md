# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.2]: https://github.com/Alex-Kaff/claude-wrap/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Alex-Kaff/claude-wrap/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Alex-Kaff/claude-wrap/releases/tag/v0.1.0
