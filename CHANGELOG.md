# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-01

Initial public release.

### Added
- `ClaudeManager` / `ClaudeInstance` — spawn `claude` headless (in-process PTY)
  or in a visible terminal window (`openWindow`, Windows).
- Virtual screen mirroring via a headless xterm, with `snapshot()`.
- `ContinuousParser` + `SessionState`: parsed status/tool/permission/todo state
  and a typed `SessionEvents` emitter (`status:busy`, `status:idle`,
  `tool:start`, `permission:prompt`, `todo:changed`, …).
- High-level instance actions: `ask()`, `approve()`/`deny()`, `waitIdle()`,
  `waitFor()`, `waitPermission()`.
- Out-of-process control over a named pipe + loopback HTTP bridge, with an
  on-disk instance registry for discovery (`listInstances`, `findInstance`).
- `EventSink` interface and a built-in `WebSocketEventSink` for forwarding an
  instance's events to another process over a generic JSON wire format.
- Live display streaming (headless): `instance.onData(cb)` for the raw PTY byte
  stream, and a `screen:changed` event that signals every screen redraw (pair
  it with `snapshot()` for rendered lines).
- Bins: `claude-wrap` (launch a wrapped window), `claude-wrap-run` (the wrapper
  process), `claude-wrap-inject` (drive a running instance from any shell).
