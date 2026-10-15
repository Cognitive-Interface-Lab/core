import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CoreError, type ChatRequest, type StreamEvent } from "@core/contracts";
import {
  AnthropicProvider,
  MemoryCredentialStore,
  outputSchemaFrom,
  type Credentials,
  type ModelProvider,
  type Preset,
} from "../src/index.js";
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  messageResponse,
  modelsResponse,
  respondWith,
  streamResponse,
  textMessage,
  type FakeFetch,
} from "./fixtures/anthropic-responses.js";

const SECRET = "sk-ant-test-secret-key-123";
const HEADER_SECRET = "team-token-value-456";
const MARKER = "LEAKMARKER-zx81";

const ANTHROPIC_PRESET: Preset = {
  baseURL: "https://api.anthropic.com/v1",
  requiresKey: true,
  api: "anthropic",
  models: "anthropic",
};
const AWS_PRESET: Preset = {
  baseURL: "https://aws-external-anthropic.{region}.api.aws/v1",
  requiresKey: true,
  requiresWorkspace: true,
  api: "anthropic",
  models: "anthropic",
};
const AWS_CREDENTIALS: Credentials = { apiKey: SECRET, region: "us-west-2", workspaceId: "wrkspc_01" };

const request: ChatRequest = {
  model: { provider: "anthropic", model: "claude-opus-5-5" },
  messages: [{ role: "user", content: "hi" }],
};

function providerFor(
  fake: FakeFetch,
  options: { id?: string; preset?: Preset; credentials?: Credentials | null } = {},
): AnthropicProvider {
  const id = options.id ?? "anthropic";
  const credentials = options.credentials === undefined ? { apiKey: SECRET } : options.credentials;
  return new AnthropicProvider({
    id,
    preset: options.preset ?? ANTHROPIC_PRESET,
    credentials: new MemoryCredentialStore(credentials ? { [id]: credentials } : {}),
    fetch: fake.fetch,
  });
}

