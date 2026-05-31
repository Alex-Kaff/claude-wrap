// SessionState type and ContinuousParser: continuously parses the virtual
// screen after every PTY write, diffs against previous state, and emits
// typed events for each detected change.

import type { VirtualScreen } from "./screen";
import type { TypedEmitter } from "./events";
import type { SessionEvents } from "./events";
import {
  parseStatusLine,
  parseUserPrompts,
  parseToolCalls,
  parsePermissionPrompt,
  parseTodoList,
  type ToolCall,
  type UserPrompt,
  type PermissionPrompt,
  type TodoList,
} from "./parse";
import { PARSE_DEBOUNCE_MS } from "./config";

// ---------------------------------------------------------------------------
// SessionState
// ---------------------------------------------------------------------------

export interface SessionState {
  status: { mode: string | null; busy: boolean; tokens: number | null };
  toolCalls: ToolCall[];
  permissionPrompt: PermissionPrompt | null;
  userPrompts: UserPrompt[];
  todoList: TodoList | null;
  lastActivity: Date;
}

export function emptyState(): SessionState {
  return {
    status: { mode: null, busy: false, tokens: null },
    toolCalls: [],
    permissionPrompt: null,
    userPrompts: [],
    todoList: null,
    lastActivity: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tool call identity matching
// ---------------------------------------------------------------------------

/** Key for matching tool calls across parse cycles. */
function toolKey(tc: ToolCall): string {
  return `${tc.tool}|${tc.args}`;
}

/**
 * Match tool calls from `next` against `prev` by (tool, args) identity.
 * Duplicate keys (e.g. repeated Read calls) are matched positionally
 * within their group.
 *
 * Returns:
 *   started   - tool calls in next that have no match in prev
 *   completed - tool calls present in both where result went "" -> non-empty
 */
function diffToolCalls(
  prev: ToolCall[],
  next: ToolCall[],
): { started: ToolCall[]; completed: ToolCall[] } {
  // Build a map of key -> list of prev entries (consumed in order)
  const prevByKey = new Map<string, ToolCall[]>();
  for (const tc of prev) {
    const k = toolKey(tc);
    const list = prevByKey.get(k);
    if (list) list.push(tc);
    else prevByKey.set(k, [tc]);
  }

  const started: ToolCall[] = [];
  const completed: ToolCall[] = [];

  for (const tc of next) {
    const k = toolKey(tc);
    const prevList = prevByKey.get(k);
    if (!prevList || prevList.length === 0) {
      started.push(tc);
      continue;
    }
    // Consume the first matching prev entry
    const matched = prevList.shift()!;
    // Result went from empty to non-empty = completed
    if (!matched.result && tc.result) {
      completed.push(tc);
    }
  }

  return { started, completed };
}

// ---------------------------------------------------------------------------
// Todo list deep comparison
// ---------------------------------------------------------------------------

function todosEqual(a: TodoList | null, b: TodoList | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.total !== b.total || a.done !== b.done || a.open !== b.open) return false;
  if (a.tasks.length !== b.tasks.length) return false;
  for (let i = 0; i < a.tasks.length; i++) {
    const ta = a.tasks[i]!;
    const tb = b.tasks[i]!;
    if (ta.status !== tb.status || ta.text !== tb.text) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ContinuousParser
// ---------------------------------------------------------------------------

export class ContinuousParser {
  private state: SessionState;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private unsubScreen: (() => void) | null = null;
  /** Safety-net interval: reparse periodically even without PTY writes,
   *  so a missed idle transition can't stick forever. */
  private safetyInterval: ReturnType<typeof setInterval> | null = null;
  private static SAFETY_REPARSE_MS = 3_000;
  /** Track spinner line content to detect stale spinners.
   *  An active spinner changes every frame (glyph animates, timer ticks).
   *  If the spinner line is identical across consecutive parses, it's stale. */
  private lastSpinnerLine: string | undefined;
  private spinnerStaleCount = 0;
  private static SPINNER_STALE_THRESHOLD = 4;
  /** Busy cooldown: when the spinner disappears, hold "busy" for a short
   *  window before reporting idle. Between tool calls the spinner briefly
   *  vanishes before reappearing; the cooldown absorbs those gaps so a
   *  momentary blank doesn't flap busy→idle→busy. Wall-clock based (not
   *  parse-count based) with a self-scheduled reparse, so idle still fires
   *  within the window even when the screen is static and no PTY writes
   *  arrive — otherwise idle would wait for the much slower safety interval. */
  private idleSince: number | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private static DEFAULT_IDLE_COOLDOWN_MS = 300;

  constructor(
    private screen: VirtualScreen,
    private emitter: TypedEmitter<SessionEvents>,
    private instanceId: string,
    private debounceMs: number = PARSE_DEBOUNCE_MS,
    private idleCooldownMs: number = ContinuousParser.DEFAULT_IDLE_COOLDOWN_MS,
  ) {
    this.state = emptyState();
    // Hook into screen writes (onChange fires AFTER xterm processes the data)
    this.unsubScreen = this.screen.onChange(() => this.scheduleReparse());
    // Safety net: reparse every 3s even if no PTY writes arrive, so a
    // stuck "busy" state self-corrects within a few seconds.
    this.safetyInterval = setInterval(() => {
      if (!this.disposed && !this.debounceTimer) this.reparse();
    }, ContinuousParser.SAFETY_REPARSE_MS);
    // Don't let this background timer keep the host process alive on its
    // own — in a live wrapper the PTY/servers hold the loop open; if the
    // parser is the last thing standing the process should be free to exit.
    this.safetyInterval.unref?.();
  }

  /** Current state -- always safe to read, never stale by more than debounceMs. */
  get current(): Readonly<SessionState> { return this.state; }

  /** Force an immediate reparse (e.g. after resize). */
  flush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (!this.disposed) this.reparse();
  }

  /** Cancel pending timers. Called by ClaudeInstance.destroy(). */
  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.safetyInterval) {
      clearInterval(this.safetyInterval);
      this.safetyInterval = null;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.unsubScreen) {
      this.unsubScreen();
      this.unsubScreen = null;
    }
  }

  // One-shot reparse fired after the idle-cooldown window so a static screen
  // (no onChange events) still transitions to idle promptly rather than
  // waiting for the much slower safety interval. Coalesced: at most one pending.
  private scheduleCooldownReparse(): void {
    if (this.disposed || this.cooldownTimer) return;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      if (!this.disposed) this.reparse();
    }, this.idleCooldownMs);
    this.cooldownTimer.unref?.();
  }

  // TRAILING-EDGE debounce: every write resets the timer.
  // The reparse fires debounceMs after the LAST write in a burst.
  private scheduleReparse(): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.disposed) this.reparse();
    }, this.debounceMs);
  }

  private reparse(): void {
    // Full scrollback so tool calls that scrolled off viewport are still tracked.
    const snap = this.screen.snapshot(false, true);
    const prev = this.state;
    const next = this.parseAll(snap.lines, prev.lastActivity);

    this.diffAndEmit(prev, next);
    this.state = next;
  }

  private parseAll(lines: string[], prevActivity: Date): SessionState {
    const status = parseStatusLine(lines);
    const toolCalls = parseToolCalls(lines);
    const permissionPrompt = parsePermissionPrompt(lines);
    const userPrompts = parseUserPrompts(lines);
    const todoList = parseTodoList(lines);

    // Stale spinner detection: an active spinner changes every parse cycle
    // (glyph animates, timer ticks up). If the spinner line is identical
    // across consecutive parses, it's a stale completion message.
    let effectiveBusy = status.busy;
    if (status.busy && status.spinnerLine) {
      if (status.spinnerLine === this.lastSpinnerLine) {
        this.spinnerStaleCount++;
        if (this.spinnerStaleCount >= ContinuousParser.SPINNER_STALE_THRESHOLD) {
          effectiveBusy = false; // spinner hasn't changed — it's stale
        }
      } else {
        this.spinnerStaleCount = 0;
      }
      this.lastSpinnerLine = status.spinnerLine;
    } else {
      this.lastSpinnerLine = undefined;
      this.spinnerStaleCount = 0;
    }

    // Busy cooldown: between tool calls the spinner briefly vanishes while
    // the screen redraws. Hold "busy" for idleCooldownMs after the spinner
    // clears, so momentary gaps don't flap busy→idle→busy.
    if (effectiveBusy) {
      this.idleSince = null;
    } else if (this.state.status.busy) {
      // Was busy, now parse says not busy — start (or continue) the cooldown.
      const now = Date.now();
      if (this.idleSince === null) this.idleSince = now;
      if (now - this.idleSince < this.idleCooldownMs) {
        effectiveBusy = true; // hold busy during the cooldown window
        this.scheduleCooldownReparse();
      } else {
        this.idleSince = null; // cooldown elapsed — allow the idle transition
      }
    }

    return {
      status: {
        mode: status.mode,
        busy: effectiveBusy,
        tokens: status.tokens,
      },
      toolCalls,
      permissionPrompt,
      userPrompts,
      todoList,
      // Carried forward; updated to now only when diffAndEmit detects a change.
      lastActivity: prevActivity,
    };
  }

  private diffAndEmit(prev: SessionState, next: SessionState): void {
    let changed = false;

    // --- Status transitions ---
    if (prev.status.busy && !next.status.busy) {
      this.emitter.emit("status:idle", { instance: this.instanceId });
      changed = true;
    } else if (!prev.status.busy && next.status.busy) {
      this.emitter.emit("status:busy", { instance: this.instanceId });
      changed = true;
    }
    if (prev.status.mode !== next.status.mode) {
      this.emitter.emit("mode:changed", {
        instance: this.instanceId,
        prev: prev.status.mode,
        next: next.status.mode,
      });
      changed = true;
    }
    if (prev.status.tokens !== next.status.tokens) {
      changed = true;
    }

    // --- Tool calls ---
    const { started, completed } = diffToolCalls(prev.toolCalls, next.toolCalls);
    for (const tc of started) {
      this.emitter.emit("tool:start", {
        instance: this.instanceId,
        tool: tc.tool,
        args: tc.args,
      });
      changed = true;
    }
    for (const tc of completed) {
      this.emitter.emit("tool:complete", {
        instance: this.instanceId,
        tool: tc.tool,
        args: tc.args,
        result: tc.result,
      });
      changed = true;
    }

    // --- Permission prompt ---
    if (!prev.permissionPrompt && next.permissionPrompt) {
      this.emitter.emit("permission:prompt", {
        instance: this.instanceId,
        prompt: next.permissionPrompt,
      });
      changed = true;
    } else if (prev.permissionPrompt && !next.permissionPrompt) {
      this.emitter.emit("permission:resolved", { instance: this.instanceId });
      changed = true;
    }

    // --- User prompts ---
    // Match by text content, not array position, because scrollback eviction
    // can remove old prompts and shift indices. We track how many prompts
    // with each text we've seen before; any excess in `next` is new.
    const prevPromptCounts = new Map<string, number>();
    for (const p of prev.userPrompts) {
      prevPromptCounts.set(p.text, (prevPromptCounts.get(p.text) ?? 0) + 1);
    }
    for (const p of next.userPrompts) {
      const remaining = prevPromptCounts.get(p.text) ?? 0;
      if (remaining > 0) {
        prevPromptCounts.set(p.text, remaining - 1);
      } else {
        this.emitter.emit("prompt:user", {
          instance: this.instanceId,
          text: p.text,
        });
        changed = true;
      }
    }

    // --- Todo list ---
    if (!todosEqual(prev.todoList, next.todoList)) {
      this.emitter.emit("todo:changed", {
        instance: this.instanceId,
        todoList: next.todoList,
      });
      changed = true;
    }

    // --- Aggregate change ---
    if (changed) {
      next.lastActivity = new Date();
      this.emitter.emit("state:changed", {
        instance: this.instanceId,
        state: next,
      });
    }
  }
}
