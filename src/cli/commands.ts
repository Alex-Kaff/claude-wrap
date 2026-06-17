// Command implementations for the claude-wrap CLI. The original `inject`
// verbs (write/key/snapshot/parse-*/approve/deny/wait-*/ask/repl/list/attach)
// were moved here from the old `inject` entry and adapted to the shared
// parser/dispatch, plus the instance-management verbs that mirror the MCP
// server: new (spawn), send, status, stop, resolve.

import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import {
  parseTodoList,
  parseUserPrompts,
  parseToolCalls,
  parsePermissionPrompt,
  parseStatusLine,
  parseRemoteUrl,
} from "../parse";
import { listInstances, findInstance, unregisterInstance, makePipeName, type InstanceEntry } from "../registry";
import { sendRequest, snapshot, write, PipeError, Client, withClient } from "../client";
import { TimeoutError } from "../errors";
import { ASK_SETTLE_MS, SUBMIT_DELAY_MS } from "../config";
import { waitIdle, waitFor } from "../wait";
import { KEYS } from "../keys";
import { quoteCmdArg } from "../cmd-quote";
import { childEnv } from "../child-env";
import { type ParsedArgs, resolvePipe, unescape } from "./args";
import { printTopUsage, printVerbUsage } from "./usage";
import type { DispatchCtx } from "./dispatch";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Selector helpers
// ---------------------------------------------------------------------------

/** Selector for the no-data verbs: --pipe, else the first positional. */
function selOf(args: ParsedArgs): string | undefined {
  return args.pipeFlag ?? args.positional[1];
}

/**
 * Resolve target + remaining tokens for verbs that take BOTH a selector and
 * data (ask/send). With exactly one live instance the selector may be omitted;
 * an explicit selector that matches the only instance is consumed so it isn't
 * mistaken for prompt text.
 */
function resolveTarget(args: ParsedArgs): { pipe: string; rest: string[] } {
  const rest = args.positional.slice(1);
  if (args.pipeFlag !== undefined) return { pipe: resolvePipe(args.pipeFlag), rest };
  const live = listInstances();
  if (live.length === 1) {
    const only = live[0]!;
    const first = rest[0];
    // Consume the first token as the selector ONLY on an exact match — a
    // prefix match would silently eat a prompt word that happens to start
    // like the label (the default label is the cwd basename, e.g.
    // `ask "claude is great"` would otherwise drop "claude").
    const matchesOnly = first !== undefined && (first === only.label || first === only.pipe);
    return matchesOnly ? { pipe: only.pipe, rest: rest.slice(1) } : { pipe: only.pipe, rest };
  }
  // 0 or >1 live: treat the first positional as the selector (resolvePipe
  // throws a helpful listing when >1 and nothing matches).
  return { pipe: resolvePipe(rest[0]), rest: rest.slice(1) };
}

// ---------------------------------------------------------------------------
// Snapshot source (pipe or file) for the parse-* verbs
// ---------------------------------------------------------------------------

async function loadLines(args: ParsedArgs, viewport = false): Promise<string[]> {
  if (args.file) {
    return fs.readFileSync(args.file, "utf8").split(/\r?\n/);
  }
  const pipe = resolvePipe(selOf(args));
  const snap = await snapshot(pipe, { viewport, clean: true });
  return snap.lines;
}

// ---------------------------------------------------------------------------
// Permission resolution (shared by approve/deny/resolve)
// ---------------------------------------------------------------------------

async function doResolve(pipe: string, decision: "approve" | "deny"): Promise<void> {
  await withClient(pipe, async (client) => {
    const snap = await client.snapshot({ viewport: true, clean: true });
    const perm = parsePermissionPrompt(snap.lines);
    if (!perm) throw new Error("no permission prompt on screen");
    if (perm.options.length === 0) throw new Error("permission prompt has no options");
    // Approve = first option (conventionally "Yes"); deny = last option
    // (conventionally "No"). Never silently fall back to the opposite choice.
    const chosen = decision === "approve" ? perm.options[0]! : perm.options[perm.options.length - 1]!;
    // Send the digit, then Enter as a separate write after a short gap so the
    // selection commits before confirm (see SUBMIT_DELAY_MS).
    await client.write(chosen.key);
    await sleep(SUBMIT_DELAY_MS);
    await client.write("\r");
    console.error(`${decision}: pressed option ${chosen.key}. ${chosen.label}`);
  });
}

/** Type text over the pipe and submit with a separate Enter after a short gap. */
async function pipeSubmit(pipe: string, text: string): Promise<void> {
  await write(pipe, text);
  await sleep(SUBMIT_DELAY_MS);
  await write(pipe, "\r");
}

