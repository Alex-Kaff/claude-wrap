// Public API barrel export for claude-wrap as a library.

// Core classes
export { ClaudeManager } from "./manager";
export { ClaudeInstance, type SpawnOptions } from "./instance";

// Shared lifecycle interface (PTY + print)
export { type ManagedSession } from "./managed";

// Print client (`claude -p` structured-protocol transport)
export {
  PrintSession,
  type PrintSessionOptions,
  type AskOptions,
} from "./print/print-session";
export {
  buildArgs,
  applyIsolation,
  validateOptions,
  type PrintOptions,
  type McpConfig,
  type Transport,
  type PermissionMode,
  type Effort,
} from "./print/args";
export {
  TurnAccumulator,
  collectTurn,
  type TurnResult,
  type ToolUse,
  type NormalizedUsage,
} from "./print/turn";
export { NdjsonReader, parseJsonArray } from "./print/ndjson";
export {
  ALL_PRINT_EVENTS,
  type PrintEvents,
  type PrintEvent,
} from "./print/print-events";
export {
  type CanUseTool,
  type PermissionToolCall,
  type PermissionResult,
  type ControlState,
} from "./print/control";
export {
  McpControlBridge,
  type BridgedTool,
  type BridgedToolResult,
} from "./print/mcp-bridge";
export {
  TESTED_CLI_VERSIONS,
  isTestedCliVersion,
  asProtoMessage,
  isInit,
  isThinkingTokens,
  isSystem,
  isRateLimitEvent,
  isAssistant,
  isUser,
  isStreamEvent,
  isResult,
  isControlRequest,
  isControlResponse,
  type ProtoMessage,
  type InitMessage,
  type ResultMessage,
  type AssistantMessage,
  type UserMessage,
  type StreamEventMessage,
  type RateLimitEventMessage,
  type ContentBlock,
  type ToolUseBlock,
  type TextBlock,
  type RawUsage,
  type ModelUsage,
  type RateLimitInfo,
} from "./print/proto";

// State & parsing
export { type SessionState, emptyState } from "./session-state";
export { ContinuousParser } from "./session-state";
export {
  type ToolCall,
  type PermissionPrompt,
  type PermissionOption,
  type TodoList,
  type TodoItem,
  type TodoStatus,
  type UserPrompt,
  type StatusLine,
  // Pure line-parsers, for deriving state from a `snapshot()` over the pipe
  // (out-of-process consumers that only have rendered lines, not the PTY byte
  // stream a ContinuousParser needs).
  parseStatusLine,
  parsePermissionPrompt,
} from "./parse";

// Events
export {
  type SessionEvents,
  type TypedEmitter,
  type CancellablePromise,
  createEmitter,
  ALL_SESSION_EVENTS,
} from "./events";

// Screen
export { VirtualScreen, type ScreenSnapshot } from "./screen";

// Terminal color extraction — per-cell foreground → compact [len, fg] runs. The
// canonical packer behind VirtualScreen.snapshot({ colors:true }); exported so
// consumers can render or re-derive runs from a snapshot's `colors` field.
export { type ColorRun } from "./protocol";
export { XTERM_PALETTE, cellFg, cpCount, buildLineRuns } from "./color";

// Event sinks (out-of-process event forwarding)
export {
  type EventSink,
  type InstanceInfo,
  type WebSocketEventSinkOptions,
  WebSocketEventSink,
} from "./sink";

// Instance registry (discovery of out-of-process wrappers)
export {
  type InstanceEntry,
  listInstances,
  registerInstance,
  unregisterInstance,
  makePipeName,
  findInstance,
} from "./registry";

// Errors
export {
  PipeError,
  TimeoutError,
  ParseError,
  ProtocolVersionError,
  MalformedStreamError,
  ProcessExitError,
  TurnTimeoutError,
  NotSupportedError,
} from "./errors";

// Client (for talking to out-of-process wrappers)
export { Client, type IClient, withClient, sendRequest } from "./client";
export { snapshot, write } from "./client";

// Config
export {
  POLL_INTERVAL_MS,
  WAIT_IDLE_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_MS,
  PARSE_DEBOUNCE_MS,
  ASK_SETTLE_TIMEOUT_MS,
  SUBMIT_DELAY_MS,
} from "./config";

// Wait helpers (for out-of-process polling)
export { waitIdle, waitFor } from "./wait";

// Child environment hygiene (strip parent Claude Code / IDE-integration vars)
export { childEnv } from "./child-env";

// Chat gateway (OpenAI-spec layer over the print transport)
export { ChatGateway, GatewayError, type GatewayOptions } from "./chat/gateway";
export { ChatHttpServer, type ChatHttpServerOptions } from "./chat/http-server";
export {
  mapRequest,
  flattenReplay,
  type MapRequestOptions,
  type MappedRequest,
} from "./chat/map-request";
export { DiffHistory, hashPrefix, type DiffPlan } from "./chat/diff-history";
export {
  turnToCompletion,
  usageFromTurn,
  mapFinishReason,
  messageContent,
} from "./chat/map-response";
export {
  DEFAULT_MODEL,
  ADVERTISED_MODELS,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatMessage,
  type ChatContentPart,
  type ResponseFormat,
  type FinishReason,
  type Usage,
  type ModelsList,
  type OpenAiError,
} from "./chat/openai-types";
