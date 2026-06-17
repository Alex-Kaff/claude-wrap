// Wire-protocol message types for the `claude -p` (print) structured-JSON
// transport, plus type guards. Single source of truth for the print client.
//
// These types describe the JSON Claude Code emits on stdout under
// `--output-format json` (an array) or `--output-format stream-json` (NDJSON).
// Field lists are grounded in fixtures captured against the CLI version in
// TESTED_CLI_VERSIONS below (see .agent-scratch/p-research/fixtures/). The wire
// format is partly undocumented and version-specific, so guards are defensive:
// unknown message types are tolerated, not rejected.

// ---------------------------------------------------------------------------
// CLI version provenance
// ---------------------------------------------------------------------------

/** CLI versions whose wire format these types were verified against. */
export const TESTED_CLI_VERSIONS = ["2.1.179"] as const;

/**
 * Return true if `version` is within the verified range. Currently an exact
 * membership check; broadened to a semver range if/when more versions are
 * validated. A mismatch is a soft warning (logged once), never an error.
 */
export function isTestedCliVersion(version: string | undefined | null): boolean {
  if (!version) return false;
  return (TESTED_CLI_VERSIONS as readonly string[]).includes(version);
}

// ---------------------------------------------------------------------------
// Content blocks (inside assistant / user `message.content[]`)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  caller?: { type: string };
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

// ---------------------------------------------------------------------------
// Usage (raw, snake_case — as it appears on `result.usage` and per-message)
// ---------------------------------------------------------------------------

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

/** Per-model usage block on `result.modelUsage.<model>` (camelCase, distinct numbers). */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface McpServerStatus {
  name: string;
  status: string; // "connected" | "pending" | "failed" | ...
}

export interface InitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: McpServerStatus[];
  permissionMode?: string;
  slash_commands?: string[];
  skills?: string[];
  agents?: string[];
  plugins?: Array<{ name: string; path?: string; source?: string }>;
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  uuid?: string;
  fast_mode_state?: string;
  [k: string]: unknown;
}

export interface ThinkingTokensMessage {
  type: "system";
  subtype: "thinking_tokens";
  estimated_tokens: number;
  estimated_tokens_delta: number;
  session_id?: string;
  uuid?: string;
}

/** Any `system` message whose subtype we don't model explicitly. */
export interface SystemOtherMessage {
  type: "system";
  subtype: string; // "api_retry" | "compact_boundary" | "plugin_install" | ...
  session_id?: string;
  uuid?: string;
  [k: string]: unknown;
}

export interface RateLimitInfo {
  status: string; // "allowed" | "rejected" | ...
  resetsAt?: number; // absolute unix timestamp (seconds)
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  [k: string]: unknown;
}

export interface RateLimitEventMessage {
  type: "rate_limit_event";
  rate_limit_info: RateLimitInfo;
  session_id?: string;
  uuid?: string;
}

export interface AssistantInnerMessage {
  model?: string;
  id?: string;
  type?: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason?: string | null; // "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null
  stop_sequence?: string | null;
  usage?: RawUsage;
  diagnostics?: { cache_miss_reason?: { type: string; cache_missed_input_tokens?: number } } | null;
  [k: string]: unknown;
}

export interface AssistantMessage {
  type: "assistant";
  message: AssistantInnerMessage;
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
  request_id?: string;
}

export interface UserInnerMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface UserMessage {
  type: "user";
  message: UserInnerMessage;
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
  timestamp?: string;
  tool_use_result?: unknown;
}

/** Raw Anthropic streaming delta, only present with `--include-partial-messages`. */
export interface StreamEventMessage {
  type: "stream_event";
  event: {
    type: string; // "message_start" | "content_block_delta" | "content_block_stop" | ...
    index?: number;
    delta?: {
      type?: string; // "text_delta" | "thinking_delta" | "input_json_delta" | "signature_delta"
      text?: string;
      thinking?: string;
      partial_json?: string;
      [k: string]: unknown;
    };
    content_block?: { type?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  session_id?: string;
  parent_tool_use_id?: string | null;
  uuid?: string;
}

export type ResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_permission_denied"
  | "interrupted"
  | (string & {});

export interface ResultMessage {
  type: "result";
  subtype: ResultSubtype;
  is_error: boolean;
  result: string | null;
  structured_output?: unknown;
  session_id: string;
  stop_reason?: string | null;
  usage?: RawUsage;
  modelUsage?: Record<string, ModelUsage>;
  total_cost_usd?: number | null;
  duration_ms?: number;
  duration_api_ms?: number;
  ttft_ms?: number;
  num_turns?: number;
  permission_denials?: unknown[];
  api_error_status?: unknown;
  terminal_reason?: string;
  uuid?: string;
  [k: string]: unknown;
}

/** SDK control-protocol frames (M4). Modeled minimally here for type guards. */
export interface ControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: { subtype: string; [k: string]: unknown };
}

export interface ControlResponseMessage {
  type: "control_response";
  response: { request_id: string; subtype?: string; [k: string]: unknown };
}

export type ProtoMessage =
  | InitMessage
  | ThinkingTokensMessage
  | SystemOtherMessage
  | RateLimitEventMessage
  | AssistantMessage
  | UserMessage
  | StreamEventMessage
  | ResultMessage
  | ControlRequestMessage
  | ControlResponseMessage;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse a single wire object loosely into a ProtoMessage (no validation). */
export function asProtoMessage(v: unknown): ProtoMessage | null {
  if (!isObj(v) || typeof v["type"] !== "string") return null;
  return v as unknown as ProtoMessage;
}

export function isInit(m: ProtoMessage): m is InitMessage {
  return m.type === "system" && (m as { subtype?: string }).subtype === "init";
}

export function isThinkingTokens(m: ProtoMessage): m is ThinkingTokensMessage {
  return m.type === "system" && (m as { subtype?: string }).subtype === "thinking_tokens";
}

export function isSystem(m: ProtoMessage): m is InitMessage | ThinkingTokensMessage | SystemOtherMessage {
  return m.type === "system";
}

export function isRateLimitEvent(m: ProtoMessage): m is RateLimitEventMessage {
  return m.type === "rate_limit_event";
}

export function isAssistant(m: ProtoMessage): m is AssistantMessage {
  return m.type === "assistant";
}

export function isUser(m: ProtoMessage): m is UserMessage {
  return m.type === "user";
}

export function isStreamEvent(m: ProtoMessage): m is StreamEventMessage {
  return m.type === "stream_event";
}

export function isResult(m: ProtoMessage): m is ResultMessage {
  return m.type === "result";
}

export function isControlRequest(m: ProtoMessage): m is ControlRequestMessage {
  return m.type === "control_request";
}

export function isControlResponse(m: ProtoMessage): m is ControlResponseMessage {
  return m.type === "control_response";
}

// ---------------------------------------------------------------------------
// Content-block helpers
// ---------------------------------------------------------------------------

export function blockIsText(b: ContentBlock): b is TextBlock {
  return b.type === "text";
}
export function blockIsThinking(b: ContentBlock): b is ThinkingBlock {
  return b.type === "thinking";
}
export function blockIsToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}
