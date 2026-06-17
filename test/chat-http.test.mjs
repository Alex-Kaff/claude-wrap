// HTTP gateway tests with an injected FAKE ChatGateway (no claude spawn).
// Run with: node --test test/chat-http.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatHttpServer, ChatGateway, GatewayError } from "../dist/index.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a server around a fake gateway. Returns { base, server }. */
async function startServer(fakeOverrides, serverOpts = {}) {
  const fake = new ChatGateway();
  fake.shutdown = () => {};
  Object.assign(fake, fakeOverrides);
  if (fakeOverrides.completions) fake.completions = fakeOverrides.completions;
  const server = new ChatHttpServer({ gateway: fake, ...serverOpts });
  const { port, host } = await server.listen(0);
  return { base: `http://${host}:${port}`, server };
}

function completion(content = "hi") {
  return {
    id: "chatcmpl-x",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

test("GET /health", async () => {
  const { base, server } = await startServer({});
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test("GET /v1/models returns the OpenAI list shape", async () => {
  const { base, server } = await startServer({
    listModels: () => ({ object: "list", data: [{ id: "claude-sonnet-4-6", object: "model", created: 1, owned_by: "anthropic" }] }),
  });
  try {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.equal(body.data[0].object, "model");
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions (non-stream) passes through", async () => {
  const { base, server } = await startServer({
    createCompletion: async (req) => completion(`echo:${req.messages[0].content}`),
    completions: { create: (req) => Promise.resolve(completion()) },
  });
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "yo" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "echo:yo");
  } finally {
    server.close();
  }
});

test("unknown route → 404 OpenAI error envelope", async () => {
  const { base, server } = await startServer({});
  try {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(typeof body.error.message, "string");
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    server.close();
  }
});

test("invalid JSON body → 400", async () => {
  const { base, server } = await startServer({});
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /invalid JSON/i);
  } finally {
    server.close();
  }
});

test("GatewayError propagates status + envelope; 429 sets Retry-After", async () => {
  const { base, server } = await startServer({
    createCompletion: async () => {
      throw new GatewayError("rate limited", 429, "rate_limit_error", null, "rate_limited", 42);
    },
  });
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "42");
    const body = await res.json();
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.code, "rate_limited");
  } finally {
    server.close();
  }
});

test("streaming SSE emits chunks then [DONE]", async () => {
  async function* gen() {
    yield { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
    yield { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] };
    yield { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] };
    yield { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  }
  const { base, server } = await startServer({
    completions: { create: () => gen() },
  });
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    const datas = text
      .split("\n\n")
      .map((l) => l.replace(/^data: /, "").trim())
      .filter((l) => l && !l.startsWith(":"));
    assert.equal(datas[datas.length - 1], "[DONE]");
    const content = datas
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d))
      .map((c) => c.choices[0]?.delta?.content ?? "")
      .join("");
    assert.equal(content, "Hello");
  } finally {
    server.close();
  }
});

test("503 when concurrency + queue are exhausted", async () => {
  const { base, server } = await startServer(
    { createCompletion: async () => { await delay(150); return completion(); } },
    { maxConcurrent: 1, maxQueue: 0 },
  );
  try {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    const opts = { method: "POST", headers: { "content-type": "application/json" }, body };
    const [a, b] = await Promise.all([
      fetch(`${base}/v1/chat/completions`, opts),
      // tiny stagger so A grabs the only slot first
      delay(10).then(() => fetch(`${base}/v1/chat/completions`, opts)),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 503]);
    const over = a.status === 503 ? a : b;
    const env = await over.json();
    assert.equal(env.error.type, "overloaded_error");
  } finally {
    server.close();
  }
});

test("lockdown rejects a missing bearer", async () => {
  const { base, server } = await startServer({}, { lockdown: true, bearer: "secret" });
  try {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 401);
    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer secret" } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});
