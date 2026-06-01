// Golden-file tests for src/parse.ts against the fixture .txt snapshots
// captured at the repo root. Run with: node --test test/parse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import {
  parseTodoList,
  parseUserPrompts,
  parseToolCalls,
  parsePermissionPrompt,
  parseStatusLine,
  parseRemoteUrl,
  sliceSinceLastUser,
} from "../dist/parse.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

function load(name) {
  return fs.readFileSync(path.join(repo, "fixtures", name), "utf8").split(/\r?\n/);
}

test("parseTodoList: 3 open", () => {
  const todo = parseTodoList(load("todo.txt"));
  assert.ok(todo);
  assert.equal(todo.total, 3);
  assert.equal(todo.done, 0);
  assert.equal(todo.open, 3);
  assert.deepEqual(
    todo.tasks.map((t) => [t.status, t.text]),
    [
      ["open", "Task one"],
      ["open", "Task two"],
      ["open", "Task three"],
    ],
  );
});

test("parseTodoList: 3 done", () => {
  const todo = parseTodoList(load("todo_done.txt"));
  assert.ok(todo);
  assert.equal(todo.done, 3);
  assert.equal(todo.open, 0);
  assert.ok(todo.tasks.every((t) => t.status === "done"));
});

test("parseTodoList: no block", () => {
  assert.equal(parseTodoList(load("in_progress.txt")), null);
  assert.equal(parseTodoList(load("asking_command.txt")), null);
});

test("parseUserPrompts: full.txt finds the user message", () => {
  const prompts = parseUserPrompts(load("full.txt"));
  assert.ok(prompts.length >= 1);
  assert.match(prompts[0].text, /make a dir test/);
});

test("sliceSinceLastUser anchors on last prompt", () => {
  const lines = load("full.txt");
  const slice = sliceSinceLastUser(lines);
  // Last prompt on full.txt is the empty input row, so the slice starts there.
  assert.ok(slice[0].trimStart().startsWith("❯"));
});

test("parseToolCalls picks up Bash, Write, Read, Web Search, Update", () => {
  const tools = parseToolCalls(load("full.txt"));
  const names = tools.map((t) => t.tool);
  assert.ok(names.includes("Bash"));
  assert.ok(names.includes("Write"));
  assert.ok(names.includes("Read"));
  assert.ok(names.includes("Web Search"));
  assert.ok(names.includes("Update"));
  // First Bash call should capture the mkdir command.
  const bash = tools.find((t) => t.tool === "Bash");
  assert.match(bash.args, /mkdir -p/);
});

test("parseToolCalls captures ⎿ result bodies", () => {
  const tools = parseToolCalls(load("full.txt"));
  const write = tools.find((t) => t.tool === "Write");
  assert.ok(write, "Write tool call should be parsed");
  assert.match(write.result, /Wrote 5 lines/);
  const bashHello = tools.find((t) => t.tool === "Bash" && /python hello\.py/.test(t.args));
  assert.ok(bashHello, "Bash(python hello.py) should be parsed");
  assert.match(bashHello.result, /Hello, world!/);
  const read = tools.find((t) => t.tool === "Read");
  assert.match(read.result, /Read 6 lines/);
});

test("parsePermissionPrompt finds Bash command with 3 options", () => {
  const p = parsePermissionPrompt(load("asking_command.txt"));
  assert.ok(p);
  assert.equal(p.title, "Bash command");
  assert.equal(p.options.length, 3);
  assert.equal(p.options[0].key, "1");
  assert.equal(p.options[0].selected, true);
  assert.equal(p.options[2].label, "No");
});

test("parsePermissionPrompt: none on other fixtures", () => {
  assert.equal(parsePermissionPrompt(load("todo.txt")), null);
  assert.equal(parsePermissionPrompt(load("full.txt")), null);
});

test("parseStatusLine: in_progress is busy", () => {
  const s = parseStatusLine(load("in_progress.txt"));
  assert.equal(s.mode, "accept edits on");
  assert.equal(s.busy, true);
  assert.equal(s.tokens, 22831);
});

test("parseStatusLine: todo_done is idle", () => {
  const s = parseStatusLine(load("todo_done.txt"));
  assert.equal(s.mode, "accept edits on");
  assert.equal(s.busy, false);
  assert.equal(s.tokens, 29841);
});

// ---------------------------------------------------------------------------
// Claude Code v2.1.159 regression fixtures (captured live; see TEST-REPORT.md).
// These guard the permission/status detection against the current TUI layout.
// ---------------------------------------------------------------------------

