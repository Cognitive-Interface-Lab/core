import { describe, expect, it } from "vitest";
import { CoreError, type ChatRequest, type ErrorCode, type StreamEvent } from "@core/contracts";
import {
  MemoryCredentialStore,
  OpenAICompatibleProvider,
  PRESETS,
  type Credentials,
  type ModelProvider,
  type Preset,
} from "../src/index.js";
import {
  completionResponse,
  errorResponse,
  fakeFetch,
  hangingFetch,
  respondWith,
  textStreamResponse,
  toolCallStreamResponse,
  type FakeFetch,
} from "./fixtures/openai-responses.js";

const SECRET = "sk-test-secret-key-123";
const HEADER_SECRET = "team-token-value-456";

const request: ChatRequest = {
  model: { provider: "openai", model: "gpt-test" },
  messages: [{ role: "user", content: "hi" }],
};

function providerFor(
  fake: FakeFetch,
  options: { id?: string; preset?: Preset | null; credentials?: Credentials | null } = {},
): OpenAICompatibleProvider {
  const id = options.id ?? "openai";
  const preset = options.preset === undefined ? PRESETS["openai"] : (options.preset ?? undefined);
  const credentials = options.credentials === undefined ? { apiKey: SECRET } : options.credentials;
  return new OpenAICompatibleProvider({
    id,
    ...(preset ? { preset } : {}),
    credentials: new MemoryCredentialStore(credentials ? { [id]: credentials } : {}),
    fetch: fake.fetch,
  });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const all: StreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function caught(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the promise to reject");
}

function streamError(events: StreamEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "error") throw new Error(`expected a final error event, got ${last?.type}`);
  expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  return last.error;
}

describe("presets", () => {
  it("define the five hosted and local servers", () => {
    expect(PRESETS).toEqual({
      openai: { baseURL: "https://api.openai.com/v1", requiresKey: true },
      ollama: { baseURL: "http://127.0.0.1:11434/v1", requiresKey: false },
      openrouter: { baseURL: "https://openrouter.ai/api/v1", requiresKey: true },
      groq: { baseURL: "https://api.groq.com/openai/v1", requiresKey: true },
      cloudflare: {
        baseURL: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
        requiresKey: true,
        models: "cloudflare",
      },
    });
  });
});

describe("OpenAICompatibleProvider capabilities", () => {
  it("defaults to streaming and tools without vision", () => {
    const provider: ModelProvider = providerFor(respondWith(() => completionResponse()));
    expect(provider.capabilities("any")).toEqual({
      streaming: true,
      tools: true,
      vision: false,
    });
  });

  it("can be overridden through the constructor", () => {
    const provider: ModelProvider = new OpenAICompatibleProvider({
      id: "openai",
      credentials: new MemoryCredentialStore(),
      capabilities: { vision: true, contextWindow: 128_000 },
    });
    expect(provider.capabilities("gpt-test")).toEqual({
      streaming: true,
      tools: true,
      vision: true,
      contextWindow: 128_000,
    });
  });

  it("answers per model when the option is a function, merged with the defaults", () => {
    const provider: ModelProvider = new OpenAICompatibleProvider({
      id: "openai",
      credentials: new MemoryCredentialStore(),
      capabilities: (model) => (model === "gpt-vision" ? { vision: true, contextWindow: 64_000 } : {}),
    });
    expect(provider.capabilities("gpt-vision")).toEqual({
      streaming: true,
      tools: true,
      vision: true,
      contextWindow: 64_000,
    });
    expect(provider.capabilities("gpt-plain")).toEqual({ streaming: true, tools: true, vision: false });
  });

  it("passes the asked model id to the function on every call", () => {
    const asked: string[] = [];
    const provider: ModelProvider = new OpenAICompatibleProvider({
      id: "ollama",
      credentials: new MemoryCredentialStore(),
      capabilities: (model) => {
        asked.push(model);
        return model.startsWith("llama3.2") ? { tools: false } : {};
      },
    });
    expect(provider.capabilities("llama3.2:3b").tools).toBe(false);
    expect(provider.capabilities("qwen3:8b").tools).toBe(true);
    expect(provider.capabilities("llama3.2:3b").tools).toBe(false);
    expect(asked).toEqual(["llama3.2:3b", "qwen3:8b", "llama3.2:3b"]);
  });

  it("returns a fresh object each time, so a caller cannot change later answers", () => {
    const provider: ModelProvider = new OpenAICompatibleProvider({
      id: "openai",
      credentials: new MemoryCredentialStore(),
      capabilities: () => ({ vision: true }),
    });
    const first = provider.capabilities("a");
    first.vision = false;
    expect(provider.capabilities("a").vision).toBe(true);
  });

  it("gives the object form the same answer for every model", () => {
    const provider: ModelProvider = new OpenAICompatibleProvider({
      id: "openai",
      credentials: new MemoryCredentialStore(),
      capabilities: { vision: true },
    });
    expect(provider.capabilities("a")).toEqual(provider.capabilities("b"));
    expect(provider.capabilities("a").vision).toBe(true);
  });
});

