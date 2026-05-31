#!/usr/bin/env node
// Tiny client for the claude-wrap control pipe.

import * as fs from "fs";
import * as child_process from "child_process";
import { DEFAULT_PIPE_NAME } from "./protocol";
import {
  parseTodoList,
  parseUserPrompts,
  parseToolCalls,
  parsePermissionPrompt,
  parseStatusLine,
} from "./parse";
import { listInstances, findInstance } from "./registry";
import { sendRequest, snapshot, write, PipeError, Client, withClient } from "./client";
import { ASK_SETTLE_MS } from "./config";
import { waitIdle, waitFor } from "./wait";
import { KEYS } from "./keys";

function unescape(s: string): string {
  return s
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  pipeFlag?: string;
  json: boolean;
  file?: string;
  timeoutMs?: number;
  positional: string[];
}

function requireValue(flag: string, v: string | undefined): string {
  if (v === undefined || v === "") throw new Error(`${flag} requires a value`);
  // Guard against `--flag1 --flag2` where flag1's value is the next flag,
  // which would otherwise validate as a non-empty string.
  if (v.startsWith("--")) throw new Error(`${flag} requires a value, got flag: ${v}`);
  return v;
}

function parseTimeoutSeconds(flag: string, raw: string | undefined): number {
  const n = Number(requireValue(flag, raw));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} requires a positive number of seconds, got: ${raw}`);
  }
  return n * 1000;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--pipe") out.pipeFlag = requireValue("--pipe", argv[++i]);
    else if (a.startsWith("--pipe=")) out.pipeFlag = requireValue("--pipe", a.slice("--pipe=".length));
    else if (a === "--json") out.json = true;
    else if (a === "--file") out.file = requireValue("--file", argv[++i]);
    else if (a.startsWith("--file=")) out.file = requireValue("--file", a.slice("--file=".length));
    else if (a === "--timeout") out.timeoutMs = parseTimeoutSeconds("--timeout", argv[++i]);
    else if (a.startsWith("--timeout=")) out.timeoutMs = parseTimeoutSeconds("--timeout", a.slice("--timeout=".length));
    else out.positional.push(a);
  }
  return out;
}

function resolvePipe(explicit?: string): string {
  if (explicit) {
    const hit = findInstance(explicit);
    return hit ? hit.pipe : explicit;
  }
  const fromEnv = process.env["CLAUDE_WRAP_PIPE"];
  if (fromEnv) return fromEnv;
  const live = listInstances();
  if (live.length === 1) return live[0]!.pipe;
  if (live.length > 1) {
    const names = live.map((e) => `  ${e.label ?? "?"}  ${e.pipe}  (pid ${e.pid}, ${e.cwd})`).join("\n");
    throw new Error(
      `multiple claude-wrap instances running; pick one with --pipe <name|label> or set CLAUDE_WRAP_PIPE:\n${names}`,
    );
  }
  return DEFAULT_PIPE_NAME;
}

// ---------------------------------------------------------------------------
// Snapshot source (pipe or file)
// ---------------------------------------------------------------------------

async function loadLines(args: ParsedArgs, viewport = false): Promise<string[]> {
  if (args.file) {
    return fs.readFileSync(args.file, "utf8").split(/\r?\n/);
  }
  const pipe = resolvePipe(args.pipeFlag);
  const snap = await snapshot(pipe, { viewport, clean: true });
  return snap.lines;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error(`Usage:
  inject [--pipe <name|label>] write "hello world\\r"
  inject [--pipe ...] write-b64 <base64>
  inject [--pipe ...] key <${Object.keys(KEYS).join("|")}>
  inject [--pipe ...] snapshot [viewport] [clean]
  inject [--pipe ...] resize <cols> <rows>

Parsers (read snapshot or --file <path>):
  inject [--pipe ... | --file ...] parse-todo
  inject [--pipe ... | --file ...] parse-prompts
  inject [--pipe ... | --file ...] parse-tools
  inject [--pipe ... | --file ...] parse-permission
  inject [--pipe ... | --file ...] parse-status

High-level:
  inject [--pipe ...] approve
  inject [--pipe ...] deny
  inject [--pipe ...] wait-idle [--timeout <seconds>]
  inject [--pipe ...] wait-for <regex> [--timeout <seconds>]
  inject [--pipe ...] ask "<text>"

Multi-instance:
  inject list [--json]
  inject attach <name|label>
  inject repl                 # one JSON Request per line on stdin, persistent