function awsProviderFor(fake: FakeFetch, credentials: Credentials | null = AWS_CREDENTIALS): AnthropicProvider {
  return providerFor(fake, { id: "anthropic-aws", preset: AWS_PRESET, credentials });
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

/** The request body fields the tests look at. */
type MessagesBody = {
  model?: string;
  temperature?: number;
  system?: string | { type: string; text: string }[];
  messages?: { role: string; content: string | Record<string, unknown>[] }[];
  [key: string]: unknown;
};

function bodyOf(fake: FakeFetch, index = 0): MessagesBody {
  const body = fake.requests[index]?.body;
  if (!body) throw new Error(`request ${index} had no body`);
  return body as MessagesBody;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AnthropicProvider requests", () => {
  it("POSTs to /messages with x-api-key and anthropic-version, and no authorization header", async () => {
    const fake = respondWith(() => textMessage("hi"));
    await providerFor(fake).chat(request);

    expect(fake.requests).toHaveLength(1);
    const [sent] = fake.requests;
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers.get("x-api-key")).toBe(SECRET);
    expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent?.headers.has("authorization")).toBe(false);
    expect(sent?.headers.has("anthropic-workspace-id")).toBe(false);
  });

  it("fills the region and sends the workspace id for Claude Platform on AWS", async () => {
    const fake = respondWith(() => textMessage("hi"));
    await awsProviderFor(fake).chat({ ...request, model: { provider: "anthropic-aws", model: "claude-opus-5-5" } });

    const [sent] = fake.requests;
    expect(sent?.url).toBe("https://aws-external-anthropic.us-west-2.api.aws/v1/messages");
    expect(sent?.headers.get("anthropic-workspace-id")).toBe("wrkspc_01");
    expect(sent?.headers.get("x-api-key")).toBe(SECRET);
    expect(sent?.headers.has("authorization")).toBe(false);
  });

  it("sends the credentials' own headers too", async () => {
    const fake = respondWith(() => textMessage("hi"));
    await providerFor(fake, { credentials: { apiKey: SECRET, headers: { "x-team": HEADER_SECRET } } }).chat(request);
    expect(fake.requests[0]?.headers.get("x-team")).toBe(HEADER_SECRET);
  });

  it("uses an explicit credentials.baseURL as is", async () => {
    const fake = respondWith(() => textMessage("hi"));
    await providerFor(fake, { credentials: { apiKey: SECRET, baseURL: "https://gateway.example.com/anthropic/v1" } }).chat(
      request,
    );
    expect(fake.requests[0]?.url).toBe("https://gateway.example.com/anthropic/v1/messages");
  });

  it("maps system, user, assistant tool calls and tool results to the Messages API body", async () => {
    const fake = respondWith(() => textMessage("done"));
    await providerFor(fake).chat({
      model: { provider: "anthropic", model: "claude-opus-5-5" },
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "weather in Paris and Rome?" },
        {
          role: "assistant",
          content: "checking",
          toolCalls: [
            { id: "toolu_1", name: "get_weather", arguments: { city: "Paris" } },
            { id: "toolu_2", name: "get_weather", arguments: { city: "Rome" } },
          ],
        },
        { role: "tool", toolCallId: "toolu_1", toolName: "get_weather", content: "sunny" },
        { role: "tool", toolCallId: "toolu_2", toolName: "get_weather", content: "city unknown", isError: true },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Weather for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
    });

    const body = bodyOf(fake);
    const systemText = typeof body.system === "string" ? body.system : body.system?.map((part) => part.text).join("");
    expect(systemText).toBe("be brief");
    expect(body.messages?.some((message) => message.role === "system")).toBe(false);

    const assistant = body.messages?.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual(
      expect.arrayContaining([
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        { type: "tool_use", id: "toolu_2", name: "get_weather", input: { city: "Rome" } },
      ]),
    );

    const results = body.messages?.at(-1);
    expect(results?.role).toBe("user");
    const blocks = results?.content as Record<string, unknown>[];
    const first = blocks.find((block) => block["tool_use_id"] === "toolu_1");
    const second = blocks.find((block) => block["tool_use_id"] === "toolu_2");
    expect(first).toMatchObject({ type: "tool_result", content: "sunny" });
    expect(first?.["is_error"]).toBeFalsy();
    expect(second).toMatchObject({ type: "tool_result", content: "city unknown", is_error: true });

    expect(body["tools"]).toEqual([expect.objectContaining({ name: "get_weather", description: "Weather for a city" })]);
  });

  it("sends temperature to claude-haiku-4-5 and leaves it out for claude-opus-5-5", async () => {
    const haiku = respondWith(() => textMessage("hi"));
    await providerFor(haiku).chat({ ...request, model: { provider: "anthropic", model: "claude-haiku-4-5" }, temperature: 0.3 });
    expect(bodyOf(haiku).temperature).toBe(0.3);

    const opus = respondWith(() => textMessage("hi"));
    await providerFor(opus).chat({ ...request, model: { provider: "anthropic", model: "claude-opus-5-5" }, temperature: 0.3 });
    expect(bodyOf(opus)).not.toHaveProperty("temperature");
  });

  it("drops temperature itself, so the SDK has nothing to warn about", async () => {
    // The SDK also drops it for models it knows reject it, but logs an "unsupported" warning.
    const warnings: unknown[] = [];
    const global = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
    global.AI_SDK_LOG_WARNINGS = (entry: unknown) => warnings.push(entry);
    try {
      const fake = respondWith(() => textMessage("hi"));
      await providerFor(fake).chat({ ...request, temperature: 0.3 });
      expect(bodyOf(fake)).not.toHaveProperty("temperature");
      expect(JSON.stringify(warnings)).not.toContain("temperature");
    } finally {
      delete global.AI_SDK_LOG_WARNINGS;
    }
  });

  it("drops temperature when streaming a model from 4.7 on, and keeps it before", async () => {
    const newer = respondWith(() => streamResponse([{ kind: "text", parts: ["hi"] }]));
    await collect(providerFor(newer).stream({ ...request, temperature: 0.3 }));
    expect(bodyOf(newer)).not.toHaveProperty("temperature");

    const older = respondWith(() => streamResponse([{ kind: "text", parts: ["hi"] }]));
    await collect(
      providerFor(older).stream({ ...request, model: { provider: "anthropic", model: "claude-opus-4-6" }, temperature: 0.3 }),
    );
    expect(bodyOf(older).temperature).toBe(0.3);
  });

  it("never reads ANTHROPIC_* variables from the environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ENV-SENTINEL-API-KEY");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ENV-SENTINEL-AUTH-TOKEN");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://env-sentinel.example.invalid/v1");

    const fake = fakeFetch((sent) =>
      sent.url.includes("/models") ? modelsResponse({ ids: ["claude-opus-5-5"], hasMore: false }) : textMessage("hi"),
    );
    const provider = providerFor(fake);
    await provider.chat(request);
    await collect(provider.stream(request));
    await provider.listModels();

    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map((sent) => sent.url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/models?limit=1000",
    ]);
    for (const sent of fake.requests) {
      expect(sent.headers.get("x-api-key")).toBe(SECRET);
      const everything = JSON.stringify({ url: sent.url, headers: [...sent.headers.entries()], body: sent.body });
      expect(everything).not.toContain("ENV-SENTINEL");
      expect(everything).not.toContain("env-sentinel");
    }
  });
});

