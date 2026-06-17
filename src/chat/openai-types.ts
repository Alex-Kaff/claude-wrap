// OpenAI Chat Completions wire types (the subset the gateway implements).
//
// These are structurally compatible with the official `openai` SDK so a client
// pointed at the gateway's baseURL works unmodified. The same objects defined
// here are what http-server.ts serializes — single source of truth (§3.1).

export type ChatRole = "system" | "user" | "assistant" | "tool" | "developer";

export interface ChatTextPart {
  type: "text";
  text: string;
}
export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}
export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[] | null;
  name?: string;
  /** assistant tool calls (client-side function calling — M5). */
  tool_calls?: ChatToolCall[];
  /** for role:"tool" results (M5). */
  tool_call_id?: string;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name?: string; schema: object; strict?: boolean } };

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters?: object };
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  // Sampling params with no `claude -p` equivalent — ignored with a warning.
  temperature?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  seed?: number;
  logprobs?: boolean;
  // Honored via gateway-side enforcement (§12-D3).
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: ResponseFormat;
  // Client-side function calling (M5).
  tools?: ChatTool[];
  tool_choice?: ToolChoice;
  // Non-standard extensions for stateful `session` history mode.
  session_id?: string;
  /** Override the per-request history strategy. */
  history?: "replay" | "session" | "diff";
  /** Provide caller MCP / tool config (server-side, honored by default). */
  mcp?: object;
  [k: string]: unknown;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] };
  finish_reason: FinishReason;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: { role?: "assistant"; content?: string; tool_calls?: ChatToolCall[] };
  finish_reason: FinishReason | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage;
}

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}
export interface ModelsList {
  object: "list";
  data: ModelObject[];
}

/** OpenAI-shaped error envelope (required for SDK compatibility). */
export interface OpenAiError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/** Default Claude model when the request doesn't pin one we recognize. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Models advertised by GET /v1/models (real ids + common aliases). */
export const ADVERTISED_MODELS: string[] = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
  "opus",
  "sonnet",
  "haiku",
];
