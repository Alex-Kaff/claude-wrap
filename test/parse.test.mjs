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
