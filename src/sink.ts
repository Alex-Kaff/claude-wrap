// EventSink: pluggable forwarding of a ClaudeInstance's SessionEvents to an
// out-of-process consumer. In-process consumers subscribe with `.on()`; an
// out-of-process controller (e.g. a window/wrapper running in another process)
// uses a sink to ship events over a transport.
//
// `WebSocketEventSink` is the built-in implementation: it connects to a
// WebSocket URL and forwards events using a generic JSON wire format:
//
//   { kind: "hello", instance, pid, cwd, label?, httpPort? }
//   { kind: "event", instance, event: <SessionEvents key>, payload }
//   { kind: "exit",  instance, exitCode }
//
// It keeps reconnect/backoff, re-syncs state on reconnect, and applies an
// optional idle debounce. It is deliberately generic — no knowledge of any
// particular backend, registry, or product.

import WebSocket from "ws";
import type { TypedEmitter, SessionEvents } from "./events";
import type { PermissionPrompt } from "./parse";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_IDLE_DEBOUNCE_MS = 2_500;

/** Identity of the wrapped instance whose events are being forwarded. */
export interface InstanceInfo {
  id: string;
  pid: number;
  cwd: string;
  label?: string | undefined;
  httpPort?: number | undefined;
}

/**
 * A pluggable destination for an instance's events. `attach` is called once,
 * wiring the sink to the instance's emitter. Implementations are responsible
 * for their own transport and lifecycle.
 */
export interface EventSink {
  attach(emitter: TypedEmitter<SessionEvents>, info: InstanceInfo): void;
  /** Optional: called when an async HTTP bridge port becomes known. */
  setHttpPort?(port: number): void;
  close(): void;
}

export interface WebSocketEventSinkOptions {
  /**
   * Debounce idle transitions to avoid busy→idle→busy flicker between tool
   * calls. Set to 0 to forward idle immediately. Default 2500ms.
   */
  idleDebounceMs?: number;
}

// --- Wire frames -----------------------------------------------------------

interface HelloFrame {
  kind: "hello";
  instance: string;
  pid: number;
  cwd: string;
  label?: string;
  httpPort?: number;
}
interface EventFrame {
  kind: "event";
  instance: string;
  event: keyof SessionEvents;
  payload: unknown;
}
interface ExitFrame {
  kind: "exit";
  instance: string;
  exitCode: number | null;
}
type Frame = HelloFrame | EventFrame | ExitFrame;

export class WebSocketEventSink implements EventSink {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly idleDebounceMs: number;
  private info: InstanceInfo | null = null;
  private unsubs: Array<() => void> = [];
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Last forwarded status event name + payload, re-sent on reconnect. */
  private lastStatus: "status:busy" | "status:idle" = "status:idle";
  private lastStatusPayload: SessionEvents["status:busy"] | null = null;
  /** True while a permission prompt is on screen — suppresses busy/idle. */
  private hasPermissionPrompt = false;
  /** Cached permission prompt for re-sending on reconnect. */
  private lastPermissionPrompt: PermissionPrompt | undefined;
  /** Debounce timer for idle transitions. */
  private idleDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, opts: WebSocketEventSinkOptions = {}) {
    this.url = url;
    this.idleDebounceMs = opts.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS;
  }

  attach(emitter: TypedEmitter<SessionEvents>, info: InstanceInfo): void {
    this.info = info;
    this.connect();
    this.subscribe(emitter);
  }

  private connect(): void {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.sendHello();
      // Re-sync state on reconnect.
      if (this.lastStatusPayload) this.sendEvent(this.lastStatus, this.lastStatusPayload);
      if (this.hasPermissionPrompt && this.lastPermissionPrompt) {
        this.sendEvent("permission:prompt", {
          instance: this.info!.id,
          prompt: this.lastPermissionPrompt,
        });
      }
    });

    this.ws.on("close", () => {
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      // close event follows
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(frame: Frame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(frame));
      } catch {
        /* best effort */
      }
    }
  }

  private sendHello(): void {
    if (!this.info) return;
    this.send({
      kind: "hello",
      instance: this.info.id,
      pid: this.info.pid,
      cwd: this.info.cwd,
      ...(this.info.label !== undefined ? { label: this.info.label } : {}),
      ...(this.info.httpPort !== undefined ? { httpPort: this.info.httpPort } : {}),
    });
  }

  private sendEvent<K extends keyof SessionEvents>(event: K, payload: SessionEvents[K]): void {
    if (!this.info) return;
    this.send({ kind: "event", instance: this.info.id, event, payload });
  }

  private subscribe(emitter: TypedEmitter<SessionEvents>): void {
    this.unsubs.push(
      emitter.on("status:busy", (payload) => {
        // While a permission prompt is on screen, the terminal is "waiting"
        // regardless of spinner state — suppress busy/idle churn.
        if (this.hasPermissionPrompt) return;
        if (this.idleDebounce) {
          clearTimeout(this.idleDebounce);
          this.idleDebounce = null;
        }
        if (this.lastStatus !== "status:busy") {
          this.lastStatus = "status:busy";
          this.lastStatusPayload = payload;
          this.sendEvent("status:busy", payload);
        }
      }),
      emitter.on("status:idle", (payload) => {
        if (this.hasPermissionPrompt) return;
        if (this.idleDebounceMs <= 0) {
          if (this.lastStatus !== "status:idle") {
            this.lastStatus = "status:idle";
            this.lastStatusPayload = payload;
            this.sendEvent("status:idle", payload);
          }
          return;
        }
        if (this.idleDebounce) return; // already waiting
        this.idleDebounce = setTimeout(() => {
          this.idleDebounce = null;
          if (!this.hasPermissionPrompt && this.lastStatus !== "status:idle") {
            this.lastStatus = "status:idle";
            this.lastStatusPayload = payload;
            this.sendEvent("status:idle", payload);
          }
        }, this.idleDebounceMs);
      }),
      emitter.on("permission:prompt", (payload) => {
        this.hasPermissionPrompt = true;
        this.lastPermissionPrompt = payload.prompt;
        this.sendEvent("permission:prompt", payload);
      }),
      emitter.on("permission:resolved", (payload) => {
        this.hasPermissionPrompt = false;
        this.lastPermissionPrompt = undefined;
        this.sendEvent("permission:resolved", payload);
      }),
      emitter.on("tool:start", (payload) => this.sendEvent("tool:start", payload)),
      emitter.on("tool:complete", (payload) => this.sendEvent("tool:complete", payload)),
      emitter.on("todo:changed", (payload) => this.sendEvent("todo:changed", payload)),
      emitter.on("mode:changed", (payload) => this.sendEvent("mode:changed", payload)),
      emitter.on("process:exit", (payload) => {
        if (!this.info) return;
        this.send({ kind: "exit", instance: this.info.id, exitCode: payload.exitCode });
      }),
      // Deliberately NOT forwarded: "screen:changed" (fires on every redraw —
      // would flood the socket) and "state:changed" (redundant aggregate).
      // Out-of-process consumers pull the display via snapshot() / GET /snapshot.
    );
  }

  /** Update the HTTP port after it becomes available (async listen). */
  setHttpPort(port: number): void {
    if (this.info) this.info.httpPort = port;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendHello();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleDebounce) {
      clearTimeout(this.idleDebounce);
      this.idleDebounce = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
