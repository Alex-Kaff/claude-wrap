// Chunked NDJSON line reader for the print transport's stdout.
//
// `claude -p --output-format stream-json` emits one JSON object per line. PTY
// chunking and Windows `cmd /c` can split a line across chunks or inject `\r`,
// so we buffer, split on `\n`, strip a trailing `\r`, and hold the partial
// trailing fragment across chunks. Lines can be large (assistant blocks carry
// thinking signatures) — no length assumption.
//
// Error contract (§2.3): a line that fails JSON.parse is logged and skipped,
// never thrown. The caller decides what a missing `result` means.

import { log } from "../log";
import { asProtoMessage, type ProtoMessage } from "./proto";

export class NdjsonReader {
  private buf = "";

  constructor(
    private readonly onMessage: (msg: ProtoMessage) => void,
    /** Called for a line that isn't valid JSON or isn't an object with a `type`. */
    private readonly onBadLine?: (line: string, err: unknown) => void,
  ) {}

  /** Feed a stdout chunk. Emits a message for each complete, parseable line. */
  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    // Process every complete line (ending in \n). The final fragment (no
    // trailing \n yet) stays in `buf` for the next chunk.
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.consumeLine(line);
    }
  }

  /** Process any buffered trailing fragment (e.g. a stream that ended without
   *  a final newline). Safe to call multiple times. */
  flush(): void {
    const rest = this.buf;
    this.buf = "";
    const line = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    this.consumeLine(line);
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      this.reportBad(line, err);
      return;
    }
    const msg = asProtoMessage(parsed);
    if (!msg) {
      this.reportBad(line, new Error("not a protocol message object"));
      return;
    }
    this.onMessage(msg);
  }

  private reportBad(line: string, err: unknown): void {
    if (this.onBadLine) {
      this.onBadLine(line, err);
    } else {
      log("[print/ndjson] skipping unparseable line:", err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Parse the one-shot `--output-format json` payload, which is a JSON *array* of
 * all messages (NOT a single object — §1.1). Returns the messages; malformed
 * top-level JSON throws (the caller maps it to a typed error). Non-object
 * elements are dropped.
 */
export function parseJsonArray(text: string): ProtoMessage[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    // Some flows might emit a single object; tolerate that too.
    const single = asProtoMessage(data);
    return single ? [single] : [];
  }
  const out: ProtoMessage[] = [];
  for (const el of data) {
    const m = asProtoMessage(el);
    if (m) out.push(m);
  }
  return out;
}
