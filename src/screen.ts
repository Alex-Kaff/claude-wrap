import { Terminal } from "@xterm/headless";
import { SCROLLBACK_LINES } from "./config";
import type { ColorRun, SnapshotResponse } from "./protocol";
import { buildLineRuns, cpCount } from "./color";

/** Core snapshot fields — wire `version` is stamped by dispatchRequest. */
export type ScreenSnapshot = Omit<SnapshotResponse, "version">;

/**
 * Thin wrapper around a headless xterm that we feed PTY output into,
 * so we can ask "what's on screen?" at any time.
 */
export class VirtualScreen {
  private term: Terminal;
  private changeListeners: (() => void)[] = [];

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: SCROLLBACK_LINES,
    });
  }

  /** Register a change listener. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      const i = this.changeListeners.indexOf(cb);
      if (i >= 0) this.changeListeners.splice(i, 1);
    };
  }

  write(data: string | Uint8Array): void {
    // Callback fires AFTER xterm processes the data into its buffer,
    // so snapshot() called from a listener sees the fresh state.
    this.term.write(data, () => {
      for (const cb of this.changeListeners.slice()) cb();
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  snapshot(viewportOnly: boolean, clean = false, colors = false): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const cols = this.term.cols;
    const rows = this.term.rows;

    const start = viewportOnly ? buf.viewportY : 0;
    const end = viewportOnly ? buf.viewportY + rows : buf.length;

    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }

    if (clean) {
      for (let i = 0; i < lines.length; i++) {
        lines[i] = (lines[i] ?? "").trimEnd();
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    }

    const snap: ScreenSnapshot = {
      cols,
      rows,
      cursor: { x: buf.cursorX, y: buf.cursorY },
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      lines,
    };

    // Opt-in per-row foreground color runs, index-aligned with `lines` (clean only
    // trims/pops, never reindexes, so `lines[i]` still maps to buffer row start+i).
    // Read the live cell colors off each line and pack compact runs; an all-default
    // row is null. Omit the field entirely when nothing is colored so a monochrome
    // screen ships the exact old shape and the caller's fallback path is unchanged.
    if (colors) {
      const runs: (ColorRun[] | null)[] = [];
      let any = false;
      for (let i = 0; i < lines.length; i++) {
        const r = buildLineRuns(buf.getLine(start + i), cols, cpCount(lines[i] ?? ""));
        runs.push(r);
        if (r) any = true;
      }
      if (any) snap.colors = runs;
    }

    return snap;
  }
}
