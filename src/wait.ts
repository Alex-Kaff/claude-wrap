// Polling helpers that watch the wrapped session via repeated snapshots.
//
// Depends on IClient (not the concrete Client) so tests can inject a
// FakeClient that serves scripted snapshots without a real pipe.

import { Client, type IClient } from "./client";
import { parseStatusLine, parseUserPrompts, parsePermissionPrompt } from "./parse";
import { POLL_INTERVAL_MS, WAIT_IDLE_TIMEOUT_MS, WAIT_FOR_TIMEOUT_MS } from "./config";
import { TimeoutError } from "./errors";

export interface WaitOptions {
  /** Milliseconds between snapshot polls. */
  interval?: number;
  /** Total budget before the wait rejects. */
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Accept either a pipe name (one-shot) or an already-open IClient. */
export type SnapshotSource = string | IClient;

function asClient(src: SnapshotSource): { client: IClient; owned: boolean } {
  if (typeof src === "string") return { client: new Client(src), owned: true };
  return { client: src, owned: false };
}

/**
 * Wait until the assistant looks idle: no spinner glyph visible AND
 * either a permission prompt is on screen (waiting on user) or the
 * most recent user prompt line is empty (ready for input).
 */
export async function waitIdle(src: SnapshotSource, opts: WaitOptions = {}): Promise<void> {
  const { client, owned } = asClient(src);
  const interval = opts.interval ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? WAIT_IDLE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      const snap = await client.snapshot({ viewport: true, clean: true });
      const status = parseStatusLine(snap.lines);
      const prompts = parseUserPrompts(snap.lines);
      const perm = parsePermissionPrompt(snap.lines);
      const lastPrompt = prompts[prompts.length - 1];
      const promptIsEmpty = lastPrompt !== undefined && lastPrompt.text === "";
      if (!status.busy && (perm || promptIsEmpty)) return;
      if (Date.now() >= deadline) {
        throw new TimeoutError(`waitIdle: timed out after ${timeoutMs}ms (busy=${status.busy})`);
      }
      await sleep(interval);
    }
  } finally {
    if (owned) client.close();
  }
}

/**
 * Wait until any snapshot line matches `pattern`. Resolves with the
 * matching line text.
 */
export async function waitFor(
  src: SnapshotSource,
  pattern: RegExp,
  opts: WaitOptions = {},
): Promise<string> {
  const { client, owned } = asClient(src);
  const interval = opts.interval ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? WAIT_FOR_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      const snap = await client.snapshot({ viewport: false, clean: true });
      for (const line of snap.lines) {
        if (pattern.test(line)) return line;
      }
      if (Date.now() >= deadline) {
        throw new TimeoutError(`waitFor: timed out after ${timeoutMs}ms waiting for ${pattern}`);
      }
      await sleep(interval);
    }
  } finally {
    if (owned) client.close();
  }
}
