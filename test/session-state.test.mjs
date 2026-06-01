// Unit tests for ContinuousParser diffing logic.
// Uses a FakeScreen + FakeEmitter to test parse→diff→emit without a real PTY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContinuousParser, emptyState } from "../dist/session-state.js";
import { createEmitter } from "../dist/events.js";

// ---------------------------------------------------------------------------
// Fake VirtualScreen: accepts onChange listeners, fires them on write()
// ---------------------------------------------------------------------------
class FakeScreen {
  constructor() {
    this.listeners = [];
    this._lines = [];
    this._cols = 80;
    this._rows = 24;
  }
  onChange(cb) {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  setLines(lines) {
    this._lines = lines;
    // Simulate xterm write callback — fire listeners synchronously
    for (const cb of this.listeners) cb();
  }
  snapshot(_viewportOnly, _clean) {
    return {
      cols: this._cols,
      rows: this._rows,
      cursor: { x: 0, y: 0 },
      viewportY: 0,
      baseY: 0,
      lines: this._lines.slice(),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect events emitted during an operation. */
function collectEvents(emitter, eventName) {
  const events = [];
  emitter.on(eventName, (payload) => events.push(payload));
  return events;
}

/** Wait for debounce to fire (debounceMs + margin). */
function tick(ms = 80) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("emptyState has correct defaults", () => {
  const s = emptyState();
  assert.equal(s.status.busy, false);
  assert.equal(s.status.mode, null);
  assert.equal(s.status.tokens, null);
  assert.deepEqual(s.toolCalls, []);
  assert.equal(s.permissionPrompt, null);
  assert.deepEqual(s.userPrompts, []);
  assert.equal(s.todoList, null);
});

test("ContinuousParser emits status:busy when 'esc to interrupt' appears", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-1", 10);
  const busyEvents = collectEvents(emitter, "status:busy");

  // Busy is keyed off the bottom bar's "esc to interrupt" hint (v2.1.159+).
  screen.setLines([
    "● Bash(echo hi)",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt   100 tokens",
  ]);

  await tick(30);
  assert.equal(busyEvents.length, 1);
  assert.equal(busyEvents[0].instance, "test-1");
  assert.equal(parser.current.status.busy, true);
  parser.dispose();
});

test("ContinuousParser emits status:idle when 'esc to interrupt' clears", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  // Short idle-cooldown (20ms) so the test is deterministic; the cooldown
  // self-schedules a reparse, so idle fires ~debounce+cooldown after the
  // busy hint clears even though the screen is static afterward.
  const parser = new ContinuousParser(screen, emitter, "test-2", 10, 20);
  const idleEvents = collectEvents(emitter, "status:idle");

  // First: busy (bar shows "esc to interrupt")
  screen.setLines([
    "● Bash(echo hi)",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt   100 tokens",
  ]);
  await tick(30);

  // Then: idle (bar shows "← for agents" instead)
  screen.setLines(["❯ ", "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents   200 tokens"]);
  await tick(80); // > debounce(10) + cooldown(20), with margin

  assert.equal(idleEvents.length, 1);
  assert.equal(parser.current.status.busy, false);
  parser.dispose();
});

test("ContinuousParser emits tool:start for new tool calls", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-3", 10);
  const starts = collectEvents(emitter, "tool:start");

  screen.setLines([
    "❯ do the thing",
    "● Bash(mkdir -p /test)",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);

  assert.equal(starts.length, 1);
  assert.equal(starts[0].tool, "Bash");
  assert.equal(starts[0].args, "mkdir -p /test");
  parser.dispose();
});

test("ContinuousParser emits tool:complete when result appears", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-4", 10);
  const completed = collectEvents(emitter, "tool:complete");

  // Tool with no result
  screen.setLines(["❯ do stuff", "● Bash(ls)", "  ⏵⏵ accept edits on · 100 tokens"]);
  await tick(30);

  // Tool with result
  screen.setLines([
    "❯ do stuff",
    "● Bash(ls)",
    "  ⎿ file1.txt",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);

  assert.equal(completed.length, 1);
  assert.equal(completed[0].tool, "Bash");
  assert.match(completed[0].result, /file1\.txt/);
  parser.dispose();
});

test("tool diffing handles duplicate (tool, args) positionally", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-5", 10);
  const starts = collectEvents(emitter, "tool:start");

  // Two Read calls
  screen.setLines([
    "❯ read files",
    "● Read(file.ts)",
    "  ⎿ Read 10 lines",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);
  assert.equal(starts.length, 1);

  // Second Read call with same args
  screen.setLines([
    "❯ read files",
    "● Read(file.ts)",
    "  ⎿ Read 10 lines",
    "● Read(file.ts)",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);

  assert.equal(starts.length, 2);
  assert.equal(starts[1].tool, "Read");
  parser.dispose();
});

test("ContinuousParser emits permission:prompt and permission:resolved", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-6", 10);
  const prompts = collectEvents(emitter, "permission:prompt");
  const resolved = collectEvents(emitter, "permission:resolved");

  // Permission appears
  screen.setLines([
    " Bash command",
    " mkdir foo",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].prompt.options.length, 2);

  // Permission resolved
  screen.setLines(["❯ ", "  ⏵⏵ accept edits on · 200 tokens"]);
  await tick(30);

  assert.equal(resolved.length, 1);
  parser.dispose();
});

test("ContinuousParser emits prompt:user for new user prompts", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-7", 10);
  const userPrompts = collectEvents(emitter, "prompt:user");

  screen.setLines(["❯ first prompt", "  ⏵⏵ accept edits on · 100 tokens"]);
  await tick(30);
  assert.equal(userPrompts.length, 1);
  assert.equal(userPrompts[0].text, "first prompt");

  // Second prompt appears
  screen.setLines([
    "❯ first prompt",
    "some response",
    "❯ second prompt",
    "  ⏵⏵ accept edits on · 200 tokens",
  ]);
  await tick(30);

  assert.equal(userPrompts.length, 2);
  assert.equal(userPrompts[1].text, "second prompt");
  parser.dispose();
});

test("ContinuousParser emits todo:changed", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-8", 10);
  const todoEvents = collectEvents(emitter, "todo:changed");

  screen.setLines([
    "3 tasks (0 done, 3 open)",
    "◻ Task one",
    "◻ Task two",
    "◻ Task three",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);

  assert.equal(todoEvents.length, 1);
  assert.equal(todoEvents[0].todoList.total, 3);

  // One task done
  screen.setLines([
    "3 tasks (1 done, 2 open)",
    "✔ Task one",
    "◻ Task two",
    "◻ Task three",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);

  assert.equal(todoEvents.length, 2);
  assert.equal(todoEvents[1].todoList.done, 1);
  parser.dispose();
});

test("ContinuousParser trailing-edge debounce coalesces rapid writes", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-9", 30);
  const changes = collectEvents(emitter, "state:changed");

  // Rapid-fire 5 writes within debounce window
  for (let i = 0; i < 5; i++) {
    screen.setLines([`❯ prompt ${i}`, "  ⏵⏵ accept edits on · 100 tokens"]);
  }

  // Should NOT have fired yet (debounce pending)
  assert.equal(changes.length, 0);

  // Wait for debounce
  await tick(60);

  // Should have fired exactly once, with the final state
  assert.equal(changes.length, 1);
  parser.dispose();
});

test("dispose() cancels pending debounce timer", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-10", 50);
  const changes = collectEvents(emitter, "state:changed");

  screen.setLines(["❯ hello", "  ⏵⏵ accept edits on · 100 tokens"]);
  // Timer is pending but hasn't fired yet
  parser.dispose();

  await tick(80);
  assert.equal(changes.length, 0, "no events after dispose");
});

