// Unit tests for VirtualScreen — the headless xterm wrapper that backs both
// the `screen:changed` event and the ContinuousParser. Runs purely in node
// (no PTY) via @xterm/headless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualScreen } from "../dist/screen.js";

// xterm's write() callback fires after the data is processed; give it a tick.
function tick(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

test("onChange fires after write() and snapshot reflects content", async () => {
  const screen = new VirtualScreen(80, 24);
  let changes = 0;
  screen.onChange(() => { changes++; });

  screen.write("hello world\r\n");
  await tick();

  assert.ok(changes >= 1, "onChange should fire at least once after write");
  const snap = screen.snapshot(false, true);
  assert.ok(
    snap.lines.some((l) => l.includes("hello world")),
    "snapshot should contain written text",
  );
});

test("onChange unsubscribe stops further callbacks", async () => {
  const screen = new VirtualScreen(80, 24);
  let changes = 0;
  const unsub = screen.onChange(() => { changes++; });

  screen.write("first\r\n");
  await tick();
  const afterFirst = changes;
  assert.ok(afterFirst >= 1, "should have fired before unsubscribe");

  unsub();
  screen.write("second\r\n");
  await tick();

  assert.equal(changes, afterFirst, "no further callbacks after unsubscribe");
});

test("snapshot clean=true trims trailing whitespace and blank rows", async () => {
  const screen = new VirtualScreen(80, 24);
  screen.write("content   \r\n");
  await tick();

  const clean = screen.snapshot(false, true);
  // No line should retain trailing spaces.
  assert.ok(
    clean.lines.every((l) => l === l.replace(/\s+$/, "")),
    "clean snapshot lines should have no trailing whitespace",
  );
  // Trailing blank rows (the empty bottom of a 24-row screen) are dropped.
  assert.ok(
    clean.lines.length === 0 || clean.lines[clean.lines.length - 1] !== "",
    "clean snapshot should not end with a blank row",
  );
});

test("multiple onChange listeners all fire", async () => {
  const screen = new VirtualScreen(80, 24);
  let a = 0, b = 0;
  screen.onChange(() => { a++; });
  screen.onChange(() => { b++; });

  screen.write("x\r\n");
  await tick();

  assert.ok(a >= 1 && b >= 1, "both listeners should fire");
});
