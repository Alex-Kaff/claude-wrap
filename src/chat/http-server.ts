#!/usr/bin/env node
// OpenAI-compatible HTTP gateway over the ChatGateway (bin: claude-wrap-serve).
//
// Routes (bound to 127.0.0.1 by default):
//   POST /v1/chat/completions   (JSON or SSE when stream:true)
//   GET  /v1/models
//   GET  /health
//
// Built on Node's `http` (no new dependency). Errors use the OpenAI envelope
// `{ error: { message, type, param, code } }`. Posture is permissive by default
// (§12-D2): bearer optional, caller MCP/tool overrides honored; `lockdown`
// forces isolation + requires a bearer.

import * as http from "http";
import { log } from "../log";
import { HTTP_MAX_BODY_BYTES } from "../config";
import { ChatGateway, GatewayError, type GatewayOptions } from "./gateway";
import type { ChatCompletionChunk, ChatCompletionRequest, OpenAiError } from "./openai-types";

export interface ChatHttpServerOptions extends GatewayOptions {
  host?: string;
  /** Optional bearer token; when set, requests must send `Authorization: Bearer <token>`. */
  bearer?: string;
  /** Max concurrent in-flight chat requests. */
  maxConcurrent?: number;
  /** Max queued requests before returning 503. */
  maxQueue?: number;
  /** Lockdown: force isolation, require bearer + same-origin (future hardening). */
  lockdown?: boolean;
  /** Heartbeat interval for SSE keep-alive comments (ms). */
  heartbeatMs?: number;
  /** Provide a pre-built gateway (else one is constructed from these options). */
  gateway?: ChatGateway;
}