Pipe resolution: --pipe → $CLAUDE_WRAP_PIPE → single live instance → "${DEFAULT_PIPE_NAME}".`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function run(args: ParsedArgs): Promise<number> {
  const cmd = args.positional[0];
  const rest = args.positional.slice(1);

  switch (cmd) {
    // -- raw pipe commands -------------------------------------------------
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
      if (!k || !(k in KEYS)) throw new Error(`unknown key: ${k}`);
      const pipe = resolvePipe(args.pipeFlag);
      await write(pipe, KEYS[k]!);
      return 0;
    }
    case "snapshot": {
      const viewport = rest.includes("viewport");
      const clean = rest.includes("clean");
      const pipe = resolvePipe(args.pipeFlag);
      const snap = await snapshot(pipe, { viewport, clean });
      console.log(snap.lines.join("\n"));
      console.error(
        `-- cursor=(${snap.cursor.x},${snap.cursor.y}) cols=${snap.cols} rows=${snap.rows}`,
      );
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

    // -- parsers -----------------------------------------------------------
    case "parse-todo": {
      const lines = await loadLines(args);
      console.log(JSON.stringify(parseTodoList(lines), null, 2));
      return 0;
    }
    case "parse-prompts": {
      const lines = await loadLines(args);
      console.log(JSON.stringify(parseUserPrompts(lines), null, 2));
      return 0;
    }
    case "parse-tools": {
      const lines = await loadLines(args);
      console.log(JSON.stringify(parseToolCalls(lines), null, 2));
      return 0;
    }
    case "parse-permission": {
      const lines = await loadLines(args);
      console.log(JSON.stringify(parsePermissionPrompt(lines), null, 2));
      return 0;
    }
    case "parse-status": {
      const lines = await loadLines(args, true);
      console.log(JSON.stringify(parseStatusLine(lines), null, 2));
      return 0;
    }

    // -- high level --------------------------------------------------------
    case "approve":
    case "deny": {
      await withClient(resolvePipe(args.pipeFlag), async (client) => {
        const snap = await client.snapshot({ viewport: true, clean: true });
        const perm = parsePermissionPrompt(snap.lines);
        if (!perm) throw new Error("no permission prompt on screen");
        if (perm.options.length === 0) throw new Error("permission prompt has no options");
        // Approve = first option (conventionally "Yes"); deny = last
        // option (conventionally "No"). Never silently fall back to
        // the opposite choice — that would turn a deny into an approve.
        const chosen =
          cmd === "approve" ? perm.options[0]! : perm.options[perm.options.length - 1]!;
        await client.write(chosen.key + "\r");
        console.error(`${cmd}: pressed option ${chosen.key}. ${chosen.label}`);
      });
      return 0;
    }
    case "wait-idle": {
      const opts = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {};
      await withClient(resolvePipe(args.pipeFlag), (client) => waitIdle(client, opts));
      return 0;
    }
    case "wait-for": {
      const re = rest[0];
      if (!re) throw new Error("wait-for requires a regex");
      const pattern = new RegExp(re);
      const opts = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {};
      const line = await withClient(resolvePipe(args.pipeFlag), (client) =>
        waitFor(client, pattern, opts),
      );
      console.log(line);
      return 0;
    }
    case "ask": {
      const text = rest.join(" ");
      if (!text) throw new Error("ask requires prompt text");
      await withClient(resolvePipe(args.pipeFlag), async (client) => {
        await client.write(text + "\r");
        // Give the TUI a moment to register the input before we start polling.
        await new Promise((r) => setTimeout(r, ASK_SETTLE_MS));
        const opts = args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {};
        await waitIdle(client, opts);
      });
      return 0;
    }
    case "repl": {
      // Interactive line-oriented REPL: stdin JSON Request per line,
      // stdout JSON Response per line, using a single persistent
      // connection to the wrapper.
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
              process.stdout.write(
                JSON.stringify({ error: `bad json: ${(e as Error).message}` }) + "\n",
              );
              continue;
            }
            // Guard every branch with try/catch so a broken stdout
            // (closed downstream reader) can't escape as an unhandled
            // rejection and crash the process mid-REPL. Final .catch
            // handles the case where `client.send` itself rejects with
            // something that slips past the onRejected arm.
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

    // -- multi-instance ----------------------------------------------------
    case "list": {
      const live = listInstances();
      if (args.json) {
        console.log(JSON.stringify(live, null, 2));
      } else if (live.length === 0) {
        console.log("(no claude-wrap instances registered)");
      } else {
        for (const e of live) {
          const http = e.httpPort ? `http=127.0.0.1:${e.httpPort}\t` : "";
          console.log(
            `${(e.label ?? "?").padEnd(16)} ${e.pipe}\tpid=${e.pid}\t${http}cwd=${e.cwd}`,
          );
        }
      }
      return 0;
    }
    case "attach": {
      const sel = rest[0];
      if (!sel) throw new Error("attach requires a name or label");
      const hit = findInstance(sel);
      if (!hit) throw new Error(`no live instance matches: ${sel}`);
      // Spawn a new cmd.exe window with CLAUDE_WRAP_PIPE pre-set.
      const title = `Shell [${hit.label ?? hit.pipe}]`;
      const env = { ...process.env, CLAUDE_WRAP_PIPE: hit.pipe, CLAUDE_WRAP_LABEL: hit.label ?? "" };
      child_process
        .spawn("cmd.exe", ["/c", "start", `"${title}"`, "cmd", "/k"], {
          cwd: hit.cwd,
          env,
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        })
        .unref();
      console.error(`attached shell to ${hit.pipe} (${hit.label ?? "no label"}) in ${hit.cwd}`);
      return 0;
    }

    default:
      printUsage();
      return 1;
  }
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.length === 0) {
    printUsage();
    process.exit(1);
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(rawArgv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
    return;
  }
  try {
    const code = await run(args);
    process.exit(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof PipeError) console.error("pipe error:", msg);
    else console.error(msg);
    process.exit(1);
  }
}

void main();
