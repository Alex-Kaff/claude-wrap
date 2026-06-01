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
  /** Line index of the question / first option row. */
  index: number;
  /** Box header, e.g. "Bash command", "Create file", "Edit file", "Fetch",
   *  "Trust folder". May be empty if we couldn't find a header. */
  title: string;
  /** The question being asked, e.g. "Do you want to create note.txt?".
   *  Empty for prompts whose phrasing we don't recognize. */
  question: string;
  /** Free-form body lines between the header and the question (command text,
   *  diff, fetch target, …) with box-drawing separators stripped. */
  body: string[];
  options: PermissionOption[];
}

export interface StatusLine {
  index: number;
  /** "auto mode on", "accept edits on", "plan mode on", "normal", or null.
   *  Normal/default mode has no phrase on the bar; we report it as "normal". */
  mode: string | null;
  /** True while the assistant is actively working. Driven by the
   *  "esc to interrupt" hint in the bottom status bar (reliable across
   *  Claude Code versions), with a live "thinking" spinner line as a
   *  fallback when no bar is on screen. */
  busy: boolean;
  /** Token count if shown in the status bar. */
  tokens: number | null;
  /** Reasoning-effort level shown bottom-right ("◉ xhigh · /effort"), or null. */
  effort: string | null;
  /** Raw text of the matched status-bar row, trimmed. */
  raw: string;
  /** The live "thinking" spinner line (e.g. "Kneading… (6s · …)") if present.
   *  Diagnostic only; busy no longer depends on animated spinner glyphs. */
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

// Remote-control session URL surfaced on boot when /remote-control is active.
const REMOTE_URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/;

/** Extract the remote-control session URL if Claude Code printed one. */
export function parseRemoteUrl(lines: string[]): string | null {
  for (const line of lines) {
    const m = REMOTE_URL_RE.exec(line);
    if (m) return m[0];
  }
  return null;
}

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

// A permission/confirmation option row: "❯ 1. Yes", "2. No", "3. ...".
// The selection cursor "❯" (when present) marks the highlighted option.
const PERMISSION_OPTION_RE = /^(?:❯\s*)?(\d+)[.)]\s+(.+)$/;

// The question that opens a tool/file permission prompt. Wording varies by
// action ("Do you want to proceed?", "Do you want to create note.txt?",
// "Do you want to allow Claude to fetch this content?", "Do you want to make
// this edit to …?"), so we match the stable "Do you want to" stem anywhere.
const PERMISSION_QUESTION_RE = /\bdo you want to\b/i;

// Startup "trust this folder" safety dialog (a different shape: no box, the
// question is wrapped across lines). Detected by its options / phrasing.
const TRUST_OPTION_RE = /\btrust this folder\b/i;
const TRUST_QUESTION_RE = /you created or one you trust/i;
const TRUST_QUESTION = "Is this a project you created or one you trust?";

// The box top border is a solid horizontal rule; diff/content separators
// inside the box are drawn with dashed box-drawing glyphs. We stop the
// title/body backscan at the solid rule and drop the dashed separators.
function isSolidRule(s: string): boolean {
  return /^─{10,}$/.test(s);
}
function isBoxSeparator(s: string): boolean {
  return /^[╌╍┄┅┈┉╶╴‐-]{4,}$/.test(s);
}

interface OptionRun {
  /** Index of the first option row. */
  start: number;
  options: PermissionOption[];
}

/** Find every run of consecutive numbered option rows on screen. */
function findOptionRuns(lines: string[]): OptionRun[] {
  const runs: OptionRun[] = [];
  for (let i = 0; i < lines.length; ) {
    const m = PERMISSION_OPTION_RE.exec((lines[i] ?? "").trimStart());
    if (!m) {
      i++;
      continue;
    }
    const start = i;
    const options: PermissionOption[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const row = (lines[j] ?? "").trimStart();
      const mj = PERMISSION_OPTION_RE.exec(row);
      if (!mj) break;
      options.push({ key: mj[1]!, label: cutRightUI(mj[2]!.trim()), selected: row.startsWith("❯") });
    }
    runs.push({ start, options });
    i = j + 1;
  }
  return runs;
}

/**
 * Detect an interactive prompt that is waiting on the user: tool/file
 * permission boxes ("Do you want to …?"), the startup trust dialog, and any
 * other numbered yes/no menu Claude Code puts up. Anchored on the option menu
 * (≥2 numbered rows with a "❯" selection cursor) so it survives prompt-wording
 * changes between Claude Code releases. Returns the last (active) one or null.
 */
