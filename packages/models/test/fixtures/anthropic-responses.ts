/** Canned Anthropic Messages API responses, model listings and SSE streams for the adapter tests. */
import { jsonResponse } from "./openai-responses.js";

export { fakeFetch, jsonResponse, respondWith, type FakeFetch, type RecordedRequest } from "./openai-responses.js";

const MODEL = "claude-test";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; thinking: string; signature: string };

export type MessageOptions = {
  content?: ContentBlock[];
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

export function messageBody(options: MessageOptions = {}): Record<string, unknown> {
  const { content = [{ type: "text", text: "Hello from the fake model" }], stopReason, usage } = options;
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL,
    content,
    stop_reason: stopReason ?? (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: usage ?? { input_tokens: 11, output_tokens: 7 },
  };
}

export function messageResponse(options: MessageOptions = {}): Response {
  return jsonResponse(messageBody(options));
}

export function textMessage(text: string): Response {
  return messageResponse({ content: [{ type: "text", text }] });
}

/** An Anthropic-style error response; `message` is what the server says, which may echo secrets. */
export function errorResponse(status: number, type: string, message = `error ${status}`): Response {
  return jsonResponse({ type: "error", error: { type, message } }, status);
}

export type ModelPage = { ids: string[]; hasMore: boolean; lastId?: string };

/** One page of `GET /v1/models`. */
export function modelsResponse(page: ModelPage): Response {
  return jsonResponse({
    data: page.ids.map((id) => ({ type: "model", id, display_name: id, created_at: "2025-01-01T00:00:00Z" })),
    has_more: page.hasMore,
    first_id: page.ids[0] ?? null,
    last_id: page.lastId ?? page.ids.at(-1) ?? null,
  });
}

type Event = { type: string } & Record<string, unknown>;

/** Server-sent events in the Anthropic streaming format: an `event:` line then a `data:` line each. */
export function sseResponse(events: Event[]): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function messageStart(inputTokens: number): Event {
  return {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  };
}

function messageEnd(stopReason: string, outputTokens: number): Event[] {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: "message_stop" },
  ];
}

function textBlock(index: number, parts: string[]): Event[] {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...parts.map(
      (text): Event => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
    ),
    { type: "content_block_stop", index },
  ];
}

function toolUseBlock(index: number, call: { id: string; name: string; argumentFragments: string[] }): Event[] {
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } },
    ...call.argumentFragments.map(
      (partial_json): Event => ({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json },
      }),
    ),
    { type: "content_block_stop", index },
  ];
}

function thinkingBlock(index: number, parts: string[]): Event[] {
  return [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
    ...parts.map(
      (thinking): Event => ({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } }),
    ),
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-test" } },
    { type: "content_block_stop", index },
  ];
}

export type StreamBlock =
  | { kind: "text"; parts: string[] }
  | { kind: "tool_use"; id: string; name: string; argumentFragments: string[] }
  | { kind: "thinking"; parts: string[] };

/** A whole streamed message made of `blocks`, with the given token counts. */
export function streamResponse(
  blocks: StreamBlock[],
  options: { stopReason?: string; inputTokens?: number; outputTokens?: number } = {},
): Response {
  const { inputTokens = 25, outputTokens = 15 } = options;
  const stopReason = options.stopReason ?? (blocks.some((block) => block.kind === "tool_use") ? "tool_use" : "end_turn");
  return sseResponse([
    messageStart(inputTokens),
    ...blocks.flatMap((block, index) => {
      if (block.kind === "text") return textBlock(index, block.parts);
      if (block.kind === "thinking") return thinkingBlock(index, block.parts);
      return toolUseBlock(index, block);
    }),
    ...messageEnd(stopReason, outputTokens),
  ]);
}