describe("AnthropicProvider temperature rule", () => {
  /** Exposes the protected rule so the version table can be pinned directly. */
  class Probe extends AnthropicProvider {
    accepts(modelId: string): boolean {
      return this.acceptsTemperature(modelId);
    }
  }
  const probe = new Probe({ id: "anthropic", credentials: new MemoryCredentialStore() });

  it.each([
    "claude-opus-4-6",
    "claude-haiku-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-20250514",
    "claude-opus-4-1-20250805",
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
  ])("accepts temperature for %s", (modelId) => {
    expect(probe.accepts(modelId)).toBe(true);
  });

  it.each([
    "claude-opus-4-7",
    "claude-opus-4-10",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-fable-5-1",
    "claude-5-opus",
    "gpt-4o",
    "claude",
    "",
  ])("rejects temperature for %j", (modelId) => {
    expect(probe.accepts(modelId)).toBe(false);
  });
});

describe("AnthropicProvider responses", () => {
  it("returns the text, the stop finish reason and the usage", async () => {
    const fake = respondWith(() => messageResponse({ content: [{ type: "text", text: "Bonjour" }], usage: { input_tokens: 12, output_tokens: 5 } }));
    const response = await providerFor(fake).chat(request);
    expect(response.model).toEqual(request.model);
    expect(response.message).toEqual({ role: "assistant", content: "Bonjour" });
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it("returns tool_use blocks as tool calls with parsed arguments", async () => {
    const fake = respondWith(() =>
      messageResponse({
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Paris", units: "c" } },
        ],
      }),
    );
    const response = await providerFor(fake).chat(request);
    expect(response.finishReason).toBe("tool-calls");
    expect(response.message.content).toBe("Let me look.");
    expect(response.message.toolCalls).toEqual([
      { id: "toolu_9", name: "get_weather", arguments: { city: "Paris", units: "c" } },
    ]);
  });

  it("streams text deltas, one tool call and a finish event with usage", async () => {
    const fake = respondWith(() =>
      streamResponse([
        { kind: "text", parts: ["Hel", "lo"] },
        { kind: "tool_use", id: "toolu_1", name: "get_weather", argumentFragments: ['{"city":', '"Paris"}'] },
      ]),
    );
    const events = await collect(providerFor(fake).stream(request));
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "tool-call", toolCall: { id: "toolu_1", name: "get_weather", arguments: { city: "Paris" } } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 25, outputTokens: 15 } },
    ]);
    expect(bodyOf(fake)["stream"]).toBe(true);
  });

  it("finishes a plain text stream with the stop reason", async () => {
    const fake = respondWith(() => streamResponse([{ kind: "text", parts: ["done"] }]));
    const events = await collect(providerFor(fake).stream(request));
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "stop", usage: { inputTokens: 25, outputTokens: 15 } });
  });

  it("ignores a thinking block in a response", async () => {
    const fake = respondWith(() =>
      messageResponse({
        content: [
          { type: "thinking", thinking: `private reasoning ${MARKER}`, signature: "sig-test" },
          { type: "text", text: "The answer." },
        ],
      }),
    );
    const response = await providerFor(fake).chat(request);
    expect(response.message.content).toBe("The answer.");
    expect(JSON.stringify(response)).not.toContain(MARKER);
  });

  it("ignores a thinking block in a stream", async () => {
    const fake = respondWith(() =>
      streamResponse([
        { kind: "thinking", parts: [`private reasoning ${MARKER}`] },
        { kind: "text", parts: ["The answer."] },
      ]),
    );
    const events = await collect(providerFor(fake).stream(request));
    expect(events.map((event) => event.type)).toEqual(["text-delta", "finish"]);
    expect(events[0]).toEqual({ type: "text-delta", text: "The answer." });
    expect(JSON.stringify(events)).not.toContain(MARKER);
  });

  it("reports the default capabilities", () => {
    const provider: ModelProvider = providerFor(respondWith(() => textMessage("hi")));
    expect(provider.capabilities("claude-opus-5-5")).toEqual({
      streaming: true,
      tools: true,
      vision: false,
      structuredOutput: true,
    });
  });
});

