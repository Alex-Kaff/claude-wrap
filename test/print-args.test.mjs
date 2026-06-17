// Unit tests for the PrintOptions → argv builder (src/print/args.ts).
// Pure/offline. Run with: node --test test/print-args.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildArgs, applyIsolation, validateOptions } from "../dist/index.js";

/** Index of a flag, or -1. */
const idx = (a, f) => a.indexOf(f);
/** Assert `flag` is immediately followed by `value`. */
function flagVal(argv, flag, value) {
  const i = idx(argv, flag);
  assert.ok(i >= 0, `expected flag ${flag} in ${JSON.stringify(argv)}`);
  assert.equal(argv[i + 1], value, `expected ${flag} ${value}`);
}

test("persistent base argv", () => {
  assert.deepEqual(buildArgs({}, "persistent"), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
});

test("oneshot base argv places prompt right after -p", () => {
  assert.deepEqual(buildArgs({}, "oneshot", "hello world"), [
    "-p",
    "hello world",
    "--output-format",
    "json",
  ]);
});

test("oneshot prompt precedes the variadic --tools (not swallowed)", () => {
  const argv = buildArgs({ tools: ["Bash", "Read"] }, "oneshot", "PROMPT");
  assert.equal(argv[1], "PROMPT");
  const ti = idx(argv, "--tools");
  assert.ok(ti > idx(argv, "PROMPT"), "--tools must come after the prompt");
  assert.deepEqual(argv.slice(ti), ["--tools", "Bash", "Read"]);
});

test("tools: [] => --tools \"\"; undefined => omitted", () => {
  const a = buildArgs({ tools: [] }, "persistent");
  flagVal(a, "--tools", "");
  const b = buildArgs({}, "persistent");
  assert.equal(idx(b, "--tools"), -1);
});

test("settingSources: [] => empty string; list => comma-joined", () => {
  flagVal(buildArgs({ settingSources: [] }, "persistent"), "--setting-sources", "");
  flagVal(
    buildArgs({ settingSources: ["user", "project"] }, "persistent"),
    "--setting-sources",
    "user,project",
  );
});

test("mcpConfig: object => inline JSON; string[] => variadic paths", () => {
  flagVal(
    buildArgs({ mcpConfig: { mcpServers: {} } }, "persistent"),
    "--mcp-config",
    '{"mcpServers":{}}',
  );
  const a = buildArgs({ mcpConfig: ["a.json", "b.json"] }, "persistent");
  const i = idx(a, "--mcp-config");
  assert.deepEqual(a.slice(i, i + 3), ["--mcp-config", "a.json", "b.json"]);
});

test("fallbackModel is ONE comma-joined arg (not variadic)", () => {
  flagVal(
    buildArgs({ fallbackModel: ["claude-sonnet-4-6", "claude-haiku-4-5"] }, "persistent"),
    "--fallback-model",
    "claude-sonnet-4-6,claude-haiku-4-5",
  );
});

test("jsonSchema and agents serialize to JSON args", () => {
  flagVal(buildArgs({ jsonSchema: { type: "object" } }, "persistent"), "--json-schema", '{"type":"object"}');
  flagVal(buildArgs({ agents: { x: 1 } }, "persistent"), "--agents", '{"x":1}');
});

test("session flags", () => {
  const a = buildArgs(
    { model: "claude-sonnet-4-6", sessionId: "uuid-1", continue: true, forkSession: true, persistSession: false },
    "persistent",
  );
  flagVal(a, "--model", "claude-sonnet-4-6");
  flagVal(a, "--session-id", "uuid-1");
  assert.ok(a.includes("--continue"));
  assert.ok(a.includes("--fork-session"));
  assert.ok(a.includes("--no-session-persistence"));
});

test("resume flag", () => {
  flagVal(buildArgs({ resume: "uuid-2" }, "persistent"), "--resume", "uuid-2");
});

test("includePartialMessages: persistent only", () => {
  assert.ok(buildArgs({ includePartialMessages: true }, "persistent").includes("--include-partial-messages"));
  assert.ok(!buildArgs({ includePartialMessages: true }, "oneshot", "hi").includes("--include-partial-messages"));
});

test("system-prompt replace vs append", () => {
  flagVal(buildArgs({ systemPrompt: "be terse" }, "persistent"), "--system-prompt", "be terse");
  flagVal(buildArgs({ appendSystemPrompt: "also rhyme" }, "persistent"), "--append-system-prompt", "also rhyme");
});

test("permissionPromptTool emits --permission-prompt-tool", () => {
  flagVal(buildArgs({ permissionPromptTool: "stdio" }, "persistent"), "--permission-prompt-tool", "stdio");
  assert.equal(idx(buildArgs({}, "persistent"), "--permission-prompt-tool"), -1);
});

test("permissionMode: valid passes, invalid throws", () => {
  flagVal(buildArgs({ permissionMode: "acceptEdits" }, "persistent"), "--permission-mode", "acceptEdits");
  assert.throws(() => buildArgs({ permissionMode: "nope" }, "persistent"), /invalid permissionMode/);
  assert.throws(() => validateOptions({ permissionMode: "bogus" }), /invalid permissionMode/);
});

test("maxBudgetUsd and extraArgs", () => {
  const a = buildArgs({ maxBudgetUsd: 0.05, extraArgs: ["--foo", "bar"] }, "persistent");
  flagVal(a, "--max-budget-usd", "0.05");
  assert.deepEqual(a.slice(-2), ["--foo", "bar"]);
});

test("isolation profile fills cost-driver defaults (explicit fields win)", () => {
  const iso = applyIsolation({ isolate: true, systemPrompt: "x" });
  assert.equal(iso.strictMcpConfig, true);
  assert.deepEqual(iso.mcpConfig, { mcpServers: {} });
  assert.deepEqual(iso.settingSources, []);
  assert.deepEqual(iso.tools, []);

  const argv = buildArgs({ isolate: true, systemPrompt: "be a pirate" }, "oneshot", "ahoy");
  assert.ok(argv.includes("--strict-mcp-config"));
  flagVal(argv, "--mcp-config", '{"mcpServers":{}}');
  flagVal(argv, "--setting-sources", "");
  flagVal(argv, "--tools", "");
  flagVal(argv, "--system-prompt", "be a pirate");

  // explicit tools override the isolation default
  const argv2 = buildArgs({ isolate: true, tools: ["Bash"] }, "persistent");
  const ti = idx(argv2, "--tools");
  assert.deepEqual(argv2.slice(ti), ["--tools", "Bash"]);
});

test("applyIsolation is a no-op without isolate", () => {
  const o = { tools: ["Bash"] };
  assert.equal(applyIsolation(o), o);
});