describe("OpenAICompatibleProvider.chat", () => {
  it("maps a text reply and its usage", async () => {
    const fake = respondWith(() => completionResponse({ content: "Hi there!", usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    const response = await providerFor(fake).chat(request);
    expect(response.message).toEqual({ role: "assistant", content: "Hi there!" });
    expect(response.model).toEqual(request.model);
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it("reports empty usage when the server sends none", async () => {
    const response = await providerFor(respondWith(() => completionResponse({ usage: null }))).chat(request);
    expect(response.usage).toEqual({});
  });

  it("maps a length finish reason", async () => {
    const response = await providerFor(respondWith(() => completionResponse({ finishReason: "length" }))).chat(request);
    expect(response.finishReason).toBe("length");
  });

  it("maps a tool-call reply to toolCalls with parsed arguments", async () => {
    const fake = respondWith(() =>
      completionResponse({
        content: null,
        toolCalls: [
          { id: "call_1", name: "search", arguments: '{"query":"cats","limit":3}' },
          { id: "call_2", name: "open", arguments: "{}" },
        ],
      }),
    );
    const response = await providerFor(fake).chat(request);
    expect(response.finishReason).toBe("tool-calls");
    expect(response.message.content).toBe("");
    expect(response.message.toolCalls).toEqual([
      { id: "call_1", name: "search", arguments: { query: "cats", limit: 3 } },
      { id: "call_2", name: "open", arguments: {} },
    ]);
  });

  it("returns tool calls to the caller instead of running them", async () => {
    const fake = respondWith(() =>
      completionResponse({ content: null, toolCalls: [{ id: "call_1", name: "search", arguments: '{"q":"x"}' }] }),
    );
    const tools = [{ name: "search", description: "Search the web", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    await providerFor(fake).chat({ ...request, tools });
    expect(fake.requests).toHaveLength(1);
  });

  it("sends the request to <baseURL>/chat/completions with the bearer key and the model id", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor(fake).chat(request);
    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0]!;
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(sent.body?.model).toBe("gpt-test");
  });

  it("maps contract messages onto the OpenAI message format", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor(fake).chat({
      model: request.model,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "weather?" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "weather", arguments: { city: "Oslo" } }] },
        { role: "tool", toolCallId: "call_1", toolName: "weather", content: '{"temp":4}' },
        { role: "user", content: "thanks" },
      ],
    });
    const messages = fake.requests[0]!.body!.messages!;
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(messages[0]!.content).toBe("be brief");
    const call = messages[2]!.tool_calls![0]!;
    expect(call.id).toBe("call_1");
    expect(call.function.name).toBe("weather");
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Oslo" });
    expect(messages[3]!.tool_call_id).toBe("call_1");
    expect(messages[3]!.content).toBe('{"temp":4}');
  });

  it("offers tool definitions to the model with their JSON Schema", async () => {
    // With toolChoice "required" the model must answer with a tool call, so the fake does.
    const fake = respondWith(() =>
      completionResponse({ content: null, toolCalls: [{ id: "call_1", name: "search", arguments: '{"q":"x"}' }] }),
    );
    const inputSchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    await providerFor(fake).chat({
      ...request,
      tools: [{ name: "search", description: "Search the web", inputSchema }],
      toolChoice: "required",
    });
    const body = fake.requests[0]!.body!;
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0]!.function.name).toBe("search");
    expect(body.tools![0]!.function.description).toBe("Search the web");
    expect(body.tools![0]!.function.parameters).toMatchObject(inputSchema);
    expect(body.tool_choice).toBe("required");
  });

  it("sends no tools when the request has none", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor(fake).chat(request);
    expect(fake.requests[0]!.body!.tools).toBeUndefined();
  });

  it("passes temperature and the output token limit", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor(fake).chat({ ...request, temperature: 0.2, maxOutputTokens: 50 });
    const body = fake.requests[0]!.body!;
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(50);
  });
});