describe("AnthropicProvider errors", () => {
  it.each([
    [401, "authentication_error", "auth"],
    [429, "rate_limit_error", "rate_limit"],
    [529, "overloaded_error", "unavailable"],
    [400, "invalid_request_error", "bad_request"],
  ] as const)("maps HTTP %i (%s) to %s", async (status, type, code) => {
    const fake = respondWith(() => errorResponse(status, type));
    const provider = providerFor(fake);

    const error = await caught(provider.chat(request));
    expect(error.code).toBe(code);
    expect(error.provider).toBe("anthropic");

    // Streaming does not throw: it ends with one error event.
    const events = await collect(provider.stream(request));
    expect(streamError(events).code).toBe(code);
  });

  it("never puts the key in an error message, even when the server echoes it", async () => {
    const fake = respondWith(() => errorResponse(401, "authentication_error", `invalid x-api-key: ${SECRET}`));
    const provider = providerFor(fake);

    const error = await caught(provider.chat(request));
    expect(error.code).toBe("auth");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);

    const streamed = streamError(await collect(provider.stream(request)));
    expect(streamed.message).toContain("[redacted]");
    expect(JSON.stringify(streamed)).not.toContain(SECRET);

    const listing = await caught(provider.listModels());
    expect(listing.code).toBe("auth");
    expect(listing.message).toContain("[redacted]");
    expect(listing.message).not.toContain(SECRET);
  });

  it("never puts a custom header value in an error message either", async () => {
    const fake = respondWith(() => errorResponse(400, "invalid_request_error", `bad header ${HEADER_SECRET}`));
    const provider = providerFor(fake, { credentials: { apiKey: SECRET, headers: { "x-team": HEADER_SECRET } } });
    const error = await caught(provider.chat(request));
    expect(error.code).toBe("bad_request");
    expect(error.message).not.toContain(HEADER_SECRET);
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    ["no saved sign-in", null, ANTHROPIC_PRESET],
    ["no key and a preset that does not require one", {}, { ...ANTHROPIC_PRESET, requiresKey: false }],
    ["no saved sign-in and a preset that does not require a key", null, { ...ANTHROPIC_PRESET, requiresKey: false }],
  ] as const)("asks for a key, and sends nothing, with %s", async (_name, credentials, preset) => {
    const fake = respondWith(() => textMessage("hi"));
    const provider = providerFor(fake, { credentials, preset });

    const error = await caught(provider.chat(request));
    expect(error.code).toBe("auth");
    expect(error.message).toBe("anthropic: no API key configured");

    const streamed = streamError(await collect(provider.stream(request)));
    expect(streamed.code).toBe("auth");
    expect(streamed.message).toBe("anthropic: no API key configured");

    const listing = await caught(provider.listModels());
    expect(listing.code).toBe("auth");
    expect(listing.message).toBe("anthropic: no API key configured");

    expect(fake.requests).toHaveLength(0);
  });

  it("asks for a region, and sends nothing, when the AWS credentials have none", async () => {
    const fake = respondWith(() => textMessage("hi"));
    const provider = awsProviderFor(fake, { apiKey: SECRET, workspaceId: "wrkspc_01" });
    const aws = { ...request, model: { provider: "anthropic-aws", model: "claude-opus-5-5" } };

    const error = await caught(provider.chat(aws));
    expect(error.code).toBe("auth");
    expect(error.message).toBe("anthropic-aws: no region configured");
    expect(streamError(await collect(provider.stream(aws))).message).toBe("anthropic-aws: no region configured");
    expect((await caught(provider.listModels())).message).toBe("anthropic-aws: no region configured");
    expect(fake.requests).toHaveLength(0);
  });

  it("asks for a workspace ID, and sends nothing, when the AWS credentials have none", async () => {
    const fake = respondWith(() => textMessage("hi"));
    const provider = awsProviderFor(fake, { apiKey: SECRET, region: "us-west-2" });
    const aws = { ...request, model: { provider: "anthropic-aws", model: "claude-opus-5-5" } };

    const error = await caught(provider.chat(aws));
    expect(error.code).toBe("auth");
    expect(error.message).toBe("anthropic-aws: no workspace ID configured");
    expect(streamError(await collect(provider.stream(aws))).message).toBe("anthropic-aws: no workspace ID configured");
    expect((await caught(provider.listModels())).message).toBe("anthropic-aws: no workspace ID configured");
    expect(fake.requests).toHaveLength(0);
  });

  it("does not fill a region into an explicit credentials.baseURL", async () => {
    const fake = respondWith(() => textMessage("hi"));
    const provider = awsProviderFor(fake, {
      apiKey: SECRET,
      workspaceId: "wrkspc_01",
      baseURL: "https://proxy.example.com/v1",
    });
    await provider.chat({ ...request, model: { provider: "anthropic-aws", model: "claude-opus-5-5" } });
    expect(fake.requests[0]?.url).toBe("https://proxy.example.com/v1/messages");
  });
});

