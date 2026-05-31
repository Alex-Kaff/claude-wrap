# claude-wrap

A client library for wrapping the **Claude Code** CLI window. Spawn `claude`
headless (in an in-process PTY) or open a visible terminal window, mirror its
output into a virtual screen, read parsed session state, subscribe to status
changes, and send input — in-process or to out-of-process instances over a
named pipe / loopback HTTP.

> Windows-first. The headless PTY uses ConPTY; the windowed mode uses
> `cmd.exe start`. Other platforms work headlessly via `node-pty`
> (`openWindow` is ignored off Windows and falls back to headless).

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

## Quickstart — headless `ask()`

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

Two push APIs let you follow the terminal live instead of polling `snapshot()`.
Both are **headless-only** (in windowed mode the PTY runs in the wrapper
process, so neither fires).

**Raw bytes — `onData(cb)`.** The truest live stream: every PTY output chunk,
verbatim, including ANSI escape codes. Best for piping to your own terminal /
xterm renderer.

```ts
const stop = instance.onData((chunk) => process.stdout.write(chunk));
// …later: stop();  // unsubscribe
```

**Rendered lines — `screen:changed` + `snapshot()`.** Fires (undebounced) on
every screen redraw and hands you a signal; pull the current clean lines in the
handler. Best when you want parsed/renderable text rather than escape codes.
(Unlike the debounced `state:changed`, this reflects cosmetic redraws too.)

```ts
instance.on("screen:changed", () => {
  const { lines } = instance.snapshot({ clean: true });
  render(lines);
});
```

Pick `onData` for a faithful byte-for-byte mirror; pick `screen:changed` when
you only need "the visible text changed, give me the new lines".

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

When a wrapper runs in another process you can't call `.on()` on it. Attach an
`EventSink` to forward its events over a transport. The built-in
`WebSocketEventSink` ships a generic JSON wire format:

```
{ kind: "hello", instance, pid, cwd, label?, httpPort? }
{ kind: "event", instance, event: <SessionEvents key>, payload }
{ kind: "exit",  instance, exitCode }
```

```ts
import { ClaudeManager, WebSocketEventSink } from "claude-wrap";

const manager = new ClaudeManager();
manager.spawn({
  cwd: process.cwd(),
  reportTo: "ws://127.0.0.1:8080", // builds a WebSocketEventSink internally
});

// …or attach one explicitly:
const inst = manager.spawn({ cwd: process.cwd() });
inst.attachSink(new WebSocketEventSink("ws://127.0.0.1:8080", { idleDebounceMs: 2500 }));
```

The wrapper binary reads the same URL from the `--report-to` flag or the
`CLAUDE_WRAP_REPORT_URL` environment variable.

## Bins

| Bin | Purpose |
|---|---|
| `claude-wrap` | Launch a wrapped `claude` in a new terminal window |
| `claude-wrap-run` | The wrapper process (PTY + pipe + HTTP bridge) |
| `claude-wrap-inject` | CLI to snapshot/parse/drive a running instance over its pipe |

## Logging

Diagnostic logs are written to `claude-wrap.log` in the OS temp directory.
Override the path with the `CLAUDE_WRAP_LOG` environment variable.

## License

[MIT](./LICENSE) © Alex Kaffetzakis
