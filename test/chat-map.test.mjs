// Offline unit tests for OpenAI request/response mapping (src/chat/*).
// Run with: node --test test/chat-map.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { mapRequest, mapFinishReason, usageFromTurn, turnToCompletion, messageContent } from "../dist/index.js";
import {
  openingChunk,
  contentChunk,
  finalChunk,
  usageChunk,
  approxTokens,
  stripCodeFence,
} from "../dist/chat/map-response.js";

// --- map-request ---

test("system messages become systemPrompt (replace) by default", async () => {
  const m = await mapRequest({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(m.printOptions.systemPrompt, "You are terse.");
  assert.equal(m.printOptions.appendSystemPrompt, undefined);
  assert.equal(m.history, "replay");
  assert.equal(m.printOptions.isolate, true);
  assert.equal(m.printOptions.persistSession, false);
});

test("appendSystem option routes to appendSystemPrompt", async () => {
  const m = await mapRequest(
    { model: "x", messages: [{ role: "system", content: "extra" }, { role: "user", content: "hi" }] },
    { appendSystem: true },
  );
  assert.equal(m.printOptions.appendSystemPrompt, "extra");
  assert.equal(m.printOptions.systemPrompt, undefined);
});

test("single user message replay sends verbatim content (no role label)", async () => {
  const m = await mapRequest({ model: "x", messages: [{ role: "user", content: "Describe rain." }] });
  assert.deepEqual(m.content, [{ type: "text", text: "Describe rain." }]);
});

test("multi-turn replay flattens with role labels + trailing Assistant:", async () => {
  const m = await mapRequest({
    model: "x",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ],
  });
  const joined = m.content.map((b) => (b.type === "text" ? b.text : "[img]")).join("");
  assert.match(joined, /User: hi/);
  assert.match(joined, /Assistant: hello/);
  assert.match(joined, /User: bye/);
  assert.match(joined.trimEnd(), /Assistant:$/);
});

test("response_format json_schema sets jsonSchema + responseFormatActive", async () => {
  const schema = { type: "object", properties: { x: { type: "number" } } };
  const m = await mapRequest({
    model: "x",
    messages: [{ role: "user", content: "go" }],
    response_format: { type: "json_schema", json_schema: { schema } },
  });
  assert.deepEqual(m.printOptions.jsonSchema, schema);
  assert.equal(m.responseFormatActive, true);
});

test("response_format json_object appends an instruction, no schema", async () => {
  const m = await mapRequest({
    model: "x",
    messages: [{ role: "user", content: "go" }],
    response_format: { type: "json_object" },
  });
  assert.equal(m.jsonObjectMode, true);
  assert.equal(m.responseFormatActive, true);
  assert.match(m.printOptions.systemPrompt ?? "", /valid JSON object/);
  assert.equal(m.printOptions.jsonSchema, undefined);
});

test("sampling params produce warnings (ignored)", async () => {
  const m = await mapRequest({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.9,
    seed: 1,
  });
  assert.ok(m.warnings.some((w) => /temperature/.test(w)));
  assert.ok(m.warnings.some((w) => /top_p/.test(w)));
  assert.ok(m.warnings.some((w) => /seed/.test(w)));
});

test("max_tokens / max_completion_tokens surfaced", async () => {
  assert.equal((await mapRequest({ model: "x", messages: [{ role: "user", content: "h" }], max_tokens: 50 })).maxTokens, 50);
  assert.equal(
    (await mapRequest({ model: "x", messages: [{ role: "user", content: "h" }], max_completion_tokens: 70 })).maxTokens,
    70,
  );
});

test("session_id selects session history and sends only the new user turn", async () => {
  const m = await mapRequest({
    model: "x",
    session_id: "abc",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
  });
  assert.equal(m.history, "session");
  assert.equal(m.sessionId, "abc");
  assert.deepEqual(m.content, [{ type: "text", text: "second" }]);
});

test("data: URI image decodes to a base64 image block (no network)", async () => {
  const dataUri = "data:image/png;base64,aGVsbG8=";
  const m = await mapRequest({
    model: "x",
    messages: [
      { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: dataUri } }] },
    ],
  });
  const img = m.content.find((b) => b.type === "image");
  assert.ok(img, "expected an image block");
  assert.equal(img.source.media_type, "image/png");
  assert.equal(img.source.data, "aGVsbG8=");
});

test("caller mcp disables isolate but keeps strict + empty settings", async () => {
  const m = await mapRequest({
    model: "x",
    messages: [{ role: "user", content: "h" }],
    mcp: { mcpServers: { foo: { command: "x" } } },
  });
  assert.equal(m.printOptions.isolate, false);
  assert.equal(m.printOptions.strictMcpConfig, true);
  assert.deepEqual(m.printOptions.settingSources, []);
  assert.deepEqual(m.printOptions.mcpConfig, { mcpServers: { foo: { command: "x" } } });
});

