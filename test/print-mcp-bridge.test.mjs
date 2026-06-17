// Unit tests for the in-process SDK-MCP bridge (src/print/mcp-bridge.ts). Offline.
// Run with: node --test test/print-mcp-bridge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { McpControlBridge } from "../dist/index.js";

function bridge() {
  return new McpControlBridge("fns", [
    {
      name: "add",
      description: "add two numbers",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      handler: async (input) => ({ content: [{ type: "text", text: String(input.a + input.b) }] }),
    },
    {
      name: "boom",
      handler: async () => {
        throw new Error("kaboom");
      },
    },
  ]);
}

test("qualifiedToolNames are mcp__<server>__<tool>", () => {
  assert.deepEqual(bridge().qualifiedToolNames, ["mcp__fns__add", "mcp__fns__boom"]);
});

test("initialize returns serverInfo + tools capability", async () => {
  const r = await bridge().handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(r.result.serverInfo.name, "fns");
  assert.ok(r.result.capabilities.tools);
});

test("tools/list lists the registered tools", async () => {
  const r = await bridge().handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(r.result.tools.map((t) => t.name), ["add", "boom"]);
  assert.equal(r.result.tools[0].description, "add two numbers");
});

test("tools/call invokes the handler", async () => {
  const r = await bridge().handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add", arguments: { a: 2, b: 3 } } });
  assert.equal(r.result.content[0].text, "5");
  assert.equal(r.result.isError, false);
});

test("tools/call on a throwing handler returns isError content (never throws)", async () => {
  const r = await bridge().handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /kaboom/);
});

test("tools/call on an unknown tool returns a JSON-RPC error", async () => {
  const r = await bridge().handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } });
  assert.ok(r.error);
  assert.match(r.error.message, /unknown tool/);
});

test("notifications (no id) return null", async () => {
  assert.equal(await bridge().handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});