describe("AnthropicProvider.listModels", () => {
  it("follows has_more with after_id and returns the sorted, unique union", async () => {
    const fake = fakeFetch((sent) =>
      sent.url.includes("after_id=")
        ? modelsResponse({ ids: ["claude-haiku-4-5", "b"], hasMore: false })
        : modelsResponse({ ids: ["claude-sonnet-4-5", "b"], hasMore: true, lastId: "b" }),
    );
    const ids = await providerFor(fake).listModels();

    expect(ids).toEqual(["b", "claude-haiku-4-5", "claude-sonnet-4-5"]);
    expect(fake.requests.map((sent) => sent.url)).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=b",
    ]);
    for (const sent of fake.requests) {
      expect(sent.method).toBe("GET");
      expect(sent.headers.get("x-api-key")).toBe(SECRET);
      expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(sent.headers.has("anthropic-workspace-id")).toBe(false);
      expect(sent.headers.has("authorization")).toBe(false);
    }
  });

  it("sends the workspace id and fills the region for Claude Platform on AWS", async () => {
    const fake = respondWith(() => modelsResponse({ ids: ["claude-opus-5-5"], hasMore: false }));
    const ids = await awsProviderFor(fake).listModels();

    expect(ids).toEqual(["claude-opus-5-5"]);
    const [sent] = fake.requests;
    expect(sent?.url).toBe("https://aws-external-anthropic.us-west-2.api.aws/v1/models?limit=1000");
    expect(sent?.headers.get("x-api-key")).toBe(SECRET);
    expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent?.headers.get("anthropic-workspace-id")).toBe("wrkspc_01");
  });

  it("sends the credentials' own headers too", async () => {
    const fake = respondWith(() => modelsResponse({ ids: ["claude-opus-5-5"], hasMore: false }));
    await providerFor(fake, { credentials: { apiKey: SECRET, headers: { "x-team": HEADER_SECRET } } }).listModels();
    expect(fake.requests[0]?.headers.get("x-team")).toBe(HEADER_SECRET);
  });

  it("stops after 10 pages even when has_more stays true, and returns what it collected", async () => {
    let page = 0;
    const fake = fakeFetch(() => {
      page += 1;
      return modelsResponse({ ids: [`claude-page-${String(page).padStart(2, "0")}`], hasMore: true });
    });
    const ids = await providerFor(fake).listModels();

    expect(fake.requests).toHaveLength(10);
    expect(ids).toEqual(Array.from({ length: 10 }, (_, index) => `claude-page-${String(index + 1).padStart(2, "0")}`));
    expect(fake.requests[9]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000&after_id=claude-page-09");
  });

  it("returns an empty list for an empty page", async () => {
    const fake = respondWith(() => jsonResponse({ data: [], has_more: false, first_id: null, last_id: null }));
    expect(await providerFor(fake).listModels()).toEqual([]);
  });

  it.each([
    ["a body without data", () => jsonResponse({ models: [] })],
    ["data that is not a list", () => jsonResponse({ data: "claude-opus-5-5", has_more: false })],
    ["an id that is not a string", () => jsonResponse({ data: [{ id: 7 }], has_more: false })],
    ["an empty id", () => jsonResponse({ data: [{ id: "" }], has_more: false })],
    ["an item without an id", () => jsonResponse({ data: [{ name: "claude-opus-5-5" }], has_more: false })],
    ["a body that is not JSON", () => new Response("<html>gateway</html>", { status: 200 })],
  ] as const)("rejects %s as an unexpected response", async (_name, make) => {
    const error = await caught(providerFor(respondWith(make)).listModels());
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("anthropic: unexpected response to the model listing");
  });

  it.each([
    [401, "authentication_error", "auth"],
    [429, "rate_limit_error", "rate_limit"],
    [529, "overloaded_error", "unavailable"],
  ] as const)("maps HTTP %i (%s) to %s", async (status, type, code) => {
    const error = await caught(providerFor(respondWith(() => errorResponse(status, type))).listModels());
    expect(error.code).toBe(code);
  });
});

