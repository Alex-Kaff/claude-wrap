// Unit tests for diff history (src/chat/diff-history.ts). Offline.
// Run with: node --test test/chat-diff.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { DiffHistory } from "../dist/index.js";

const U = (text) => ({ role: "user", content: text });
const A = (text) => ({ role: "assistant", content: text });

test("plan: replay when no assistant message (fresh conversation)", () => {
  const d = new DiffHistory();
  assert.deepEqual(d.plan([U("hi")]), { mode: "replay" });
});

test("plan: replay when prefix is unknown", () => {
  const d = new DiffHistory();
  assert.deepEqual(d.plan([U("hi"), A("hello"), U("more")]), { mode: "replay" });
});

test("record then plan: resume on an exact prefix-extension", () => {
  const d = new DiffHistory();
  const turn1 = [U("hi")];
  // After turn 1, the assistant replied "hello" via claude session SID.
  d.record(turn1, "hello", "SID-1");
  // Next request extends the exact prefix: [user hi, assistant hello, user more]
  const plan = d.plan([U("hi"), A("hello"), U("more")]);
  assert.equal(plan.mode, "resume");
  assert.equal(plan.claudeSessionId, "SID-1");
  assert.deepEqual(
    plan.newMessages.map((m) => m.content),
    ["more"],
  );
});

test("plan: divergent history falls back to replay (safety)", () => {
  const d = new DiffHistory();
  d.record([U("hi")], "hello", "SID-1");
  // Client altered the assistant content → hash mismatch → replay (never resume mismatched).
  const plan = d.plan([U("hi"), A("HELLO DIFFERENT"), U("more")]);
  assert.deepEqual(plan, { mode: "replay" });
});

test("multi-turn chain resumes the latest committed prefix", () => {
  const d = new DiffHistory();
  d.record([U("a")], "1", "SID");
  // turn 2 extends and we record the longer prefix
  const t2 = [U("a"), A("1"), U("b")];
  assert.equal(d.plan(t2).mode, "resume");
  d.record(t2, "2", "SID");
  // turn 3 must match the longer committed prefix
  const plan3 = d.plan([U("a"), A("1"), U("b"), A("2"), U("c")]);
  assert.equal(plan3.mode, "resume");
  assert.deepEqual(plan3.newMessages.map((m) => m.content), ["c"]);
});

test("tool messages count as new turns in resume", () => {
  const d = new DiffHistory();
  d.record([U("call a tool")], "ok", "SID");
  const plan = d.plan([
    U("call a tool"),
    A("ok"),
    { role: "tool", content: "tool result", tool_call_id: "t1" },
  ]);
  assert.equal(plan.mode, "resume");
  assert.equal(plan.newMessages.length, 1);
  assert.equal(plan.newMessages[0].role, "tool");
});
