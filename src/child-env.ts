// Build a clean environment for a spawned `claude` process.
//
// claude-wrap is frequently launched from *inside* another Claude Code session
// (e.g. an MCP server the parent agent is driving). The parent process carries
// environment variables that make a freshly-spawned `claude` misbehave:
//
//  - CLAUDE_CODE_SSE_PORT  — the parent's IDE (VS Code / Cursor) extension port.
//    The child auto-connects to that same IDE, so every Write/Edit pops a diff
//    in the editor and stalls on "Save file to continue…", and permission
//    prompts grow an IDE-diff header. This is the single biggest source of
//    "junky" spawned sessions.
//  - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT — mark the process as running inside
//    Claude Code; leaking them makes the child think it is nested.
//  - CLAUDE_CODE_SESSION_ID — the parent's session id, inherited verbatim.
//  - CLAUDE_EFFORT — the parent's reasoning-effort override, silently applied
//    to the child instead of its own configured default.
//
// We strip these so a spawned session behaves like a clean standalone `claude`
// invocation. Everything else (PATH, HOME, auth, etc.) is preserved.

/** Exact env var names to drop from a spawned child's environment. */
const STRIP_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "AI_AGENT",
]);

/** Env var name prefixes to drop (covers the whole CLAUDE_CODE_* family). */
const STRIP_PREFIXES = ["CLAUDE_CODE_"];

/**
 * Return a shallow copy of `base` (defaults to process.env) with the parent's
 * Claude Code / IDE-integration variables removed, plus any `extra` overrides
 * merged on top. Use this for every `claude` spawn so nested sessions don't
 * inherit the launching agent's IDE connection, session id, or effort.
 */
export function childEnv(
  extra?: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP_EXACT.has(k)) continue;
    if (STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  if (extra) Object.assign(env, extra);
  return env;
}
