// Map an OpenAI ChatCompletionRequest onto PrintOptions + the content to send.
//
// OpenAI requests are stateless (the client resends full messages[]). Claude
// `-p` stream-json input only accepts `user` messages, so only `replay` can
// honor client-asserted assistant content (§3.4 / §12-D9). System messages
// become --system-prompt (replace) or --append-system-prompt.

import type { ContentBlock, ImageBlock } from "../print/proto";
import type { PrintOptions } from "../print/args";
import {
  DEFAULT_MODEL,
  type ChatCompletionRequest,
  type ChatContentPart,
  type ChatMessage,
} from "./openai-types";

export interface MapRequestOptions {
  /** Isolate by default (§1.7). */
  isolate?: boolean;
  /** Route joined system text to --append-system-prompt instead of replacing. */
  appendSystem?: boolean;
  /** Fallback model when the request doesn't name one. */
  defaultModel?: string;
}

export interface MappedRequest {
  printOptions: PrintOptions;
  /** Joined system text (already folded into printOptions; exposed for session reuse). */
  systemText: string | null;
  /** The user content to send THIS call (replay: full flattened history; session: new turn only). */
  content: ContentBlock[];
  /** The raw request messages (diff mode needs them to plan resume-vs-replay). */
  messages: ChatMessage[];
  stream: boolean;
  /** A response_format (schema or json_object) is active — disables max_tokens truncation. */
  responseFormatActive: boolean;
  /** json_object mode (no schema, just "valid JSON object" instruction). */
  jsonObjectMode: boolean;
  /** Effective max output tokens, or null. */
  maxTokens: number | null;
  history: "replay" | "session" | "diff";
  sessionId?: string;
  warnings: string[];
}

const SAMPLING_PARAMS = ["temperature", "top_p", "n", "stop", "seed", "logprobs", "frequency_penalty", "presence_penalty"];

/** Parse a data: URI into an ImageBlock, or null if it isn't one. */
function dataUriToImage(url: string): ImageBlock | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mediaType = m[1] || "image/png";
  const isB64 = !!m[2];
  const raw = m[3] ?? "";
  const data = isB64 ? raw : Buffer.from(decodeURIComponent(raw), "utf8").toString("base64");
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