export function parsePermissionPrompt(lines: string[]): PermissionPrompt | null {
  // A real prompt menu has a selection cursor; Claude's own numbered output
  // (e.g. a markdown list in a reply) never does. That cursor is what keeps
  // this from matching ordinary transcript text.
  const runs = findOptionRuns(lines).filter(
    (r) => r.options.length >= 2 && r.options.some((o) => o.selected),
  );
  if (runs.length === 0) return null;
  const run = runs[runs.length - 1]!;

  // Nearest non-empty line above the option menu.
  let qIdx = -1;
  for (let k = run.start - 1; k >= 0; k--) {
    if ((lines[k] ?? "").trim() !== "") {
      qIdx = k;
      break;
    }
  }
  const qLine = qIdx >= 0 ? (lines[qIdx] ?? "").trim() : "";

  // --- Startup "trust this folder" dialog -------------------------------
  if (
    !PERMISSION_QUESTION_RE.test(qLine) &&
    (run.options.some((o) => TRUST_OPTION_RE.test(o.label)) ||
      lines.some((l) => TRUST_QUESTION_RE.test(l)))
  ) {
    return {
      index: run.start,
      title: "Trust folder",
      question: TRUST_QUESTION,
      body: [],
      options: run.options,
    };
  }

  // --- Tool / file permission box (and generic numbered prompts) --------
  const isQuestion = PERMISSION_QUESTION_RE.test(qLine);
  // Backscan for the box header: collect non-empty content rows up to the
  // solid top rule; the topmost collected row is the title ("Create file",
  // "Bash command", "Fetch", …), the rest is the body. When the line above
  // the options isn't a recognizable question we fold it into the body.
  const collected: string[] = [];
  const scanFrom = isQuestion ? qIdx : run.start;
  for (let k = scanFrom - 1; k >= 0; k--) {
    const row = (lines[k] ?? "").trim();
    if (row === "") continue;
    if (isSolidRule(row)) break;
    if (row.startsWith("●") || row.startsWith("❯")) break;
    if (isBoxSeparator(row)) continue;
    collected.push(cutRightUI(row));
    if (collected.length > 30) break;
  }
  let title = "";
  let body: string[] = [];
  if (collected.length > 0) {
    title = collected[collected.length - 1]!;
    body = collected.slice(0, -1).reverse();
  }

  return {
    index: qIdx >= 0 ? qIdx : run.start,
    title,
    question: isQuestion ? qLine : "",
    body,
    options: run.options,
  };
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

// Mode phrases shown at the left of the bottom status bar. Normal/default
// mode shows no phrase (just "? for shortcuts"), so it's matched separately.
const MODE_RE = /\b(auto mode on|accept edits on|plan mode on|bypass(?:ing)? permissions(?: on)?|auto-accept on)\b/i;
const TOKENS_RE = /(\d[\d,]*)\s+tokens\b/;
// Normal/default mode hint (no explicit mode phrase on the bar).
const NORMAL_HINT_RE = /\?\s+for\s+shortcuts/i;
// Present in the bottom bar only while Claude is working — the reliable,
// version-stable busy signal (idle shows "← for agents" instead).
const INTERRUPT_RE = /\besc to interrupt\b/i;
// Reasoning-effort indicator, rendered bottom-right: "◉ xhigh · /effort".
const EFFORT_RE = /[◉●]\s*([A-Za-z]+)\s*·\s*\/effort/;
// A live "thinking"/working spinner line: "Kneading… (6s · ↓ 143 tokens · …)".
// The trailing "(Ns" distinguishes it from a static completion line such as
// "✻ Baked for 27s", which carries no parenthetical timer.
const WORKING_RE = /…\s*\(\d+\s*s\b/;

/** True if `line` looks like the bottom status bar (vs. transcript content). */
function looksLikeStatusBar(line: string): boolean {
  return (
    TOKENS_RE.test(line) ||
    MODE_RE.test(line) ||
    NORMAL_HINT_RE.test(line) ||
    INTERRUPT_RE.test(line)
  );
}

/**
 * Parse the bottom status bar: mode, token count, reasoning effort, and
 * whether Claude is busy. Busy is keyed off the "esc to interrupt" hint in
 * the bar (stable across Claude Code versions) rather than animated spinner
 * glyphs — the glyphs vary per frame ("*", "·", "✶", "✻") and a finished
 * "✻ Baked for 27s" line stays on screen, so glyph matching gave false
 * positives. A live "thinking" spinner line is used only as a fallback when
 * no status bar is on screen (e.g. mid-boot).
 */
export function parseStatusLine(lines: string[]): StatusLine {
  // Find the live bottom bar: the lowest status-bar-looking line that isn't
  // the working spinner (which also mentions "tokens"). The effort line
  // ("◉ xhigh · /effort") renders below the bar but matches none of the bar
  // signatures, so it's naturally skipped.
  let barIdx = -1;
  let bar = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    if (WORKING_RE.test(raw)) continue; // thinking line, not the bar
    if (looksLikeStatusBar(raw)) {
      barIdx = i;
      bar = raw;
      break;
    }
  }

  // Reasoning effort (scan the tail; it sits at/just below the bar).
  let effort: string | null = null;
  {
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
    const start = Math.max(0, end - BUSY_WINDOW_LINES);
    for (let i = end - 1; i >= start; i--) {
      const m = EFFORT_RE.exec((lines[i] ?? "").trim());
      if (m) {
        effort = m[1]!.toLowerCase();
        break;
      }
    }
  }

  // Live thinking/working spinner line (diagnostic + busy fallback).
  let spinnerLine: string | undefined;
  {
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
    const start = Math.max(0, end - BUSY_WINDOW_LINES);
    for (let i = end - 1; i >= start; i--) {
      const raw = (lines[i] ?? "").trim();
      if (WORKING_RE.test(raw)) {
        spinnerLine = raw;
        break;
      }
    }
  }

  let mode: string | null = null;
  let tokens: number | null = null;
  let busy = false;
  if (barIdx >= 0) {
    const mm = MODE_RE.exec(bar);
    if (mm) mode = mm[1]!.toLowerCase();
    else if (NORMAL_HINT_RE.test(bar)) mode = "normal";
    const tm = TOKENS_RE.exec(bar);
    if (tm) tokens = Number(tm[1]!.replace(/,/g, ""));
    busy = INTERRUPT_RE.test(bar);
  } else if (spinnerLine) {
    // No bar on screen but a live spinner is — treat as busy.
    busy = true;
  }

  return { index: barIdx, mode, busy, tokens, effort, raw: bar, spinnerLine };
}
