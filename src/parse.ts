// Parsers for structured UI blocks that appear in Claude Code snapshots.

import { BUSY_WINDOW_LINES, RIGHT_UI_MIN_GAP } from "./config";

export type TodoStatus = "open" | "done" | "in_progress";

export interface TodoItem {
  status: TodoStatus;
  text: string;
}

export interface TodoList {
  total: number;
  done: number;
  open: number;
  tasks: TodoItem[];
}

export interface UserPrompt {
  /** Line index in the input snapshot. */
  index: number;
  text: string;
}

export interface ToolCall {
  /** Line index of the "● Tool(args)" row. */
  index: number;
  tool: string;
  args: string;
  /** Joined continuation lines after the "⎿" marker, if any. */
  result: string;
}

export interface PermissionOption {
  key: string;
  label: string;
  selected: boolean;
}

export interface PermissionPrompt {
  /** Line index of the "Do you want to proceed?" row. */
  index: number;
  /** e.g. "Bash command", "Write", "Edit". May be empty if we couldn't find a header. */
  title: string;
  /** Free-form body lines between the header and the question. */
  body: string[];
  options: PermissionOption[];
}

export interface StatusLine {
  index: number;
  /** "accept edits on", "plan mode", "normal", or whatever mode string was seen. */
  mode: string | null;
  /** True if a spinner glyph is currently on screen (assistant is working). */
  busy: boolean;
  /** Token count if shown in the status bar. */
  tokens: number | null;
  /** Raw text of the matched row, trimmed. */
  raw: string;
  /** The spinner line content (if busy), used to detect stale spinners. */
  spinnerLine?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cut a snapshot row at the first run of `minGap`+ spaces so that
 * right-aligned UI (decorative ASCII art, status column, etc.) doesn't
 * bleed into parsed text. Defaults to 5+ spaces so normal code/shell
 * snippets containing a stray "  " aren't mangled; pass a smaller gap
 * when the payload is known to be tight (e.g. a single-word task).
 */
// Compiled regexes are cached by gap width — cutRightUI is the most-called
// helper in the parse cycle and `minGap` is almost always the default.
const RIGHT_UI_RE_CACHE = new Map<number, RegExp>();

function cutRightUI(s: string, minGap: number = RIGHT_UI_MIN_GAP): string {
  let re = RIGHT_UI_RE_CACHE.get(minGap);
  if (!re) {
    re = new RegExp(`\\s{${minGap},}`);
    RIGHT_UI_RE_CACHE.set(minGap, re);
  }
  const m = re.exec(s);
  return m ? s.slice(0, m.index) : s;
}

const TODO_HEADER_RE = /^(\d+)\s+tasks?\s*\((\d+)\s+done,\s*(\d+)\s+open\)\s*$/;

const TODO_GLYPHS: Record<string, TodoStatus> = {
  "◻": "open",
  "☐": "open",
  "✔": "done",
  "✓": "done",
  "☑": "done",
  "◉": "in_progress",
};

// Characters the TUI uses as animated progress indicators.
const SPINNER_GLYPHS = new Set(["✢", "✻", "✶", "✽", "◐", "◑", "◒", "◓", "⠋", "⠙", "⠹", "⠸"]);

// ---------------------------------------------------------------------------
// Todo list
// ---------------------------------------------------------------------------

/**
 * Scan for a todo-list block of the form:
 *
 *   N tasks (D done, O open)
 *   ◻ Task one
 *   ✔ Task two
 *
 * Returns the last such block on screen, or null.
 */
export function parseTodoList(lines: string[]): TodoList | null {
  let found: TodoList | null = null;

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.trim() ?? "";
    const m = TODO_HEADER_RE.exec(header);
    if (!m) continue;

    const total = Number(m[1]);
    const done = Number(m[2]);
    const open = Number(m[3]);

    const tasks: TodoItem[] = [];
    for (let j = i + 1; j < lines.length && tasks.length < total; j++) {
      const raw = lines[j]?.trim() ?? "";
      if (raw === "") continue;
      // Glyphs are all single BMP code points, so raw[0] is sufficient
      // and avoids spreading the whole line into an array.
      const glyph = raw[0] ?? "";
      const status = TODO_GLYPHS[glyph];
      if (!status) break;
      const text = cutRightUI(raw.slice(glyph.length).trim());
      tasks.push({ status, text });
    }

    if (tasks.length === total) found = { total, done, open, tasks };
  }

  return found;
}

// ---------------------------------------------------------------------------
// User prompts
// ---------------------------------------------------------------------------

/**
 * Return every user prompt row on screen. A user prompt is a line that,
 * after trimming leading whitespace, begins with "❯ " (or equals "❯").
 * The chevron is stripped and trailing right-column UI is cut.
 */
export function parseUserPrompts(lines: string[]): UserPrompt[] {
  const out: UserPrompt[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trimStart();
    if (raw === "❯" || raw === "❯ ") {
      out.push({ index: i, text: "" });
    } else if (raw.startsWith("❯ ")) {
      out.push({ index: i, text: cutRightUI(raw.slice(2).trim()) });
    }
  }
  return out;
}