// ---------------------------------------------------------------------------
// Combined parsed state (mirrors the MCP SessionStateLite shape)
// ---------------------------------------------------------------------------

interface StateLite {
  busy: boolean;
  mode: string | null;
  tokens: number | null;
  effort: string | null;
  permissionPrompt:
    | { title: string; question: string; body: string[]; options: { key: string; label: string; selected: boolean }[] }
    | null;
  todoList: { total: number; done: number; open: number; tasks: { status: string; text: string }[] } | null;
  toolCalls: { tool: string; args: string; result: string }[];
  remoteUrl: string | null;
}

async function buildStatus(pipe: string): Promise<StateLite> {
  // Reuse one connection for both snapshots (like doResolve/ask) instead of
  // two connect/teardown round-trips.
  const { vp, full } = await withClient(pipe, async (client) => ({
    vp: await client.snapshot({ viewport: true, clean: true }),
    full: await client.snapshot({ clean: true }),
  }));
  const sl = parseStatusLine(vp.lines);
  const perm = parsePermissionPrompt(full.lines);
  const todo = parseTodoList(full.lines);
  const tools = parseToolCalls(full.lines);
  return {
    busy: sl.busy,
    mode: sl.mode,
    tokens: sl.tokens,
    effort: sl.effort,
    permissionPrompt: perm
      ? {
          title: perm.title,
          question: perm.question,
          body: perm.body,
          options: perm.options.map((o) => ({ key: o.key, label: o.label, selected: o.selected })),
        }
      : null,
    todoList: todo
      ? { total: todo.total, done: todo.done, open: todo.open, tasks: todo.tasks.map((t) => ({ status: t.status, text: t.text })) }
      : null,
    toolCalls: tools.map((t) => ({ tool: t.tool, args: t.args, result: t.result })),
    remoteUrl: parseRemoteUrl(full.lines),
  };
}

function printStatusHuman(s: StateLite): void {
  const bits = [`busy=${s.busy}`, `mode=${s.mode ?? "?"}`];
  if (s.tokens !== null) bits.push(`tokens=${s.tokens}`);
  if (s.effort) bits.push(`effort=${s.effort}`);
  console.log(bits.join("  "));
  if (s.permissionPrompt) {
    const p = s.permissionPrompt;
    console.log(`permission: ${p.title}${p.question ? " — " + p.question : ""}`);
    for (const o of p.options) console.log(`  ${o.selected ? "❯" : " "} ${o.key}. ${o.label}`);
  }
  if (s.todoList) console.log(`todo: ${s.todoList.done}/${s.todoList.total} done, ${s.todoList.open} open`);
  if (s.toolCalls.length) console.log(`tools: ${s.toolCalls.length} call(s) on screen`);
  if (s.remoteUrl) console.log(`remote: ${s.remoteUrl}`);
}

// ---------------------------------------------------------------------------
// Spawning (new / launch / legacy passthrough)
// ---------------------------------------------------------------------------

interface SpawnTarget {
  cwd: string;
  label: string;
  pipe: string;
  wrapperJs: string;
}

/** Open a visible terminal window running the wrapper (Windows). */
function openWindow(claudeArgs: string[], t: SpawnTarget): void {
  const nodeBin = quoteCmdArg(process.execPath);
  const forwarded = claudeArgs.map(quoteCmdArg).join(" ");
  const wrapCmd = `${nodeBin} ${quoteCmdArg(t.wrapperJs)}${forwarded ? " " + forwarded : ""}`;
  // `start "title" cmd /k <command>` opens a new console window. The first
  // quoted argument to `start` is the window title and MUST be present.
  const args = ["/c", "start", `"Claude (wrapped)"`, "cmd", "/k", wrapCmd];
  // childEnv strips the parent's Claude Code / IDE-integration vars (see
  // child-env.ts) — the convention every spawn in this package follows.
  const env = childEnv({ CLAUDE_WRAP_PIPE: t.pipe, CLAUDE_WRAP_LABEL: t.label });
  spawn("cmd.exe", args, {
    cwd: t.cwd,
    env,
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  }).unref();
}

/** Spawn the wrapper as a hidden, detached background process (no window). */
function spawnHeadless(claudeArgs: string[], t: SpawnTarget): void {
  const env = childEnv({ CLAUDE_WRAP_PIPE: t.pipe, CLAUDE_WRAP_LABEL: t.label });
  spawn(process.execPath, [t.wrapperJs, ...claudeArgs], {
    cwd: t.cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  }).unref();
}