test("flush() triggers immediate reparse", () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-11", 1000);

  // Set lines directly (not via setLines) to avoid triggering onChange,
  // so we can test that flush() parses independently of the debounce cycle.
  screen._lines = [
    "● Bash(echo hi)",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt   100 tokens",
  ];

  parser.flush();
  assert.equal(parser.current.status.busy, true);
  parser.dispose();
});

test("once() works when emitter methods are destructured", () => {
  const emitter = createEmitter();
  const { once, emit } = emitter;
  const p = once("status:busy");
  emit("status:busy", { instance: "x" });
  return p.then((payload) => {
    assert.equal(payload.instance, "x");
  });
});

test("prompt:user detected when scrollback eviction + new prompt happen simultaneously", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-evict", 10);
  const userPrompts = collectEvents(emitter, "prompt:user");

  // Initial: two prompts visible
  screen.setLines([
    "❯ first prompt",
    "some response",
    "❯ second prompt",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);
  assert.equal(userPrompts.length, 2);

  // Scrollback evicts "first prompt", adds "third prompt" in same cycle.
  // Array length stays at 2 — old length-based diff would miss this.
  screen.setLines([
    "❯ second prompt",
    "more response",
    "❯ third prompt",
    "  ⏵⏵ accept edits on · 200 tokens",
  ]);
  await tick(30);

  assert.equal(userPrompts.length, 3);
  assert.equal(userPrompts[2].text, "third prompt");
  parser.dispose();
});

