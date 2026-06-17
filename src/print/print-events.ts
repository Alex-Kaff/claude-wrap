// PrintEvents: the typed event surface for a PrintSession.
//
// These are deliberately distinct from the PTY-side SessionEvents (../events):
// the print transport speaks structured JSON, not screen scrapes, so the two
// event shapes don't merge. PrintSession carries its own
// TypedEmitter<PrintEvents>, reusing the generic createEmitter<T>() factory.

import type { InitMessage, ProtoMessage, RateLimitInfo } from "./proto";
import type { ToolUse, TurnResult } from "./turn";
import type { PermissionResult, PermissionToolCall } from "./control";

export interface PrintEvents {
  /** Per-turn `system/init`. Re-emitted every turn in persistent mode (§9). */
  init: { instance: string; init: InitMessage };

  /** Incremental assistant text delta (only with includePartialMessages). */
  "assistant:delta": { instance: string; text: string };

  /** A completed assistant text block. */
  "assistant:text": { instance: string; text: string };

  /** Incremental thinking delta (only with includePartialMessages). */
  "thinking:delta": { instance: string; text: string };

  /** Running thinking-token estimate (system/thinking_tokens). */
  "thinking:tokens": { instance: string; estimatedTokens: number; delta: number };

  /** An assistant tool_use block. */
  "tool:use": { instance: string; tool: ToolUse };

  /** A tool_result (from the user-role message that carries tool output). */
  "tool:result": { instance: string; toolUseId: string; content: unknown; isError: boolean };

  /** A rate_limit_event. */
  rate_limit: { instance: string; info: RateLimitInfo };

  /** Control-protocol permission request (M4). `respond` resolves the decision. */
  "permission:request": {
    instance: string;
    requestId: string;
    call: PermissionToolCall;
    respond: (result: PermissionResult) => void;
  };

  /** Any raw protocol message, in arrival order (catch-all for power users). */
  message: { instance: string; message: ProtoMessage };

  /** A turn completed (its `result` arrived). */
  result: { instance: string; result: TurnResult };

  /** The underlying print process exited. */
  "process:exit": { instance: string; code: number | null };

  /** A non-fatal error (bad line, stderr noise) or a fatal turn error. */
  error: { instance: string; error: Error };
}

/** Tagged union of every print event, for the stream() async-iterator. */
export type PrintEvent = {
  [K in keyof PrintEvents]: { type: K } & PrintEvents[K];
}[keyof PrintEvents];

/** All print event names, for forwarding/iteration. */
export const ALL_PRINT_EVENTS: (keyof PrintEvents)[] = [
  "init",
  "assistant:delta",
  "assistant:text",
  "thinking:delta",
  "thinking:tokens",
  "tool:use",
  "tool:result",
  "rate_limit",
  "permission:request",
  "message",
  "result",
  "process:exit",
  "error",
];