test("streaming requests pin persistent transport + partial messages", async () => {
  const m = await mapRequest({ model: "x", stream: true, messages: [{ role: "user", content: "h" }] });
  assert.equal(m.stream, true);
  assert.equal(m.printOptions.transport, "persistent");
  assert.equal(m.printOptions.includePartialMessages, true);
});

// --- map-response ---

function fakeTurn(over = {}) {
  return {
    sessionId: "s",
    text: "hello world",
    isError: false,
    subtype: "success",
    stopReason: "end_turn",
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 5 },
    cacheMissReason: null,
    costUsd: 0.001,
    numTurns: 1,
    durationMs: 10,
    permissionDenials: [],
    raw: [],
    ...over,
  };
}

test("mapFinishReason covers the OpenAI enum", () => {
  assert.equal(mapFinishReason(fakeTurn({ stopReason: "end_turn" })), "stop");
  assert.equal(mapFinishReason(fakeTurn({ stopReason: "stop_sequence" })), "stop");
  assert.equal(mapFinishReason(fakeTurn({ stopReason: "max_tokens" })), "length");
  assert.equal(mapFinishReason(fakeTurn({ stopReason: "tool_use" })), "tool_calls");
  assert.equal(mapFinishReason(fakeTurn({ stopReason: undefined, subtype: "error_max_turns" })), "length");
  assert.equal(mapFinishReason(fakeTurn({}), { maxTokensHit: true }), "length");
});

test("usageFromTurn: cached is a subset of prompt", () => {
  const u = usageFromTurn(fakeTurn());
  assert.equal(u.prompt_tokens, 100 + 30 + 5);
  assert.equal(u.completion_tokens, 20);
  assert.equal(u.total_tokens, 135 + 20);
  assert.equal(u.prompt_tokens_details.cached_tokens, 30);
});

test("turnToCompletion: text vs structured content", () => {
  const plain = turnToCompletion(fakeTurn(), { model: "m", responseFormatActive: false });
  assert.equal(plain.object, "chat.completion");
  assert.equal(plain.choices[0].message.content, "hello world");
  assert.equal(plain.choices[0].finish_reason, "stop");

  const structured = turnToCompletion(
    fakeTurn({ structuredOutput: { a: 1 } }),
    { model: "m", responseFormatActive: true },
  );
  assert.equal(structured.choices[0].message.content, '{"a":1}');
});

test("turnToCompletion: max_tokens truncates non-structured content", () => {
  const long = "x".repeat(400); // ~100 tokens
  const c = turnToCompletion(fakeTurn({ text: long }), { model: "m", responseFormatActive: false, maxTokens: 10 });
  assert.ok(c.choices[0].message.content.length <= 40);
  assert.equal(c.choices[0].finish_reason, "length");
});

test("messageContent never empty when structured output exists", () => {
  const t = fakeTurn({ text: "", structuredOutput: { ok: true } });
  assert.equal(messageContent(t, true), '{"ok":true}');
});

test("stripCodeFence unwraps a ```json fence; leaves bare/plain text alone", () => {
  assert.equal(stripCodeFence('```json\n{"name":"Bob"}\n```'), '{"name":"Bob"}');
  assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"already":"json"}'), '{"already":"json"}');
  assert.equal(stripCodeFence("hello"), "hello");
});

test("messageContent strips a fence in json_object mode (responseFormatActive, no structured)", () => {
  const t = fakeTurn({ text: '```json\n{"name":"Bob"}\n```', structuredOutput: undefined });
  assert.equal(messageContent(t, true), '{"name":"Bob"}');
  // but NOT for normal chat (responseFormatActive false)
  assert.equal(messageContent(fakeTurn({ text: "```js\ncode\n```" }), false), "```js\ncode\n```");
});

test("streaming chunk builders shape", () => {
  const base = { id: "chatcmpl-1", model: "m", created: 100 };
  assert.deepEqual(openingChunk(base).choices[0].delta, { role: "assistant" });
  assert.equal(contentChunk(base, "hi").choices[0].delta.content, "hi");
  assert.equal(finalChunk(base, "stop").choices[0].finish_reason, "stop");
  const u = usageChunk(base, usageFromTurn(fakeTurn()));
  assert.deepEqual(u.choices, []);
  assert.ok(u.usage.total_tokens > 0);
  assert.equal(approxTokens("12345678"), 2);
});
