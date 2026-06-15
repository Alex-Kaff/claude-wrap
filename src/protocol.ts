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
  /**
   * Opt-in: also return per-row foreground color runs (see SnapshotResponse.colors).
   * Omitted/false => the response carries no `colors` field (byte-for-byte the old
   * shape), so old callers are unaffected and old servers simply ignore the flag.
   */
  colors?: boolean;
}

/**
 * One foreground color run on a row: [length-in-codepoints, packed 0xRRGGBB fg, or
 * -1 for the terminal default]. `length` counts codepoints (a surrogate pair is 1),
 * matching the per-codepoint walk a renderer uses over the row text.
 */
export type ColorRun = [number, number];

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
  /**
   * Optional per-row foreground color runs. Present only when the request set
   * `colors:true` AND at least one row has non-default color. Index-aligned with
   * `lines`: each entry is that row's runs (covering its codepoints) or null for an
   * all-default row. Absent entirely => the caller renders monochrome (so a client
   * talking to an older, color-unaware server degrades cleanly).
   */
  colors?: (ColorRun[] | null)[];
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
