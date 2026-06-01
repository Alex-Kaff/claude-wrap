// Localhost HTTP bridge for the claude-wrap control channel.
//
// Endpoints (all bound to 127.0.0.1 — no remote access):
//
//   GET  /health              → { ok: true, pid, pipe }
//   POST /request             → same Request/Response schema as the pipe
//                               (body is the JSON Request, response is the
//                                JSON Response)
//   GET  /snapshot            → shortcut: ?viewport=1&clean=1
//   POST /write               → shortcut: body = raw text to write
//
// The HTTP transport shares the same ControlHandlers as the pipe, via
// the pure `dispatchRequest` router in control.ts, so behavior is
// identical across both transports.

import * as http from "http";
import { dispatchRequest, type ControlHandlers } from "./control";
import { log } from "./log";
import { HTTP_MAX_BODY_BYTES } from "./config";
import type { Request as ControlRequest, Response as ControlResponse } from "./protocol";

export interface HttpBridgeInfo {
  port: number;
  host: string;
}

export class HttpBridge {
  private server: http.Server;
  private info: HttpBridgeInfo | null = null;

  constructor(
    private readonly handlers: ControlHandlers,
    private readonly meta: { pid: number; pipe: string },
  ) {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on("error", (err) => log("[http] server error", err));
  }

  /** Bind to 127.0.0.1 on `port` (0 = ephemeral). Resolves with chosen port. */
  listen(port = 0): Promise<HttpBridgeInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        const addr = this.server.address();
        const chosen = typeof addr === "object" && addr ? addr.port : Number(port);
        this.info = { port: chosen, host: "127.0.0.1" };
        log(`[http] listening at http://127.0.0.1:${chosen}`);
        resolve(this.info);
      });
    });
  }

  close(): void {
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Defense in depth: only accept loopback clients. Node already
    // binds to 127.0.0.1 above, but if that ever changes we still
    // want to reject non-local requests explicitly.
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.startsWith("127.") && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      this.sendJson(res, 403, { error: "forbidden: loopback only" });
      return;
    }

    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/health") {
      this.sendJson(res, 200, { ok: true, pid: this.meta.pid, pipe: this.meta.pipe });
      return;
    }

    if (method === "GET" && url.startsWith("/snapshot")) {
      const params = new URL(url, "http://x").searchParams;
      const msg: ControlRequest = {
        cmd: "snapshot",
        viewport: params.get("viewport") === "1" || params.get("viewport") === "true",
        clean: params.get("clean") === "1" || params.get("clean") === "true",
      };
      this.dispatchAndReply(res, msg);
      return;
    }

    if (method === "POST" && url === "/write") {
      this.readBody(req)
        .then((body) => {
          const msg: ControlRequest = { cmd: "write", data: body };
          this.dispatchAndReply(res, msg);
        })
        .catch((e: Error) => this.sendJson(res, 400, { error: e.message }));
      return;
    }

    if (method === "POST" && url === "/request") {
      this.readBody(req)
        .then((body) => {
          let msg: ControlRequest;
          try {
            msg = JSON.parse(body) as ControlRequest;
          } catch {
            this.sendJson(res, 400, { error: "bad json" });
            return;
          }
          this.dispatchAndReply(res, msg);
        })
        .catch((e: Error) => this.sendJson(res, 400, { error: e.message }));
      return;
    }

    this.sendJson(res, 404, { error: `not found: ${method} ${url}` });
  }

  /**
   * Dispatch a control request and reply with its response, or a 500 if a
   * handler throws. Mirrors the try/catch guard the pipe transport applies
   * in ControlServer.handleLine, so the two transports behave identically.
   */
  private dispatchAndReply(res: http.ServerResponse, msg: ControlRequest): void {
    let response: ControlResponse;
    try {
      response = dispatchRequest(this.handlers, msg);
    } catch (e) {
      this.sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.sendJson(res, "error" in response ? 400 : 200, response);
  }

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
        // `destroying` is set synchronously the moment we decide to
        // tear down, so any already-queued "data" events that fire
        // before Node actually closes the stream don't continue to
        // accumulate past HTTP_MAX_BODY_BYTES.
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

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: ControlResponse | { ok: true; pid: number; pipe: string } | { error: string },
  ): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }
}
