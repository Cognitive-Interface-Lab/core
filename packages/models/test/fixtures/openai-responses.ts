/** Canned OpenAI chat-completions responses and a recording fake `fetch` for the adapter tests. */

/** The parts of an OpenAI chat-completions request body that the tests look at. */
export type ChatBody = {
  model?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tool_choice?: unknown;
  messages?: {
    role: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  }[];
  tools?: { type: string; function: { name: string; description?: string; parameters?: unknown } }[];
  [key: string]: unknown;
};

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  /** The parsed JSON body, or undefined when the request had none. */
  body: ChatBody | undefined;
};

export type FakeFetch = {
  fetch: typeof fetch;
  requests: RecordedRequest[];
};

type Responder = (request: RecordedRequest, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** A `fetch` that records every request and answers with `responder`. Never touches the network. */
export function fakeFetch(responder: Responder): FakeFetch {
  const requests: RecordedRequest[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as ChatBody) : undefined,
    };
    requests.push(request);
    return responder(request, init?.signal ?? undefined);
  };
  return { fetch: impl as typeof fetch, requests };
}

/** A `fetch` that answers every call with a fresh response from `make`. */
export function respondWith(make: () => Response): FakeFetch {
  return fakeFetch(() => make());
}

/** A `fetch` that never answers until its signal fires, then rejects with the signal's reason. */
export function hangingFetch(): FakeFetch {
  return fakeFetch(
    (_request, signal) =>
      new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

const MODEL = "gpt-test";

export type CompletionOptions = {
  content?: string | null;
  toolCalls?: { id: string; name: string; arguments: string }[];
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
};

export function completionBody(options: CompletionOptions = {}): Record<string, unknown> {
  const { content = "Hello from the fake model", toolCalls, finishReason, usage } = options;
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls && {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
        },
        finish_reason: finishReason ?? (toolCalls ? "tool_calls" : "stop"),
      },
    ],
    ...(usage !== null && {
      usage: {
        prompt_tokens: usage?.prompt_tokens ?? 11,
        completion_tokens: usage?.completion_tokens ?? 7,
        total_tokens: (usage?.prompt_tokens ?? 11) + (usage?.completion_tokens ?? 7),
      },
    }),
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function completionResponse(options: CompletionOptions = {}): Response {
  return jsonResponse(completionBody(options));
}

/** An OpenAI-style error response; `message` is what the server says, which may echo secrets. */
export function errorResponse(status: number, message = `error ${status}`): Response {
  return jsonResponse({ error: { message, type: "test_error", code: String(status) } }, status);
}

type Chunk = Record<string, unknown>;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null, extra: Chunk = {}): Chunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
}

/** Server-sent events in the OpenAI streaming format, ending with `data: [DONE]`. */
export function sseResponse(chunks: Chunk[]): Response {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function textStreamResponse(
  parts: string[],
  usage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 5, completion_tokens: parts.length },
): Response {
  return sseResponse([
    chunk({ role: "assistant", content: "" }),
    ...parts.map((part) => chunk({ content: part })),
    chunk({}, "stop"),
    // Sent when the request asks for usage; harmless otherwise.
    { ...chunk({}), choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } },
  ]);
}

export function toolCallStreamResponse(call: { id: string; name: string; argumentFragments: string[] }): Response {
  return sseResponse([
    chunk({
      role: "assistant",
      content: null,
      tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: "" } }],
    }),
    ...call.argumentFragments.map((fragment) =>
      chunk({ tool_calls: [{ index: 0, function: { arguments: fragment } }] }),
    ),
    chunk({}, "tool_calls"),
  ]);
}
