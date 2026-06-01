// Unit tests for waitIdle / waitFor against a FakeClient that serves
// scripted snapshots. No wrapper or pipe required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitIdle, waitFor } from "../dist/wait.js";
import { TimeoutError } from "../dist/errors.js";

// Minimal IClient impl — each snapshot() call pops the next scripted
// lines[] from the queue (or repeats the last one if exhausted).
class FakeClient {
  constructor(frames) {
    this.frames = frames.map((lines) => (Array.isArray(lines) ? lines : [lines]));
    this.cursor = 0;
    this.writes = [];
    this.closed = false;
  }
  async snapshot() {
    const i = Math.min(this.cursor, this.frames.length - 1);
    this.cursor++;
    return {
      version: 1,
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0 },
      viewportY: 0,
      baseY: 0,
      lines: this.frames[i],
    };
  }
  async write(data) {
    this.writes.push(data);
  }
  close() {
    this.closed = true;
  }
}

const BUSY = ["✢ Tempering…", "❯ what is 2+2", "  ⏵⏵ accept edits on · 123 tokens"];
const IDLE = ["❯ ", "  ⏵⏵ accept edits on · 123 tokens"];
const PERMISSION = [
  " Bash command",
  " mkdir foo",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "  ⏵⏵ accept edits on · 123 tokens",
];

test("waitIdle resolves once the spinner clears and input is empty", async () => {
  const fake = new FakeClient([BUSY, BUSY, IDLE]);
  await waitIdle(fake, { interval: 1, timeoutMs: 1000 });
  assert.ok(fake.cursor >= 3, "should poll at least until idle frame");
});

test("waitIdle resolves immediately if a permission prompt is up", async () => {
  const fake = new FakeClient([PERMISSION]);
  await waitIdle(fake, { interval: 1, timeoutMs: 1000 });
});

test("waitIdle rejects with TimeoutError when the busy state never clears", async () => {
  const fake = new FakeClient([BUSY]);
  await assert.rejects(
    () => waitIdle(fake, { interval: 5, timeoutMs: 200 }),
    (e) => e instanceof TimeoutError,
  );
});

test("waitFor resolves with the first matching line", async () => {
  const fake = new FakeClient([
    ["nothing here", "still nothing"],
    ["still nothing", "target line: hello"],
  ]);
  const line = await waitFor(fake, /target/, { interval: 1, timeoutMs: 1000 });
  assert.match(line, /target line/);
});

test("waitFor rejects with TimeoutError when the pattern never appears", async () => {
  const fake = new FakeClient([["no match here"]]);
  await assert.rejects(
    () => waitFor(fake, /never/, { interval: 5, timeoutMs: 200 }),
    (e) => e instanceof TimeoutError,
  );
});

test("waitIdle does not close a caller-owned client", async () => {
  const fake = new FakeClient([IDLE]);
  await waitIdle(fake, { interval: 1, timeoutMs: 100 });
  assert.equal(fake.closed, false, "caller-owned clients must not be closed by waitIdle");
});