describe("AnthropicProvider structured output", () => {
  const schema = outputSchemaFrom(z.object({ a: z.number(), b: z.string().optional() }));
  const structured: ChatRequest = { ...request, outputSchema: schema };

  it("reports structuredOutput capability", () => {
    const provider = providerFor(respondWith(() => textMessage("{}")));
    expect(provider.capabilities("claude-opus-5-5").structuredOutput).toBe(true);
  });

  it("returns the parsed object in output and keeps the text", async () => {
    const fake = respondWith(() => textMessage('{"a":1,"b":"x"}'));
    const response = await providerFor(fake).chat(structured);
    expect(response.output).toEqual({ a: 1, b: "x" });
    expect(response.message.content).toBe('{"a":1,"b":"x"}');
  });

  it("accepts a reply wrapped in a ```json fence", async () => {
    const fake = respondWith(() => textMessage('```json\n{"a":3}\n```'));
    const response = await providerFor(fake).chat(structured);
    expect(response.output).toEqual({ a: 3 });
  });

  it("has no output key when no outputSchema was sent", async () => {
    const fake = respondWith(() => textMessage('{"a":1}'));
    const response = await providerFor(fake).chat(request);
    expect("output" in response).toBe(false);
  });

  it("rejects a mismatching reply with code unknown, without repeating the reply or the key", async () => {
    const fake = respondWith(() => textMessage(`{"a":"${MARKER}"}`));
    const error = await caught(providerFor(fake).chat(structured));
    expect(error.code).toBe("unknown");
    expect(error.message.startsWith("structured output does not match outputSchema:")).toBe(true);
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain(SECRET);
  });

  it("rejects a reply that is not JSON with code unknown, without repeating the reply or the key", async () => {
    const fake = respondWith(() => textMessage(`oops ${MARKER}`));
    const error = await caught(providerFor(fake).chat(structured));
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("structured output is not valid JSON");
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain(SECRET);
  });

  it("rejects streaming with one bad_request error event and makes no fetch call", async () => {
    const fake = respondWith(() => streamResponse([{ kind: "text", parts: ['{"a":1}'] }]));
    const events = await collect(providerFor(fake).stream(structured));

    expect(events).toHaveLength(1);
    const [event] = events;
    if (event?.type !== "error") throw new Error(`expected an error event, got ${event?.type}`);
    expect(event.error.code).toBe("bad_request");
    expect(event.error.message).toBe("outputSchema is not supported when streaming");
    expect(fake.requests).toHaveLength(0);
  });
});
