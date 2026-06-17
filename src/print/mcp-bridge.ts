// In-process SDK-MCP server hosted over the control protocol (§5 / M5).
//
// The Agent SDK lets a controller host MCP servers *in its own process*: the
// `initialize` control_request advertises their names in `sdkMcpServers`, and
// the CLI then forwards every JSON-RPC message for those servers as a
// `mcp_message` control_request (`{server_name, message}`), expecting a
// control_response carrying `{mcp_response: <jsonrpc>}`. Tool names the model
// sees are `mcp__<serverName>__<toolName>`.
//
// This is the substrate for OpenAI client-side function calling: register the
// client's functions as bridged tools whose handlers surface a tool_call to the
// OpenAI client and return its result. Wire format verified against 2.1.179.

/** A tool the bridge exposes to Claude. */
export interface BridgedTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool input. */
  inputSchema?: object;
  /** Invoked when Claude calls the tool; may be async/parked. */
  handler: (input: unknown) => Promise<BridgedToolResult>;
}

export interface BridgedToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown; [k: string]: unknown };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export class McpControlBridge {
  constructor(
    readonly serverName: string,
    private readonly tools: BridgedTool[],
  ) {}

  /** Fully-qualified tool names as the model/CLI see them. */
  get qualifiedToolNames(): string[] {
    return this.tools.map((t) => `mcp__${this.serverName}__${t.name}`);
  }

  /**
   * Handle one inbound JSON-RPC message. Returns the JSON-RPC response, or null
   * for a notification (no id). Never throws — tool errors are folded into an
   * isError result.
   */
  async handle(message: JsonRpcMessage): Promise<unknown | null> {
    const { id, method, params } = message;

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: this.serverName, version: "0.1.0" },
        },
      };
    }

    // Notifications (no id) — e.g. notifications/initialized — need no response.
    if (id === undefined || method === "notifications/initialized") return null;

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
        },
      };
    }

    if (method === "tools/call") {
      const name = params?.name;
      const tool = this.tools.find((t) => t.name === name);
      if (!tool) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(name)}` } };
      }
      try {
        const result = await tool.handler(params?.arguments);
        return { jsonrpc: "2.0", id, result: { content: result.content, isError: result.isError ?? false } };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true },
        };
      }
    }

    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } };
  }
}
