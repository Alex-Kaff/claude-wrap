// ClaudeInstance: owns a PTY, VirtualScreen, ContinuousParser, and
// optionally a ControlServer + HttpBridge for a single Claude Code session.

import * as pty from "node-pty";
import * as fs from "fs";
import * as os from "os";
import { spawn as cpSpawn } from "child_process";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { VirtualScreen } from "./screen";
import { ControlServer, type ControlHandlers } from "./control";
import { HttpBridge } from "./http";
import { pipePath } from "./protocol";
import { makePipeName, registerInstance, unregisterInstance } from "./registry";
import { WebSocketEventSink, type EventSink, type InstanceInfo } from "./sink";
import { ContinuousParser } from "./session-state";
import type { SessionState } from "./session-state";
import type { ScreenSnapshot } from "./screen";
import { createEmitter, type TypedEmitter, type SessionEvents } from "./events";
import type { ManagedSession } from "./managed";
import { TimeoutError } from "./errors";
import { childEnv } from "./child-env";
import { WAIT_IDLE_TIMEOUT_MS, ASK_SETTLE_TIMEOUT_MS, SUBMIT_DELAY_MS } from "./config";
import type { PermissionPrompt } from "./parse";
import { KEYS } from "./keys";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
import { quoteCmdArg } from "./cmd-quote";

// ---------------------------------------------------------------------------
// SpawnOptions
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  /** Working directory for the Claude process. */
  cwd?: string;
  /** Extra CLI args after `claude`. */
  args?: string[];
  /** Human label for this instance. */
  label?: string;
  /** Terminal size. */
  cols?: number;
  rows?: number;
  /** Whether to start the named-pipe control server (for external clients). */
  enablePipe?: boolean;
  /** Whether to start the HTTP bridge. */
  enableHttp?: boolean;
  /** Custom pipe name. Auto-generated if omitted. */
  pipeName?: string;
  /** Whether to mirror output to the current process stdout. */
  passthrough?: boolean;
  /** Out-of-process event sinks to attach (headless mode). In-process consumers
   *  usually don't need these — subscribe directly with `.on()`. */
  sinks?: EventSink[];
  /** WebSocket URL to forward events to. In headless mode this builds a
   *  WebSocketEventSink; in windowed mode it is passed to the wrapper via
   *  `--report-to` (the wrapper builds the sink in its own process). */
  reportTo?: string;
  /** Open a visible terminal window (Windows: cmd.exe start) running the wrapper
   *  instead of a headless ConPTY. The user can interact with Claude directly.
   *  The wrapper handles PTY + pipe + HTTP bridge + event sink internally. */
  openWindow?: boolean;
}

// ---------------------------------------------------------------------------
// ClaudeInstance
// ---------------------------------------------------------------------------

let instanceCounter = 0;

export class ClaudeInstance implements ManagedSession {
  readonly id: string;
  readonly label: string;
  readonly kind = "pty" as const;
  readonly pipeName: string;
  readonly emitter: TypedEmitter<SessionEvents>;

  private child: pty.IPty | null = null;
  private windowPid: number | null = null;
  private screen: VirtualScreen;
  private parser: ContinuousParser | null = null;
  private control: ControlServer | null = null;
  private http: HttpBridge | null = null;
  private sinks: EventSink[] = [];
  private _alive = true;
  private injectDecoder = new StringDecoder("utf8");
  private _cwd: string;
  private _httpPort: number | undefined;
  /** Raw PTY byte-stream listeners (headless mode), see onData(). */
  private dataListeners = new Set<(data: string) => void>();
  /** Unsubscribe for the undebounced screen:changed forwarding. */
  private unsubScreenChanged: (() => void) | null = null;