describe("OpenAICompatibleProvider configuration", () => {
  it("uses the credentials' base URL over the preset's", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor(fake, { credentials: { apiKey: SECRET, baseURL: "https://proxy.example/v9" } }).chat(request);
    expect(fake.requests[0]!.url).toBe("https://proxy.example/v9/chat/completions");
  });

  it("works without a preset when the credentials carry a base URL", async () => {
    const fake = respondWith(() => completionResponse());
    const provider = providerFor(fake, { id: "custom", preset: null, credentials: { baseURL: "https://llm.internal/v1" } });
    await provider.chat(request);
    expect(fake.requests[0]!.url).toBe("https://llm.internal/v1/chat/completions");
    expect(fake.requests[0]!.headers.get("authorization")).toBeNull();
  });

  it("sends no Authorization header to a preset that does not require a key", async () => {
    const fake = respondWith(() => completionResponse());
    const provider = providerFor(fake, { id: "ollama", preset: PRESETS["ollama"]!, credentials: null });
    await provider.chat({ ...request, model: { provider: "ollama", model: "llama3.2:3b" } });
    expect(fake.requests[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(fake.requests[0]!.headers.get("authorization")).toBeNull();
    expect(fake.requests[0]!.body!.model).toBe("llama3.2:3b");
  });

  it("forwards custom headers", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor(fake, { credentials: { apiKey: SECRET, headers: { "x-team": "core" } } }).chat(request);
    expect(fake.requests[0]!.headers.get("x-team")).toBe("core");
  });

  it("reads credentials on every call, so a changed key takes effect", async () => {
    const fake = respondWith(() => completionResponse());
    const store = new MemoryCredentialStore({ openai: { apiKey: "key-one" } });
    const provider = new OpenAICompatibleProvider({ id: "openai", preset: PRESETS["openai"]!, credentials: store, fetch: fake.fetch });
    await provider.chat(request);
    store.set("openai", { apiKey: "key-two" });
    await provider.chat(request);
    expect(fake.requests.map((sent) => sent.headers.get("authorization"))).toEqual(["Bearer key-one", "Bearer key-two"]);
  });

  describe("missing configuration, raised before any network call", () => {
    it("chat: a missing key with requiresKey throws auth", async () => {
      const fake = respondWith(() => completionResponse());
      const error = await caught(providerFor(fake, { credentials: null }).chat(request));
      expect(error.code).toBe("auth");
      expect(error.provider).toBe("openai");
      expect(error.message).toBe("openai: no API key configured");
      expect(fake.requests).toHaveLength(0);
    });

    it("chat: an empty key counts as missing", async () => {
      const fake = respondWith(() => completionResponse());
      const error = await caught(providerFor(fake, { credentials: { apiKey: "" } }).chat(request));
      expect(error.code).toBe("auth");
      expect(fake.requests).toHaveLength(0);
    });

    it("stream: a missing key becomes a final auth error event", async () => {
      const fake = respondWith(() => textStreamResponse(["x"]));
      const events = await collect(providerFor(fake, { credentials: null }).stream(request));
      expect(events).toHaveLength(1);
      expect(streamError(events)).toMatchObject({ code: "auth", provider: "openai", message: "openai: no API key configured" });
      expect(fake.requests).toHaveLength(0);
    });

    it("chat: a missing base URL throws bad_request", async () => {
      const fake = respondWith(() => completionResponse());
      const error = await caught(providerFor(fake, { id: "custom", preset: null, credentials: null }).chat(request));
      expect(error.code).toBe("bad_request");
      expect(error.provider).toBe("custom");
      expect(error.message).toBe("custom: no base URL configured");
      expect(fake.requests).toHaveLength(0);
    });

    it("stream: a missing base URL becomes a final bad_request error event", async () => {
      const fake = respondWith(() => textStreamResponse(["x"]));
      const events = await collect(providerFor(fake, { id: "custom", preset: null, credentials: { apiKey: SECRET } }).stream(request));
      expect(streamError(events)).toMatchObject({ code: "bad_request", message: "custom: no base URL configured" });
      expect(fake.requests).toHaveLength(0);
    });
  });
});

