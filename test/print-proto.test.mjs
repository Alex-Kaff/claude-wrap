// Unit tests for protocol type guards + version provenance (src/print/proto.ts).
// Offline. Run with: node --test test/print-proto.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  asProtoMessage,
  isInit,
  isThinkingTokens,
  isSystem,
  isRateLimitEvent,
  isAssistant,
  isUser,
  isStreamEvent,
  isResult,
  isControlRequest,
  isControlResponse,
  isTestedCliVersion,
  TESTED_CLI_VERSIONS,
} from "../dist/index.js";

test("asProtoMessage requires an object with a string type", () => {
  assert.equal(asProtoMessage(null), null);
  assert.equal(asProtoMessage(42), null);
  assert.equal(asProtoMessage({}), null);
  assert.equal(asProtoMessage({ type: 1 }), null);
  assert.deepEqual(asProtoMessage({ type: "x" }), { type: "x" });
});

test("system subtype guards", () => {
  const init = { type: "system", subtype: "init", session_id: "s" };
  const tok = { type: "system", subtype: "thinking_tokens", estimated_tokens: 1, estimated_tokens_delta: 1 };
  const other = { type: "system", subtype: "compact_boundary" };
  assert.ok(isInit(init));
  assert.ok(!isInit(tok));
  assert.ok(isThinkingTokens(tok));
  assert.ok(isSystem(init) && isSystem(tok) && isSystem(other));
});

test("top-level type guards", () => {
  assert.ok(isRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }));
  assert.ok(isAssistant({ type: "assistant", message: { role: "assistant", content: [] } }));
  assert.ok(isUser({ type: "user", message: { role: "user", content: "" } }));
  assert.ok(isStreamEvent({ type: "stream_event", event: { type: "x" } }));
  assert.ok(isResult({ type: "result", subtype: "success", is_error: false, result: null, session_id: "s" }));
  assert.ok(isControlRequest({ type: "control_request", request_id: "1", request: { subtype: "x" } }));
  assert.ok(isControlResponse({ type: "control_response", response: { request_id: "1" } }));
  // negatives
  assert.ok(!isAssistant({ type: "user", message: { role: "user", content: "" } }));
});

test("version provenance", () => {
  assert.ok(isTestedCliVersion(TESTED_CLI_VERSIONS[0]));
  assert.ok(!isTestedCliVersion("0.0.1"));
  assert.ok(!isTestedCliVersion(undefined));
  assert.ok(!isTestedCliVersion(null));
});
