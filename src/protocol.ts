// Wire protocol for the claude-wrap control pipe.
// Newline-delimited JSON. One request -> one response.
//
// Protocol version bumps whenever the shape of a request/response
// changes in a way that would confuse an older peer. Requests may
// omit `version` (treated as latest-compatible), but responses
// always carry it so clients can detect mismatches.

import * as os from "os";
import * as path from "path";

export const PROTOCOL_VERSION = 1;

export interface VersionField {
  /** Wire protocol version. Omitted on request = "assume latest". */
  version?: number;
}

export interface WriteRequest extends VersionField {
  cmd: "write";
  /** UTF-8 string; mutually exclusive with b64. */
  data?: string;
  /** Base64-encoded raw bytes; use this for binary-safe input. */
  b64?: string;
}

export interface SnapshotRequest extends VersionField {
  cmd: "snapshot";
  /** If true, return only currently-visible rows instead of full scrollback. */
  viewport?: boolean;
  /** If true, rtrim each line and drop trailing blank rows. */
  clean?: boolean;
}

export interface ResizeRequest extends VersionField {
  cmd: "resize";
  cols: number;
  rows: number;
}

export type Request = WriteRequest | SnapshotRequest | ResizeRequest;

export interface WriteResponse {
  version: number;
  ok: true;
  bytes: number;
}

export interface SnapshotResponse {
  version: number;
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  viewportY: number;
  baseY: number;
  lines: string[];
}

export interface ResizeResponse {
  version: number;
  ok: true;
  cols: number;
  rows: number;
}

export interface ErrorResponse {
  version: number;
  error: string;
  /** Machine-readable code. "version_mismatch" signals a protocol gap. */
  code?: string;
}

export type Response = WriteResponse | SnapshotResponse | ResizeResponse | ErrorResponse;

export const DEFAULT_PIPE_NAME = "claude-wrap";

/**
 * Platform-specific address for the control channel.
 *  - Windows: named pipe at \\.\pipe\<name>
 *  - Unix:    socket file at $TMPDIR/<name>.sock
 */
export const pipePath = (name: string): string => {
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
};
