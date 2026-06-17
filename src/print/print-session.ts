// PrintSession: the structured-JSON (`claude -p`) client. Mirror of the PTY
// ClaudeInstance, but it drives Claude through the official headless protocol
// (stream-json over stdin/stdout) instead of screen-scraping a ConPTY.
//
// Two transports behind one API (§2.1):
//  - persistent: one long-lived `claude -p --input-format stream-json
//    --output-format stream-json --verbose`; ask() writes a user line and
//    resolves on the matching `result`. Memory + prompt-cache carry across
//    turns. With `warm` (default), it eager-spawns and runs a priming turn so
//    the toolset/cache are warm before the first real ask (§12-D4/D5).
//  - oneshot: each ask() spawns `claude -p "<prompt>" --output-format json
//    [--resume <id>]`, collects stdout, parses the array. Stateless/robust;
//    `--resume` makes it stateful-by-id.

import { spawn as cpSpawn, type ChildProcess } from "child_process";
import { childEnv } from "../child-env";
import { log } from "../log";
import { registerInstance, unregisterInstance } from "../registry";
import { createEmitter, type TypedEmitter } from "../events";
import {
  MalformedStreamError,
  ProcessExitError,
  TurnTimeoutError,
  NotSupportedError,
} from "../errors";
import { quoteCmdArg } from "../cmd-quote";
import type { ManagedSession } from "../managed";
import {
  ALL_PRINT_EVENTS,
  type PrintEvent,
  type PrintEvents,
} from "./print-events";
import {
  isAssistant,
  isControlRequest,
  isControlResponse,
  isInit,
  isRateLimitEvent,
  isResult,
  isStreamEvent,
  isThinkingTokens,
  isUser,
  isTestedCliVersion,
  TESTED_CLI_VERSIONS,
  blockIsText,
  blockIsThinking,
  blockIsToolUse,
  type ContentBlock,
  type ControlRequestMessage,
  type ControlResponseMessage,
  type InitMessage,
  type ProtoMessage,
} from "./proto";
import { NdjsonReader, parseJsonArray } from "./ndjson";
import { TurnAccumulator, collectTurn, type TurnResult } from "./turn";
import { buildArgs, type PrintOptions, type Transport } from "./args";
import { ControlChannel, type PermissionResult, type PermissionToolCall } from "./control";
import { McpControlBridge } from "./mcp-bridge";

/** Default per-turn timeout (§12-D6). */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/** Priming prompt for warm persistent sessions (§12-D4/D5). Intentionally tiny. */
const PRIMING_PROMPT = "Reply with the single word: ready";

/** Cap on captured stderr so a noisy child can't balloon memory. */
const STDERR_CAP = 64 * 1024;

export interface AskOptions {
  timeoutMs?: number;
  /** Per-turn JSON schema (oneshot only; persistent must set jsonSchema at construction). */
  schema?: object;
}

export interface PrintSessionOptions extends PrintOptions {
  /** Warm the session on construction (eager spawn + priming turn). Persistent only; default true. */
  warm?: boolean;
}

interface ActiveTurn {
  acc: TurnAccumulator;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  schemaRequested: boolean;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

let printCounter = 0;

export class PrintSession implements ManagedSession {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly kind = "print" as const;
  /** Synthetic registry/pipe key (print sessions open no real pipe). */
  readonly pipeName: string;
  readonly emitter: TypedEmitter<PrintEvents>;

  private readonly opts: PrintSessionOptions;
  private readonly transport: Transport;
  private readonly warm: boolean;

  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private control: ControlChannel | null = null;
  private readonly mcpBridge: McpControlBridge | null;
  private activeTurn: ActiveTurn | null = null;
  private turnLock: Promise<unknown> = Promise.resolve();
  private _sessionId: string | null = null;
  private _lastResult: TurnResult | null = null;
  private _alive = true;
  private _destroyed = false;
  private _exitEmitted = false;
  private versionChecked = false;
  private stderrBuf = "";
  /** When set, the next persistent spawn resumes this session (timeout recovery, §12-D6). */
  private pendingResume: string | null = null;
  private readonly _ready: Promise<void>;