/** Poll the registry until the just-spawned instance registers its pipe. */
async function waitForRegistration(pipe: string, timeoutMs = 15_000): Promise<InstanceEntry | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = listInstances().find((e) => e.pipe === pipe);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

/**
 * Legacy fire-and-forget launch: open a window forwarding args to claude,
 * exactly as the old `claude-wrap` bin did. Returns immediately.
 */
export function legacyLaunch(claudeArgs: string[], ctx: DispatchCtx): number {
  if (process.platform !== "win32") {
    throw new Error("windowed launch is Windows-only; use `claude-wrap new --headless` elsewhere");
  }
  const cwd = process.env["INIT_CWD"] ?? process.cwd();
  const label = path.basename(cwd) || "wrap";
  const pipe = makePipeName();
  openWindow(claudeArgs, { cwd, label, pipe, wrapperJs: ctx.wrapperJs });
  return 0;
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not signalable by us — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort kill of a process tree. `force` adds taskkill /F (SIGKILL). */
function killTree(pid: number, force: boolean): void {
  if (process.platform === "win32") {
    const a = force ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
    // Don't throw on a non-zero exit — Windows console trees report
    // "can only be terminated forcefully" for a non-/F attempt. The caller
    // checks liveness and escalates, so a failed attempt is expected, not fatal.
    spawnSync("taskkill", a, { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Verb dispatch
// ---------------------------------------------------------------------------

const ALIAS: Record<string, string> = {
  ls: "list",
  kill: "stop",
  launch: "new",
  spawn: "new",
};

export async function run(args: ParsedArgs, ctx: DispatchCtx): Promise<number> {
  const rawCmd = args.positional[0];
  if (args.help && rawCmd) {
    printVerbUsage(rawCmd, ctx.bin);
    return 0;
  }
  const cmd = rawCmd ? (ALIAS[rawCmd] ?? rawCmd) : rawCmd;
  const rest = args.positional.slice(1);

  switch (cmd) {
    // -- sessions ----------------------------------------------------------
    case "new": {
      if (process.platform !== "win32" && !args.headless) {
        throw new Error("windowed `new` is Windows-only; pass --headless");
      }
      const cwd = args.cwd ?? process.env["INIT_CWD"] ?? process.cwd();
      const label = args.label ?? (path.basename(cwd) || "wrap");
      const pipe = makePipeName();
      const claudeArgs = [
        ...(args.model !== undefined ? ["--model", args.model] : []),
        ...(args.passthrough ?? []),
      ];
      const target: SpawnTarget = { cwd, label, pipe, wrapperJs: ctx.wrapperJs };
      const headless = args.headless === true;
      if (headless) spawnHeadless(claudeArgs, target);
      else openWindow(claudeArgs, target);
      const kind = headless ? "headless" : "windowed";
      const entry = await waitForRegistration(pipe);
      if (args.json) {
        console.log(
          JSON.stringify(
            { pipe, label, cwd, kind, pid: entry?.pid ?? null, registered: !!entry },
            null,
            2,
          ),
        );
      } else if (entry) {
        console.log(`started ${label}  pipe=${pipe}  pid=${entry.pid}  (${kind})  cwd=${cwd}`);
      } else {
        console.log(
          `launched ${label}  pipe=${pipe}  (${kind})  cwd=${cwd}  [not yet registered — check 'claude-wrap list']`,
        );
      }
      return 0;
    }
    case "list": {
      const live = listInstances();
      if (args.json) {
        console.log(JSON.stringify(live, null, 2));
      } else if (live.length === 0) {
        console.log("(no claude-wrap instances registered)");
      } else {
        for (const e of live) {
          const http = e.httpPort ? `http=127.0.0.1:${e.httpPort}\t` : "";
          console.log(`${(e.label ?? "?").padEnd(16)} ${e.pipe}\tpid=${e.pid}\t${http}cwd=${e.cwd}`);
        }
      }
      return 0;
    }
    case "stop": {
      const sel = selOf(args);
      let entry: InstanceEntry | null = null;
      if (sel) {
        entry = findInstance(sel);
      } else {
        const live = listInstances();
        if (live.length === 1) entry = live[0]!;
        else if (live.length === 0) throw new Error("no claude-wrap instances running");
        else resolvePipe(undefined); // throws the multi-instance listing
      }
      if (!entry) throw new Error(`no live instance matches: ${sel}`);
      const force = args.force === true;
      // Plain `stop` tries a graceful close first; if the tree survives (Windows
      // console trees can't be closed without /F), escalate to a hard kill so the
      // instance is actually stopped. `--force` skips straight to the hard kill.
      let forced = force;
      if (force) {
        killTree(entry.pid, true);
      } else {
        killTree(entry.pid, false);
        await sleep(400);
        if (isAlive(entry.pid)) {
          killTree(entry.pid, true);
          forced = true;
        }
      }
      await sleep(300);
      // Only drop the registry entry once the process is actually dead — never
      // unregister a still-running instance (that would orphan it, invisible to
      // `list`). listInstances() also prunes dead pids, so this is belt-and-braces.
      if (isAlive(entry.pid)) {
        throw new Error(
          `could not stop ${entry.label ?? entry.pipe} (pid ${entry.pid}); it is still running. Try again, or kill pid ${entry.pid} manually.`,
        );
      }
      try {
        unregisterInstance(entry.pipe);
      } catch {
        /* ignore — listInstances also prunes dead pids */
      }
      console.error(`stopped ${entry.label ?? entry.pipe} (pid ${entry.pid})${forced ? " [forced]" : ""}`);
      return 0;
    }
    case "attach": {
      const sel = rest[0];
      if (!sel) throw new Error("attach requires a name or label");
      const hit = findInstance(sel);
      if (!hit) throw new Error(`no live instance matches: ${sel}`);
      // Strip quotes from the (user-settable via --label) display name so they
      // can't break out of the `start "title"` token under windowsVerbatimArguments.
      const name = (hit.label ?? hit.pipe).replace(/"/g, "'");
      const title = `Shell [${name}]`;
      // Bare shell with no wrapper to re-clean the env, so strip the parent's
      // Claude Code / IDE vars here (childEnv) like every other spawn does.
      const env = childEnv({ CLAUDE_WRAP_PIPE: hit.pipe, CLAUDE_WRAP_LABEL: hit.label ?? "" });
      spawn("cmd.exe", ["/c", "start", `"${title}"`, "cmd", "/k"], {
        cwd: hit.cwd,
        env,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }).unref();
      console.error(`attached shell to ${hit.pipe} (${hit.label ?? "no label"}) in ${hit.cwd}`);
      return 0;
    }

    // -- drive -------------------------------------------------------------
    case "ask": {
      const target = resolveTarget(args);
      const text = target.rest.join(" ");
      if (!text) throw new Error("ask requires prompt text");
      await withClient(target.pipe, async (client) => {
        await client.write(text);
        await sleep(SUBMIT_DELAY_MS);
        await client.write("\r");
        await sleep(ASK_SETTLE_MS);
        const opts = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {};
        let status: "idle" | "busy" = "idle";
        try {
          await waitIdle(client, opts);
        } catch (e) {
          if (e instanceof TimeoutError) status = "busy";
          else throw e;
        }
        const snap = await client.snapshot({ clean: true });
        const lines = snap.lines.slice(-400);
        if (args.json) {
          console.log(JSON.stringify({ status, lines }, null, 2));
        } else {
          console.log(lines.join("\n"));
          console.error(`-- ${status}`);
        }
      });
      return 0;
    }
    case "send": {
      const target = resolveTarget(args);
      if (args.key !== undefined) {
        if (!(args.key in KEYS)) {
          throw new Error(`unknown key: ${args.key}. Valid keys: ${Object.keys(KEYS).join(", ")}`);
        }
        await write(target.pipe, KEYS[args.key]!);
      } else if (args.text !== undefined) {
        await write(target.pipe, unescape(args.text));
      } else if (args.line !== undefined) {
        await pipeSubmit(target.pipe, args.line);
      } else if (target.rest.length > 0) {
        await pipeSubmit(target.pipe, target.rest.join(" "));
      } else {
        throw new Error("send requires --text, --line, --key, or a positional text argument");
      }
      return 0;
    }
    case "status": {
      const pipe = resolvePipe(selOf(args));
      const state = await buildStatus(pipe);
      if (args.json) console.log(JSON.stringify(state, null, 2));
      else printStatusHuman(state);
      return 0;
    }
    case "approve":
    case "deny": {
      await doResolve(resolvePipe(selOf(args)), cmd);
      return 0;
    }
    case "resolve": {
      const decision = rest.find((t) => t === "approve" || t === "deny") as "approve" | "deny" | undefined;
      if (!decision) throw new Error("resolve requires approve|deny");
      const selTok = args.pipeFlag ?? rest.find((t) => t !== "approve" && t !== "deny");
      await doResolve(resolvePipe(selTok), decision);
      return 0;
    }

    // -- raw pipe ----------------------------------------------------------
    case "write": {
      const pipe = resolvePipe(args.pipeFlag);
      await write(pipe, unescape(rest.join(" ")));
      return 0;
    }
    case "write-b64": {
      const b64 = rest[0];
      if (!b64) throw new Error("write-b64 requires a base64 argument");
      const pipe = resolvePipe(args.pipeFlag);
      const res = await sendRequest(pipe, { cmd: "write", b64 });
      if ("error" in res) throw new PipeError(res.error);
      return 0;
    }
    case "key": {
      const k = rest[0];
      if (!k || !(k in KEYS)) {
        throw new Error(`unknown key: ${k ?? "<missing>"}. Valid keys: ${Object.keys(KEYS).join(", ")}`);
      }
      const pipe = resolvePipe(args.pipeFlag);
      await write(pipe, KEYS[k]!);
      return 0;
    }
    case "snapshot": {
      const viewport = rest.includes("viewport");
      const clean = rest.includes("clean");
      const selTok = args.pipeFlag ?? rest.find((t) => t !== "viewport" && t !== "clean");
      const pipe = resolvePipe(selTok);
      const snap = await snapshot(pipe, { viewport, clean });
      console.log(snap.lines.join("\n"));
      console.error(`-- cursor=(${snap.cursor.x},${snap.cursor.y}) cols=${snap.cols} rows=${snap.rows}`);
      return 0;
    }
    case "resize": {
      const c = Number(rest[0]);
      const r = Number(rest[1]);
      if (!Number.isFinite(c) || !Number.isFinite(r)) throw new Error("resize requires numeric cols rows");
      const pipe = resolvePipe(args.pipeFlag);
      const res = await sendRequest(pipe, { cmd: "resize", cols: c, rows: r });
      if ("error" in res) throw new PipeError(res.error);
      return 0;
    }

    // -- parsers (read snapshot or --file) ---------------------------------
    case "parse-todo": {
      console.log(JSON.stringify(parseTodoList(await loadLines(args)), null, 2));
      return 0;
    }
    case "parse-prompts": {
      console.log(JSON.stringify(parseUserPrompts(await loadLines(args)), null, 2));
      return 0;
    }
    case "parse-tools": {
      console.log(JSON.stringify(parseToolCalls(await loadLines(args)), null, 2));
      return 0;
    }
    case "parse-permission": {
      console.log(JSON.stringify(parsePermissionPrompt(await loadLines(args)), null, 2));
      return 0;
    }
    case "parse-status": {
      console.log(JSON.stringify(parseStatusLine(await loadLines(args, true)), null, 2));
      return 0;
    }

    // -- waits -------------------------------------------------------------
    case "wait-idle": {
      const opts = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {};
      await withClient(resolvePipe(selOf(args)), (client) => waitIdle(client, opts));
      return 0;
    }
    case "wait-for": {
      const re = rest[0];
      if (!re) throw new Error("wait-for requires a regex");
      const pattern = new RegExp(re);
      const opts = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {};
      const line = await withClient(resolvePipe(args.pipeFlag), (client) => waitFor(client, pattern, opts));
      console.log(line);
      return 0;
    }

    // -- repl --------------------------------------------------------------
    case "repl": {
      const pipe = resolvePipe(args.pipeFlag);
      const client = new Client(pipe);
      process.stderr.write(`connected to ${pipe}. one JSON Request per line, EOF to exit.\n`);
      await new Promise<void>((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let req: unknown;
            try {
              req = JSON.parse(line);
            } catch (e) {
              process.stdout.write(JSON.stringify({ error: `bad json: ${(e as Error).message}` }) + "\n");
              continue;
            }
            const safeWrite = (obj: unknown): void => {
              try {
                process.stdout.write(JSON.stringify(obj) + "\n");
              } catch {
                /* stdout is gone — nothing useful we can do */
              }
            };
            client
              .send(req as Parameters<Client["send"]>[0])
              .then(
                (res) => safeWrite(res),
                (e: Error) => safeWrite({ error: e.message }),
              )
              .catch(() => {
                /* already handled above; swallow to keep REPL alive */
              });
          }
        });
        process.stdin.on("end", () => resolve());
      });
      client.close();
      return 0;
    }

    // -- help / unknown ----------------------------------------------------
    case "help": {
      const target = rest[0];
      if (target) printVerbUsage(target, ctx.bin);
      else printTopUsage(ctx.bin);
      return 0;
    }
    default:
      printTopUsage(ctx.bin);
      return 1;
  }
}
