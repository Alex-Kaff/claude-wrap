// Gated integration tests — these spawn the real `claude` CLI. They are OFF by
// default; enable with CLAUDE_WRAP_INTEGRATION=1. Cost is bounded with the
// isolation profile + --max-budget-usd, and a tiny model. Tests SKIP (not fail)
// when auth/credits are unavailable.
//
//   CLAUDE_WRAP_INTEGRATION=1 npm run test:integration
//
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

import { PrintSession } from "../dist/index.js";

const ENABLED = process.env.CLAUDE_WRAP_INTEGRATION === "1";
const MODEL = process.env.CLAUDE_WRAP_TEST_MODEL || "claude-haiku-4-5-20251001";
const BUDGET = 0.2;

/** Heuristic: did this failure come from missing auth / exhausted credits? */
function looksUnavailable(errOrResult) {
  const s = JSON.stringify(errOrResult?.raw ?? errOrResult?.message ?? errOrResult ?? "").toLowerCase();
  return /out_of_credits|credit|rate_limit|unauthor|forbidden|api key|apikey|login|401|429|402/.test(s);
}

/** Run `fn`; if it fails in a way that looks like an auth/credit problem, skip. */
async function guarded(t, fn) {
  try {
    return await fn();
  } catch (err) {
    if (looksUnavailable(err)) {
      t.skip(`claude unavailable: ${err?.message ?? err}`);
      return undefined;
    }
    throw err;
  }
}

