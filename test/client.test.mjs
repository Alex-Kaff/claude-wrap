// Unit tests for Client version-mismatch paths.
//
// We don't open a real pipe — instead we exercise `ensureCompatibleResponse`
// and `throwIfVersionMismatchError` indirectly via a subclass of Client
// whose `send()` is overridden to return scripted responses. This covers
// the five branches the reviewer walked through:
//   1. current-version happy path      → returns snapshot
//   2. pre-versioning (undefined)       → returns snapshot (tolerated)
//   3. future version (v=2)             → throws ProtocolVersionError
//   4. explicit version_mismatch error  → throws ProtocolVersionError
//   5. generic error response           → throws PipeError
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, PipeError, ProtocolVersionError } from "../dist/client.js";

class ScriptedClient extends Client {
  constructor(response) {
    super("fake-pipe");
    this._response = response;
  }
  async send() {
    return this._response;
  }
  close() {
    /* no socket to close */
  }
}

function snap(extra = {}) {
  return {
    version: 1,
    cols: 80,
    rows: 24,
    cursor: { x: 0, y: 0 },
    viewportY: 0,
    baseY: 0,
    lines: ["hello"],
    ...extra,
  };
}

test("snapshot: happy path with current protocol version", async () => {
  const client = new ScriptedClient(snap());
  const res = await client.snapshot();
  assert.equal(res.version, 1);
  assert.deepEqual(res.lines, ["hello"]);
});

test("snapshot: tolerates missing version field (pre-versioning server)", async () => {
  const r = snap();
  delete r.version;
  const client = new ScriptedClient(r);
  const res = await client.snapshot();
  assert.deepEqual(res.lines, ["hello"]);
});

test("snapshot: future version throws ProtocolVersionError", async () => {
  const client = new ScriptedClient(snap({ version: 2 }));
  await assert.rejects(
    () => client.snapshot(),
    (e) => {
      assert.ok(e instanceof ProtocolVersionError, "should be ProtocolVersionError");
      assert.equal(e.remoteVersion, 2);
      // MUST NOT be a PipeError — catching PipeError to retry would
      // otherwise spin forever against an incompatible server.
      assert.ok(!(e instanceof PipeError), "must NOT extend PipeError");
      return true;
    },
  );
});

test("snapshot: explicit version_mismatch error code → ProtocolVersionError", async () => {
  const client = new ScriptedClient({
    version: 1,
    error: "protocol version mismatch",
    code: "version_mismatch",
  });
  await assert.rejects(
    () => client.snapshot(),
    (e) => e instanceof ProtocolVersionError,
  );
});

test("snapshot: generic error response → PipeError (not ProtocolVersionError)", async () => {
  const client = new ScriptedClient({
    version: 1,
    error: "something broke",
    code: "internal",
  });
  await assert.rejects(
    () => client.snapshot(),
    (e) => {
      assert.ok(e instanceof PipeError);
      assert.ok(!(e instanceof ProtocolVersionError));
      return true;
    },
  );
});

test("write: version_mismatch on write also surfaces as ProtocolVersionError", async () => {
  const client = new ScriptedClient({
    version: 1,
    error: "nope",
    code: "version_mismatch",
  });
  await assert.rejects(
    () => client.write("data"),
    (e) => e instanceof ProtocolVersionError,
  );
});
