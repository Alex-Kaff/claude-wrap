// ChatGateway: an OpenAI-shaped, in-process chat client backed by `claude -p`.
//
// Isolation is the DEFAULT (§1.7) — every call empties the host's MCP/tools/
// plugins unless `isolate:false`. History strategies (§3.4 / §12-D1):
//   - replay  (default): flatten messages into one user turn; transient session.
//   - session (stateful): pooled, warm, persistent PrintSession keyed by id.
// `diff` lands in M5.

import { PrintSession } from "../print/print-session";
import type { PrintOptions } from "../print/args";
import type { ContentBlock } from "../print/proto";
import type { TurnResult } from "../print/turn";
import { log } from "../log";
import { mapRequest, flattenReplay, type MapRequestOptions, type MappedRequest } from "./map-request";
import { DiffHistory } from "./diff-history";
import { FunctionConversation, type FnEvent } from "./function-bridge";
import {
  turnToCompletion,
  usageFromTurn,
  mapFinishReason,
  messageContent,
  newCompletionId,
  nowUnix,
  openingChunk,
  contentChunk,
  finalChunk,
  usageChunk,
} from "./map-response";
import {
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatMessage,
  type ModelsList,
  ADVERTISED_MODELS,
} from "./openai-types";

/** Error carrying an HTTP status + OpenAI error envelope fields. */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly type: string,
    public readonly param: string | null = null,
    public readonly code: string | null = null,
    /** Seconds for a 429 Retry-After, when known. */
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayOptions {
  /** Isolate by default (§1.7). */
  isolate?: boolean;
  /** Route system messages to --append-system-prompt instead of replacing. */
  appendSystem?: boolean;
  /** Fallback model when a request doesn't name one. */
  defaultModel?: string;
  /** Max pooled persistent `session`-mode sessions (LRU-evicted). */
  maxSessions?: number;
  /** Idle TTL before a pooled session is reaped. */
  idleTtlMs?: number;
  /** Warm pooled sessions on creation. */
  warmSessions?: boolean;
}

interface PoolEntry {
  session: PrintSession;
  claudeSessionId: string | null;
  printOptions: PrintOptions;
  lastUsed: number;
}

function hasImages(content: ContentBlock[]): boolean {
  return content.some((b) => b.type === "image");
}

export class ChatGateway {
  private readonly opts: Required<Omit<GatewayOptions, "defaultModel">> & { defaultModel?: string };
  private readonly pool = new Map<string, PoolEntry>();
  private readonly diff = new DiffHistory();
  /** Paused function-calling conversations, keyed by every open tool_call id (§3.5). */
  private readonly fnConvos = new Map<string, FunctionConversation>();

  /** OpenAI-SDK-shaped surface: `gateway.completions.create(req)`. */
  readonly completions = {
    create: (req: ChatCompletionRequest): Promise<ChatCompletion> | AsyncIterable<ChatCompletionChunk> => {
      return req.stream === true ? this.createStream(req) : this.createCompletion(req);
    },
  };

