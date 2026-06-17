// Map a normalized TurnResult onto OpenAI response shapes (non-streaming
// ChatCompletion and streaming chunks). See §3.3.

import type { TurnResult } from "../print/turn";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  FinishReason,
  Usage,
} from "./openai-types";

/** Rough token estimate (≈4 chars/token) — used only for max_tokens enforcement. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Map Claude stop signals to the OpenAI finish_reason enum (§3.3). */
export function mapFinishReason(turn: TurnResult, opts?: { maxTokensHit?: boolean }): FinishReason {
  if (opts?.maxTokensHit) return "length";
  const sr = turn.stopReason;
  if (sr === "end_turn" || sr === "stop_sequence") return "stop";
  if (sr === "max_tokens") return "length";
  if (sr === "tool_use") return "tool_calls";
  // Fallback from result.subtype.
  switch (turn.subtype) {
    case "success":
      return "stop";
    case "error_max_turns":
      return "length";
    case "interrupted":
      return "stop";
    default:
      return "stop";
  }
}

/** OpenAI usage from a TurnResult (cached is a SUBSET of prompt, not additive). */
export function usageFromTurn(turn: TurnResult): Usage {
  const u = turn.usage;
  const prompt = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
    prompt_tokens_details: { cached_tokens: u.cacheReadInputTokens },
  };
}

/** Strip a single surrounding markdown code fence (```json … ```), if present. */
export function stripCodeFence(text: string): string {
  const m = /^\s*```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
  return m ? m[1]!.trim() : text;
}

/** The assistant message content: stringified structured output when a
 *  response_format is active, else the prose text. Never empty when structured
 *  output exists. Under a response_format with no structured output (json_object
 *  mode), strip any markdown code fence so the content stays directly parseable. */
export function messageContent(turn: TurnResult, responseFormatActive: boolean): string {
  if (responseFormatActive && turn.structuredOutput !== undefined && turn.structuredOutput !== null) {
    return JSON.stringify(turn.structuredOutput);
  }
  return responseFormatActive ? stripCodeFence(turn.text) : turn.text;
}

export function newCompletionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2, 8)}`;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export interface ToCompletionOpts {
  model: string;
  id?: string;
  created?: number;
  responseFormatActive: boolean;
  /** Honor max_tokens by truncating content (non-stream); skipped when a response_format is active. */
  maxTokens?: number | null;
}

export function turnToCompletion(turn: TurnResult, opts: ToCompletionOpts): ChatCompletion {
  let content = messageContent(turn, opts.responseFormatActive);
  let maxTokensHit = false;

  // Non-streaming max_tokens enforcement (§12-D3): truncate, unless a
  // response_format is active (truncating would corrupt the JSON object).
  if (opts.maxTokens != null && !opts.responseFormatActive && approxTokens(content) > opts.maxTokens) {
    content = content.slice(0, opts.maxTokens * 4);
    maxTokensHit = true;
  }

  return {
    id: opts.id ?? newCompletionId(),
    object: "chat.completion",
    created: opts.created ?? nowUnix(),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: mapFinishReason(turn, { maxTokensHit }),
      },
    ],
    usage: usageFromTurn(turn),
  };
}

// --- streaming chunk builders ---

interface ChunkBase {
  id: string;
  model: string;
  created: number;
}

export function openingChunk(b: ChunkBase): ChatCompletionChunk {
  return {
    id: b.id,
    object: "chat.completion.chunk",
    created: b.created,
    model: b.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

export function contentChunk(b: ChunkBase, text: string): ChatCompletionChunk {
  return {
    id: b.id,
    object: "chat.completion.chunk",
    created: b.created,
    model: b.model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

export function finalChunk(b: ChunkBase, finishReason: FinishReason): ChatCompletionChunk {
  return {
    id: b.id,
    object: "chat.completion.chunk",
    created: b.created,
    model: b.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

export function usageChunk(b: ChunkBase, usage: Usage): ChatCompletionChunk {
  return {
    id: b.id,
    object: "chat.completion.chunk",
    created: b.created,
    model: b.model,
    choices: [],
    usage,
  };
}
