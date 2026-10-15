import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CoreError, type ChatRequest, type ChatResponse, type StreamEvent } from "@core/contracts";
import {
  MemoryCredentialStore,
  MockProvider,
  ModelRouter,
  OpenAICompatibleProvider,
  PRESETS,
  ProviderRegistry,
  outputSchemaFrom,
  type ModelProvider,
} from "../src/index.js";
import { completionResponse, respondWith, type FakeFetch } from "./fixtures/openai-responses.js";

const SECRET = "sk-test-secret-key-123";
const MARKER = "LEAKMARKER-zx81";

const schema = outputSchemaFrom(z.object({ a: z.number(), b: z.string().optional() }));

const mockModel = { provider: "mock", model: "echo" };
const openaiModel = { provider: "openai", model: "gpt-test" };

const plain: ChatRequest = { model: mockModel, messages: [{ role: "user", content: "hi" }] };
const structured: ChatRequest = { ...plain, outputSchema: schema };

function providerFor(fake: FakeFetch): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "openai",
    preset: PRESETS["openai"],
    credentials: new MemoryCredentialStore({ openai: { apiKey: SECRET } }),
    fetch: fake.fetch,
  });
}

const openaiRequest: ChatRequest = { ...structured, model: openaiModel };

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

function expectStreamingRejected(events: StreamEvent[]): void {
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event?.type !== "error") throw new Error(`expected an error event, got ${event?.type}`);
  expect(event.error.code).toBe("bad_request");
  expect(event.error.message).toBe("outputSchema is not supported when streaming");
}

/** A provider that lacks structured output and counts how often it is asked to chat. */
function incapableProvider(id: string, reply: string): ModelProvider & { chats: number } {
  const delegate = new MockProvider({ script: [{ text: reply }] });
  const provider = {
    id,
    chats: 0,
    capabilities: () => ({ streaming: true, tools: true, vision: false }),
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      provider.chats += 1;
      return delegate.chat(req);
    },
    stream: async function* (): AsyncGenerator<StreamEvent> {},
  };
  return provider;
}

function routerFor(...providers: ModelProvider[]): ModelRouter {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return new ModelRouter(registry);
}

describe("structured output on MockProvider", () => {
  it("reports structuredOutput capability", () => {
    expect(new MockProvider().capabilities("echo").structuredOutput).toBe(true);
  });

  it("returns the validated parsed value in output and keeps the text", async () => {
    const provider = new MockProvider({ script: [{ text: '{"a":1}' }] });
    const response = await provider.chat(structured);
    expect(response.output).toEqual({ a: 1 });
    expect(response.message.content).toBe('{"a":1}');
  });

  it("has no output key when no outputSchema was sent", async () => {
    const provider = new MockProvider({ script: [{ text: '{"a":1}' }] });
    const response = await provider.chat(plain);
    expect("output" in response).toBe(false);
  });

  it("accepts a reply wrapped in a ```json fence", async () => {
    const provider = new MockProvider({ script: [{ text: '```json\n{"a":2,"b":"x"}\n```' }] });
    const response = await provider.chat(structured);
    expect(response.output).toEqual({ a: 2, b: "x" });
  });

  it("rejects a reply that does not match the schema with code unknown", async () => {
    const provider = new MockProvider({ script: [{ text: `{"a":"${MARKER}"}` }] });
    const error = await caught(provider.chat(structured));
    expect(error.code).toBe("unknown");
    expect(error.message.startsWith("structured output does not match outputSchema:")).toBe(true);
    expect(error.message).not.toContain(MARKER);
  });

  it("rejects a reply that is not JSON with code unknown and does not leak it", async () => {
    const provider = new MockProvider({ script: [{ text: `not json ${MARKER}` }] });
    const error = await caught(provider.chat(structured));
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("structured output is not valid JSON");
    expect(error.message).not.toContain(MARKER);
  });

  it("records the outputSchema it was sent in calls", async () => {
    const provider = new MockProvider({ script: [{ text: '{"a":1}' }] });
    await provider.chat(structured);
    expect(provider.calls[0]?.outputSchema).toEqual(schema);
  });
});

