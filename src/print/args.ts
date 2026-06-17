// PrintOptions and the PrintOptions → argv builder (+ isolation profile).
//
// Pure and side-effect-free so it is fully unit-testable. The print client
// composes the executable + this argv; the prompt itself is handled per-mode
// (persistent primes stdin; one-shot passes the prompt positionally right after
// `-p`, BEFORE any variadic flag like --tools, so the prompt isn't swallowed).

import type { CanUseTool } from "./control";
import type { BridgedTool } from "./mcp-bridge";

export type Transport = "persistent" | "oneshot";

/** Inline MCP config object (§10 shape). */
export interface McpConfig {
  mcpServers: Record<string, unknown>;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

const VALID_PERMISSION_MODES = new Set<string>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface PrintOptions {
  cwd?: string;
  model?: string;
  /** --session-id (pin) — else captured from init. */
  sessionId?: string;
  /** --resume <id>. */
  resume?: string;
  /** --continue. */
  continue?: boolean;
  /** --fork-session. */
  forkSession?: boolean;
  /** false => --no-session-persistence. */
  persistSession?: boolean;
  transport?: Transport;
  /** --system-prompt (replace). */
  systemPrompt?: string;
  /** --append-system-prompt. */
  appendSystemPrompt?: string;
  /** --tools. [] => `--tools ""` (none); undefined => omit (CLI default set). */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Passed verbatim; validated against the known set, unknown values rejected before spawn. */
  permissionMode?: PermissionMode;
  /** --permission-prompt-tool. "stdio" routes "ask" decisions to the control
   *  protocol (can_use_tool); set automatically when canUseTool is provided. */
  permissionPromptTool?: string;
  /** --mcp-config: inline object, or one/more config file paths. */
  mcpConfig?: McpConfig | string[];
  /** --strict-mcp-config. */
  strictMcpConfig?: boolean;
  /** --setting-sources (comma-joined). [] => `--setting-sources ""`. */
  settingSources?: ("user" | "project" | "local")[] | [];
  /** --json-schema (structured output). */
  jsonSchema?: object;
  /** --include-partial-messages (stream-json / persistent only). */
  includePartialMessages?: boolean;
  /** --max-budget-usd. */
  maxBudgetUsd?: number;
  /** --fallback-model — joined into ONE comma-separated arg (NOT variadic). */
  fallbackModel?: string[];
  /** Reasoning effort. Applied via the CLAUDE_EFFORT env var (the `--effort` flag
   *  is unverified for `claude -p`), so it lives outside the argv. */
  effort?: Effort;
  /** --agents (JSON). */
  agents?: object;
  /** Escape hatch — appended verbatim. */
  extraArgs?: string[];
  /** Enables the control protocol (M4). Not an argv flag. */
  canUseTool?: CanUseTool;
  /** In-process functions exposed to Claude via the SDK-MCP control bridge (M5). Not an argv flag. */
  functions?: BridgedTool[];
  /** Server name for the in-process function bridge. Default "cw_fns". */
  functionServerName?: string;
  /** Shorthand for the cheap-clean isolation profile (§1.7). */
  isolate?: boolean;
  /** Human label for the session. Not an argv flag. */
  label?: string;
  /** Per-turn timeout (ms). Not an argv flag. */
  timeoutMs?: number;
}

/**
 * Apply the §1.7 isolation profile as DEFAULTS (explicit fields win). Returns a
 * new options object; does not mutate the input. Empties the cost drivers
 * (tools / mcp_servers / plugins) so a clean call costs ~13× less. Note: this
 * is orthogonal to env hygiene (childEnv) — both are needed for cheap-clean.
 */
export function applyIsolation(opts: PrintOptions): PrintOptions {
  if (!opts.isolate) return opts;
  return {
    ...opts,
    strictMcpConfig: opts.strictMcpConfig ?? true,
    mcpConfig: opts.mcpConfig ?? { mcpServers: {} },
    settingSources: opts.settingSources ?? [],
    tools: opts.tools ?? [],
  };
}

/** Validate options that must be rejected before spawn. Throws on invalid input. */
export function validateOptions(opts: PrintOptions): void {
  if (opts.permissionMode !== undefined && !VALID_PERMISSION_MODES.has(opts.permissionMode)) {
    throw new Error(
      `invalid permissionMode "${opts.permissionMode}"; expected one of ${[...VALID_PERMISSION_MODES].join(", ")}`,
    );
  }
}

/**
 * Build the argv that follows `claude`. For one-shot, pass `prompt` so it is
 * placed positionally right after `-p`; for persistent, omit it (stdin-primed).
 *
 * Throws on invalid options (see validateOptions).
 */
export function buildArgs(rawOpts: PrintOptions, mode: Transport, prompt?: string): string[] {
  validateOptions(rawOpts);
  const opts = applyIsolation(rawOpts);
  const argv: string[] = ["-p"];

  // One-shot: prompt goes immediately after -p, before any variadic flag.
  if (mode === "oneshot" && prompt !== undefined) {
    argv.push(prompt);
  }

  // Transport / output format.
  if (mode === "persistent") {
    argv.push("--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
    if (opts.includePartialMessages) argv.push("--include-partial-messages");
  } else {
    argv.push("--output-format", "json");
    // --include-partial-messages is stream-json-only; silently irrelevant here.
  }

  if (opts.model) argv.push("--model", opts.model);
  if (opts.sessionId) argv.push("--session-id", opts.sessionId);
  if (opts.resume) argv.push("--resume", opts.resume);
  if (opts.continue) argv.push("--continue");
  if (opts.forkSession) argv.push("--fork-session");
  if (opts.persistSession === false) argv.push("--no-session-persistence");

  if (opts.systemPrompt !== undefined) argv.push("--system-prompt", opts.systemPrompt);
  if (opts.appendSystemPrompt !== undefined) argv.push("--append-system-prompt", opts.appendSystemPrompt);

  if (opts.permissionMode !== undefined) argv.push("--permission-mode", opts.permissionMode);
  if (opts.permissionPromptTool !== undefined) argv.push("--permission-prompt-tool", opts.permissionPromptTool);

  if (opts.mcpConfig !== undefined) {
    if (Array.isArray(opts.mcpConfig)) {
      if (opts.mcpConfig.length > 0) argv.push("--mcp-config", ...opts.mcpConfig);
    } else {
      argv.push("--mcp-config", JSON.stringify(opts.mcpConfig));
    }
  }
  if (opts.strictMcpConfig) argv.push("--strict-mcp-config");

  if (opts.settingSources !== undefined) {
    argv.push("--setting-sources", opts.settingSources.length === 0 ? "" : opts.settingSources.join(","));
  }

  if (opts.jsonSchema !== undefined) argv.push("--json-schema", JSON.stringify(opts.jsonSchema));

  if (opts.maxBudgetUsd !== undefined) argv.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.fallbackModel !== undefined && opts.fallbackModel.length > 0) {
    argv.push("--fallback-model", opts.fallbackModel.join(","));
  }
  if (opts.agents !== undefined) argv.push("--agents", JSON.stringify(opts.agents));

  if (opts.allowedTools !== undefined && opts.allowedTools.length > 0) {
    argv.push("--allowedTools", ...opts.allowedTools);
  }
  if (opts.disallowedTools !== undefined && opts.disallowedTools.length > 0) {
    argv.push("--disallowedTools", ...opts.disallowedTools);
  }
  // --tools is variadic. Emit LAST among the variadic flags so its run ends at
  // a following `--flag` or argv end (never swallows a positional — the
  // one-shot prompt already sits up front after -p).
  if (opts.tools !== undefined) {
    argv.push("--tools", ...(opts.tools.length === 0 ? [""] : opts.tools));
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) argv.push(...opts.extraArgs);

  return argv;
}
