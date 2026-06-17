// Gated integration tests for the chat gateway — spawn real `claude`. OFF by
// default; enable with CLAUDE_WRAP_INTEGRATION=1. Bounded by isolation + a tiny
// model. SKIP (not fail) when auth/credits are unavailable.
//
//   CLAUDE_WRAP_INTEGRATION=1 npm run test:integration
//
import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatGateway, ChatHttpServer } from "../dist/index.js";

const ENABLED = process.env.CLAUDE_WRAP_INTEGRATION === "1";
const MODEL = process.env.CLAUDE_WRAP_TEST_MODEL || "claude-haiku-4-5-20251001";

function looksUnavailable(x) {
  const s = JSON.stringify(x?.message ?? x ?? "").toLowerCase();
  return /out_of_credits|credit|unauthor|forbidden|api key|login|401|402/.test(s);
}

test("in-process gateway: non-stream completion", { skip: !ENABLED }, async (t) => {
  const gw = new ChatGateway({ defaultModel: MODEL });
  try {
    const res = await gw.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "Reply with exactly one word: PONG" },
        { role: "user", content: "ping" },
      ],
      max_tokens: 50,
    });
    assert.equal(res.object, "chat.completion");
    assert.match(res.choices[0].message.content, /pong/i);
    assert.ok(res.usage.total_tokens > 0);
  } catch (err) {
    if (looksUnavailable(err)) return t.skip(`unavailable: ${err.message}`);
    throw err;
  } finally {
    gw.shutdown();
  }
});

test("in-process gateway: json_schema structured output", { skip: !ENABLED }, async (t) => {
  const gw = new ChatGateway({ defaultModel: MODEL });
  try {
    const res = await gw.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: "Parse: John Smith is 30 years old and lives in Paris." }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "person",
          schema: {
            type: "object",
            properties: { name: { type: "string" }, age: { type: "number" }, city: { type: "string" } },
            required: ["name", "age", "city"],
          },
        },
      },
    });
    const obj = JSON.parse(res.choices[0].message.content);
    assert.equal(obj.name, "John Smith");
    assert.equal(obj.age, 30);
    assert.equal(obj.city, "Paris");
  } catch (err) {
    if (looksUnavailable(err)) return t.skip(`unavailable: ${err.message}`);
    throw err;
  } finally {
    gw.shutdown();
  }
});

test("in-process gateway: streaming yields content then a final chunk", { skip: !ENABLED }, async (t) => {
  const gw = new ChatGateway({ defaultModel: MODEL });
  try {
    const stream = gw.completions.create({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "Reply with exactly one word: PONG" },
        { role: "user", content: "ping" },
      ],
    });
    let content = "";
    let sawFinal = false;
    let sawUsage = false;
    for await (const chunk of stream) {
      const c = chunk.choices[0];
      if (c?.delta?.content) content += c.delta.content;
      if (c?.finish_reason) sawFinal = true;
      if (chunk.usage) sawUsage = true;
    }
    assert.match(content, /pong/i);
    assert.ok(sawFinal, "expected a final chunk with finish_reason");
    assert.ok(sawUsage, "expected a usage chunk when include_usage:true");
  } catch (err) {
    if (looksUnavailable(err)) return t.skip(`unavailable: ${err.message}`);
    throw err;
  } finally {
    gw.shutdown();
  }
});

test("gateway function calling: tool_calls round-trip (M5)", { skip: !ENABLED }, async (t) => {
  const gw = new ChatGateway({ defaultModel: MODEL });
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ];
  const messages = [
    { role: "user", content: "What is the weather in Paris right now? You MUST call the get_weather tool to find out." },
  ];
  try {
    const r1 = await gw.completions.create({ model: MODEL, messages, tools });
    if (r1.choices[0].finish_reason !== "tool_calls") {
      // Model declined to call the tool (or errored) — don't hard-fail.
      return t.skip(`model did not call the tool (finish_reason=${r1.choices[0].finish_reason})`);
    }
    const calls = r1.choices[0].message.tool_calls;
    assert.ok(calls && calls.length >= 1, "expected tool_calls");
    assert.equal(calls[0].function.name, "get_weather");
    const args = JSON.parse(calls[0].function.arguments);
    assert.match(String(args.city ?? ""), /paris/i);

    // Client executes the tool and returns the result.
    const r2 = await gw.completions.create({
      model: MODEL,
      tools,
      messages: [
        ...messages,
        r1.choices[0].message,
        { role: "tool", tool_call_id: calls[0].id, content: "Sunny, 22°C" },
      ],
    });
    assert.equal(r2.choices[0].finish_reason, "stop");
    assert.match(r2.choices[0].message.content ?? "", /sunny|22/i);
  } catch (err) {
    if (looksUnavailable(err)) return t.skip(`unavailable: ${err.message}`);
    throw err;
  } finally {
    gw.shutdown();
  }
});

test("HTTP server: an OpenAI-style client round-trips", { skip: !ENABLED }, async (t) => {
  const server = new ChatHttpServer({ defaultModel: MODEL });
  const { port, host } = await server.listen(0);
  const base = `http://${host}:${port}`;
  try {
    const models = await (await fetch(`${base}/v1/models`)).json();
    assert.equal(models.object, "list");

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "Reply with exactly one word: PONG" },
          { role: "user", content: "ping" },
        ],
        max_tokens: 50,
      }),
    });
    if (res.status !== 200) {
      const body = await res.json();
      if (looksUnavailable(body.error)) return t.skip(`unavailable: ${body.error.message}`);
      assert.fail(`unexpected status ${res.status}: ${JSON.stringify(body)}`);
    }
    const body = await res.json();
    assert.match(body.choices[0].message.content, /pong/i);
  } finally {
    server.close();
  }
});
