// Promise-based client for the claude-wrap control pipe.
//
// The `Client` class opens a single connection and multiplexes sequential
// requests over it. The server handles requests in order, so responses
// arrive in order and we match them by FIFO. Used for polling loops
// (wait-idle, ask) and the `inject repl` interactive mode.
//
// `withClient(pipe, fn)` is the recommended way to use a Client for a
// bounded operation — it guarantees the connection is closed even when
// fn throws. The `sendRequest` / `snapshot` / `write` helpers are thin
// one-shot wrappers around `withClient` for single-request callers.
//
// `IClient` is the minimal surface that consumers (wait.ts, etc.) need.
// Tests can satisfy it with a FakeClient that serves scripted snapshots
// without touching a real pipe.

import * as net from "net";
import {
  PROTOCOL_VERSION,
  pipePath,
  type Request,
  type Response,
  type SnapshotResponse,
} from "./protocol";
import { PipeError, ProtocolVersionError } from "./errors";

export { PipeError, ProtocolVersionError } from "./errors";

/** Minimal client surface used by wait.ts and high-level inject commands. */
export interface IClient {
  snapshot(opts?: { viewport?: boolean; clean?: boolean }): Promise<SnapshotResponse>;
  write(data: string): Promise<void>;
  close(): void;
}

interface PendingRequest {
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
}

function ensureCompatibleResponse(res: Response): void {
  // Tolerate `undefined` for responses from pre-versioning wrappers
  // (anything built before PROTOCOL_VERSION was introduced). Any other
  // value is an explicit, loud mismatch.
  const v = (res as { version?: number }).version;
  if (v === undefined || v === PROTOCOL_VERSION) return;
  throw new ProtocolVersionError(
    `protocol version mismatch: client speaks ${PROTOCOL_VERSION}, wrapper sent ${v}`,
    typeof v === "number" ? v : null,
  );
}

function throwIfVersionMismatchError(res: Response): void {
  if (!("error" in res)) return;
  const code = (res as { code?: string }).code;
  if (code === "version_mismatch") {
    throw new ProtocolVersionError(res.error, null);
  }
}

export class Client implements IClient {
  private sock: net.Socket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private pending: PendingRequest[] = [];
  private readBuf = "";
  private closed = false;

  constructor(readonly pipe: string) {}

  private connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(pipePath(this.pipe));
      this.sock = sock;

      const onError = (e: Error): void => {
        if (this.sock === sock) this.sock = null;
        this.connected = false;
        this.connecting = null;
        this.failAll(new PipeError(e.message));
        reject(new PipeError(e.message));
      };

      sock.once("connect", () => {
        this.connected = true;
        this.connecting = null;
        resolve();
      });
      sock.on("data", (d: Buffer) => this.onData(d));
      sock.on("error", onError);
      sock.on("close", () => {
        if (this.sock === sock) {
          this.sock = null;
          this.connected = false;
        }
        if (!this.closed) this.failAll(new PipeError("pipe closed"));
      });
    });
    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.readBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.readBuf.indexOf("\n")) >= 0) {
      const line = this.readBuf.slice(0, idx);
      this.readBuf = this.readBuf.slice(idx + 1);
      const waiter = this.pending.shift();
      if (!waiter) continue; // unsolicited — ignore
      try {
        waiter.resolve(JSON.parse(line) as Response);
      } catch (e) {
        waiter.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  private failAll(err: Error): void {
    const waiters = this.pending.splice(0, this.pending.length);
    for (const w of waiters) w.reject(err);
  }

  async send(msg: Request): Promise<Response> {
    await this.connect();
    const sock = this.sock;
    if (!sock) throw new PipeError("not connected");
    // Stamp the client's protocol version on outgoing requests so the
    // server can signal incompatibility explicitly.
    const stamped: Request = { ...msg, version: PROTOCOL_VERSION };
    return new Promise<Response>((resolve, reject) => {
      const waiter: PendingRequest = { resolve, reject };
      this.pending.push(waiter);
      sock.write(JSON.stringify(stamped) + "\n", (err) => {
        if (!err) return;
        const idx = this.pending.indexOf(waiter);
        if (idx >= 0) {
          this.pending.splice(idx, 1);
          reject(new PipeError(err.message));
        }
        try {
          sock.destroy(err);
        } catch {
          /* ignore */
        }
      });
    });
  }

  async snapshot(opts: { viewport?: boolean; clean?: boolean } = {}): Promise<SnapshotResponse> {
    const res = await this.send({
      cmd: "snapshot",
      viewport: opts.viewport === true,
      clean: opts.clean === true,
    });
    ensureCompatibleResponse(res);
    throwIfVersionMismatchError(res);
    if ("error" in res) throw new PipeError(res.error);
    if (!("lines" in res)) throw new PipeError("unexpected response to snapshot");
    return res;
  }

  async write(data: string): Promise<void> {
    const res = await this.send({ cmd: "write", data });
    ensureCompatibleResponse(res);
    throwIfVersionMismatchError(res);
    if ("error" in res) throw new PipeError(res.error);
  }

  close(): void {
    this.closed = true;
    const sock = this.sock;
    this.sock = null;
    this.connected = false;
    try {
      sock?.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run `fn` with a fresh Client, guaranteeing close() even when fn throws.
 */
export async function withClient<T>(pipe: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client(pipe);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// One-shot wrappers
// ---------------------------------------------------------------------------

export function sendRequest(pipe: string, msg: Request): Promise<Response> {
  return withClient(pipe, (c) => c.send(msg));
}

export function snapshot(
  pipe: string,
  opts: { viewport?: boolean; clean?: boolean } = {},
): Promise<SnapshotResponse> {
  return withClient(pipe, (c) => c.snapshot(opts));
}

export function write(pipe: string, data: string): Promise<void> {
  return withClient(pipe, (c) => c.write(data));
}