  constructor(opts: PrintSessionOptions = {}) {
    printCounter++;
    this.id = `print-${printCounter}-${Math.random().toString(36).slice(2, 8)}`;
    this.label = opts.label ?? `print-${printCounter}`;
    this.cwd = opts.cwd ?? process.cwd();
    this.pipeName = `print:${this.id}`;
    this.emitter = createEmitter<PrintEvents>();
    this.opts = opts;
    this.transport = opts.transport ?? "persistent";
    this.warm = opts.warm ?? true;
    this.mcpBridge =
      opts.functions && opts.functions.length > 0
        ? new McpControlBridge(opts.functionServerName ?? "cw_fns", opts.functions)
        : null;
    this._ready = this.init();
  }

  // --- public getters ---

  get sessionId(): string | null {
    return this._sessionId;
  }
  /** The Claude session UUID — alias of sessionId, for callers that disambiguate from a wrap id. */
  get claudeSessionId(): string | null {
    return this._sessionId;
  }
  get alive(): boolean {
    return this._alive;
  }
  get lastResult(): TurnResult | null {
    return this._lastResult;
  }
  /** Resolves once the session is usable (warm sessions: after the priming turn). */
  ready(): Promise<void> {
    return this._ready;
  }

  // --- lifecycle bootstrap ---