  constructor(options: GatewayOptions = {}) {
    this.opts = {
      isolate: options.isolate ?? true,
      appendSystem: options.appendSystem ?? false,
      maxSessions: options.maxSessions ?? 50,
      idleTtlMs: options.idleTtlMs ?? 5 * 60_000,
      warmSessions: options.warmSessions ?? true,
      ...(options.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
    };
  }

  /** GET /v1/models payload. */
  listModels(): ModelsList {
    const created = nowUnix();
    return {
      object: "list",
      data: ADVERTISED_MODELS.map((id) => ({ id, object: "model" as const, created, owned_by: "anthropic" })),
    };
  }

  private mapOpts(): MapRequestOptions {
    return {
      isolate: this.opts.isolate,
      appendSystem: this.opts.appendSystem,
      ...(this.opts.defaultModel !== undefined ? { defaultModel: this.opts.defaultModel } : {}),
    };
  }

  // --- non-streaming ---

  async createCompletion(req: ChatCompletionRequest): Promise<ChatCompletion> {
    const mapped = await mapRequest(req, this.mapOpts());
    this.logWarnings(mapped);

    if (this.wantsFunctionCalling(req)) return this.runFunctionCompletion(req, mapped);

    const turn =
      mapped.history === "session"
        ? await this.runSessionTurn(mapped)
        : mapped.history === "diff"
          ? await this.runDiffTurn(mapped)
          : await this.runReplayTurn(mapped);

    this.throwIfUpstreamError(turn);
    return turnToCompletion(turn, {
      model: req.model,
      responseFormatActive: mapped.responseFormatActive,
      maxTokens: mapped.maxTokens,
    });
  }

  // --- streaming ---

  private async *createStream(req: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    if (this.wantsFunctionCalling(req)) {
      throw new GatewayError(
        "streaming function calling is not supported; retry with stream:false",
        400,
        "invalid_request_error",
        "stream",
        "stream_tools_unsupported",
      );
    }
    const mapped = await mapRequest(req, this.mapOpts());
    this.logWarnings(mapped);

    const id = newCompletionId();
    const created = nowUnix();
    const base = { id, model: req.model, created };

    // Streaming always runs over a stream-json (persistent) session so we get
    // partial-message deltas. Session mode reuses the pool; replay uses a
    // transient warm:false session.
    const { session, finalize } = await this.streamSession(mapped);

    yield openingChunk(base);

    let emitted = "";
    let finishReason = null as null | ReturnType<typeof mapFinishReason>;
    let maxHit = false;
    let lastTurn: TurnResult | null = null;
    try {
      for await (const ev of session.stream(mapped.content, mapped.maxTokens != null ? { } : {})) {
        // Under a response_format, the model's prose deltas aren't the answer —
        // the structured/JSON content is emitted once at the end. Suppress them.
        if (ev.type === "assistant:delta" && !mapped.responseFormatActive) {
          // max_tokens enforcement (§12-D3): stop forwarding past the cap,
          // and kill the (paid) turn since interrupt() is M4.
          if (mapped.maxTokens != null && !mapped.responseFormatActive) {
            const room = mapped.maxTokens * 4 - emitted.length;
            if (room <= 0) {
              maxHit = true;
              break;
            }
            const piece = ev.text.length > room ? ev.text.slice(0, room) : ev.text;
            emitted += piece;
            yield contentChunk(base, piece);
            if (emitted.length >= mapped.maxTokens * 4) {
              maxHit = true;
              break;
            }
          } else {
            emitted += ev.text;
            yield contentChunk(base, ev.text);
          }
        } else if (ev.type === "result") {
          lastTurn = ev.result;
        }
      }
    } finally {
      finalize(maxHit);
    }

    // If no partial deltas arrived (json_schema emits a tool call, not text; or
    // --include-partial-messages was unsupported), emit the final content once.
    // When deltas DID stream, don't double-emit.
    if (emitted.length === 0 && lastTurn) {
      const text = messageContent(lastTurn, mapped.responseFormatActive);
      if (text) yield contentChunk(base, text);
    }

    if (lastTurn) this.throwIfUpstreamError(lastTurn);

    finishReason = maxHit
      ? "length"
      : lastTurn
        ? mapFinishReason(lastTurn)
        : "stop";
    yield finalChunk(base, finishReason);

    if (req.stream_options?.include_usage && lastTurn) {
      yield usageChunk(base, usageFromTurn(lastTurn));
    }
  }

  /** Resolve the session for a streaming turn + a finalize() to clean it up. */
  private async streamSession(mapped: MappedRequest): Promise<{
    session: PrintSession;
    finalize: (maxHit: boolean) => void;
  }> {
    if (mapped.history === "session") {
      const entry = this.acquirePooled(mapped);
      return {
        session: entry.session,
        finalize: (maxHit) => {
          entry.lastUsed = Date.now();
          // A max-tokens kill ends the turn destructively; drop the pooled
          // session so a later turn starts clean.
          if (maxHit) this.evict(this.keyFor(mapped));
          this.captureSessionId(entry);
        },
      };
    }
    const session = new PrintSession({
      ...mapped.printOptions,
      transport: "persistent",
      warm: false,
    });
    return { session, finalize: () => session.destroy() };
  }

  // --- replay (transient) ---

  private async runReplayTurn(mapped: MappedRequest): Promise<TurnResult> {
    const useOneshot = !hasImages(mapped.content);
    const session = new PrintSession({
      ...mapped.printOptions,
      transport: useOneshot ? "oneshot" : "persistent",
      ...(useOneshot ? {} : { warm: false }),
    });
    try {
      return await this.askWithSchemaRetry(session, mapped.content, mapped.printOptions.jsonSchema !== undefined);
    } finally {
      session.destroy();
    }
  }

  // --- diff (auto-optimize resume vs replay) ---

  private async runDiffTurn(mapped: MappedRequest): Promise<TurnResult> {
    const plan = this.diff.plan(mapped.messages);
    const schemaRequested = mapped.printOptions.jsonSchema !== undefined;
    let turn: TurnResult;
    if (plan.mode === "resume") {
      // Exact-prefix match: resume the stored Claude session, sending only the
      // new user/tool turns.
      const content = await flattenReplay(plan.newMessages);
      const session = new PrintSession({
        ...mapped.printOptions,
        transport: "oneshot",
        resume: plan.claudeSessionId,
        persistSession: true,
      });
      try {
        turn = await this.askWithSchemaRetry(session, content, schemaRequested);
      } finally {
        session.destroy();
      }
      log("[gateway] diff: resumed", plan.claudeSessionId);
    } else {
      // No match → replay the full history, but PERSIST so a later turn can resume it.
      const session = new PrintSession({
        ...mapped.printOptions,
        transport: hasImages(mapped.content) ? "persistent" : "oneshot",
        ...(hasImages(mapped.content) ? { warm: false } : {}),
        persistSession: true,
      });
      try {
        turn = await this.askWithSchemaRetry(session, mapped.content, schemaRequested);
      } finally {
        session.destroy();
      }
    }
    // Remember this conversation→session mapping for the next extension.
    if (turn.sessionId && !turn.isError) this.diff.record(mapped.messages, turn.text, turn.sessionId);
    return turn;
  }

  // --- session (pooled persistent) ---

  private async runSessionTurn(mapped: MappedRequest): Promise<TurnResult> {
    const entry = this.acquirePooled(mapped);
    try {
      const turn = await this.askWithSchemaRetry(entry.session, mapped.content, mapped.printOptions.jsonSchema !== undefined);
      entry.lastUsed = Date.now();
      this.captureSessionId(entry);
      return turn;
    } catch (err) {
      // A dead pooled session: drop it so the next call recreates (with resume).
      if (!entry.session.alive) this.evict(this.keyFor(mapped));
      throw err;
    }
  }

  private keyFor(mapped: MappedRequest): string {
    return mapped.sessionId ?? "default";
  }

  private acquirePooled(mapped: MappedRequest): PoolEntry {
    this.reapIdle();
    const key = this.keyFor(mapped);
    const existing = this.pool.get(key);
    if (existing && existing.session.alive) {
      existing.lastUsed = Date.now();
      return existing;
    }
    // Revive a reaped/crashed session by resuming its claude session id.
    const resume = existing?.claudeSessionId ?? undefined;
    const printOptions: PrintOptions = {
      ...mapped.printOptions,
      transport: "persistent",
      // session mode owns the id and persists to disk.
      persistSession: true,
      ...(resume ? { resume } : {}),
    };
    const session = new PrintSession({ ...printOptions, warm: this.opts.warmSessions });
    const entry: PoolEntry = { session, claudeSessionId: resume ?? null, printOptions, lastUsed: Date.now() };
    this.pool.set(key, entry);
    this.enforceLru();
    return entry;
  }

  private captureSessionId(entry: PoolEntry): void {
    if (!entry.claudeSessionId && entry.session.claudeSessionId) {
      entry.claudeSessionId = entry.session.claudeSessionId;
    }
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [key, entry] of this.pool) {
      if (now - entry.lastUsed > this.opts.idleTtlMs || !entry.session.alive) {
        entry.session.destroy();
        this.pool.delete(key);
      }
    }
  }