describe("structured output on OpenAICompatibleProvider", () => {
  it("reports structuredOutput capability", () => {
    const provider = providerFor(respondWith(() => completionResponse({ content: "{}" })));
    expect(provider.capabilities("gpt-test").structuredOutput).toBe(true);
  });

  it("returns output for a valid JSON reply and keeps the text", async () => {
    const fake = respondWith(() => completionResponse({ content: '{"a":1,"b":"x"}' }));
    const response = await providerFor(fake).chat(openaiRequest);
    expect(response.output).toEqual({ a: 1, b: "x" });
    expect(response.message.content).toBe('{"a":1,"b":"x"}');
  });

  it("returns output for a reply wrapped in a ```json fence", async () => {
    const fake = respondWith(() => completionResponse({ content: '```json\n{"a":3}\n```' }));
    const response = await providerFor(fake).chat(openaiRequest);
    expect(response.output).toEqual({ a: 3 });
  });

  it("has no output key when no outputSchema was sent", async () => {
    const fake = respondWith(() => completionResponse({ content: '{"a":1}' }));
    const response = await providerFor(fake).chat({ ...plain, model: openaiModel });
    expect("output" in response).toBe(false);
  });

  it("sends the outputSchema to the endpoint as a json_schema response_format", async () => {
    const fake = respondWith(() => completionResponse({ content: '{"a":1}' }));
    await providerFor(fake).chat(openaiRequest);
    expect(fake.requests).toHaveLength(1);
    const format = fake.requests[0]?.body?.["response_format"] as
      | { type: string; json_schema: { schema: unknown } }
      | undefined;
    expect(format?.type).toBe("json_schema");
    expect(format?.json_schema.schema).toEqual(schema);
  });

  it("rejects an invalid JSON reply with code unknown without leaking the reply or key", async () => {
    const fake = respondWith(() => completionResponse({ content: `oops ${MARKER}` }));
    const error = await caught(providerFor(fake).chat(openaiRequest));
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("structured output is not valid JSON");
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain(SECRET);
  });

  it("rejects a mismatching reply with code unknown without leaking the reply or key", async () => {
    const fake = respondWith(() => completionResponse({ content: `{"a":"${MARKER}"}` }));
    const error = await caught(providerFor(fake).chat(openaiRequest));
    expect(error.code).toBe("unknown");
    expect(error.message.startsWith("structured output does not match outputSchema:")).toBe(true);
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain(SECRET);
  });
});

describe("streaming rejects outputSchema", () => {
  it("MockProvider yields one bad_request error event and consumes no scripted turn", async () => {
    const provider = new MockProvider({ script: [{ text: '{"a":1}' }] });
    expectStreamingRejected(await collect(provider.stream(structured)));
    const response = await provider.chat(structured);
    expect(response.output).toEqual({ a: 1 });
  });

  it("OpenAICompatibleProvider yields one bad_request error event and makes no fetch call", async () => {
    const fake = respondWith(() => completionResponse({ content: '{"a":1}' }));
    expectStreamingRejected(await collect(providerFor(fake).stream(openaiRequest)));
    expect(fake.requests.length).toBe(0);
  });

  it("ModelRouter yields one bad_request error event and no route event", async () => {
    const provider = new MockProvider({ script: [{ text: '{"a":1}' }] });
    const router = routerFor(provider);
    const events = await collect(
      router.stream({ messages: plain.messages, outputSchema: schema }, [{ model: mockModel }]),
    );
    expectStreamingRejected(events);
    expect(events.some((event) => event.type === "route")).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("ModelRouter with outputSchema", () => {
  it("skips a step whose provider lacks structuredOutput without calling it", async () => {
    const incapable = incapableProvider("old", '{"a":9}');
    const capable = new MockProvider({ script: [{ text: '{"a":1}' }] });
    const router = routerFor(incapable, capable);

    const response = await router.chat({ messages: plain.messages, outputSchema: schema }, [
      { model: { provider: "old", model: "m" } },
      { model: mockModel },
    ]);

    expect(incapable.chats).toBe(0);
    expect(response.output).toEqual({ a: 1 });
    expect(response.attempts).toHaveLength(2);
    const [skipped, answered] = response.attempts;
    expect(skipped?.ok).toBe(false);
    expect(skipped?.error?.code).toBe("bad_request");
    expect(skipped?.error?.message).toContain("structured output is not supported");
    expect(answered?.ok).toBe(true);
  });

  it("rejects with bad_request when no step supports structured output", async () => {
    const first = incapableProvider("old1", '{"a":9}');
    const second = incapableProvider("old2", '{"a":9}');
    const router = routerFor(first, second);

    const error = await caught(
      router.chat({ messages: plain.messages, outputSchema: schema }, [
        { model: { provider: "old1", model: "m" } },
        { model: { provider: "old2", model: "m" } },
      ]),
    );

    expect(error.code).toBe("bad_request");
    expect(error.message).toBe("no route supports structured output");
    expect(first.chats + second.chats).toBe(0);
  });

  it("still calls an incapable provider normally when no outputSchema is sent", async () => {
    const incapable = incapableProvider("old", "plain reply");
    const router = routerFor(incapable);

    const response = await router.chat({ messages: plain.messages }, [
      { model: { provider: "old", model: "m" } },
    ]);

    expect(incapable.chats).toBe(1);
    expect(response.message.content).toBe("plain reply");
    expect(response.attempts).toHaveLength(1);
    expect(response.attempts[0]?.ok).toBe(true);
  });
});
