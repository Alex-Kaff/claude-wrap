// OpenAI client-side function calling, bridged onto Claude (§3.5 / M5).
//
// Impedance mismatch: OpenAI clients expect the model to *return* tool_calls for
// the client to execute, then resend a `tool` result. Claude instead executes
// tools in-process. The bridge: register the client's `tools` as in-process
// SDK-MCP functions (mcp-bridge.ts) whose handlers PARK — when Claude calls one,
// the gateway surfaces an OpenAI tool_call and pauses the turn (inside the
// mcp_message handler) until the client supplies the result on a later request.
//
// Continuity key: the tool_call ids we mint. The client echoes them back on the
// `tool` messages, so the gateway maps them to the paused conversation.

import { PrintSession } from "../print/print-session";
import type { PrintOptions } from "../print/args";
import type { BridgedTool } from "../print/mcp-bridge";
import type { ContentBlock } from "../print/proto";
import type { TurnResult } from "../print/turn";
import type { ChatTool, ChatToolCall } from "./openai-types";

export type FnEvent =
  | { type: "tool_calls"; calls: ChatToolCall[] }
  | { type: "result"; turn: TurnResult }
  | { type: "error"; error: Error };

/** Batch window (ms) to collect parallel tool calls before flushing them. */
const FLUSH_DELAY_MS = 15;

/**
 * One paused, function-calling conversation. Drives a persistent PrintSession
 * whose bridged tools park until the OpenAI client returns their results.
 */
export class FunctionConversation {
  private readonly session: PrintSession;
  private readonly parked = new Map<string, (content: string) => void>();
  private pending: ChatToolCall[] = [];
  private waiter: ((ev: FnEvent) => void) | null = null;
  private buffered: FnEvent | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private counter = 0;
  private settled = false;

  constructor(printOptions: PrintOptions, tools: ChatTool[]) {
    const functions: BridgedTool[] = tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description !== undefined ? { description: t.function.description } : {}),
      ...(t.function.parameters !== undefined ? { inputSchema: t.function.parameters } : {}),
      handler: (input: unknown) =>
        new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve) => {
          this.counter++;
          const id = `call_${this.counter}_${Math.random().toString(36).slice(2, 8)}`;
          this.pending.push({ id, type: "function", function: { name: t.function.name, arguments: JSON.stringify(input ?? {}) } });
          this.parked.set(id, (content) => resolve({ content: [{ type: "text", text: content }] }));
          this.scheduleFlush();
        }),
    }));
    this.session = new PrintSession({
      ...printOptions,
      transport: "persistent",
      warm: false,
      persistSession: true,
      functions,
    });
  }

  /** The ids of tool calls currently awaiting a client result. */
  get openCallIds(): string[] {
    return [...this.parked.keys()];
  }
  get alive(): boolean {
    return this.session.alive;
  }

  /** Start the turn; resolve with the first tool_calls batch or the result. */
  start(content: ContentBlock[]): Promise<FnEvent> {
    this.session.ask(content).then(
      (turn) => this.deliver({ type: "result", turn }),
      (error: unknown) => this.deliver({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return this.nextEvent();
  }

  /** Resolve parked tool calls with the client's results; resume until the next event. */
  provideResults(results: Array<{ toolCallId: string; content: string }>): Promise<FnEvent> {
    for (const r of results) {
      const resolve = this.parked.get(r.toolCallId);
      if (resolve) {
        this.parked.delete(r.toolCallId);
        resolve(r.content);
      }
    }
    return this.nextEvent();
  }

  destroy(): void {
    this.settled = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.session.destroy();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pending.length > 0) {
        const calls = this.pending;
        this.pending = [];
        this.deliver({ type: "tool_calls", calls });
      }
    }, FLUSH_DELAY_MS);
  }

  private deliver(ev: FnEvent): void {
    if (this.settled && ev.type !== "result" && ev.type !== "error") return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(ev);
    } else {
      this.buffered = ev;
    }
  }

  private nextEvent(): Promise<FnEvent> {
    if (this.buffered) {
      const e = this.buffered;
      this.buffered = null;
      return Promise.resolve(e);
    }
    return new Promise<FnEvent>((resolve) => {
      this.waiter = resolve;
    });
  }
}
