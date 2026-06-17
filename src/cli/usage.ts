// Usage / help text for the claude-wrap CLI.

import { DEFAULT_PIPE_NAME } from "../protocol";
import { KEYS } from "../keys";

export type Bin = "claude-wrap" | "inject";

const PIPE_RESOLUTION = `Selector: a <name|label> positional or --pipe <name|label>. When omitted it falls\n  back to $CLAUDE_WRAP_PIPE, then the single live instance, then "${DEFAULT_PIPE_NAME}".`;

/** Top-level usage, tailored to which bin invoked it. */
export function printTopUsage(bin: Bin): void {
  const prog = bin === "inject" ? "claude-wrap-inject" : "claude-wrap";
  const launchBlurb =
    bin === "inject"
      ? ""
      : `\nLaunch (default when the first word isn't a verb):\n  ${prog}                         open a Claude window in the current dir\n  ${prog} --model <id> [args…]     open a window, forwarding flags to claude\n  ${prog} -- <claude args…>        force-forward args to claude (escape verbs)\n`;

  console.error(`claude-wrap — spawn and drive Claude Code sessions.

Usage: ${prog} <verb> [selector] [options]
${launchBlurb}
Sessions:
  new [--label L] [--model ID] [--cwd DIR] [--headless|--headful] [-- claude args…]
                                spawn a session (headful window by default)
  list | ls [--json]            list live instances
  stop | kill <sel> [--force]   stop an instance (--force hard-kills immediately)
  attach <sel>                  open a shell window bound to an instance

Drive:
  ask <sel> "<text>" [--timeout S]   send a prompt and wait until idle
  send <sel> (--text S | --line S | --key NAME | "<text>")   send input
  status <sel> [--json]              parsed state (busy/mode/tokens/perm/todo/tools)
  snapshot <sel> [viewport] [clean]  dump the rendered screen
  approve <sel> | deny <sel>         resolve a pending permission prompt
  resolve <sel> <approve|deny>       same, MCP-style

Advanced (raw pipe + parsers):
  write <text> | write-b64 <b64> | key <${Object.keys(KEYS).slice(0, 4).join("|")}|…>
  resize <cols> <rows> | snapshot | repl
  wait-idle [--timeout S] | wait-for <regex> [--timeout S]
  parse-todo | parse-prompts | parse-tools | parse-permission | parse-status
                                (these read --pipe or --file <path>)

  ${prog} help [verb]            detailed help for a verb

${PIPE_RESOLUTION}`);
}

interface VerbHelp {
  usage: string;
  notes?: string;
}

const VERB_HELP: Record<string, VerbHelp> = {
  new: {
    usage: "new [--label L] [--model ID] [--cwd DIR] [--headless|--headful] [-- <claude args…>]",
    notes:
      "Spawns a session. Default is a visible window (--headful); --headless runs a hidden\n" +
      "background instance you drive over the pipe. Prints the new pipe/label/pid. Args after\n" +
      "`--` are forwarded to claude verbatim. Aliases: launch, spawn.",
  },
  list: { usage: "list [--json]", notes: "List live instances. Alias: ls." },
  stop: {
    usage: "stop <sel> [--force]",
    notes:
      "Stop a live instance by pid (closes its claude + window/process tree). Plain `stop`\n" +
      "tries a graceful close, then hard-kills if it survives (Windows console trees need it).\n" +
      "--force skips straight to the hard kill. The registry entry is only dropped once the\n" +
      "process is confirmed dead, so a failed stop never orphans an instance. Alias: kill.",
  },
  ask: {
    usage: 'ask <sel> "<text>" [--timeout S]',
    notes:
      "Type a prompt, press Enter, and wait until Claude goes idle. With exactly one live\n" +
      "instance the selector may be omitted. --json prints {status, lines}.",
  },
  send: {
    usage: 'send <sel> (--text S | --line S | --key NAME | "<text>")',
    notes:
      "Send input without waiting. --text = verbatim (supports \\r \\n \\t \\xNN); --line adds\n" +
      "Enter; --key sends a named key (e.g. shift-tab to cycle modes). A bare positional is\n" +
      "treated as --line.",
  },
  status: {
    usage: "status <sel> [--json]",
    notes: "Parsed state: busy/mode/tokens/effort, permission prompt, todo list, tool calls.",
  },
  snapshot: { usage: "snapshot <sel> [viewport] [clean]", notes: "Dump the rendered screen." },
  approve: { usage: "approve <sel>", notes: "Pick the first option of a pending permission prompt." },
  deny: { usage: "deny <sel>", notes: "Pick the last option of a pending permission prompt." },
  resolve: { usage: "resolve <sel> <approve|deny>", notes: "Approve/deny, MCP-style." },
  attach: { usage: "attach <sel>", notes: "Open a new shell window with CLAUDE_WRAP_PIPE preset." },
};

/** Per-verb detailed help. Falls back to top usage for unknown verbs. */
export function printVerbUsage(verb: string | undefined, bin: Bin): void {
  const norm = verb === "ls" ? "list" : verb === "kill" ? "stop" : verb === "launch" || verb === "spawn" ? "new" : verb;
  const h = norm ? VERB_HELP[norm] : undefined;
  if (!h) {
    printTopUsage(bin);
    return;
  }
  console.error(`Usage: claude-wrap ${h.usage}`);
  if (h.notes) console.error(`\n${h.notes}`);
  console.error(`\n${PIPE_RESOLUTION}`);
}
