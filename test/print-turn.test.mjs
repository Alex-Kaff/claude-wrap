// Unit tests for TurnResult aggregation (src/print/turn.ts) against fixtures.
// Offline. Run with: node --test test/print-turn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { collectTurn, TurnAccumulator, parseJsonArray } from "../dist/index.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "fixtures", "print");
const read = (n) => fs.readFileSync(path.join(fixtures, n), "utf8");

test("D_schema: structured output + usage normalized from modelUsage", () => {
  const t = collectTurn(parseJsonArray(read("D_schema.json")), { schemaRequested: true });
  assert.equal(t.subtype, "success");
  assert.equal(t.isError, false);
  assert.equal(t.sessionId, "09645657-dcb7-4777-b98f-e978a5438829");
  assert.deepEqual(t.structuredOutput, { name: "John Smith", age: 30, city: "Paris" });
  assert.equal(t.structuredOutputMissing, undefined);
  assert.match(t.text, /John Smith/);
  assert.equal(t.stopReason, "end_turn");
  assert.equal(t.numTurns, 2);
  assert.equal(t.costUsd, 0.055518);
  // usage normalized from result.modelUsage (NOT the snake_case result.usage)
  assert.deepEqual(t.usage, {
    inputTokens: 535,
    outputTokens: 321,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 26689,
  });
  // tool_use (StructuredOutput) collected
  assert.ok(t.toolCalls.some((c) => c.name === "StructuredOutput"));
  // thinking blocks collected
  assert.ok(Array.isArray(t.thinking) && t.thinking.length >= 1);
  // cache_miss_reason surfaced from assistant diagnostics
  assert.deepEqual(t.cacheMissReason, { type: "tools_changed", cacheMissedInputTokens: 10000 });
  // rate_limit_event surfaced
  assert.equal(t.rateLimit?.status, "allowed");
});

test("structuredOutputMissing set when schema requested but absent", () => {
  const t = collectTurn(parseJsonArray(read("A_json_result.json")), { schemaRequested: true });
  assert.equal(t.structuredOutputMissing, true);
  assert.equal(t.structuredOutput, undefined);
});

test("no structuredOutputMissing flag when no schema requested", () => {
  const t = collectTurn(parseJsonArray(read("A_json_result.json")));
  assert.equal(t.structuredOutputMissing, undefined);
  assert.equal(t.text, "PONG");
});

test("F_isolated: clean call, usage + cost", () => {
  const t = collectTurn(parseJsonArray(read("F_isolated.json")));
  assert.equal(t.text, "HELLO");
  assert.equal(t.costUsd, 0.001229);
  assert.deepEqual(t.usage, {
    inputTokens: 679,
    outputTokens: 110,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
  assert.equal(t.permissionDenials.length, 0);
});

test("TurnAccumulator splits a stream into per-turn brackets; memory carries", () => {
  const lines = read("E_multiturn.jsonl")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const acc = new TurnAccumulator();
  const turns = [];
  for (const m of lines) {
    acc.add(m);
    if (m.type === "result") {
      turns.push(acc.finalize());
      acc.reset();
    }
  }
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, "Forty-two, got it.");
  assert.equal(turns[1].text, "42");
  // single session id across turns (memory carries within the process)
  assert.equal(turns[0].sessionId, turns[1].sessionId);
});

test("finalize throws without a result message", () => {
  const acc = new TurnAccumulator();
  acc.add({ type: "system", subtype: "init", session_id: "x" });
  assert.equal(acc.hasResult, false);
  assert.throws(() => acc.finalize(), /no result/);
});

test("collectTurn picks the LAST result element", () => {
  const msgs = [
    { type: "result", subtype: "success", is_error: false, result: "first", session_id: "s" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
    { type: "result", subtype: "success", is_error: false, result: "last", session_id: "s" },
  ];
  assert.equal(collectTurn(msgs).text, "last");
});