function tmpCwd(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cw-print-${tag}-`));
  return dir;
}

test("oneshot isolated chat returns a result (PONG)", { skip: !ENABLED }, async (t) => {
  const s = new PrintSession({
    transport: "oneshot",
    isolate: true,
    model: MODEL,
    maxBudgetUsd: BUDGET,
    systemPrompt: "You reply with exactly one word: PONG",
  });
  await guarded(t, async () => {
    const r = await s.ask("ping");
    if (r.isError && looksUnavailable(r)) return t.skip("upstream error (credits)");
    assert.equal(r.isError, false);
    assert.match(r.text, /pong/i);
    assert.ok(r.sessionId);
  });
  s.destroy();
});

test("isolation profile yields a clean init (tools/mcp/plugins empty)", { skip: !ENABLED }, async (t) => {
  let init = null;
  const s = new PrintSession({ transport: "oneshot", isolate: true, model: MODEL, maxBudgetUsd: BUDGET });
  s.on("init", (p) => {
    init = p.init;
  });
  await guarded(t, async () => {
    const r = await s.ask("hi");
    if (r.isError && looksUnavailable(r)) return t.skip("upstream error (credits)");
    assert.ok(init, "expected an init message");
    assert.deepEqual(init.tools ?? [], []);
    assert.deepEqual(init.mcp_servers ?? [], []);
    assert.deepEqual(init.plugins ?? [], []);
  });
  s.destroy();
});

test("json-schema structured output", { skip: !ENABLED }, async (t) => {
  const s = new PrintSession({
    transport: "oneshot",
    isolate: true,
    model: MODEL,
    maxBudgetUsd: BUDGET,
    jsonSchema: {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" }, city: { type: "string" } },
      required: ["name", "age", "city"],
    },
  });
  await guarded(t, async () => {
    const r = await s.ask("Parse: John Smith is 30 years old and lives in Paris.");
    if (r.isError && looksUnavailable(r)) return t.skip("upstream error (credits)");
    assert.ok(r.structuredOutput, "expected structured_output");
    assert.equal(r.structuredOutput.name, "John Smith");
    assert.equal(r.structuredOutput.age, 30);
    assert.equal(r.structuredOutput.city, "Paris");
  });
  s.destroy();
});

test("persistent multi-turn memory carries (42) — validates Windows stdin path", { skip: !ENABLED }, async (t) => {
  const s = new PrintSession({
    transport: "persistent",
    warm: false, // no priming exchange polluting history
    isolate: true,
    model: MODEL,
    maxBudgetUsd: BUDGET,
  });
  await guarded(t, async () => {
    const r1 = await s.ask("My favorite number is 42. Acknowledge briefly.");
    if (r1.isError && looksUnavailable(r1)) return t.skip("upstream error (credits)");
    const r2 = await s.ask("What is my favorite number? Reply with just the number.");
    assert.match(r2.text, /42/);
    assert.equal(r1.sessionId, r2.sessionId);
    // Second turn should read cache (warm within the process).
    assert.ok(r2.usage.cacheReadInputTokens >= 0);
  });
  await s.shutdown();
});

test("cross-process resume (BANANA)", { skip: !ENABLED }, async (t) => {
  const cwd = tmpCwd("resume");
  const s1 = new PrintSession({ transport: "oneshot", isolate: true, model: MODEL, maxBudgetUsd: BUDGET, cwd });
  let sid = null;
  await guarded(t, async () => {
    const r1 = await s1.ask("Remember this secret word: BANANA. Acknowledge briefly.");
    if (r1.isError && looksUnavailable(r1)) return t.skip("upstream error (credits)");
    sid = r1.sessionId;
  });
  s1.destroy();
  if (!sid) return; // skipped above

  const s2 = new PrintSession({ transport: "oneshot", isolate: true, model: MODEL, maxBudgetUsd: BUDGET, cwd, resume: sid });
  await guarded(t, async () => {
    const r2 = await s2.ask("What was the secret word? Reply with just the word.");
    assert.match(r2.text, /banana/i);
  });
  s2.destroy();
});

// --- M4: control protocol / dynamic permissions ---

test("canUseTool DENY blocks a Write (control protocol)", { skip: !ENABLED }, async (t) => {
  const cwd = tmpCwd("perm-deny");
  const seen = [];
  const s = new PrintSession({
    transport: "persistent",
    warm: false,
    isolate: true,
    tools: ["Write", "Bash"], // isolate empties mcp/settings but keeps these tools
    model: MODEL,
    maxBudgetUsd: BUDGET,
    cwd,
    canUseTool: async (call) => {
      seen.push(call.name);
      return { behavior: "deny", message: "denied by test" };
    },
  });
  await guarded(t, async () => {
    const r = await s.ask("Use the Write tool to create a file named notes.txt containing: hello");
    if (r.isError && looksUnavailable(r)) return t.skip("upstream error (credits)");
    assert.ok(seen.includes("Write"), "expected a Write permission request");
    assert.ok(!fs.existsSync(path.join(cwd, "notes.txt")), "denied Write must not create the file");
  });
  await s.shutdown();
});

test("canUseTool ALLOW + permission:request event lets a Write through", { skip: !ENABLED }, async (t) => {
  const cwd = tmpCwd("perm-allow");
  let eventCall = null;
  const s = new PrintSession({
    transport: "persistent",
    warm: false,
    isolate: true,
    tools: ["Write", "Bash"],
    model: MODEL,
    maxBudgetUsd: BUDGET,
    cwd,
    canUseTool: async () => ({ behavior: "allow" }),
  });
  s.on("permission:request", (p) => {
    eventCall = p.call;
  });
  await guarded(t, async () => {
    const r = await s.ask("Use the Write tool to create a file named ok.txt containing exactly: yes");
    if (r.isError && looksUnavailable(r)) return t.skip("upstream error (credits)");
    assert.ok(eventCall, "expected a permission:request event");
    assert.equal(eventCall.name, "Write");
    assert.ok(fs.existsSync(path.join(cwd, "ok.txt")), "allowed Write should create the file");
  });
  await s.shutdown();
});

test("in-process function bridge: the model calls a JS function (M5)", { skip: !ENABLED }, async (t) => {
  const calls = [];
  const s = new PrintSession({
    transport: "persistent",
    warm: false,
    model: MODEL,
    maxBudgetUsd: BUDGET,
    // Isolate MCP/settings for cost, but DON'T empty --tools (would also hide the bridge tool).
    strictMcpConfig: true,
    mcpConfig: { mcpServers: {} },
    settingSources: [],
    functions: [
      {
        name: "add_numbers",
        description: "Add two integers and return their sum.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        handler: async (input) => {
          calls.push(input);
          return { content: [{ type: "text", text: String(Number(input.a) + Number(input.b)) }] };
        },
      },
    ],
  });
  await guarded(t, async () => {
    const r = await s.ask(
      "You MUST use the add_numbers tool to compute this — do not calculate it yourself. Add 17 and 25, then tell me the resulting number.",
    );
    if (r.isError && looksUnavailable(r)) return t.skip("upstream error (credits)");
    assert.ok(calls.length >= 1, "expected the add_numbers handler to be invoked via the MCP bridge");
    assert.match(r.text, /42/);
  });
  await s.shutdown();
});

test("interrupt() is callable on a persistent session", { skip: !ENABLED }, async (t) => {
  const s = new PrintSession({ transport: "persistent", warm: true, isolate: true, model: MODEL, maxBudgetUsd: BUDGET });
  await guarded(t, async () => {
    await s.ready(); // control channel is up after warm spawn
    // No in-flight turn → interrupt is a harmless control_request, must not throw.
    assert.doesNotThrow(() => s.interrupt());
  });
  await s.shutdown();
});
