#!/usr/bin/env node
// claude-wrap: run `claude` inside a ConPTY, passthrough to the current terminal,
// mirror output into a virtual screen, and expose a named-pipe control channel.

import * as pty from "node-pty";
import * as fs from "fs";
import { StringDecoder } from "string_decoder";
import { VirtualScreen } from "./screen";
import { ControlServer, type ControlHandlers } from "./control";
import { HttpBridge } from "./http";
import { pipePath } from "./protocol";
import { log } from "./log";
import { registerInstance, unregisterInstance, makePipeName } from "./registry";
import { WebSocketEventSink } from "./sink";
import { ContinuousParser } from "./session-state";
import { createEmitter, type SessionEvents } from "./events";

/** Ctrl+] — quits the wrapper without disturbing Ctrl+C passthrough to claude. */
const QUIT_BYTE = 0x1d;

function main(): void {
  // Parse wrapper-specific flags (consumed here, not passed to claude)
  const rawArgs = process.argv.slice(2);
  let reportToArg: string | undefined;
  const promptFiles: string[] = [];
  const claudeArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--report-to" && i + 1 < rawArgs.length) {
      reportToArg = rawArgs[++i];
    } else if (rawArgs[i] === "--prompt-file" && i + 1 < rawArgs.length) {
      // Read prompt from temp file (avoids cmd.exe quoting issues with
      // long/multi-line prompts) and clean up the file.
      const pf = rawArgs[++i]!;
      try {
        const content = fs.readFileSync(pf, "utf8");
        claudeArgs.push(content);
        promptFiles.push(pf);
      } catch (e) {
        log(`[wrap] failed to read prompt file ${pf}: ${(e as Error).message}`);
      }
    } else {
      claudeArgs.push(rawArgs[i]!);
    }
  }
  // Clean up prompt temp files
  for (const pf of promptFiles) {
    try { fs.unlinkSync(pf); } catch { /* ignore */ }
  }

  // Pipe name resolution:
  //  1. CLAUDE_WRAP_PIPE from env (set by the launcher per instance).
  //  2. Otherwise mint a fresh unique name so standalone `wrapper` runs
  //     never collide with an existing instance.
  const pipeName = process.env["CLAUDE_WRAP_PIPE"] ?? makePipeName();
  const path = pipePath(pipeName);
  process.env["CLAUDE_WRAP_PIPE"] = pipeName;

  let cols = process.stdout.columns ?? 120;
  let rows = process.stdout.rows ?? 30;

  const screen = new VirtualScreen(cols, rows);

  const shell = process.env["ComSpec"] ?? "cmd.exe";
  const args = ["/c", "claude", ...claudeArgs];

  const child = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "3" },
    useConpty: true,
  });
  log(`[wrap] spawned pid=${child.pid} ${shell} ${args.join(" ")}`);

  // PTY -> real terminal + virtual screen
  child.onData((data) => {
    process.stdout.write(data);
    screen.write(data);
  });

  // Event emitter + parser (detects busy/idle/permission/tool/todo events)
  const emitter = createEmitter<SessionEvents>();
  const instanceId = process.env["CLAUDE_WRAP_ID"] ?? `wrap-${process.pid}`;
  const parser = new ContinuousParser(screen, emitter, instanceId);

  // Out-of-process event sink. Report URL comes from the --report-to flag or
  // the CLAUDE_WRAP_REPORT_URL env var; no implicit discovery.
  const reportUrl = reportToArg ?? process.env["CLAUDE_WRAP_REPORT_URL"];
  const wrapLabel = process.env["CLAUDE_WRAP_LABEL"];
  let sink: WebSocketEventSink | null = null;
  if (reportUrl) {
    sink = new WebSocketEventSink(reportUrl);
    sink.attach(emitter, {
      id: instanceId,
      pid: process.pid,
      cwd: process.cwd(),
      ...(wrapLabel !== undefined ? { label: wrapLabel } : {}),
    });
    log(`[wrap] reporting to ${reportUrl}`);
  }

  // StringDecoder buffers partial multi-byte UTF-8 sequences so they
  // don't get corrupted when a character is split across two reads.
  const stdinDecoder = new StringDecoder("utf8");
  const injectDecoder = new StringDecoder("utf8");

  // Shared handlers used by both the named-pipe and HTTP transports.
  const handlers: ControlHandlers = {
    onWrite: (bytes) => child.write(injectDecoder.write(bytes)),
    onSnapshot: (viewportOnly, clean) => screen.snapshot(viewportOnly, clean),
    onResize: (c, r) => {
      cols = c;
      rows = r;
      child.resize(c, r);
      screen.resize(c, r);
    },
  };

  // Pipe transport
  const control = new ControlServer(path, handlers);

  // HTTP bridge (loopback only). Ephemeral port unless overridden.
  const httpPortEnv = Number(process.env["CLAUDE_WRAP_HTTP_PORT"] ?? "0");
  const httpBridge = new HttpBridge(handlers, { pid: process.pid, pipe: pipeName });
  let httpPort: number | null = null;

  // Hoisted above Promise.all so the .then() below can check whether
  // cleanup() already ran (e.g., child process exited while we were
  // still waiting for listen() to resolve).
  let cleaned = false;

  const pipeListen = control.listen();
  const httpListen = httpBridge
    .listen(Number.isFinite(httpPortEnv) ? httpPortEnv : 0)
    .then((info) => {
      httpPort = info.port;
    });

  Promise.all([pipeListen, httpListen]).then(
    () => {
      // If the child died before both transports came up, don't
      // register a ghost entry that points at a closed pipe.
      if (cleaned) {
        try { control.close(); } catch { /* ignore */ }
        try { httpBridge.close(); } catch { /* ignore */ }
        return;
      }
      const base = {
        pipe: pipeName,
        pid: process.pid,
        cwd: process.cwd(),
        title: "Claude (wrapped)",
        startedAt: new Date().toISOString(),
      };
      const label = process.env["CLAUDE_WRAP_LABEL"];
      const withLabel = label ? { ...base, label } : base;
      const entry = httpPort ? { ...withLabel, httpPort } : withLabel;
      registerInstance(entry);
      // Update sink with the now-known HTTP port
      if (sink && httpPort) sink.setHttpPort(httpPort);
      log(`[wrap] registered instance pipe=${pipeName} http=${httpPort}`);
    },
    (err) => {
      // If one transport bound but the other failed, tear down the
      // successful half so we don't leave a half-functional instance
      // with no registry entry for clients to discover.
      log("[control] listen failed", err);
      pipeListen.then(() => control.close(), () => {});
      httpListen.then(() => httpBridge.close(), () => {});
      process.exitCode = 1;
      try { child.kill(); } catch { /* ignore */ }
    },
  );

  // Real terminal input -> PTY
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf: Buffer) => {
    if (buf.length === 1 && buf[0] === QUIT_BYTE) {
      log("[wrap] quit byte received");
      cleanup();
      process.exit(0);
    }
    // Buffer partial UTF-8 sequences across reads so multi-byte paste
    // never gets decoded into replacement chars.
    child.write(stdinDecoder.write(buf));
  });

  // Resize
  process.stdout.on("resize", () => {
    cols = process.stdout.columns ?? cols;
    rows = process.stdout.rows ?? rows;
    try { child.resize(cols, rows); } catch { /* ignore */ }
    try { screen.resize(cols, rows); } catch { /* ignore */ }
  });

  // Lifecycle (`cleaned` is declared above so the Promise.all success
  // branch can consult it before registering a ghost instance.)
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
    parser.flush();
    parser.dispose();
    if (sink) { sink.close(); sink = null; }
    control.close();
    try { httpBridge.close(); } catch { /* ignore */ }
    try { unregisterInstance(pipeName); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }

  child.onExit(({ exitCode }) => {
    log(`[wrap] child exit ${exitCode}`);
    cleanup();
    process.exit(exitCode ?? 0);
  });
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
}

main();