test("todo:changed emitted when todo list disappears", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-todo-gone", 10);
  const todoEvents = collectEvents(emitter, "todo:changed");

  // Todo present
  screen.setLines([
    "2 tasks (1 done, 1 open)",
    "✔ Task one",
    "◻ Task two",
    "  ⏵⏵ accept edits on · 100 tokens",
  ]);
  await tick(30);
  assert.equal(todoEvents.length, 1);
  assert.ok(todoEvents[0].todoList !== null);

  // Todo disappears from screen
  screen.setLines(["❯ ", "  ⏵⏵ accept edits on · 200 tokens"]);
  await tick(30);

  assert.equal(todoEvents.length, 2);
  assert.equal(todoEvents[1].todoList, null);
  parser.dispose();
});

test("lastActivity only updates on actual changes", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-activity", 10);

  const lines = ["❯ hello", "  ⏵⏵ accept edits on · 100 tokens"];

  screen.setLines(lines);
  await tick(30);
  const firstActivity = parser.current.lastActivity;

  // Wait a bit, then set same lines
  await tick(50);
  screen.setLines(lines);
  await tick(30);

  // lastActivity should NOT have changed
  assert.equal(parser.current.lastActivity, firstActivity);
  parser.dispose();
});

test("lastActivity updates when state actually changes", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-activity-pos", 10);

  screen.setLines(["❯ hello", "  ⏵⏵ accept edits on · 100 tokens"]);
  await tick(30);
  const firstActivity = parser.current.lastActivity;

  await tick(50);

  // Different state — lastActivity SHOULD update
  screen.setLines(["❯ hello", "● Bash(ls)", "  ⏵⏵ accept edits on · 200 tokens"]);
  await tick(30);

  assert.notEqual(parser.current.lastActivity, firstActivity);
  assert.ok(parser.current.lastActivity > firstActivity);
  parser.dispose();
});

test("once() cancel prevents subscription leak", () => {
  const emitter = createEmitter();
  const p = emitter.once("status:busy");
  p.cancel();
  // Emit after cancel — should not resolve
  let resolved = false;
  p.then(() => {
    resolved = true;
  });
  emitter.emit("status:busy", { instance: "x" });
  // Synchronous check — handler was removed, promise never resolves
  assert.equal(resolved, false);
});

test("state:changed not emitted when nothing changes", async () => {
  const screen = new FakeScreen();
  const emitter = createEmitter();
  const parser = new ContinuousParser(screen, emitter, "test-12", 10);
  const changes = collectEvents(emitter, "state:changed");

  const lines = ["❯ ", "  ⏵⏵ accept edits on · 100 tokens"];

  screen.setLines(lines);
  await tick(30);
  assert.equal(changes.length, 1); // initial state -> idle

  // Set same lines again
  screen.setLines(lines);
  await tick(30);

  // Should not emit again (nothing changed)
  assert.equal(changes.length, 1);
  parser.dispose();
});