  private async init(): Promise<void> {
    if (this.transport === "persistent" && this.warm) {
      // Eager spawn + priming turn: avoids the 3s no-stdin self-exit and warms
      // the toolset/cache before the first real ask.
      try {
        await this.runTurn([{ type: "text", text: PRIMING_PROMPT }], {});
      } catch (err) {
        // A failed warm-up shouldn't wedge the session permanently; surface it
        // but let a later ask() retry a fresh spawn.
        log("[print] warm-up turn failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // --- input ---

  /**
   * Send a turn and resolve with the normalized TurnResult. Turns are
   * serialized per session (one in-flight turn); overlapping calls queue.
   */
  ask(text: string | ContentBlock[], opts?: AskOptions): Promise<TurnResult> {
    const content = typeof text === "string" ? [{ type: "text", text } as ContentBlock] : text;
    // Chain onto the turn lock so only one turn runs at a time.
    const run = this.turnLock.then(
      () => this.runTurn(content, opts),
      () => this.runTurn(content, opts),
    );
    // Keep the lock chained regardless of this turn's outcome.
    this.turnLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private runTurn(content: ContentBlock[], opts?: AskOptions): Promise<TurnResult> {
    if (this._destroyed || !this._alive) {
      return Promise.reject(new ProcessExitError("print session is not alive", null, this.stderrBuf));
    }
    return this.transport === "persistent"
      ? this.runPersistentTurn(content, opts)
      : this.runOneshotTurn(content, opts);
  }

  // --- persistent transport ---

  private runPersistentTurn(content: ContentBlock[], opts?: AskOptions): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.ensurePersistentChild();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const schemaRequested = (opts?.schema ?? this.opts.jsonSchema) !== undefined;
      if (opts?.schema !== undefined && this.opts.jsonSchema === undefined) {
        log(
          "[print] per-ask schema is not injectable mid-persistent-session; set jsonSchema at construction or use the oneshot transport",
        );
      }
      const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const turn: ActiveTurn = {
        acc: new TurnAccumulator(),
        resolve,
        reject,
        schemaRequested,
        timeoutMs,
        timer: null,
        settled: false,
      };
      turn.timer = setTimeout(() => this.onTurnTimeout(turn), timeoutMs);
      this.activeTurn = turn;

      try {
        child.stdin?.write(this.userLine(content));
      } catch (err) {
        this.failTurn(turn, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private ensurePersistentChild(): ChildProcess {
    if (this.child) return this.child;
    const resume = this.pendingResume ?? this.opts.resume;
    const merged: PrintOptions = { ...this.opts };
    if (resume) merged.resume = resume;
    // Enable dynamic permission routing when a canUseTool hook is supplied.
    if (this.opts.canUseTool && merged.permissionPromptTool === undefined) {
      merged.permissionPromptTool = "stdio";
    }
    // Make bridged functions available + allowed (no permission prompt for them).
    if (this.mcpBridge) {
      merged.allowedTools = [...(merged.allowedTools ?? []), ...this.mcpBridge.qualifiedToolNames];
    }
    this.pendingResume = null;
    const argv = buildArgs(merged, "persistent");
    const child = this.spawn(argv, true);
    this.child = child;
    this.childPid = child.pid ?? null;
    this.registerInRegistry();

    const reader = new NdjsonReader((m) => this.handleMessage(m));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => reader.push(d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => this.appendStderr(d));
    child.on("error", (err) => this.emit("error", { instance: this.id, error: err }));
    child.on("exit", (code) => this.onPersistentExit(child, code, reader));

    // Open the SDK control channel (enables interrupt + dynamic permissions +
    // in-process function bridge).
    this.control = new ControlChannel(
      (line) => {
        try {
          child.stdin?.write(line);
        } catch {
          /* ignore */
        }
      },
      (call, requestId) => this.onCanUseTool(call, requestId),
      this.mcpBridge ? (server, message) => this.handleMcp(server, message) : undefined,
    );
    this.control.initialize(this.mcpBridge ? [this.mcpBridge.serverName] : []).catch(() => {
      /* best effort — normal turns still work without it */
    });
    return child;
  }

  /** Handle an inbound can_use_tool request: emit the event + invoke canUseTool. */
  private onCanUseTool(call: PermissionToolCall, requestId: string): void {
    let answered = false;
    const respond = (result: PermissionResult): void => {
      if (answered || !this.control) return;
      answered = true;
      const final: PermissionResult =
        result.behavior === "allow" ? { behavior: "allow", updatedInput: result.updatedInput ?? call.input } : result;
      this.control.respondPermission(requestId, final);
    };
    this.emit("permission:request", { instance: this.id, requestId, call, respond });
    const cb = this.opts.canUseTool;
    if (cb) {
      cb(call).then(respond, (err) => respond({ behavior: "deny", message: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Route an inbound mcp_message to the in-process function bridge. */
  private handleMcp(serverName: string, message: unknown): Promise<unknown | null> {
    if (!this.mcpBridge || serverName !== this.mcpBridge.serverName) return Promise.resolve(null);
    return this.mcpBridge.handle(message as Parameters<McpControlBridge["handle"]>[0]);
  }

  private onPersistentExit(child: ChildProcess, code: number | null, reader: NdjsonReader): void {
    // Stale exit (the child was already replaced, e.g. timeout recovery): just
    // flush its buffer and ignore — the session lives on under a new child.
    if (this.child !== child) {
      reader.flush();
      return;
    }
    reader.flush();
    this.child = null;
    if (this.control) {
      this.control.rejectAll(new ProcessExitError("print process exited", code, this.stderrBuf));
      this.control = null;
    }

    const turn = this.activeTurn;
    if (turn && !turn.settled) {
      this.clearTurn(turn);
      const err =
        code !== null && code !== 0
          ? new ProcessExitError(`print process exited with code ${code} before result`, code, this.stderrBuf)
          : new MalformedStreamError("print stream ended without a result", this.stderrBuf);
      turn.reject(err);
    }

    this._alive = false;
    this.unregister();
    this.emitExitOnce(code);
  }

  private onTurnTimeout(turn: ActiveTurn): void {
    if (turn.settled) return;
    this.clearTurn(turn);
    log(`[print] turn timed out after ${turn.timeoutMs}ms; killing + scheduling resume`);
    // §12-D6: kill the process, schedule a transparent resume on the next ask
    // so the session survives, and reject the in-flight turn.
    const old = this.child;
    this.child = null; // detach first so the stale-exit guard fires
    if (this.control) {
      this.control.rejectAll(new TurnTimeoutError("turn timed out; control channel reset"));
      this.control = null;
    }
    this.pendingResume = this._sessionId ?? this.opts.resume ?? null;
    if (old) this.treeKill(old);
    turn.reject(new TurnTimeoutError(`print turn timed out after ${turn.timeoutMs}ms`));
  }

  // --- oneshot transport ---

  private runOneshotTurn(content: ContentBlock[], opts?: AskOptions): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      let prompt: string;
      try {
        prompt = this.contentToPrompt(content);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const schema = opts?.schema ?? this.opts.jsonSchema;
      const resume = this._sessionId ?? this.opts.resume;
      const merged: PrintOptions = {
        ...this.opts,
        ...(schema !== undefined ? { jsonSchema: schema } : {}),
        ...(resume !== undefined ? { resume } : {}),
      };
      const argv = buildArgs(merged, "oneshot", prompt);
      const child = this.spawn(argv, false);
      const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

      let out = "";
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          this.treeKill(child);
          reject(new TurnTimeoutError(`oneshot turn timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        out += d;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => this.appendStderr(d));
      child.on("error", (err) => finish(() => reject(err)));
      child.on("close", (code) => {
        finish(() => {
          let msgs: ProtoMessage[];
          try {
            msgs = parseJsonArray(out);
          } catch {
            reject(new MalformedStreamError("oneshot stdout was not valid JSON", this.stderrBuf));
            return;
          }
          if (!msgs.some(isResult)) {
            if (code !== null && code !== 0) {
              reject(new ProcessExitError(`oneshot process exited with code ${code} and no result`, code, this.stderrBuf));
            } else {
              reject(new MalformedStreamError("oneshot output had no result element", this.stderrBuf));
            }
            return;
          }
          for (const m of msgs) this.observe(m);
          let result: TurnResult;
          try {
            result = collectTurn(msgs, { schemaRequested: schema !== undefined });
          } catch (err) {
            reject(new MalformedStreamError(err instanceof Error ? err.message : String(err), this.stderrBuf));
            return;
          }
          if (result.sessionId) this._sessionId = result.sessionId;
          this._lastResult = result;
          this.emit("result", { instance: this.id, result });
          resolve(result);
        });
      });
    });
  }

  /** Oneshot prompts are a positional string — flatten text blocks, reject media. */
  private contentToPrompt(content: ContentBlock[]): string {
    const parts: string[] = [];
    for (const b of content) {
      if (blockIsText(b)) parts.push(b.text);
      else
        throw new NotSupportedError(
          `oneshot transport supports text content only (got "${b.type}"); use the persistent transport for images`,
        );
    }
    return parts.join("");
  }

  // --- message handling (persistent stream) ---

  private handleMessage(msg: ProtoMessage): void {
    // Control frames are out-of-band: route them and never accumulate them
    // into the turn transcript.
    if (this.control && (isControlRequest(msg) || isControlResponse(msg))) {
      this.control.handle(msg as ControlRequestMessage | ControlResponseMessage);
      return;
    }
    this.observe(msg);
    const turn = this.activeTurn;
    if (turn && !turn.settled) {
      turn.acc.add(msg);
      if (isResult(msg)) this.settleTurn(turn);
    }
  }

  /** sessionId capture, version check, and granular event emission (shared by both transports). */
  private observe(msg: ProtoMessage): void {
    const sid = (msg as { session_id?: unknown }).session_id;
    if (typeof sid === "string" && !this._sessionId) this._sessionId = sid;

    if (isInit(msg)) {
      this._sessionId = msg.session_id;
      this.checkVersion(msg);
      this.emit("init", { instance: this.id, init: msg });
    }
    this.emitGranular(msg);
    this.emit("message", { instance: this.id, message: msg });
  }

  private emitGranular(msg: ProtoMessage): void {
    if (isThinkingTokens(msg)) {
      this.emit("thinking:tokens", {
        instance: this.id,
        estimatedTokens: msg.estimated_tokens,
        delta: msg.estimated_tokens_delta,
      });
    } else if (isRateLimitEvent(msg)) {
      this.emit("rate_limit", { instance: this.id, info: msg.rate_limit_info });
    } else if (isAssistant(msg)) {
      for (const b of msg.message.content ?? []) {
        if (blockIsText(b)) this.emit("assistant:text", { instance: this.id, text: b.text });
        else if (blockIsThinking(b)) this.emit("thinking:delta", { instance: this.id, text: b.thinking });
        else if (blockIsToolUse(b))
          this.emit("tool:use", { instance: this.id, tool: { id: b.id, name: b.name, input: b.input } });
      }
    } else if (isStreamEvent(msg)) {
      const d = msg.event.delta;
      if (d?.type === "text_delta" && typeof d.text === "string")
        this.emit("assistant:delta", { instance: this.id, text: d.text });
      else if (d?.type === "thinking_delta" && typeof d.thinking === "string")
        this.emit("thinking:delta", { instance: this.id, text: d.thinking });
    } else if (isUser(msg)) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_result") {
            this.emit("tool:result", {
              instance: this.id,
              toolUseId: b.tool_use_id,
              content: b.content,
              isError: b.is_error === true,
            });
          }
        }
      }
    }
  }

  private settleTurn(turn: ActiveTurn): void {
    if (turn.settled) return;
    this.clearTurn(turn);
    let result: TurnResult;
    try {
      result = turn.acc.finalize({ schemaRequested: turn.schemaRequested });
    } catch (err) {
      turn.reject(new MalformedStreamError(err instanceof Error ? err.message : String(err), this.stderrBuf));
      return;
    }
    if (result.sessionId) this._sessionId = result.sessionId;
    this._lastResult = result;
    this.emit("result", { instance: this.id, result });
    turn.resolve(result);
  }

  private failTurn(turn: ActiveTurn, err: Error): void {
    if (turn.settled) return;
    this.clearTurn(turn);
    turn.reject(err);
  }

  private clearTurn(turn: ActiveTurn): void {
    turn.settled = true;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    if (this.activeTurn === turn) this.activeTurn = null;
  }

  // --- streaming adapter ---

  /**
   * Run a turn and yield its events as they arrive. Terminates after the
   * turn's `result` (or the underlying ask settling). No PTY-side analogue.
   */
  async *stream(text: string | ContentBlock[], opts?: AskOptions): AsyncIterable<PrintEvent> {
    const queue: PrintEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const wake = (): void => {
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    };
    const unsubs = ALL_PRINT_EVENTS.map((ev) =>
      this.emitter.on(ev, (payload) => {
        queue.push({ type: ev, ...payload } as PrintEvent);
        wake();
      }),
    );
    const askP = this.ask(text, opts).then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      done = true;
      wake();
    });
    try {
      for (;;) {
        if (queue.length === 0) {
          if (done) break;
          await new Promise<void>((r) => {
            notify = r;
          });
          continue;
        }
        const ev = queue.shift()!;
        yield ev;
        if (ev.type === "result") break;
      }
    } finally {
      for (const u of unsubs) u();
      await askP;
    }
  }

  // --- events ---

  on<K extends keyof PrintEvents>(event: K, handler: (payload: PrintEvents[K]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  /** Normalized exit subscription for ManagedSession / the manager's auto-detach. */
  onExit(handler: (code: number | null) => void): () => void {
    return this.emitter.on("process:exit", ({ code }) => handler(code));
  }

  private emit<K extends keyof PrintEvents>(event: K, payload: PrintEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  // --- control (M4) ---

  /** Interrupt the in-flight turn via the control protocol. Persistent only. */
  interrupt(): void {
    if (!this.control) {
      throw new NotSupportedError("interrupt() requires a persistent session with an open control channel");
    }
    void this.control.interrupt();
  }

  /** Change the permission mode mid-session (control protocol). */
  setPermissionMode(mode: string): Promise<unknown> {
    if (!this.control) return Promise.reject(new NotSupportedError("no control channel"));
    return this.control.setPermissionMode(mode);
  }

  // --- spawn helpers ---

  private spawn(argv: string[], persistent: boolean): ChildProcess {
    const env = this.childEnvVars();
    const stdio: ["pipe" | "ignore", "pipe", "pipe"] = persistent
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];
    if (process.platform === "win32") {
      const comspec = process.env["ComSpec"] ?? "cmd.exe";
      // windowsVerbatimArguments: we pre-quote each element (JSON args contain
      // braces/quotes that Node's default quoting would mangle).
      const parts = ["/c", "claude", ...argv.map(quoteCmdArg)];
      return cpSpawn(comspec, parts, {
        cwd: this.cwd,
        env,
        stdio,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    }
    return cpSpawn("claude", argv, { cwd: this.cwd, env, stdio });
  }

  private childEnvVars(): NodeJS.ProcessEnv {
    const extra: Record<string, string> = { FORCE_COLOR: "0" };
    if (this.opts.effort) extra["CLAUDE_EFFORT"] = this.opts.effort;
    return childEnv(extra);
  }

  private userLine(content: ContentBlock[]): string {
    return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  }

  private appendStderr(d: string): void {
    if (this.stderrBuf.length >= STDERR_CAP) return;
    this.stderrBuf += d;
    if (this.stderrBuf.length > STDERR_CAP) this.stderrBuf = this.stderrBuf.slice(0, STDERR_CAP);
  }

  private checkVersion(init: InitMessage): void {
    if (this.versionChecked) return;
    this.versionChecked = true;
    const v = init.claude_code_version;
    if (!isTestedCliVersion(v)) {
      log(
        `[print] CLI version ${v ?? "unknown"} is outside the tested range ${TESTED_CLI_VERSIONS.join(", ")}; wire format may differ`,
      );
    }
  }

  private registerInRegistry(): void {
    if (this.childPid === null) return;
    try {
      registerInstance({
        pipe: this.pipeName,
        pid: this.childPid,
        cwd: this.cwd,
        title: "Claude (print)",
        label: this.label,
        kind: "print",
        startedAt: new Date().toISOString(),
      });
    } catch {
      /* best effort */
    }
  }

  private unregister(): void {
    try {
      unregisterInstance(this.pipeName);
    } catch {
      /* ignore */
    }
  }

  private emitExitOnce(code: number | null): void {
    if (this._exitEmitted) return;
    this._exitEmitted = true;
    this.emit("process:exit", { instance: this.id, code });
  }

  private treeKill(child: ChildProcess): void {
    const pid = child.pid;
    if (process.platform === "win32" && pid) {
      // Reap the whole cmd → node → claude tree (killing the cmd pid alone orphans claude).
      try {
        cpSpawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }).unref();
      } catch {
        /* ignore */
      }
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  // --- teardown ---

  /** Synchronous teardown. Idempotent. */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._alive = false;

    const turn = this.activeTurn;
    if (turn && !turn.settled) {
      this.clearTurn(turn);
      turn.reject(new ProcessExitError("print session destroyed", null, this.stderrBuf));
    }
    if (this.control) {
      this.control.rejectAll(new ProcessExitError("print session destroyed", null, this.stderrBuf));
      this.control = null;
    }
    const child = this.child;
    this.child = null;
    if (child) this.treeKill(child);
    this.unregister();
    this.emitExitOnce(null);
  }

  /** Graceful shutdown: half-close stdin, await exit (grace), then force-kill. */
  async shutdown(opts?: { timeoutMs?: number }): Promise<void> {
    if (this._destroyed || !this.child) {
      this.destroy();
      return;
    }
    const child = this.child;
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        unsub();
        resolve();
      }, opts?.timeoutMs ?? 10_000);
      const onExit = (): void => {
        clearTimeout(t);
        unsub();
        resolve();
      };
      const unsub = (): void => {
        child.removeListener("exit", onExit);
      };
      child.on("exit", onExit);
    });
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await exited;
    this.destroy();
  }
}
