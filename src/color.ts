// Terminal color extraction: read per-cell foreground colors back out of an
// @xterm/headless buffer (which parses ANSI but whose plain-text snapshot discards
// them) and pack them into compact per-row runs a renderer can consume. Foreground
// only — backgrounds and attributes other than bold are intentionally dropped.
//
// This is the canonical extractor: VirtualScreen.snapshot({ colors:true }) uses it
// to emit SnapshotResponse.colors, and out-of-process consumers (e.g. the vr-overlay
// bridge) render the resulting runs. The packing is the format the overlay already
// consumes: per row a list of [len, fg] pairs where `len` counts CODEPOINTS
// (surrogate pairs = 1) covering exactly the trimmed line length, and `fg` is a
// packed 0xRRGGBB or -1 for terminal-default; an all-default row emits no runs.

import type { ColorRun } from "./protocol";

// Minimal structural view of the @xterm/headless cell/line APIs we touch. Declared
// locally (the package does not export IBufferCell / IBufferLine) so this module is
// self-contained; a real buffer cell/line satisfies these structurally.
export interface XtermCell {
  getWidth(): number;
  getChars(): string;
  getFgColor(): number;
  isFgDefault(): boolean;
  isFgRGB(): boolean;
  isBold(): number;
}
export interface XtermLine {
  getCell(x: number, cell?: XtermCell): XtermCell | undefined;
}

// The standard xterm 256-color palette → packed 0xRRGGBB. Built once.
export const XTERM_PALETTE: number[] = (() => {
  const p = new Array<number>(256);
  // 0-15: the classic system colors (normal + bright).
  const sys = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
    0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
  ];
  for (let i = 0; i < 16; i++) p[i] = sys[i]!;
  // 16-231: a 6×6×6 RGB cube.
  const steps = [0, 95, 135, 175, 215, 255];
  let idx = 16;
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) p[idx++] = (steps[r]! << 16) | (steps[g]! << 8) | steps[b]!;
  // 232-255: a 24-step grayscale ramp.
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p[232 + i] = (v << 16) | (v << 8) | v;
  }
  return p;
})();

// One xterm cell's foreground as packed 0xRRGGBB, or -1 for the terminal default
// (which the renderer shows in its own neutral terminal color).
export function cellFg(cell: XtermCell): number {
  if (cell.isFgDefault()) return -1;
  if (cell.isFgRGB()) return cell.getFgColor() & 0xffffff;
  // Palette: a bold cell promotes a base color (0-7) to its bright variant (8-15),
  // matching how a real terminal renders bold ANSI colors.
  let idx = cell.getFgColor();
  if (cell.isBold() && idx >= 0 && idx < 8) idx += 8;
  if (idx < 0 || idx > 255) return -1;
  return XTERM_PALETTE[idx]!;
}

// Codepoints in `s` (surrogate pairs count as one) — the unit a renderer walks the
// row text in, so run lengths must agree with it (one codepoint == one display cell).
export function cpCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i++; // skip the trailing surrogate
  }
  return n;
}

let g_cell: XtermCell | undefined; // reused xterm cell buffer (Node is single-threaded — safe to share)

// Build color runs for one buffer line as compact [len, fg] pairs, where `len` counts
// codepoints (matching the renderer's per-codepoint walk) and covers exactly `textCp`
// codepoints (the snapshot's trimmed line length). Returns null when the whole row is
// default-fg, so an all-plain row ships no runs and stays on the cheap monochrome path.
export function buildLineRuns(
  line: XtermLine | undefined,
  cols: number,
  textCp: number,
): ColorRun[] | null {
  if (!line || textCp <= 0) return null;
  const runs: ColorRun[] = [];
  let curFg = -1;
  let curLen = 0;
  let used = 0;
  let sawColor = false;
  for (let col = 0; col < cols && used < textCp; col++) {
    const cell = line.getCell(col, g_cell);
    if (!cell) break;
    g_cell = cell;
    if (cell.getWidth() === 0) continue; // trailing half of a wide glyph — already counted
    const chars = cell.getChars();
    const clen = chars.length === 0 ? 1 : cpCount(chars); // empty cell == one space
    const take = Math.min(clen, textCp - used);
    const fg = cellFg(cell);
    if (fg !== -1) sawColor = true;
    if (fg === curFg) {
      curLen += take;
    } else {
      if (curLen > 0) runs.push([curLen, curFg]);
      curFg = fg;
      curLen = take;
    }
    used += take;
  }
  if (curLen > 0) runs.push([curLen, curFg]);
  return sawColor ? runs : null;
}
