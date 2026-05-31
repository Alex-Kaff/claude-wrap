// Typed event emitter and session event definitions for claude-wrap.

import type {
  PermissionPrompt,
  TodoList,
} from "./parse";
import type { SessionState } from "./session-state";

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

export interface SessionEvents {
  /** Fires on every state change with the full new state. */
  "state:changed": { instance: string; state: SessionState };

  /** A new tool call appeared (● line detected). */
  "tool:start": { instance: string; tool: string; args: string };

  /** A tool call's result block completed. */
  "tool:complete": { instance: string; tool: string; args: string; result: string };

  /** Permission prompt appeared on screen. */
  "permission:prompt": { instance: string; prompt: PermissionPrompt };

  /** Permission prompt disappeared (user or automation responded). */
  "permission:resolved": { instance: string };

  /** Claude transitioned from busy to idle. */
  "status:idle": { instance: string };

  /** Claude transitioned from idle to busy. */
  "status:busy": { instance: string };

  /** The underlying process exited. */
  "process:exit": { instance: string; exitCode: number | null };

  /** A new user prompt appeared (❯ line). */
  "prompt:user": { instance: string; text: string };

  /** Todo list changed (null = todo list disappeared from screen). */
  "todo:changed": { instance: string; todoList: TodoList | null };

  /** Claude's mode changed (e.g. "plan mode on" → "normal mode"). */
  "mode:changed": { instance: string; prev: string | null; next: string | null };

  /** The virtual screen mutated (any redraw). A signal to re-`snapshot()`;
   *  carries no contents. Fires undebounced on every screen change, so it
   *  reflects cosmetic redraws too (unlike the debounced `state:changed`).
   *  Headless instances only. */
  "screen:changed": { instance: string };
}

/** All event names, for iteration. */
export const ALL_SESSION_EVENTS: (keyof SessionEvents)[] = [
  "state:changed",
  "tool:start",
  "tool:complete",
  "permission:prompt",
  "permission:resolved",
  "status:idle",
  "status:busy",
  "process:exit",
  "prompt:user",
  "todo:changed",
  "mode:changed",
  "screen:changed",
];

// ---------------------------------------------------------------------------
// Typed emitter
// ---------------------------------------------------------------------------

export interface CancellablePromise<T> extends Promise<T> {
  /**
   * Unsubscribe the event listener. The promise will never settle after this.
   * Call cancel() before chaining .then() if the event may never fire,
   * otherwise the .then() continuation holds a reference indefinitely.
   */
  cancel(): void;
}

export interface TypedEmitter<T> {
  on<K extends keyof T>(event: K, handler: (payload: T[K]) => void): () => void;
  off<K extends keyof T>(event: K, handler: (payload: T[K]) => void): void;
  emit<K extends keyof T>(event: K, payload: T[K]): void;
  /** Returns a cancellable promise. Call `.cancel()` to unsubscribe if the event may never fire. */
  once<K extends keyof T>(event: K): CancellablePromise<T[K]>;
}

type HandlerMap<T> = { [K in keyof T]?: Array<(payload: T[K]) => void> };

export function createEmitter<T>(): TypedEmitter<T> {
  const handlers: HandlerMap<T> = {} as HandlerMap<T>;

  function getList<K extends keyof T>(event: K): Array<(payload: T[K]) => void> {
    let list = handlers[event];
    if (!list) {
      list = [];
      handlers[event] = list;
    }
    return list;
  }

  function on<K extends keyof T>(event: K, handler: (payload: T[K]) => void): () => void {
    const list = getList(event);
    list.push(handler);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function off<K extends keyof T>(event: K, handler: (payload: T[K]) => void): void {
    const list = handlers[event];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }

  function emit<K extends keyof T>(event: K, payload: T[K]): void {
    const list = handlers[event];
    if (!list) return;
    // Iterate over a snapshot so handlers that unsubscribe mid-emit
    // don't cause skipped or double-fired callbacks.
    for (const h of list.slice()) h(payload);
  }

  function once<K extends keyof T>(event: K): CancellablePromise<T[K]> {
    let unsub: (() => void) | null = null;
    const promise = new Promise<T[K]>((resolve) => {
      unsub = on(event, (payload) => {
        unsub!();
        unsub = null;
        resolve(payload);
      });
    }) as CancellablePromise<T[K]>;
    promise.cancel = () => {
      if (unsub) { unsub(); unsub = null; }
    };
    return promise;
  }

  return { on, off, emit, once };
}