  constructor(opts: SpawnOptions = {}) {
    instanceCounter++;
    this.id = `claude-${instanceCounter}-${Math.random().toString(36).slice(2, 8)}`;
    this.label = opts.label ?? `instance-${instanceCounter}`;
    this.pipeName = opts.pipeName ?? makePipeName();
    this.emitter = createEmitter<SessionEvents>();

    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;
    const cwd = opts.cwd ?? process.cwd();
    this._cwd = cwd;

    // Virtual screen (used even in window mode for snapshots via pipe)
    this.screen = new VirtualScreen(cols, rows);

    if (opts.openWindow && process.platform === "win32") {
      // --- Windowed mode: launch wrapper.js in a visible cmd.exe window ---
      // The wrapper handles PTY + screen + pipe + HTTP bridge + event sink.
      // This instance becomes a thin handle for tracking and destruction.
      this.spawnWindow(opts, cwd);
    } else {
      // --- Headless mode: direct PTY in-process ---
      this.spawnHeadless(opts, cwd, cols, rows);
    }
  }

  /** Spawn wrapper.js in a visible terminal window. */
  private spawnWindow(opts: SpawnOptions, cwd: string): void {
    const wrapperJs = path.join(__dirname, "wrapper.js");
    const nodeBin = process.execPath;

    // Build the wrapper command line.
    // Long/multi-line prompts can't survive cmd.exe quoting, so we write
    // them to a temp file and pass the path instead.
    const wrapArgs: string[] = [];
    if (opts.reportTo) {
      wrapArgs.push("--report-to", opts.reportTo);
    }

    const rawCliArgs = opts.args ?? [];
    const promptFiles: string[] = []; // track for cleanup on failure
    const safeArgs: string[] = [];
    for (const arg of rawCliArgs) {
      // If an arg contains newlines or is very long, it's a prompt — write to temp file
      if (arg.includes("\n") || arg.length > 500) {
        const tmpFile = path.join(
          os.tmpdir(),
          `claude-wrap-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
        );
        fs.writeFileSync(tmpFile, arg, "utf8");
        promptFiles.push(tmpFile);
        wrapArgs.push("--prompt-file", tmpFile);
      } else {
        safeArgs.push(arg);
      }
    }
    wrapArgs.push(...safeArgs);

    // Quote for cmd.exe
    const cmdLine = `${quoteCmdArg(nodeBin)} ${quoteCmdArg(wrapperJs)} ${wrapArgs.map(quoteCmdArg).join(" ")}`;
    const title = this.label || "Claude (workflow)";

    // Strip the parent's Claude Code / IDE-integration env so the windowed
    // child doesn't hijack the launching agent's IDE connection or session.
    const env = childEnv({
      CLAUDE_WRAP_PIPE: this.pipeName,
      CLAUDE_WRAP_LABEL: this.label,
      CLAUDE_WRAP_ID: this.id,
    });

    const proc = cpSpawn("cmd.exe", ["/c", "start", `"${title}"`, "cmd", "/k", cmdLine], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    });
    this.windowPid = proc.pid ?? null;
    proc.unref();

    // The wrapper deletes prompt files after reading them.
    // Safety net: clean up after a short delay in case the spawn failed
    // and wrapper never ran.
    if (promptFiles.length > 0) {
      setTimeout(() => {
        for (const f of promptFiles) {
          try {
            fs.unlinkSync(f);
          } catch {
            /* already deleted by wrapper or missing */
          }
        }
      }, 30_000);
    }
  }

  /** Spawn claude headlessly via node-pty (original behavior). */
  private spawnHeadless(opts: SpawnOptions, cwd: string, cols: number, rows: number): void {
    const isWindows = process.platform === "win32";
    const spawnFile = isWindows ? (process.env["ComSpec"] ?? "cmd.exe") : "claude";
    const spawnArgs = isWindows ? ["/c", "claude", ...(opts.args ?? [])] : [...(opts.args ?? [])];

    this.child = pty.spawn(spawnFile, spawnArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // childEnv strips the parent's Claude Code / IDE-integration vars so a
      // headless child doesn't auto-connect to the launching agent's IDE.
      env: childEnv({ TERM: "xterm-256color", FORCE_COLOR: "3" }) as Record<string, string>,
      ...(isWindows ? { useConpty: true } : {}),
    });

    // PTY data -> screen (+ optional passthrough + raw onData listeners)
    this.child.onData((data) => {
      if (opts.passthrough) {
        try {
          process.stdout.write(data);
        } catch {
          /* ignore */
        }
      }
      this.screen.write(data);
      // Fan out the raw chunk to onData() subscribers. Iterate a copy so a
      // listener that unsubscribes mid-emit doesn't disturb iteration.
      if (this.dataListeners.size > 0) {
        for (const cb of [...this.dataListeners]) {
          try {
            cb(data);
          } catch {
            /* listener errors are non-fatal */
          }
        }
      }
    });

    // Continuous parser (hooks into screen.onChange, debounced)
    this.parser = new ContinuousParser(this.screen, this.emitter, this.id);

    // Undebounced screen:changed signal — fires on every screen mutation so
    // consumers can stream the display (call snapshot() in the handler).
    // Separate from the parser's own debounced onChange subscription.
    this.unsubScreenChanged = this.screen.onChange(() => {
      this.emitter.emit("screen:changed", { instance: this.id });
    });

    // Process exit — emit before cleanup so the event sink can forward the exit message
    this.child.onExit(({ exitCode }) => {
      if (this.parser) {
        this.parser.flush();
        this.parser.dispose();
      }
      this.emitter.emit("process:exit", {
        instance: this.id,
        exitCode: exitCode ?? null,
      });
      this.cleanup();
    });

    // Optional control server + HTTP bridge
    if (opts.enablePipe || opts.enableHttp) {
      const handlers: ControlHandlers = {
        onWrite: (bytes) => this.child!.write(this.injectDecoder.write(bytes)),
        onSnapshot: (viewportOnly, clean, colors) =>
          this.screen.snapshot(viewportOnly, clean, colors),
        onResize: (c, r) => {
          this.child!.resize(c, r);
          this.screen.resize(c, r);
        },
      };

      if (opts.enablePipe) {
        const pipePth = pipePath(this.pipeName);
        this.control = new ControlServer(pipePth, handlers);
        this.control.listen().catch(() => {
          /* best effort */
        });
      }

      if (opts.enableHttp) {
        this.http = new HttpBridge(handlers, { pid: this.pid, pipe: this.pipeName });
        this.http
          .listen(0)
          .then((info) => {
            // If the instance was torn down before listen() resolved, don't
            // register a ghost entry pointing at a closing bridge.
            if (!this._alive) {
              this.http?.close();
              return;
            }
            registerInstance({
              pipe: this.pipeName,
              pid: this.pid,
              cwd,
              title: "Claude (managed)",
              label: this.label,
              httpPort: info.port,
              startedAt: new Date().toISOString(),
            });
            this._httpPort = info.port;
            for (const s of this.sinks) s.setHttpPort?.(info.port);
          })
          .catch(() => {
            /* best effort */
          });
      } else if (opts.enablePipe) {
        registerInstance({
          pipe: this.pipeName,
          pid: this.pid,
          cwd,
          title: "Claude (managed)",
          label: this.label,
          startedAt: new Date().toISOString(),
        });
      }
    }

    // Attach event sinks (out-of-process forwarding). Caller-supplied sinks
    // plus, if a report URL was given, a built-in WebSocketEventSink.
    for (const sink of opts.sinks ?? []) this.attachSink(sink);
    if (opts.reportTo) this.attachSink(new WebSocketEventSink(opts.reportTo));
  }

  /** Attach an EventSink that forwards this instance's events out-of-process. */
  attachSink(sink: EventSink): void {
    this.sinks.push(sink);
    const info: InstanceInfo = {
      id: this.id,
      pid: this.pid,
      cwd: this._cwd,
      label: this.label,
      ...(this._httpPort !== undefined ? { httpPort: this._httpPort } : {}),
    };
    sink.attach(this.emitter, info);
  }

  // --- State access ---

  get state(): Readonly<SessionState> {
    if (!this.parser) throw new Error("state not available in windowed mode");
    return this.parser.current;
  }
  get alive(): boolean {
    return this._alive;
  }
  get cwd(): string {
    return this._cwd;
  }
  get pid(): number {
    return this.child?.pid ?? this.windowPid ?? 0;
  }
  get isWindowed(): boolean {
    return this.child === null;
  }

  // --- Input ---

  send(text: string): void {
    if (!this._alive) return;
    if (!this.child) return; // windowed mode — input goes through the visible window
    this.child.write(text);
  }

  sendKey(name: string): void {
    const seq = KEYS[name];
    if (!seq) {
      throw new Error(`unknown key: ${name}. Valid keys: ${Object.keys(KEYS).join(", ")}`);
    }
    this.send(seq);
  }

  /**
   * Type text and submit it with Enter. The text and the Enter are sent as
   * separate PTY writes with a short gap (SUBMIT_DELAY_MS) so the TUI commits
   * the typed text before Enter fires — sending them together lets Enter race
   * ahead and the line is typed but never submitted.
   */
  sendLine(text: string): void {
    if (!this._alive || !this.child) return;
    this.send(text);
    setTimeout(() => {
      if (this._alive) this.send("\r");
    }, SUBMIT_DELAY_MS);
  }

  // --- High-level actions ---

  /**
   * Choose a numbered option in the on-screen prompt. Sends the option's
   * digit, then (after a gap) Enter, as separate writes. Pressing the digit
   * highlights/activates the option; the follow-up Enter confirms it if the
   * digit alone didn't, and is a harmless no-op on an empty input box if it
   * did. Async so callers can await the keystrokes landing.
   */
  private async chooseOption(key: string): Promise<void> {
    this.send(key);
    await delay(SUBMIT_DELAY_MS);
    if (this._alive) this.send("\r");
  }

  async approve(): Promise<void> {
    const perm = this.state.permissionPrompt;
    if (!perm || perm.options.length === 0) {
      throw new Error("no permission prompt on screen");
    }
    await this.chooseOption(perm.options[0]!.key);
  }

  async deny(): Promise<void> {
    const perm = this.state.permissionPrompt;
    if (!perm || perm.options.length === 0) {
      throw new Error("no permission prompt on screen");
    }
    await this.chooseOption(perm.options[perm.options.length - 1]!.key);
  }

  /**
   * Send a prompt and wait until Claude is idle. Returns parsed state.
   *
   * May return with a pending permission prompt if Claude requests
   * permission mid-response. Callers should check `result.permissionPrompt`.
   *
   * Throws TimeoutError if Claude never starts processing within
   * ASK_SETTLE_TIMEOUT_MS and `strict` is true (default false).
   */
  async ask(
    text: string,
    opts?: {
      timeoutMs?: number;
      /** If true, throw when Claude never becomes busy after sending. Default false. */
      strict?: boolean;
    },
  ): Promise<Readonly<SessionState>> {
    // Type the prompt, then submit with a separate Enter after a short gap so
    // the TUI has committed the text (see sendLine). If Claude doesn't start
    // working, the Enter likely raced — retry it once before giving up. This
    // removes the "typed but never submitted" flakiness.
    this.send(text);
    await delay(SUBMIT_DELAY_MS);
    if (this._alive) this.send("\r");

    let becameBusy = await this.waitBusy({ timeoutMs: ASK_SETTLE_TIMEOUT_MS });
    if (!becameBusy && this._alive && this.state.permissionPrompt === null) {
      // Retry the submit once — the first Enter may have fired before the
      // text committed, or before the input box was focused.
      this.send("\r");
      becameBusy = await this.waitBusy({ timeoutMs: ASK_SETTLE_TIMEOUT_MS });
    }

    if (!becameBusy && opts?.strict) {
      throw new TimeoutError(
        `ask: Claude did not start processing within ${2 * ASK_SETTLE_TIMEOUT_MS}ms`,
      );
    }
    if (becameBusy) {
      await this.waitIdle(opts);
    }
    return this.state;
  }

  /**
   * Promise that resolves when Claude transitions to idle.
   * Subscribe-then-check pattern to avoid TOCTOU race.
   */
  waitIdle(opts?: { timeoutMs?: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? WAIT_IDLE_TIMEOUT_MS;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsub();
        unsubPerm();
        resolve();
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        unsubPerm();
        reject(new TimeoutError(`waitIdle: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsub = this.emitter.on("status:idle", done);
      const unsubPerm = this.emitter.on("permission:prompt", done);

      // Check AFTER subscribing to close the race window
      if (!this.state.status.busy || this.state.permissionPrompt !== null) {
        done();
      }
    });
  }

  /** Resolves to true if Claude became busy, false if timed out. */
  private waitBusy(opts?: { timeoutMs?: number }): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutMs = opts?.timeoutMs ?? ASK_SETTLE_TIMEOUT_MS;
      let settled = false;
      const done = (becameBusy: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsub();
        resolve(becameBusy);
      };

      const timeout = setTimeout(() => done(false), timeoutMs);
      const unsub = this.emitter.on("status:busy", () => done(true));
      if (this.state.status.busy) done(true);
    });
  }

  /** Promise that resolves when a permission prompt appears. */
  waitPermission(opts?: { timeoutMs?: number }): Promise<PermissionPrompt> {
    return new Promise((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? WAIT_IDLE_TIMEOUT_MS;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        unsubExit();
        reject(new TimeoutError(`waitPermission: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsub = this.emitter.on("permission:prompt", ({ prompt }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsub();
        unsubExit();
        resolve(prompt);
      });

      const unsubExit = this.emitter.on("process:exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsub();
        unsubExit();
        reject(new Error("process exited while waiting for permission prompt"));
      });

      // Check AFTER subscribing
      if (this.state.permissionPrompt) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsub();
        unsubExit();
        resolve(this.state.permissionPrompt);
      }
    });
  }

  // --- Screen ---

  snapshot(opts?: { viewport?: boolean; clean?: boolean; colors?: boolean }): ScreenSnapshot {
    return this.screen.snapshot(opts?.viewport ?? false, opts?.clean ?? false, opts?.colors ?? false);
  }

  resize(cols: number, rows: number): void {
    if (this.child) {
      try {
        this.child.resize(cols, rows);
      } catch {
        /* ignore */
      }
    }
    this.screen.resize(cols, rows);
    if (this.parser) this.parser.flush();
  }

  // --- Events ---

  on<K extends keyof SessionEvents>(
    event: K,
    handler: (payload: SessionEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  /** Normalized exit subscription (ManagedSession). Returns an unsubscribe fn. */
  onExit(handler: (code: number | null) => void): () => void {
    return this.emitter.on("process:exit", ({ exitCode }) => handler(exitCode));
  }

  /**
   * Subscribe to the raw PTY byte stream as it arrives — the truest "stream
   * the display as it updates". Each call delivers an output chunk verbatim,
   * including ANSI escape sequences (not cleaned lines). For rendered lines,
   * use the `screen:changed` event and call `snapshot()` in the handler.
   *
   * Headless instances only — in windowed mode the PTY lives in the wrapper
   * process, so this never fires.
   *
   * Returns an unsubscribe function.
   */
  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => {
      this.dataListeners.delete(cb);
    };
  }

  // --- Lifecycle ---

  /** Idempotent cleanup of control server, HTTP bridge, and registry. */
  private cleanup(): void {
    if (this.control) {
      this.control.close();
      this.control = null;
    }
    if (this.http) {
      this.http.close();
      this.http = null;
    }
    for (const s of this.sinks) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.sinks = [];
    if (this.unsubScreenChanged) {
      this.unsubScreenChanged();
      this.unsubScreenChanged = null;
    }
    this.dataListeners.clear();
    try {
      unregisterInstance(this.pipeName);
    } catch {
      /* ignore */
    }
    this._alive = false;
  }

  /** Tear down the instance. Idempotent — safe to call after natural exit. */
  destroy(): void {
    if (this.parser) {
      this.parser.flush();
      this.parser.dispose();
    }
    this.cleanup();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    } else if (this.windowPid) {
      // Windowed mode: kill the cmd.exe process tree
      try {
        process.kill(this.windowPid);
      } catch {
        /* ignore */
      }
      try {
        cpSpawn("taskkill", ["/F", "/T", "/PID", String(this.windowPid)], {
          stdio: "ignore",
        }).unref();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Graceful shutdown: destroy + wait for process:exit.
   * Resolves immediately if the process has already exited.
   */
  async shutdown(opts?: { timeoutMs?: number }): Promise<void> {
    if (!this._alive) {
      this.destroy(); // idempotent cleanup of any leftover resources
      return;
    }
    const exitPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        unsub();
        resolve();
      }, opts?.timeoutMs ?? 10_000);
      const unsub = this.emitter.on("process:exit", () => {
        clearTimeout(timeout);
        unsub();
        resolve();
      });
    });
    this.destroy();
    await exitPromise;
  }
}
