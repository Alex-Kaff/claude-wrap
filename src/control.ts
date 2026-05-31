import * as net from "net";
import * as fs from "fs";
import { log } from "./log";
import {
  PROTOCOL_VERSION,
  type Request,
  type Response,
  type SnapshotResponse,
  type WriteResponse,
  type ResizeResponse,
  type ErrorResponse,
} from "./protocol";

export interface ControlHandlers {
  onWrite(bytes: Buffer): void;
  /** Handlers return the core fields; dispatch stamps the protocol version. */
  onSnapshot(
    viewportOnly: boolean,
    clean: boolean,
  ): Omit<SnapshotResponse, "version">;
  onResize(cols: number, rows: number): void;
}

function makeError(msg: string, code?: string): ErrorResponse {
  return code
    ? { version: PROTOCOL_VERSION, error: msg, code }
    : { version: PROTOCOL_VERSION, error: msg };
}

/**
 * Pure router: turn a Request into a Response by delegating to the
 * shared handlers. Used by both the named-pipe and HTTP transports.
 * Every response carries PROTOCOL_VERSION so clients can detect mismatches.
 */
export function dispatchRequest(handlers: ControlHandlers, msg: Request): Response {
  if (msg.version !== undefined && msg.version !== PROTOCOL_VERSION) {
    return makeError(
      `protocol version mismatch: wrapper speaks ${PROTOCOL_VERSION}, client sent ${msg.version}`,
      "version_mismatch",
    );
  }
  switch (msg.cmd) {
    case "write": {
      const data =
        msg.b64 !== undefined
          ? Buffer.from(msg.b64, "base64")
          : Buffer.from(msg.data ?? "", "utf8");
      handlers.onWrite(data);
      const res: WriteResponse = { version: PROTOCOL_VERSION, ok: true, bytes: data.length };
      return res;
    }
    case "snapshot": {
      const core = handlers.onSnapshot(msg.viewport === true, msg.clean === true);
      return { version: PROTOCOL_VERSION, ...core };
    }
    case "resize": {
      handlers.onResize(msg.cols, msg.rows);
      const res: ResizeResponse = {
        version: PROTOCOL_VERSION,
        ok: true,
        cols: msg.cols,
        rows: msg.rows,
      };
      return res;
    }
    default:
      return makeError(
        `unknown cmd: ${(msg as { cmd?: string }).cmd ?? "<missing>"}`,
        "unknown_cmd",
      );
  }
}

/**
 * Named-pipe JSON control server. Newline-delimited; one request -> one response.
 */
export class ControlServer {
  private server: net.Server;

  constructor(private readonly pipePath: string, private readonly handlers: ControlHandlers) {
    this.server = net.createServer((sock) => this.onConnection(sock));
    this.server.on("error", (err) => log("[control] server error", err));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      // On Unix the "pipe" is actually a socket file; remove any stale
      // leftover from a previous crashed run so bind doesn't fail.
      if (process.platform !== "win32") {
        try { fs.unlinkSync(this.pipePath); } catch { /* ignore */ }
      }
      this.server.once("error", reject);
      this.server.listen(this.pipePath, () => {
        this.server.removeListener("error", reject);
        log(`[control] listening at ${this.pipePath}`);
        resolve();
      });
    });
  }

  close(): void {
    try {
      this.server.close();
    } catch {
      /* ignore */
    }
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.pipePath); } catch { /* ignore */ }
    }
  }

  private onConnection(sock: net.Socket): void {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        this.handleLine(line, sock);
      }
    });
    sock.on("error", () => {
      /* client errors are non-fatal */
    });
  }

  private handleLine(line: string, sock: net.Socket): void {
    let msg: Request;
    try {
      msg = JSON.parse(line) as Request;
    } catch {
      this.send(sock, makeError("bad json", "bad_json"));
      return;
    }
    try {
      const res = dispatchRequest(this.handlers, msg);
      this.send(sock, res);
    } catch (e) {
      this.send(sock, makeError(e instanceof Error ? e.message : String(e)));
    }
  }

  private send(sock: net.Socket, res: Response): void {
    sock.write(JSON.stringify(res) + "\n");
  }
}
