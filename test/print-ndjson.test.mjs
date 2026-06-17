// Unit tests for the chunked NDJSON reader + parseJsonArray (src/print/ndjson.ts).
// Offline. Run with: node --test test/print-ndjson.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { NdjsonReader, parseJsonArray } from "../dist/index.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "..", "fixtures", "print");
const read = (n) => fs.readFileSync(path.join(fixtures, n), "utf8");

function collect(chunks) {
  const out = [];
  const r = new NdjsonReader((m) => out.push(m));
  for (const c of chunks) r.push(c);
  r.flush();
  return out;
}

test("parses one object per line", () => {
  const out = collect(['{"type":"a"}\n{"type":"b"}\n']);
  assert.deepEqual(out.map((m) => m.type), ["a", "b"]);
});

test("reassembles a line split across chunks", () => {
  const out = collect(['{"type":"sys', 'tem","subtype":"in', 'it"}\n']);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "system");
  assert.equal(out[0].subtype, "init");
});

test("tolerates \\r\\n line endings", () => {
  const out = collect(['{"type":"a"}\r\n{"type":"b"}\r\n']);
  assert.deepEqual(out.map((m) => m.type), ["a", "b"]);
});

test("flush() emits a trailing line with no final newline", () => {
  const out = collect(['{"type":"a"}\n{"type":"b"}']);
  assert.deepEqual(out.map((m) => m.type), ["a", "b"]);
});

test("skips a malformed line, keeps going (calls onBadLine)", () => {
  const bad = [];
  const good = [];
  const r = new NdjsonReader(
    (m) => good.push(m),
    (line, err) => bad.push({ line, err }),
  );
  r.push('{"type":"a"}\nNOT JSON\n{"type":"b"}\n');
  assert.deepEqual(good.map((m) => m.type), ["a", "b"]);
  assert.equal(bad.length, 1);
  assert.match(bad[0].line, /NOT JSON/);
});

test("skips a JSON value that isn't a typed object", () => {
  const out = collect(['123\n{"type":"ok"}\n"a string"\n']);
  assert.deepEqual(out.map((m) => m.type), ["ok"]);
});

test("ignores blank lines", () => {
  const out = collect(["\n  \n", '{"type":"a"}\n', "\n"]);
  assert.deepEqual(out.map((m) => m.type), ["a"]);
});

test("streams the real multi-turn fixture, byte-chunked", () => {
  const raw = read("E_multiturn.jsonl");
  // Feed in awkward 7-byte chunks to exercise split-line reassembly.
  const out = [];
  const r = new NdjsonReader((m) => out.push(m));
  for (let i = 0; i < raw.length; i += 7) r.push(raw.slice(i, i + 7));
  r.flush();
  const types = out.map((m) => m.type);
  // Two turns: each bracketed system/init … result.
  assert.equal(types.filter((t) => t === "result").length, 2);
  assert.ok(types.includes("system"));
  assert.ok(types.includes("assistant"));
  const results = out.filter((m) => m.type === "result");
  assert.equal(results[0].result, "Forty-two, got it.");
  assert.equal(results[1].result, "42");
});

test("parseJsonArray reads the one-shot json array (last element is result)", () => {
  const msgs = parseJsonArray(read("D_schema.json"));
  assert.ok(Array.isArray(msgs));
  assert.equal(msgs[msgs.length - 1].type, "result");
  assert.equal(msgs[0].type, "system");
});

test("parseJsonArray tolerates a single object", () => {
  const msgs = parseJsonArray('{"type":"result","subtype":"success"}');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, "result");
});

test("parseJsonArray throws on invalid top-level JSON", () => {
  assert.throws(() => parseJsonArray("not json"));
});
