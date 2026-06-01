// Simple append-only file logger with size-based rotation.
//
// Lines look like:
//   [2026-04-08T12:34:56.789Z] [pid=1234 inst=myrepo] [control] listening at ...
//
// The instance tag is derived from CLAUDE_WRAP_PIPE / CLAUDE_WRAP_LABEL
// at module load so concurrent wrappers writing to the same log file
// can be grepped apart.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LOG_ROTATE_BYTES, LOG_ROTATE_KEEP } from "./config";

// Log to a writable location, not the package's own install directory —
// once published, that dir is frequently read-only (global installs, CI,
// Docker, pnpm's content-addressable store). Override with CLAUDE_WRAP_LOG.
const LOG_PATH = process.env["CLAUDE_WRAP_LOG"] ?? path.join(os.tmpdir(), "claude-wrap.log");

function instanceTag(): string {
  const label = process.env["CLAUDE_WRAP_LABEL"];
  const pipe = process.env["CLAUDE_WRAP_PIPE"];
  const id = label || pipe || "-";
  return `[pid=${process.pid} inst=${id}]`;
}

// Captured once — the env vars are set before log() is called in
// wrapper.ts, and re-reading them on every log line is wasteful.
const TAG = instanceTag();

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < LOG_ROTATE_BYTES) return;
  } catch {
    return; // no log yet
  }
  try {
    const oldest = `${LOG_PATH}.${LOG_ROTATE_KEEP}`;
    try {
      fs.unlinkSync(oldest);
    } catch {
      /* ignore */
    }
    for (let i = LOG_ROTATE_KEEP - 1; i >= 1; i--) {
      const from = `${LOG_PATH}.${i}`;
      const to = `${LOG_PATH}.${i + 1}`;
      try {
        fs.renameSync(from, to);
      } catch {
        /* ignore missing */
      }
    }
    fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    // best effort
  }
}

export function log(...parts: unknown[]): void {
  rotateIfNeeded();
  const line = `[${new Date().toISOString()}] ${TAG} ${parts.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // best effort
  }
}
