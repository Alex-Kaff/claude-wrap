// Unit tests for the SDK control-protocol channel (src/print/control.ts).
// Offline — drives ControlChannel with a fake stdin writer. Wire format is the
// shape verified empirically against claude 2.1.179.
// Run with: node --test test/print-control.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlChannel } from "../dist/print/control.js";

function harness() {
  const lines = [];
  const perms = [];
  const ch = new ControlChannel(
    (line) => lines.push(JSON.parse(line.replace(/\n$/, ""))),
    (call, requestId) => perms.push({ call, requestId }),
  );
  return { ch, lines, perms };
}

test("initialize writes the {subtype:initialize, hooks, sdkMcpServers} frame", () => {
  const { ch, lines } = harness();
  ch.initialize();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "control_request");
  assert.equal(lines[0].request.subtype, "initialize");
  assert.deepEqual(lines[0].request.hooks, {});
  assert.deepEqual(lines[0].request.sdkMcpServers, []);
  assert.ok(typeof lines[0].request_id === "string");
});

test("control_response resolves the matching pending request", async () => {
  const { ch, lines } = harness();
  const p = ch.initialize();
  const reqId = lines[0].request_id;
  ch.handle({ type: "control_response", response: { subtype: "success", request_id: reqId, response: { ok: 1 } } });
  assert.deepEqual(await p, { ok: 1 });
});

test("inbound can_use_tool is mapped + surfaced to onPermission", () => {
  const { ch, perms } = harness();
  const consumed = ch.handle({
    type: "control_request",
    request_id: "r1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      display_name: "Write",
      input: { file_path: "a.txt", content: "x" },
      description: "a.txt",
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits" }],
      tool_use_id: "toolu_1",
    },
  });
  assert.equal(consumed, true);
  assert.equal(perms.length, 1);
  assert.equal(perms[0].requestId, "r1");
  assert.deepEqual(perms[0].call, {
    name: "Write",
    input: { file_path: "a.txt", content: "x" },
    id: "toolu_1",
    displayName: "Write",
    description: "a.txt",
    suggestions: [{ type: "setMode", mode: "acceptEdits" }],
  });
});

test("respondPermission writes the allow/deny control_response frames", () => {
  const { ch, lines } = harness();
  ch.respondPermission("r1", { behavior: "allow", updatedInput: { a: 1 } });
  assert.deepEqual(lines[0], {
    type: "control_response",
    response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { a: 1 } } },
  });
  ch.respondPermission("r2", { behavior: "deny", message: "no" });
  assert.deepEqual(lines[1].response.response, { behavior: "deny", message: "no" });
});

test("interrupt + setPermissionMode frames", () => {
  const { ch, lines } = harness();
  ch.interrupt();
  assert.equal(lines[0].request.subtype, "interrupt");
  ch.setPermissionMode("acceptEdits");
  assert.equal(lines[1].request.subtype, "set_permission_mode");
  assert.equal(lines[1].request.mode, "acceptEdits");
});

test("rejectAll rejects pending requests", async () => {
  const { ch } = harness();
  const p = ch.initialize();
  ch.rejectAll(new Error("torn down"));
  await assert.rejects(p, /torn down/);
});