/** Bounded-concurrency limiter: resolve a release fn, or null when the queue overflows. */
class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}
  acquire(): Promise<() => void> | null {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    if (this.queue.length >= this.maxQueue) return null;
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export class ChatHttpServer {
  private readonly gateway: ChatGateway;
  private readonly server: http.Server;
  private readonly limiter: Limiter;
  private readonly host: string;
  private readonly bearer: string | undefined;
  private readonly lockdown: boolean;
  private readonly heartbeatMs: number;

  constructor(options: ChatHttpServerOptions = {}) {
    this.lockdown = options.lockdown ?? false;
    this.gateway =
      options.gateway ??
      new ChatGateway(this.lockdown ? { ...options, isolate: true } : options);
    this.host = options.host ?? "127.0.0.1";
    this.bearer = options.bearer;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.limiter = new Limiter(options.maxConcurrent ?? 8, options.maxQueue ?? 32);
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on("error", (err) => log("[serve] server error", err));
  }

  listen(port = 0): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, this.host, () => {
        this.server.removeListener("error", reject);
        const addr = this.server.address();
        const chosen = typeof addr === "object" && addr ? addr.port : Number(port);
        log(`[serve] listening at http://${this.host}:${chosen}/v1`);
        resolve({ port: chosen, host: this.host });
      });
    });
  }

  close(): void {
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
    this.gateway.shutdown();
  }

  // --- routing ---

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote.startsWith("127.") || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (this.lockdown && !isLoopback) {
      this.sendError(res, new GatewayError("forbidden: loopback only", 403, "permission_error"));
      return;
    }

    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/health") {
      this.sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && (url === "/v1/models" || url === "/models")) {
      if (!this.authOk(req)) return this.sendError(res, this.unauthorized());
      this.sendJson(res, 200, this.gateway.listModels());
      return;
    }
    if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      void this.handleChat(req, res);
      return;
    }
    this.sendError(res, new GatewayError(`not found: ${method} ${url}`, 404, "invalid_request_error"));
  }

  private authOk(req: http.IncomingMessage): boolean {
    if (!this.bearer && !this.lockdown) return true;
    if (!this.bearer) return true; // lockdown without a configured bearer still allows loopback
    const h = req.headers["authorization"];
    return typeof h === "string" && h === `Bearer ${this.bearer}`;
  }

  private unauthorized(): GatewayError {
    return new GatewayError("missing or invalid Authorization bearer", 401, "authentication_error", null, "invalid_api_key");
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authOk(req)) return this.sendError(res, this.unauthorized());

    const slot = this.limiter.acquire();
    if (slot === null) {
      this.sendError(res, new GatewayError("server overloaded; retry shortly", 503, "overloaded_error"));
      return;
    }
    const release = await slot;
    try {
      const body = await this.readBody(req);
      let payload: ChatCompletionRequest;
      try {
        payload = JSON.parse(body) as ChatCompletionRequest;
      } catch {
        this.sendError(res, new GatewayError("invalid JSON body", 400, "invalid_request_error"));
        return;
      }
      this.applyHeaders(req, payload);

      if (payload.stream === true) {
        await this.streamChat(payload, res);
      } else {
        const completion = await this.gateway.createCompletion(payload);
        this.sendJson(res, 200, completion);
      }
    } catch (err) {
      this.handleChatError(res, err);
    } finally {
      release();
    }
  }

  /** Fold gateway-relevant headers into the request body. */
  private applyHeaders(req: http.IncomingMessage, payload: ChatCompletionRequest): void {
    const sid = req.headers["x-claude-session-id"];
    if (typeof sid === "string" && sid && payload.session_id === undefined) payload.session_id = sid;
    const mcp = req.headers["x-claude-mcp"];
    if (typeof mcp === "string" && mcp && payload.mcp === undefined) {
      try {
        payload.mcp = JSON.parse(mcp);
      } catch {
        /* ignore malformed header */
      }
    }
  }

  private async streamChat(payload: ChatCompletionRequest, res: http.ServerResponse): Promise<void> {
    let headersSent = false;
    let aborted = false;
    res.on("close", () => {
      aborted = true;
    });

    const writeHeaders = (): void => {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    };

    // Heartbeat comments keep proxies/clients from idling out during the
    // multi-second pre-first-token gap (fixtures show ttft 1.1–3.5s).
    const heartbeat = setInterval(() => {
      if (headersSent && !res.writableEnded) res.write(": keep-alive\n\n");
    }, this.heartbeatMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const writeChunk = (chunk: ChatCompletionChunk): void => {
      writeHeaders();
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    try {
      const stream = this.gateway.completions.create(payload) as AsyncIterable<ChatCompletionChunk>;
      for await (const chunk of stream) {
        if (aborted) break;
        writeChunk(chunk);
      }
      if (!aborted) {
        writeHeaders();
        res.write("data: [DONE]\n\n");
      }
    } catch (err) {
      if (!headersSent) {
        // Nothing streamed yet — emit a proper JSON error envelope.
        this.handleChatError(res, err);
        return;
      }
      // Mid-stream failure: surface as an SSE error event, then terminate.
      const env = this.toEnvelope(err);
      res.write(`event: error\ndata: ${JSON.stringify(env)}\n\n`);
      res.write("data: [DONE]\n\n");
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  private handleChatError(res: http.ServerResponse, err: unknown): void {
    if (err instanceof GatewayError) {
      this.sendError(res, err);
    } else {
      log("[serve] unexpected error", err instanceof Error ? err.stack ?? err.message : String(err));
      this.sendError(res, new GatewayError(err instanceof Error ? err.message : String(err), 500, "api_error"));
    }
  }

  // --- io helpers ---

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      let settled = false;
      let destroying = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        if (settled || destroying) return;
        data += chunk;
        if (data.length > HTTP_MAX_BODY_BYTES) {
          destroying = true;
          req.destroy(new Error("body too large"));
        }
      });
      req.on("end", () => settle(() => resolve(data)));
      req.on("error", (e) => settle(() => reject(e)));
    });
  }

  private toEnvelope(err: unknown): OpenAiError {
    if (err instanceof GatewayError) {
      return { error: { message: err.message, type: err.type, param: err.param, code: err.code } };
    }
    return { error: { message: err instanceof Error ? err.message : String(err), type: "api_error", param: null, code: null } };
  }

  private sendError(res: http.ServerResponse, err: GatewayError): void {
    const headers: Record<string, string | number> = {
      "content-type": "application/json; charset=utf-8",
    };
    if (err.status === 429 && err.retryAfterSec !== undefined) headers["retry-after"] = err.retryAfterSec;
    const body = JSON.stringify(this.toEnvelope(err));
    headers["content-length"] = Buffer.byteLength(body);
    if (!res.headersSent) res.writeHead(err.status, headers);
    res.end(body);
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    if (!res.headersSent) {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
      });
    }
    res.end(text);
  }
}

// ---------------------------------------------------------------------------
// CLI entry (bin: claude-wrap-serve)
// ---------------------------------------------------------------------------

function envBool(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

export async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? process.env["CLAUDE_WRAP_SERVE_PORT"] ?? 4000);
  const options: ChatHttpServerOptions = {
    host: process.env["HOST"] ?? "127.0.0.1",
    ...(process.env["CLAUDE_WRAP_SERVE_BEARER"] ? { bearer: process.env["CLAUDE_WRAP_SERVE_BEARER"] } : {}),
    lockdown: envBool("CLAUDE_WRAP_SERVE_LOCKDOWN"),
    isolate: process.env["CLAUDE_WRAP_SERVE_ISOLATE"] === "0" ? false : true,
    ...(process.env["CLAUDE_WRAP_SERVE_MODEL"] ? { defaultModel: process.env["CLAUDE_WRAP_SERVE_MODEL"] } : {}),
  };
  const server = new ChatHttpServer(options);
  const { host, port: chosen } = await server.listen(port);
  // eslint-disable-next-line no-console
  console.log(`claude-wrap-serve: OpenAI-compatible gateway on http://${host}:${chosen}/v1`);
  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("claude-wrap-serve failed to start:", err);
    process.exit(1);
  });
}
