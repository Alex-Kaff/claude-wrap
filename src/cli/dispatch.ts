// Top-level dispatch for the claude-wrap CLI.
//
// Two bins share this router:
//  - `claude-wrap`        — lenient: a reserved verb as the first word runs a
//                           management command; ANYTHING else (no args, a flag,
//                           a free-form prompt, or a leading `--`) opens a
//                           Claude window, exactly as the old launcher did.
//  - `claude-wrap-inject` — strict: every invocation is a verb (no launch
//                           fallthrough), preserving the contract the MCP
//                           server depends on (`--pipe … parse-status`, `key`,
//                           `approve`, `deny`).

import { parseArgs } from "./args";
import { run, legacyLaunch } from "./commands";
import { printTopUsage, type Bin } from "./usage";
import { PipeError } from "../client";

export interface DispatchCtx {
  bin: Bin;
  /** Absolute path to dist/wrapper.js, resolved by the thin bin entry. */
  wrapperJs: string;
}

/** Verbs recognized as the first word on the `claude-wrap` bin. */
const RESERVED = new Set([
  "new", "launch", "spawn",
  "list", "ls",
  "stop", "kill",
  "attach",
  "ask", "send", "status", "snapshot",
  "approve", "deny", "resolve",
  "help",
  // raw / advanced (also accepted, de-emphasized in help)
  "write", "write-b64", "key", "resize", "repl",
  "wait-idle", "wait-for",
  "parse-todo", "parse-prompts", "parse-tools", "parse-permission", "parse-status",
]);

async function dispatch(argv: string[], ctx: DispatchCtx): Promise<number> {
  if (ctx.bin === "inject") {
    // Strict: parse and run; no window-launch fallthrough.
    if (argv.length === 0) {
      printTopUsage("inject");
      return 1;
    }
    if (argv[0] === "--help" || argv[0] === "-h") {
      printTopUsage("inject");
      return 0;
    }
    return run(parseArgs(argv), ctx);
  }

  // claude-wrap: lenient verb-or-launch.
  if (argv.length === 0) return legacyLaunch([], ctx);
  const first = argv[0]!;
  if (first === "--help" || first === "-h") {
    printTopUsage("claude-wrap");
    return 0;
  }
  // `claude-wrap -- <claude args>` force-forwards to claude (escapes verbs).
  if (first === "--") return legacyLaunch(argv.slice(1), ctx);
  if (RESERVED.has(first)) return run(parseArgs(argv), ctx);
  // Not a verb → legacy launch, forwarding everything to claude.
  return legacyLaunch(argv, ctx);
}

/** Entry point used by both thin bins. Handles errors + process exit. */
export async function main(argv: string[], ctx: DispatchCtx): Promise<void> {
  try {
    const code = await dispatch(argv, ctx);
    process.exit(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof PipeError) console.error("pipe error:", msg);
    else console.error(msg);
    process.exit(1);
  }
}