/** Return the slice of `lines` from the last user prompt onward. */
export function sliceSinceLastUser(lines: string[]): string[] {
  const prompts = parseUserPrompts(lines);
  if (prompts.length === 0) return lines.slice();
  return lines.slice(prompts[prompts.length - 1]!.index);
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

// Matches "● Bash(mkdir -p ...)" or "● Web Search("query")" etc.
const TOOL_CALL_RE = /^●\s+([A-Za-z][\w ]*?)\((.*)\)\s*$/;

/**
 * Parse "● Tool(args)" rows and their "⎿ result" continuations.
 * Handles multi-line results (subsequent lines that are indented more
 * than the "●" row and don't themselves start with "●").
 */
export function parseToolCalls(lines: string[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trimStart();
    const m = TOOL_CALL_RE.exec(cutRightUI(trimmed));
    if (!m) continue;

    const tool = m[1]!.trim();
    const args = m[2]!;
    const resultParts: string[] = [];

    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      const nextTrim = next.trimStart();
      if (nextTrim === "") continue;
      if (nextTrim.startsWith("●")) break;
      // A "⎿" marks the first result line; subsequent indented lines belong to it.
      if (nextTrim.startsWith("⎿")) {
        resultParts.push(cutRightUI(nextTrim.slice(1).trim()));
        continue;
      }
      if (resultParts.length > 0) {
        resultParts.push(cutRightUI(nextTrim));
        continue;
      }
      break;
    }

    out.push({ index: i, tool, args, result: resultParts.join("\n") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Permission prompt
// ---------------------------------------------------------------------------

const PERMISSION_Q_RE = /^do you want to proceed\??$/i;
const PERMISSION_OPTION_RE = /^(?:❯\s*)?(\d+)\.\s+(.+)$/;

/**
 * Detect the "Do you want to proceed?" permission box. Returns the last
 * one on screen or null if not present.
 */
export function parsePermissionPrompt(lines: string[]): PermissionPrompt | null {
  let found: PermissionPrompt | null = null;

  for (let i = 0; i < lines.length; i++) {
    const q = lines[i]?.trim() ?? "";
    if (!PERMISSION_Q_RE.test(q)) continue;

    // Walk forward collecting options.
    const options: PermissionOption[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const rowFull = lines[j] ?? "";
      const row = rowFull.trimStart();
      if (row === "") {
        if (options.length > 0) break;
        continue;
      }
      const selected = row.startsWith("❯");
      const m = PERMISSION_OPTION_RE.exec(row);
      if (!m) {
        if (options.length > 0) break;
        continue;
      }
      options.push({ key: m[1]!, label: cutRightUI(m[2]!.trim()), selected });
    }

    // Walk backward for the title ("<Tool> command") and body lines.
    // Stop at a `●` tool bullet or `❯` user prompt so we don't scoop in
    // unrelated earlier content.
    let title = "";
    const bodyRev: string[] = [];
    for (let k = i - 1; k >= 0; k--) {
      const row = (lines[k] ?? "").trim();
      if (row === "") continue;
      if (row.startsWith("●") || row.startsWith("❯")) break;
      if (/ command$/i.test(row)) {
        title = row;
        break;
      }
      bodyRev.push(cutRightUI(row));
      if (bodyRev.length > 20) break;
    }
    const body = bodyRev.reverse();

    found = { index: i, title, body, options };
  }

  return found;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

const MODE_RE = /(accept edits on|plan mode on|auto-accept on|normal mode)/i;
const TOKENS_RE = /(\d[\d,]*)\s+tokens/;

/**
 * Parse the bottom status row plus detect whether a spinner glyph is
 * currently visible (i.e. the assistant is working). Busy detection is
 * limited to the window immediately above the status bar so that stale
 * spinner rows from earlier in the scrollback don't report as busy.
 */
export function parseStatusLine(lines: string[]): StatusLine {
  let bar: StatusLine | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    const modeMatch = MODE_RE.exec(raw);
    if (modeMatch) {
      const tokensMatch = TOKENS_RE.exec(raw);
      bar = {
        index: i,
        mode: modeMatch[1]!.toLowerCase(),
        busy: false,
        tokens: tokensMatch ? Number(tokensMatch[1]!.replace(/,/g, "")) : null,
        raw,
      };
    }
  }

  // Busy window: the last BUSY_WINDOW_LINES non-empty lines of the
  // snapshot tail. Anchoring to the actual tail (rather than to
  // bar.index) avoids a subtle bug when multiple status-bar-like rows
  // exist in scrollback and `bar` points to the wrong one.
  let tailEnd = lines.length;
  while (tailEnd > 0 && (lines[tailEnd - 1] ?? "").trim() === "") tailEnd--;
  const tailStart = Math.max(0, tailEnd - BUSY_WINDOW_LINES);
  // Scan tail for spinner glyphs indicating Claude is actively working.
  let busy = false;
  let spinnerLine: string | undefined;
  for (let i = tailStart; i < tailEnd; i++) {
    const row = (lines[i] ?? "").trim();
    if (row === "") continue;
    const glyph = row[0] ?? "";
    if (SPINNER_GLYPHS.has(glyph)) {
      busy = true;
      spinnerLine = row;
      break;
    }
  }

  if (bar) {
    bar.busy = busy;
    bar.spinnerLine = spinnerLine;
    return bar;
  }
  return { index: -1, mode: null, busy, tokens: null, raw: "", spinnerLine };
}
