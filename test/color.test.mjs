// Unit tests for the terminal color extractor and the opt-in colored snapshot.
//
// Two layers:
//   1. The canonical packer (buildLineRuns/cpCount) reads @xterm/headless cells the
//      way consumers assume — exercised end-to-end through a real VirtualScreen.
//   2. VirtualScreen.snapshot({colors}) is OPT-IN and BACKWARD COMPATIBLE: without
//      the flag (or when nothing is colored) the response carries no `colors` field,
//      i.e. byte-for-byte the old shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualScreen } from "../dist/screen.js";
import { cpCount } from "../dist/index.js";

const ESC = "\x1b[";

// xterm's write() callback fires after the data is processed; give it a tick.
function tick(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

// Write `data`, then return the clean colored snapshot of the screen.
async function snap(data, cols = 80) {
  const screen = new VirtualScreen(cols, 8);
  screen.write(data);
  await tick();
  return screen.snapshot(false, true, true); // viewport=false, clean=true, colors=true
}

const sum = (runs) => (runs || []).reduce((a, r) => a + r[0], 0);

// --- cpCount (pure) ----------------------------------------------------------

test("cpCount counts codepoints, surrogate pairs as one", () => {
  assert.equal(cpCount(""), 0);
  assert.equal(cpCount("abc"), 3);
  assert.equal(cpCount("│"), 1); // 3-byte UTF-8, one codepoint
  assert.equal(cpCount("😀"), 1); // surrogate pair → one codepoint
  assert.equal(cpCount("a😀b"), 3);
});

// --- colored snapshot --------------------------------------------------------

test("plain text → no colors field (stays on the monochrome path)", async () => {
  const s = await snap("plain text");
  assert.ok(s.lines.some((l) => l.includes("plain text")));
  assert.equal("colors" in s, false, "all-default screen must omit `colors`");
});

test("palette red splits a row into 3 runs, middle one bright red", async () => {
  const s = await snap(`pre ${ESC}38;5;9mRED${ESC}0m post`);
  assert.equal(s.lines[0], "pre RED post");
  assert.ok(Array.isArray(s.colors), "colors present when a row is colored");
  const runs = s.colors[0];
  assert.deepEqual(runs, [
    [4, -1],
    [3, 0xff0000],
    [5, -1],
  ]);
  assert.equal(sum(runs), cpCount(s.lines[0]), "runs cover the whole line");
});

test("24-bit truecolor round-trips to exact RGB", async () => {
  const s = await snap(`${ESC}38;2;18;52;86mX${ESC}0m`);
  assert.equal(s.colors[0][0][1], 0x123456);
});

test("bold base color promotes to its bright variant", async () => {
  const s = await snap(`${ESC}1;31mB${ESC}0m`);
  assert.equal(s.colors[0][0][1], 0xff0000); // palette 1 + bold → 9 (bright red)
});

test("box-drawing runs count codepoints, not UTF-8 bytes", async () => {
  const s = await snap(`${ESC}32m││${ESC}0m end`);
  assert.equal(s.lines[0], "││ end");
  assert.equal(s.colors[0][0][0], 2, "two bars = two codepoints");
  assert.equal(s.colors[0][0][1], 0x008000); // green
  assert.equal(sum(s.colors[0]), cpCount(s.lines[0]));
});

test("colors is index-aligned with lines; default rows are null", async () => {
  const s = await snap(`a\r\n${ESC}31mRED${ESC}0m\r\nb`);
  assert.deepEqual(s.lines, ["a", "RED", "b"]);
  assert.equal(s.colors.length, s.lines.length);
  assert.equal(s.colors[0], null, "default row → null");
  assert.deepEqual(s.colors[1], [[3, 0x800000]]); // palette 1 (non-bold red) = dark red
  assert.equal(s.colors[2], null, "default row → null");
});

// --- backward compatibility --------------------------------------------------

test("snapshot WITHOUT the colors flag has the exact old shape (no `colors`)", async () => {
  const screen = new VirtualScreen(80, 8);
  screen.write(`${ESC}31mRED${ESC}0m`); // even with color on screen...
  await tick();
  const plain = screen.snapshot(false, true); // ...the unflagged call must omit `colors`
  assert.equal("colors" in plain, false);
  assert.deepEqual(Object.keys(plain).sort(), [
    "baseY",
    "cols",
    "cursor",
    "lines",
    "rows",
    "viewportY",
  ]);
});

test("colors:true but an all-default screen still omits `colors`", async () => {
  const screen = new VirtualScreen(80, 8);
  screen.write("nothing colored here");
  await tick();
  const s = screen.snapshot(false, true, true);
  assert.equal("colors" in s, false);
});
