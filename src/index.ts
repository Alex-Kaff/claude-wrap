// Public API barrel export for claude-wrap as a library.

// Core classes
export { ClaudeManager } from "./manager";
export { ClaudeInstance, type SpawnOptions } from "./instance";

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
export { PipeError, TimeoutError, ParseError, ProtocolVersionError } from "./errors";

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
