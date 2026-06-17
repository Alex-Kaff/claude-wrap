// Shared argument parsing + instance-selector resolution for the claude-wrap
// CLI. Extracted from the original `inject` entry so both the `claude-wrap`
// and `claude-wrap-inject` bins share one parser and never drift.

import { DEFAULT_PIPE_NAME } from "../protocol";
import { listInstances, findInstance } from "../registry";

export interface ParsedArgs {
  /** --pipe <name|label>: explicit instance selector. */
  pipeFlag?: string;
  /** --json: emit machine-readable JSON instead of human text. */
  json: boolean;
  /** --file <path>: read a snapshot from a file instead of a live pipe. */
  file?: string;
  /** --timeout <seconds>, normalized to milliseconds. */
  timeoutMs?: number;
  // -- `new`/spawn flags ----------------------------------------------------
  /** --label <L>: human label for a spawned instance. */
  label?: string;
  /** --model <ID>: forwarded to claude as `--model <ID>`. */
  model?: string;
  /** --cwd <DIR>: working directory for a spawned instance. */
  cwd?: string;
  /** --headless: spawn a hidden background instance (no window). */
  headless?: boolean;
  /** --headful: spawn a visible terminal window (the default). */
  headful?: boolean;
  // -- `send` flags ---------------------------------------------------------
  /** --text <S>: raw text, sent verbatim (no Enter). */
  text?: string;
  /** --line <S>: text followed by Enter. */
  line?: string;
  /** --key <NAME>: a named key from KEYS. */
  key?: string;
  // -- `stop` flag ----------------------------------------------------------
  /** --force: hard-kill (taskkill /F) instead of a graceful close. */
  force?: boolean;
  // -- generic --------------------------------------------------------------
  /** --help / -h. */
  help?: boolean;
  /** Positional args (verb is positional[0]). */
  positional: string[];
  /** Args after a bare `--` separator (forwarded to claude on `new`). */
  passthrough?: string[];
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

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Everything after a bare `--` is forwarded verbatim (used by `new`).
    if (a === "--") {
      out.passthrough = argv.slice(i + 1);
      break;
    } else if (a === "--pipe") out.pipeFlag = requireValue("--pipe", argv[++i]);
    else if (a.startsWith("--pipe=")) out.pipeFlag = requireValue("--pipe", a.slice("--pipe=".length));
    else if (a === "--json") out.json = true;
    else if (a === "--file") out.file = requireValue("--file", argv[++i]);
    else if (a.startsWith("--file=")) out.file = requireValue("--file", a.slice("--file=".length));
    else if (a === "--timeout") out.timeoutMs = parseTimeoutSeconds("--timeout", argv[++i]);
    else if (a.startsWith("--timeout="))
      out.timeoutMs = parseTimeoutSeconds("--timeout", a.slice("--timeout=".length));
    else if (a === "--label") out.label = requireValue("--label", argv[++i]);
    else if (a.startsWith("--label=")) out.label = requireValue("--label", a.slice("--label=".length));
    else if (a === "--model") out.model = requireValue("--model", argv[++i]);
    else if (a.startsWith("--model=")) out.model = requireValue("--model", a.slice("--model=".length));
    else if (a === "--cwd") out.cwd = requireValue("--cwd", argv[++i]);
    else if (a.startsWith("--cwd=")) out.cwd = requireValue("--cwd", a.slice("--cwd=".length));
    else if (a === "--text") out.text = requireValue("--text", argv[++i]);
    else if (a.startsWith("--text=")) out.text = requireValue("--text", a.slice("--text=".length));
    else if (a === "--line") out.line = requireValue("--line", argv[++i]);
    else if (a.startsWith("--line=")) out.line = requireValue("--line", a.slice("--line=".length));
    else if (a === "--key") out.key = requireValue("--key", argv[++i]);
    else if (a.startsWith("--key=")) out.key = requireValue("--key", a.slice("--key=".length));
    else if (a === "--headless") out.headless = true;
    else if (a === "--headful") out.headful = true;
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else out.positional.push(a);
  }
  return out;
}

/**
 * Resolve a user-supplied selector to a concrete pipe name. Order:
 *   explicit selector → $CLAUDE_WRAP_PIPE → the single live instance →
 *   DEFAULT_PIPE_NAME. Throws a helpful listing when >1 instance is live
 *   and no selector was given.
 */
export function resolvePipe(explicit?: string): string {
  if (explicit) {
    const hit = findInstance(explicit);
    return hit ? hit.pipe : explicit;
  }
  const fromEnv = process.env["CLAUDE_WRAP_PIPE"];
  if (fromEnv) return fromEnv;
  const live = listInstances();
  if (live.length === 1) return live[0]!.pipe;
  if (live.length > 1) {
    const names = live
      .map((e) => `  ${e.label ?? "?"}  ${e.pipe}  (pid ${e.pid}, ${e.cwd})`)
      .join("\n");
    throw new Error(
      `multiple claude-wrap instances running; pick one with <selector> / --pipe <name|label> or set CLAUDE_WRAP_PIPE:\n${names}`,
    );
  }
  return DEFAULT_PIPE_NAME;
}

/** Expand the small set of backslash escapes accepted on `write`/`send --text`. */
export function unescape(s: string): string {
  return s
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