describe("OpenAICompatibleProvider.stream", () => {
  it("streams text deltas and ends with finish and usage", async () => {
    const fake = respondWith(() => textStreamResponse(["Hel", "lo ", "world"], { prompt_tokens: 9, completion_tokens: 3 }));
    const events = await collect(providerFor(fake).stream(request));
    const text = events.flatMap((event) => (event.type === "text-delta" ? [event.text] : []));
    expect(text.join("")).toBe("Hello world");
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 3 },
    });
    expect(events.filter((event) => event.type === "finish")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("asks the server to stream", async () => {
    const fake = respondWith(() => textStreamResponse(["x"]));
    await collect(providerFor(fake).stream(request));
    expect(fake.requests[0]!.body!.stream).toBe(true);
    expect(fake.requests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(fake.requests[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("never emits route events", async () => {
    const events = await collect(providerFor(respondWith(() => textStreamResponse(["x"]))).stream(request));
    expect(events.some((event) => event.type === "route")).toBe(false);
  });

  it("assembles a streamed tool call with parsed arguments", async () => {
    const fake = respondWith(() =>
      toolCallStreamResponse({ id: "call_9", name: "search", argumentFragments: ['{"que', 'ry":"ca', 'ts"}'] }),
    );
    const events = await collect(providerFor(fake).stream(request));
    expect(events.filter((event) => event.type === "tool-call")).toEqual([
      { type: "tool-call", toolCall: { id: "call_9", name: "search", arguments: { query: "cats" } } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("OpenAICompatibleProvider HTTP errors", () => {
  const cases: [number, ErrorCode, boolean][] = [
    [401, "auth", false],
    [403, "auth", false],
    [404, "not_found", false],
    [400, "bad_request", false],
    [422, "bad_request", false],
    [429, "rate_limit", true],
    [500, "unavailable", true],
    [503, "unavailable", true],
  ];

  for (const [status, code, retryable] of cases) {
    it(`chat: HTTP ${status} → ${code}, with the provider set`, async () => {
      const fake = respondWith(() => errorResponse(status));
      const error = await caught(providerFor(fake).chat(request));
      expect(error.code).toBe(code);
      expect(error.provider).toBe("openai");
      expect(error.retryable).toBe(retryable);
      expect(fake.requests).toHaveLength(1); // no hidden retries: the router owns them
    });

    it(`stream: HTTP ${status} → a final ${code} error event, with the provider set`, async () => {
      const fake = respondWith(() => errorResponse(status));
      const events = await collect(providerFor(fake).stream(request));
      expect(events).toHaveLength(1);
      expect(streamError(events)).toMatchObject({ code, provider: "openai", retryable });
      expect(fake.requests).toHaveLength(1);
    });
  }

  it("maps a refused connection to unavailable", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
    });
    const provider = providerFor(fake, { id: "ollama", preset: PRESETS["ollama"]!, credentials: null });
    const error = await caught(provider.chat(request));
    expect(error.code).toBe("unavailable");
    expect(error.provider).toBe("ollama");
    expect(error.retryable).toBe(true);
    const events = await collect(provider.stream(request));
    expect(streamError(events)).toMatchObject({ code: "unavailable", provider: "ollama" });
  });

  it("maps an unexpected failure to unknown", async () => {
    const fake = fakeFetch(() => {
      throw new Error("something odd");
    });
    const error = await caught(providerFor(fake).chat(request));
    expect(error.code).toBe("unknown");
    expect(error.provider).toBe("openai");
  });

  it("maps an unmapped HTTP status to unknown", async () => {
    const error = await caught(providerFor(respondWith(() => errorResponse(418))).chat(request));
    expect(error.code).toBe("unknown");
    expect(error.provider).toBe("openai");
  });
});

describe("OpenAICompatibleProvider never leaks secrets", () => {
  const echoing = () => errorResponse(401, `Incorrect API key provided: ${SECRET}. Header seen: ${HEADER_SECRET}`);
  const credentials = { apiKey: SECRET, headers: { "x-team-token": HEADER_SECRET } };

  function expectClean(value: unknown) {
    const text = JSON.stringify(value) + String(value instanceof Error ? value.message : "");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HEADER_SECRET);
  }

  it("chat: an error whose server message echoes the key does not contain it", async () => {
    const error = await caught(providerFor(respondWith(echoing), { credentials }).chat(request));
    expect(error.code).toBe("auth");
    expectClean(error.toJSON());
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(HEADER_SECRET);
    expect(`${error.stack}`).not.toContain(SECRET);
    expect(String(error.cause ?? "")).not.toContain(SECRET);
  });

  it("stream: the error event does not contain the key", async () => {
    const events = await collect(providerFor(respondWith(echoing), { credentials }).stream(request));
    expectClean(events);
    expect(streamError(events).code).toBe("auth");
  });

  it("a missing-key error does not contain other providers' keys", async () => {
    const store = new MemoryCredentialStore({ other: { apiKey: SECRET } });
    const provider = new OpenAICompatibleProvider({ id: "openai", preset: PRESETS["openai"]!, credentials: store, fetch: respondWith(() => completionResponse()).fetch });
    expectClean((await caught(provider.chat(request))).toJSON());
  });
});

describe("OpenAICompatibleProvider cancellation", () => {
  it("chat: aborting the caller's signal gives aborted", async () => {
    const fake = hangingFetch();
    const controller = new AbortController();
    const pending = caught(providerFor(fake).chat(request, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const error = await pending;
    expect(error.code).toBe("aborted");
    expect(error.provider).toBe("openai");
  });

  it("chat: a signal that is already aborted gives aborted", async () => {
    const error = await caught(providerFor(hangingFetch()).chat(request, { signal: AbortSignal.abort() }));
    expect(error.code).toBe("aborted");
  });

  it("chat: a signal aborted with a TimeoutError reason gives timeout", async () => {
    const controller = new AbortController();
    const pending = caught(providerFor(hangingFetch()).chat(request, { signal: controller.signal }));
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 10);
    const error = await pending;
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });

  it("stream: aborting gives a final aborted error event", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const events = await collect(providerFor(hangingFetch()).stream(request, { signal: controller.signal }));
    expect(streamError(events).code).toBe("aborted");
  });

  it("stream: a TimeoutError reason gives a final timeout error event", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 10);
    const events = await collect(providerFor(hangingFetch()).stream(request, { signal: controller.signal }));
    expect(streamError(events).code).toBe("timeout");
  });
});