  private enforceLru(): void {
    while (this.pool.size > this.opts.maxSessions) {
      // Evict the least-recently-used.
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, entry] of this.pool) {
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      this.evict(oldestKey);
    }
  }

  private evict(key: string): void {
    const entry = this.pool.get(key);
    if (entry) {
      entry.session.destroy();
      this.pool.delete(key);
    }
  }

  // --- shared turn execution ---

  /** Ask once; if a schema was requested but no/invalid structured_output came
   *  back, retry once, then fall back leniently (§12-D10). */
  private async askWithSchemaRetry(
    session: PrintSession,
    content: ContentBlock[],
    schemaRequested: boolean,
  ): Promise<TurnResult> {
    let turn = await session.ask(content);
    if (schemaRequested && turn.structuredOutputMissing && session.alive) {
      log("[gateway] structured output missing; retrying once (§12-D10)");
      turn = await session.ask(content);
    }
    return turn; // structuredOutputMissing may remain true → lenient prose fallback
  }

  // --- guards / errors ---

  // --- client-side function calling (§3.5 / M5) ---

  private wantsFunctionCalling(req: ChatCompletionRequest): boolean {
    return !!(req.tools && req.tools.length > 0 && req.tool_choice !== "none");
  }

  private async runFunctionCompletion(req: ChatCompletionRequest, mapped: MappedRequest): Promise<ChatCompletion> {
    // Prune dead paused conversations.
    for (const [id, c] of [...this.fnConvos]) if (!c.alive) this.fnConvos.delete(id);

    const toolResults = req.messages.filter((m) => m.role === "tool" && typeof m.tool_call_id === "string");

    let convo: FunctionConversation;
    let ev: FnEvent;
    if (toolResults.length > 0) {
      // Continuation: find the paused conversation by any returned tool_call id.
      const found = toolResults.map((m) => this.fnConvos.get(m.tool_call_id as string)).find(Boolean);
      if (!found || !found.alive) {
        throw new GatewayError(
          "no paused tool-calling conversation matches these tool results (it may have expired)",
          400,
          "invalid_request_error",
          "messages",
          "no_tool_session",
        );
      }
      convo = found;
      const results = toolResults.map((m) => ({ toolCallId: m.tool_call_id as string, content: this.toolResultContent(m) }));
      for (const m of toolResults) this.fnConvos.delete(m.tool_call_id as string);
      ev = await convo.provideResults(results);
    } else {
      convo = new FunctionConversation(mapped.printOptions, req.tools ?? []);
      ev = await convo.start(mapped.content);
    }
    return this.handleFnEvent(req, mapped, convo, ev);
  }

  private handleFnEvent(
    req: ChatCompletionRequest,
    mapped: MappedRequest,
    convo: FunctionConversation,
    ev: FnEvent,
  ): ChatCompletion {
    if (ev.type === "error") {
      convo.destroy();
      throw ev.error;
    }
    if (ev.type === "result") {
      convo.destroy();
      this.throwIfUpstreamError(ev.turn);
      return turnToCompletion(ev.turn, {
        model: req.model,
        responseFormatActive: mapped.responseFormatActive,
        maxTokens: mapped.maxTokens,
      });
    }
    // tool_calls: register every open id → this conversation, return them.
    for (const c of ev.calls) this.fnConvos.set(c.id, convo);
    return {
      id: newCompletionId(),
      object: "chat.completion",
      created: nowUnix(),
      model: req.model,
      choices: [
        { index: 0, message: { role: "assistant", content: null, tool_calls: ev.calls }, finish_reason: "tool_calls" },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  private toolResultContent(m: ChatMessage): string {
    const c = m.content;
    if (c === null || c === undefined) return "";
    if (typeof c === "string") return c;
    return c.map((p) => (p.type === "text" ? p.text : "")).join("");
  }

  private throwIfUpstreamError(turn: TurnResult): void {
    const rl = turn.rateLimit;
    if (rl && rl.status !== "allowed") {
      const retryAfter = rl.resetsAt ? Math.max(0, rl.resetsAt - nowUnix()) : undefined;
      throw new GatewayError("rate limited", 429, "rate_limit_error", null, "rate_limited", retryAfter);
    }
    if (!turn.isError) return;
    switch (turn.subtype) {
      case "error_max_budget_usd":
        throw new GatewayError("budget exceeded", 402, "insufficient_quota", null, "budget_exceeded");
      case "error_permission_denied":
        throw new GatewayError("permission denied", 403, "permission_error", null, "permission_denied");
      case "error_max_turns":
      case "interrupted":
        return; // not hard errors — mapped to finish_reason instead
      default:
        throw new GatewayError(`upstream error: ${turn.subtype}`, 500, "api_error", null, turn.subtype);
    }
  }

  private logWarnings(mapped: MappedRequest): void {
    for (const w of mapped.warnings) log("[gateway]", w);
  }

  /** Destroy all pooled sessions + paused function-calling conversations. */
  shutdown(): void {
    for (const [, entry] of this.pool) entry.session.destroy();
    this.pool.clear();
    const convos = new Set(this.fnConvos.values());
    for (const c of convos) c.destroy();
    this.fnConvos.clear();
  }
}
