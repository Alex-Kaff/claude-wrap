# claude-wrap

[![npm version](https://img.shields.io/npm/v/claude-wrap.svg)](https://www.npmjs.com/package/claude-wrap)
[![npm downloads](https://img.shields.io/npm/dm/claude-wrap.svg)](https://www.npmjs.com/package/claude-wrap)
[![types](https://img.shields.io/npm/types/claude-wrap.svg)](https://www.npmjs.com/package/claude-wrap)
[![node](https://img.shields.io/node/v/claude-wrap.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/claude-wrap.svg)](./LICENSE)

A client library for driving the **Claude Code** CLI from your own code. It has
two clients:

- **PTY client** (`ClaudeManager.spawn` / `ClaudeInstance`) — wraps the
  interactive `claude` terminal: spawn it headless or in a visible window,
  mirror its output into a virtual screen, read parsed state, subscribe to
  status events, send input. Use it to watch or take over a real session.
- **Print client** (`ClaudeManager.print` / `PrintSession`) — drives the
  official headless JSON protocol (`claude -p`): clean, cheap, structured,
  scriptable. Returns normalized turn results (text, structured output, tool
  calls, usage, cost). On top of it sits an **OpenAI-compatible chat gateway**
  (`ChatGateway` + the `claude-wrap-serve` HTTP server).

> Windows-first. The PTY uses ConPTY (windowed mode uses `cmd.exe start`); the
> print client spawns `claude` via `cmd /c` for a real stdin pipe. Other
> platforms work headlessly (`openWindow` falls back to headless).

## Install

```sh
npm install claude-wrap
```

Requires **Node ≥ 18** and the `claude` CLI on your `PATH`.

### Native dependency: `node-pty`

This package depends on [`node-pty`](https://github.com/microsoft/node-pty), a
native (node-gyp) addon. Installation downloads a prebuilt binary when one
matches your platform + Node ABI; otherwise it compiles from source and needs a
C/C++ toolchain:

- **Windows** — the "Desktop development with C++" workload (Visual Studio
  Build Tools) and Python 3.
- **macOS** — Xcode Command Line Tools (`xcode-select --install`).
- **Linux** — `build-essential` (gcc/g++/make) and Python 3.

If `npm install` fails building `node-pty`, install the toolchain above and retry.

## Quickstart — PTY client `ask()`

```ts
import { ClaudeManager } from "claude-wrap";

const manager = new ClaudeManager();
const instance = manager.spawn({ cwd: process.cwd() });

// Send a prompt and wait until Claude goes idle. Returns the parsed state.
const state = await instance.ask("List the files in this repo.");

// `ask` may return with a pending permission prompt — handle it if present.
if (state.permissionPrompt) {
  instance.approve(); // or instance.deny()
}

// Read what's on screen (full scrollback, trailing blanks trimmed).
const snap = instance.snapshot({ clean: true });
console.log(snap.lines.join("\n"));

await instance.shutdown();
```

## Subscribe to events

```ts
instance.on("status:busy", () => console.log("working…"));
instance.on("status:idle", () => console.log("done"));
instance.on("permission:prompt", ({ prompt }) => console.log("needs:", prompt.title));
instance.on("tool:start", ({ tool, args }) => console.log("tool:", tool, args));
instance.on("todo:changed", ({ todoList }) => console.log("todos:", todoList));
```

All event names are in `ALL_SESSION_EVENTS`; payload types are keyed in
`SessionEvents`.

## Stream the display as it updates

Two headless-only push APIs follow the terminal live instead of polling:
`onData(cb)` delivers every raw PTY chunk (ANSI included) for a byte-for-byte
mirror, while the `screen:changed` event signals a redraw so you can pull clean
lines from `snapshot()`.

```ts
const stop = instance.onData((chunk) => process.stdout.write(chunk)); // raw bytes
instance.on("screen:changed", () => render(instance.snapshot({ clean: true }).lines));
```

## Open a visible window (Windows)

```ts
const win = manager.spawn({
  cwd: "C:\\my\\project",
  label: "my-project",
  openWindow: true,   // visible cmd.exe window the user can type into
  enablePipe: true,   // control channel for snapshots / input
  enableHttp: true,   // loopback HTTP bridge
});
```

The window registers itself in an on-disk instance registry, so a separate
process can discover and drive it:

```ts
import { listInstances, snapshot, write } from "claude-wrap";

const [entry] = listInstances();
if (entry) {
  const snap = await snapshot(entry.pipe, { clean: true });
  await write(entry.pipe, "hello\r");
}
```

## Forward events out-of-process — `EventSink`

When a wrapper runs in another process, attach an `EventSink` to forward its
events over a transport. The built-in `WebSocketEventSink` ships a generic JSON
wire format (`hello` / `event` / `exit` frames).

```ts
import { ClaudeManager, WebSocketEventSink } from "claude-wrap";

const manager = new ClaudeManager();
// `reportTo` builds the sink internally; or call inst.attachSink(...) explicitly.
manager.spawn({ cwd: process.cwd(), reportTo: "ws://127.0.0.1:8080" });
```

The wrapper binary reads the same URL from `--report-to` or the
`CLAUDE_WRAP_REPORT_URL` environment variable.

## Print client — structured `claude -p`

`ClaudeManager.print()` (or `new PrintSession(...)`) drives Claude through the
headless JSON protocol and returns a normalized `TurnResult` per turn — no
screen scraping.

```ts
import { ClaudeManager } from "claude-wrap";

const manager = new ClaudeManager();
const session = manager.print({ cwd: process.cwd(), isolate: true });

const r = await session.ask("Say hello in one word.");
console.log(r.text, r.usage, r.costUsd);

await session.shutdown();
```

- **Transports.** `persistent` (default) keeps one process alive for fast
  multi-turn with a warm prompt cache; `oneshot` (`transport: "oneshot"`) spawns
  a fresh process per turn. Memory carries across turns either way.
- **`isolate: true`** runs the cheap clean profile (no host MCP servers, tools,
  or plugins) — ~13× cheaper for plain chat.
- **Structured output.** Pass `jsonSchema` (or `ask(text, { schema })` in
  oneshot) and read `r.structuredOutput`.
- **Resume.** `{ resume: "<claude-session-uuid>" }` continues a prior session
  (cwd-scoped); the id is on `session.claudeSessionId` / `r.sessionId`.
- **Permissions.** Supply `canUseTool(call)` to approve/deny each tool live, or
  subscribe to the `permission:request` event. `session.interrupt()` cancels the
  in-flight turn.
- **In-process functions.** Pass `functions: [{ name, inputSchema, handler }]`
  and Claude can call your JavaScript directly (hosted as an in-process MCP
  server over the control protocol).

## OpenAI-compatible chat gateway

`ChatGateway` exposes an OpenAI-shaped client (isolated by default), and
`claude-wrap-serve` puts an HTTP server in front of it — point any OpenAI SDK at
`http://127.0.0.1:<port>/v1`.

```ts
import { ChatGateway } from "claude-wrap";

const chat = new ChatGateway();
const res = await chat.completions.create({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Describe rain in one line." }],
});
console.log(res.choices[0].message.content);
```

```sh
claude-wrap-serve            # listens on 127.0.0.1:4000 by default
# POST /v1/chat/completions (JSON or SSE), GET /v1/models, GET /health
```

Supports streaming (SSE), `response_format` (json schema / json object),
`max_tokens`, client-side function calling (`tools` → `tool_calls`), and three
history strategies — `replay` (stateless, default), `session` (pooled warm
session via `X-Claude-Session-Id`), and `diff` (auto-resume on an exact prefix
match). Errors use the OpenAI envelope.

## MCP server

[`claude-wrap-mcp`](../claude-wrap-mcp) exposes both clients to agents as MCP
tools: `claude_*` drive PTY sessions, `claudep_*` drive print sessions
(`claudep_spawn` / `claudep_ask` / `claudep_resume` / `claudep_resolve_permission` / …).

## Bins

| Bin | Purpose |
|---|---|
| `claude-wrap` | Launch a wrapped `claude` in a new terminal window |
| `claude-wrap-run` | The wrapper process (PTY + pipe + HTTP bridge) |
| `claude-wrap-inject` | CLI to snapshot/parse/drive a running instance over its pipe |
| `claude-wrap-serve` | OpenAI-compatible HTTP chat gateway (`/v1/chat/completions`) |

## Logging

Diagnostic logs are written to `claude-wrap.log` in the OS temp directory.
Override the path with the `CLAUDE_WRAP_LOG` environment variable.

## License

[MIT](./LICENSE) © Alex Kaffetzakis