test("v2159 permission: WebFetch domain approval", () => {
  const p = parsePermissionPrompt(load("v2159_perm_webfetch.txt"));
  assert.ok(p, "WebFetch prompt must be detected");
  assert.equal(p.title, "Fetch");
  assert.equal(p.question, "Do you want to allow Claude to fetch this content?");
  assert.equal(p.options.length, 3);
  assert.equal(p.options[0].key, "1");
  assert.equal(p.options[0].selected, true);
  assert.match(p.options[1].label, /don't ask again for example\.com/);
});

test("v2159 permission: Write / create file", () => {
  const p = parsePermissionPrompt(load("v2159_perm_write.txt"));
  assert.ok(p, "Write prompt must be detected");
  assert.equal(p.title, "Create file");
  assert.equal(p.question, "Do you want to create note.txt?");
  assert.equal(p.options.length, 3);
  // The dashed diff frames must be stripped from the body.
  assert.ok(!p.body.some((b) => /^[╌╍-]+$/.test(b)), "diff frames stripped from body");
  assert.ok(p.body.includes("note.txt"));
});

test("v2159 permission: Edit / make this edit", () => {
  const p = parsePermissionPrompt(load("v2159_perm_edit.txt"));
  assert.ok(p, "Edit prompt must be detected");
  assert.equal(p.title, "Edit file");
  assert.equal(p.question, "Do you want to make this edit to note.txt?");
  assert.equal(p.options[2].label, "No");
});

test("v2159 permission: Bash command (legacy 'proceed?')", () => {
  const p = parsePermissionPrompt(load("v2159_perm_bash.txt"));
  assert.ok(p, "Bash prompt must be detected");
  assert.equal(p.title, "Bash command");
  assert.equal(p.question, "Do you want to proceed?");
  assert.equal(p.options.length, 3);
  assert.match(p.body.join("\n"), /mkdir subdir_test/);
});

test("v2159 trust dialog is surfaced as a prompt", () => {
  const p = parsePermissionPrompt(load("v2159_trust_dialog.txt"));
  assert.ok(p, "Trust dialog must be detected");
  assert.equal(p.title, "Trust folder");
  assert.equal(p.options.length, 2);
  assert.match(p.options[0].label, /trust this folder/i);
  assert.equal(p.options[0].selected, true);
});

test("v2159 status: idle in auto mode (mode + tokens decoupled)", () => {
  const s = parseStatusLine(load("v2159_idle_automode.txt"));
  assert.equal(s.mode, "auto mode on");
  assert.equal(s.busy, false);
  assert.equal(s.tokens, 0); // "0 tokens" must parse, not become null
  assert.equal(s.effort, "xhigh");
});

test("v2159 status: busy via 'esc to interrupt'", () => {
  const s = parseStatusLine(load("v2159_busy_automode.txt"));
  assert.equal(s.busy, true);
  assert.equal(s.mode, "auto mode on");
  assert.equal(s.tokens, 27656);
});

test("v2159 status: completion line is NOT busy (no false spinner)", () => {
  // "✻ Baked for 27s" stays on screen after work; must read idle.
  const s = parseStatusLine(load("v2159_idle_completed_toolcall.txt"));
  assert.equal(s.busy, false);
  assert.equal(s.mode, "auto mode on");
  assert.equal(s.tokens, 27864);
});

test("v2159 status: every mode line parses", () => {
  const lines = load("v2159_mode_lines.txt");
  // Drive each non-comment line through the parser individually.
  const byMode = {};
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const s = parseStatusLine([line]);
    if (s.mode) byMode[s.mode] = (byMode[s.mode] ?? 0) + 1;
    else if (/\? for shortcuts/.test(line)) byMode["normal?"] = 1;
  }
  // Normal mode shows no phrase -> reported as "normal".
  assert.equal(parseStatusLine(["  ? for shortcuts · ← for agents      27864 tokens"]).mode, "normal");
  assert.equal(parseStatusLine(["  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents   0 tokens"]).mode, "auto mode on");
  assert.equal(parseStatusLine(["  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents   1 tokens"]).mode, "accept edits on");
  assert.equal(parseStatusLine(["  ⏸ plan mode on (shift+tab to cycle) · ← for agents   1 tokens"]).mode, "plan mode on");
});

test("v2159 no false permission prompt on busy/idle transcripts", () => {
  assert.equal(parsePermissionPrompt(load("v2159_busy_automode.txt")), null);
  assert.equal(parsePermissionPrompt(load("v2159_idle_completed_toolcall.txt")), null);
});

test("v2159 remote-control URL is parsed", () => {
  const url = parseRemoteUrl(load("v2159_idle_automode.txt"));
  assert.match(url ?? "", /^https:\/\/claude\.ai\/code\/session_/);
});
