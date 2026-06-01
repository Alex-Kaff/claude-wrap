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
