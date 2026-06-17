// TurnResult aggregation: collapse one init→result message bracket into a
// normalized, consumer-friendly object.
//
// The `usage` field is a NORMALIZATION (§2.1): its camelCase numbers are
// computed here, preferring the per-turn `result.modelUsage.<model>` totals
// (camelCase, complete, carries cost) summed across models, and falling back to
// `result.usage` (snake_case) mapped to camelCase. It is NOT a raw copy of
// either — pick the source deliberately if you need raw numbers (use `.raw`).

import {
  isAssistant,
  isResult,
  isRateLimitEvent,
  blockIsText,
  blockIsThinking,
  blockIsToolUse,
  type ProtoMessage,
  type ResultMessage,
} from "./proto";

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface TurnResult {
  sessionId: string;
  /** result.result (prose), or concatenated assistant text if result.result is null. */
  text: string;
  structuredOutput?: unknown;
  /** True if a schema was requested but the model produced no/invalid structured_output. */
  structuredOutputMissing?: boolean;
  isError: boolean;
  subtype: string;
  /** result.stop_reason, falling back to the last assistant stop_reason. */
  stopReason?: string;
  toolCalls: ToolUse[];
  thinking?: string[];
  usage: NormalizedUsage;
  /** assistant message.diagnostics.cache_miss_reason — lets callers detect cache invalidation. */
  cacheMissReason?: { type: string; cacheMissedInputTokens?: number } | null;
  costUsd: number | null;
  numTurns: number;
  durationMs: number;
  /** From the most recent rate_limit_event in the bracket, if any. */
  rateLimit?: { status: string; resetsAt?: number; rateLimitType?: string };
  permissionDenials: unknown[];
  /** Full message list for power users. */
  raw: ProtoMessage[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sum modelUsage across all models into normalized camelCase totals. */
function usageFromModelUsage(r: ResultMessage): NormalizedUsage | null {
  const mu = r.modelUsage;
  if (!mu || typeof mu !== "object") return null;
  const acc: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let any = false;
  for (const m of Object.values(mu)) {
    if (!m || typeof m !== "object") continue;
    any = true;
    acc.inputTokens += num(m.inputTokens);
    acc.outputTokens += num(m.outputTokens);
    acc.cacheReadInputTokens += num(m.cacheReadInputTokens);
    acc.cacheCreationInputTokens += num(m.cacheCreationInputTokens);
  }
  return any ? acc : null;
}

function usageFromRaw(r: ResultMessage): NormalizedUsage {
  const u = r.usage ?? {};
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
  };
}

/**
 * Streaming aggregator: feed messages with `add()` as they arrive, then
 * `finalize()` once the `result` for the turn lands. Re-usable for one-shot
 * (push the whole array, then finalize). `hasResult` reports whether the turn
 * delimiter has been seen.
 */
export class TurnAccumulator {
  private msgs: ProtoMessage[] = [];
  private result: ResultMessage | null = null;

  add(msg: ProtoMessage): void {
    this.msgs.push(msg);
    if (isResult(msg)) this.result = msg;
  }

  get hasResult(): boolean {
    return this.result !== null;
  }

  /** Messages collected so far (live reference is not exposed; returns a copy). */
  get messages(): ProtoMessage[] {
    return this.msgs.slice();
  }

  reset(): void {
    this.msgs = [];
    this.result = null;
  }

  /**
   * Build the TurnResult. Throws if no `result` message was seen — callers in
   * the print client translate that into a MalformedStreamError.
   */
  finalize(opts?: { schemaRequested?: boolean }): TurnResult {
    if (!this.result) throw new Error("TurnAccumulator.finalize: no result message in bracket");
    return collectFromResult(this.msgs, this.result, opts);
  }
}

/** One-shot convenience: aggregate a complete message array into a TurnResult. */
export function collectTurn(messages: ProtoMessage[], opts?: { schemaRequested?: boolean }): TurnResult {
  const result = [...messages].reverse().find(isResult);
  if (!result) throw new Error("collectTurn: no result message in array");
  return collectFromResult(messages, result, opts);
}

function collectFromResult(
  messages: ProtoMessage[],
  result: ResultMessage,
  opts?: { schemaRequested?: boolean },
): TurnResult {
  const toolCalls: ToolUse[] = [];
  const thinking: string[] = [];
  const assistantText: string[] = [];
  let lastAssistantStop: string | undefined;
  let cacheMissReason: { type: string; cacheMissedInputTokens?: number } | null = null;
  let rateLimit: TurnResult["rateLimit"];

  for (const m of messages) {
    if (isAssistant(m)) {
      const inner = m.message;
      if (typeof inner.stop_reason === "string") lastAssistantStop = inner.stop_reason;
      const diag = inner.diagnostics;
      if (diag && diag.cache_miss_reason) {
        cacheMissReason = {
          type: diag.cache_miss_reason.type,
          ...(diag.cache_miss_reason.cache_missed_input_tokens !== undefined
            ? { cacheMissedInputTokens: diag.cache_miss_reason.cache_missed_input_tokens }
            : {}),
        };
      }
      for (const b of inner.content ?? []) {
        if (blockIsText(b)) assistantText.push(b.text);
        else if (blockIsThinking(b)) thinking.push(b.thinking);
        else if (blockIsToolUse(b)) toolCalls.push({ id: b.id, name: b.name, input: b.input });
      }
    } else if (isRateLimitEvent(m)) {
      const info = m.rate_limit_info;
      rateLimit = {
        status: info.status,
        ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
        ...(info.rateLimitType !== undefined ? { rateLimitType: info.rateLimitType } : {}),
      };
    }
  }

  const text = result.result ?? assistantText.join("");
  const stopReason = (typeof result.stop_reason === "string" && result.stop_reason) || lastAssistantStop;
  const usage = usageFromModelUsage(result) ?? usageFromRaw(result);
  const hasStructured = result.structured_output !== undefined && result.structured_output !== null;
  const structuredOutputMissing = opts?.schemaRequested === true && !hasStructured;

  return {
    sessionId: result.session_id,
    text,
    ...(hasStructured ? { structuredOutput: result.structured_output } : {}),
    ...(structuredOutputMissing ? { structuredOutputMissing: true } : {}),
    isError: result.is_error === true,
    subtype: result.subtype,
    ...(stopReason !== undefined ? { stopReason } : {}),
    toolCalls,
    ...(thinking.length > 0 ? { thinking } : {}),
    usage,
    cacheMissReason,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    numTurns: num(result.num_turns),
    durationMs: num(result.duration_ms),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
    permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials : [],
    raw: messages,
  };
}