/** Fetch a remote image and inline it as a base64 ImageBlock (§12-D11). */
async function fetchImage(url: string): Promise<ImageBlock> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch image ${url}: ${res.status}`);
  const mediaType = res.headers.get("content-type")?.split(";")[0] || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } };
}

async function imagePartToBlock(part: Extract<ChatContentPart, { type: "image_url" }>): Promise<ImageBlock> {
  const url = part.image_url.url;
  if (url.startsWith("data:")) {
    const block = dataUriToImage(url);
    if (block) return block;
  }
  return fetchImage(url);
}

/** Normalize a message's content to OpenAI content parts. */
function toParts(content: ChatMessage["content"]): ChatContentPart[] {
  if (content === null) return [];
  if (typeof content === "string") return content.length ? [{ type: "text", text: content }] : [];
  return content;
}

/** Build the content blocks for one message, prefixing role label on its text (replay). */
async function messageToBlocks(msg: ChatMessage, label: string | null): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  let text = label ? `${label}: ` : "";
  for (const part of toParts(msg.content)) {
    if (part.type === "text") {
      text += part.text;
    } else if (part.type === "image_url") {
      if (text.trim().length) blocks.push({ type: "text", text });
      text = "";
      blocks.push(await imagePartToBlock(part));
    }
  }
  if (text.trim().length) blocks.push({ type: "text", text });
  return blocks;
}

const ROLE_LABEL: Record<string, string | null> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
  developer: "Developer",
};

/** Flatten the full conversation (minus system/developer) into a single user turn. */
export async function flattenReplay(messages: ChatMessage[]): Promise<ContentBlock[]> {
  // system + developer messages become the system prompt (mapRequest), so they
  // must not also be replayed into the user turn.
  const nonSystem = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const out: ContentBlock[] = [];
  // Single-turn fast path: one user message → send its content verbatim (no label).
  if (nonSystem.length === 1 && nonSystem[0]!.role === "user") {
    return messageToBlocks(nonSystem[0]!, null);
  }
  for (const m of nonSystem) {
    const label = ROLE_LABEL[m.role] ?? null;
    out.push(...(await messageToBlocks(m, label)));
    out.push({ type: "text", text: "\n\n" });
  }
  // The model should answer the last turn; nudge it.
  out.push({ type: "text", text: "Assistant:" });
  return out;
}

/** The newest user message's content (session mode sends only the new turn). */
async function lastUserContent(messages: ChatMessage[]): Promise<ContentBlock[]> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messageToBlocks(messages[i]!, null);
  }
  return [{ type: "text", text: "" }];
}

export async function mapRequest(req: ChatCompletionRequest, opts: MapRequestOptions = {}): Promise<MappedRequest> {
  const warnings: string[] = [];
  const isolate = opts.isolate ?? true;

  // System prompt: join all system/developer messages' text.
  const systemParts = req.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : toParts(m.content).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("")))
    .filter((s) => s.length > 0);
  let systemText = systemParts.length ? systemParts.join("\n\n") : null;

  // response_format.
  let responseFormatActive = false;
  let jsonObjectMode = false;
  let jsonSchema: object | undefined;
  const rf = req.response_format;
  if (rf) {
    if (rf.type === "json_schema") {
      jsonSchema = rf.json_schema.schema;
      responseFormatActive = true;
    } else if (rf.type === "json_object") {
      jsonObjectMode = true;
      responseFormatActive = true;
      const instr =
        "Respond with a single valid JSON object and nothing else — no prose, no explanation, and no markdown code fences.";
      systemText = systemText ? `${systemText}\n\n${instr}` : instr;
    }
    // {type:"text"} is an explicit no-op.
  }

  // Sampling params: ignored with a one-time warning.
  for (const p of SAMPLING_PARAMS) {
    if (req[p] !== undefined) warnings.push(`ignoring unsupported sampling param "${p}" (no claude -p equivalent)`);
  }

  const maxTokens = (req.max_tokens ?? req.max_completion_tokens) ?? null;

  const history: "replay" | "session" | "diff" = req.history ?? (req.session_id ? "session" : "replay");

  const content = history === "session" ? await lastUserContent(req.messages) : await flattenReplay(req.messages);

  // Caller-supplied MCP config is honored by default (permissive posture,
  // §12-D2). When present, drop the `isolate` shorthand (which would empty
  // tools) and instead keep the cheap flags except the tool restriction, so
  // the caller's MCP tools remain usable.
  const callerMcp = req.mcp as PrintOptions["mcpConfig"] | undefined;
  const printOptions: PrintOptions = {
    model: req.model || opts.defaultModel || DEFAULT_MODEL,
    ...(callerMcp
      ? { mcpConfig: callerMcp, strictMcpConfig: true, settingSources: [], isolate: false }
      : { isolate }),
    // Replay is OpenAI-pure: never persist to disk. Session mode persists (it owns the id).
    ...(history === "replay" ? { persistSession: false } : {}),
    ...(systemText !== null ? (opts.appendSystem ? { appendSystemPrompt: systemText } : { systemPrompt: systemText }) : {}),
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
    // Streaming needs partial messages over the stream-json (persistent) transport.
    ...(req.stream ? { includePartialMessages: true, transport: "persistent" as const } : {}),
  };

  return {
    printOptions,
    systemText,
    content,
    messages: req.messages,
    stream: req.stream === true,
    responseFormatActive,
    jsonObjectMode,
    maxTokens,
    history,
    ...(req.session_id !== undefined ? { sessionId: req.session_id } : {}),
    warnings,
  };
}
