// SDK control-protocol types + channel for the print transport (M4).
//
// Plain stream-json does NOT route per-tool approval frames (§1.8): with just
// `--permission-mode` + allow/deny rules, an "allow" decision runs the tool
// silently. Dynamic, interactive approval requires the SDK control protocol:
//   1. spawn with `--permission-prompt-tool stdio`;
//   2. send an `initialize` control_request over stdin;
//   3. the CLI routes every "ask" decision back as a `can_use_tool`
//      control_request, which the controller answers with a control_response.
//
// Wire format verified empirically against claude 2.1.179 (see
// .agent-scratch/p-research/probe-control.mjs):
//   ask   (CLI→us): {type:"control_request", request_id, request:{subtype:"can_use_tool",
//                    tool_name, display_name, input, description, permission_suggestions, tool_use_id}}
//   answer(us→CLI): {type:"control_response", response:{subtype:"success", request_id,
//                    response:{behavior:"allow", updatedInput} | {behavior:"deny", message}}}
//   init/interrupt/set_permission_mode/set_model are controller→CLI control_requests.

import { randomUUID } from "crypto";
import type { ControlRequestMessage, ControlResponseMessage } from "./proto";

/** A tool invocation surfaced for approval. (Named to avoid clashing with the
 *  PTY-side `ToolCall` in parse.ts.) */
export interface PermissionToolCall {
  /** Tool-use id (the assistant's tool_use block id), when known. */
  id?: string;
  name: string;
  input: unknown;
  /** Human display name from the CLI (e.g. "Write"). */
  displayName?: string;
  /** Short description the CLI provides (e.g. the target file). */
  description?: string;
  /** Suggested resolutions (e.g. setMode acceptEdits). */
  suggestions?: unknown[];
}

/** The decision returned by a `canUseTool` callback. */
export type PermissionResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message?: string };

/** Caller-supplied per-tool approval hook. Presence enables the control protocol. */
export type CanUseTool = (call: PermissionToolCall) => Promise<PermissionResult>;

/** Whether the control protocol handshake is active for a session. */
export interface ControlState {
  readonly enabled: boolean;
}

/**
 * Bidirectional control-protocol channel over the print transport's stdio.
 * Construct with a `write` fn (writes a line to the child's stdin) and an
 * `onPermission` handler (invoked for each inbound can_use_tool request).
 */
export class ControlChannel {
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private counter = 0;

  constructor(
    private readonly write: (line: string) => void,
    private readonly onPermission: (call: PermissionToolCall, requestId: string) => void,
    /** Handle an inbound JSON-RPC message for an in-process MCP server (mcp_message). */
    private readonly onMcpMessage?: (serverName: string, message: unknown) => Promise<unknown | null>,
  ) {}

  private nextId(): string {
    this.counter++;
    return `cw-${this.counter}-${randomUUID().slice(0, 8)}`;
  }

  /** Send the initialize handshake. Resolves with the CLI's reported capabilities. */
  initialize(sdkMcpServers: string[] = []): Promise<unknown> {
    return this.request({ subtype: "initialize", hooks: {}, sdkMcpServers });
  }

  /** Request the CLI interrupt the in-flight turn. */
  interrupt(): Promise<unknown> {
    return this.request({ subtype: "interrupt" });
  }

  setPermissionMode(mode: string): Promise<unknown> {
    return this.request({ subtype: "set_permission_mode", mode });
  }

  setModel(model: string): Promise<unknown> {
    return this.request({ subtype: "set_model", model });
  }

  private request(req: Record<string, unknown>): Promise<unknown> {
    const requestId = this.nextId();
    const frame = { type: "control_request", request_id: requestId, request: req };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.write(JSON.stringify(frame) + "\n");
      } catch (err) {
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Route an inbound frame. Returns true if it was a control frame (so the
   * caller skips turn-accumulation), false otherwise.
   */
  handle(msg: ControlRequestMessage | ControlResponseMessage): boolean {
    if (msg.type === "control_response") {
      const id = msg.response?.request_id;
      const p = id ? this.pending.get(id) : undefined;
      if (p && id) {
        this.pending.delete(id);
        if (msg.response.subtype === "error") {
          p.reject(new Error(String((msg.response as { error?: unknown }).error ?? "control error")));
        } else {
          p.resolve((msg.response as { response?: unknown }).response);
        }
      }
      return true;
    }
    if (msg.type === "control_request") {
      const req = msg.request as {
        subtype?: string;
        tool_name?: string;
        display_name?: string;
        input?: unknown;
        description?: string;
        permission_suggestions?: unknown[];
        tool_use_id?: string;
        server_name?: string;
        message?: unknown;
      };
      if (req.subtype === "mcp_message" && this.onMcpMessage) {
        const requestId = msg.request_id;
        const serverName = req.server_name ?? "";
        void this.onMcpMessage(serverName, req.message)
          .then((mcpResponse) => this.respondMcp(requestId, mcpResponse))
          .catch(() => this.respondMcp(requestId, null));
        return true;
      }
      if (req.subtype === "can_use_tool") {
        const call: PermissionToolCall = {
          name: req.tool_name ?? "",
          input: req.input,
          ...(req.tool_use_id !== undefined ? { id: req.tool_use_id } : {}),
          ...(req.display_name !== undefined ? { displayName: req.display_name } : {}),
          ...(req.description !== undefined ? { description: req.description } : {}),
          ...(req.permission_suggestions !== undefined ? { suggestions: req.permission_suggestions } : {}),
        };
        this.onPermission(call, msg.request_id);
      }
      // Other inbound control_requests (hook_callback, mcp_message) are ignored in M4.
      return true;
    }
    return false;
  }

  /** Answer a can_use_tool request. */
  respondPermission(requestId: string, result: PermissionResult): void {
    const inner =
      result.behavior === "allow"
        ? { behavior: "allow", updatedInput: result.updatedInput ?? {} }
        : { behavior: "deny", message: result.message ?? "denied by canUseTool" };
    const frame = {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: inner },
    };
    this.write(JSON.stringify(frame) + "\n");
  }

  /** Reply to an mcp_message control_request with the JSON-RPC response. */
  private respondMcp(requestId: string, mcpResponse: unknown | null): void {
    const frame = {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: { mcp_response: mcpResponse } },
    };
    this.write(JSON.stringify(frame) + "\n");
  }

  /** Reject all in-flight controller→CLI requests (e.g. on teardown). */
  rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
