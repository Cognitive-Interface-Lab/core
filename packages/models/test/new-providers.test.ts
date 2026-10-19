import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CoreError, type ChatRequest, type StreamEvent } from "@core/contracts";
import {
  AzureOpenAIProvider,
  GoogleProvider,
  MemoryCredentialStore,
  OpenAICompatibleProvider,
  PRESETS,
  createPresetRegistry,
  outputSchemaFrom,
  presetProvider,
  type Credentials,
} from "../src/index.js";
import {
  completionResponse,
  fakeFetch,
  jsonResponse,
  respondWith,
  type FakeFetch,
  type RecordedRequest,
} from "./fixtures/openai-responses.js";

const GOOGLE_KEY = "g-key-12345678";
const AZURE_KEY = "az-key-12345678";
const AZURE_BASE_URL = "https://my-res.openai.azure.com/openai";
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const LOCAL_BASE_URL = "http://localhost:1234/v1";
const MARKER = "LEAKMARKER-zx81";

// Values the environment holds while a test runs; none of them may ever reach a request.
const ENV = {
  GOOGLE_GENERATIVE_AI_API_KEY: "env-google-key-99999999",
  AZURE_API_KEY: "env-azure-key-88888888",
  AZURE_RESOURCE_NAME: "env-resource-name",
} as const;
const ENV_NAMES = Object.keys(ENV) as (keyof typeof ENV)[];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = ENV[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const previous = savedEnv.get(name);
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  }
  savedEnv.clear();
});

function chatRequest(provider: string, model: string): ChatRequest {
  return { model: { provider, model }, messages: [{ role: "user", content: "hi" }] };
}

const localRequest = chatRequest("openai-compatible", "local-model");
const googleRequest = chatRequest("google", "gemini-test");
const azureRequest = chatRequest("azure", "my-deployment");

function providerFor(id: string, credentials: Credentials | null, fake: FakeFetch) {
  return presetProvider(id, new MemoryCredentialStore(credentials ? { [id]: credentials } : {}), {
    fetch: fake.fetch,
  });
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

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const all: StreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

/** The one request a fake recorded; fails when it recorded none or several. */
function onlyRequest(fake: FakeFetch): RecordedRequest {
  expect(fake.requests).toHaveLength(1);
  const [sent] = fake.requests;
  if (!sent) throw new Error("no request was recorded");
  return sent;
}

function headerValues(sent: RecordedRequest): string[] {
  const values: string[] = [];
  sent.headers.forEach((value) => values.push(value));
  return values;
}

/** The request's URL without its query string. */
function urlWithoutQuery(sent: RecordedRequest): string {
  const url = new URL(sent.url);
  return `${url.origin}${url.pathname}`;
}

/** A Gemini `generateContent` reply with one text part. */
function geminiBody(text: string, finishReason?: string): Record<string, unknown> {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  };
}

function geminiResponse(text: string): Response {
  return jsonResponse(geminiBody(text, "STOP"));
}

/** A Gemini `streamGenerateContent` reply: one SSE chunk per text part, the last one finishing. */
function geminiStreamResponse(parts: string[]): Response {
  const body = parts
    .map((part, index) => `data: ${JSON.stringify(geminiBody(part, index === parts.length - 1 ? "STOP" : undefined))}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

type ModelEntry = { name: string; supportedGenerationMethods: string[] };

function modelEntry(name: string, methods: string[] = ["generateContent", "countTokens"]): ModelEntry {
  return { name, supportedGenerationMethods: methods };
}

describe("the new presets", () => {
  it("openai-compatible takes its address from the credentials and needs no key", () => {
    expect(PRESETS["openai-compatible"]).toEqual({ baseURL: "", requiresKey: false, requiresBaseURL: true });
  });

  it("google points at the Generative Language API and needs a key", () => {
    expect(PRESETS["google"]).toEqual({
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      requiresKey: true,
      api: "google",
    });
  });

  it("azure takes its address from the credentials and needs a key", () => {
    expect(PRESETS["azure"]).toEqual({ baseURL: "", requiresKey: true, requiresBaseURL: true, api: "azure" });
  });
});

describe("openai-compatible", () => {
  const noBaseURL: [string, Credentials | null][] = [
    ["no credential at all", null],
    ["a credential with only a key", { apiKey: "some-key-12345678" }],
  ];

  it.each(noBaseURL)("chat rejects auth when there is a base URL nowhere: %s", async (_label, credentials) => {
    const fake = respondWith(() => completionResponse());
    const error = await caught(providerFor("openai-compatible", credentials, fake).chat(localRequest));
    expect(error.code).toBe("auth");
    expect(error.message).toBe("openai-compatible needs a base URL");
    expect(error.provider).toBe("openai-compatible");
    expect(fake.requests).toHaveLength(0);
  });

  it.each(noBaseURL)("listModels rejects auth when there is a base URL nowhere: %s", async (_label, credentials) => {
    const fake = respondWith(() => jsonResponse({ object: "list", data: [{ id: "m" }] }));
    const error = await caught(providerFor("openai-compatible", credentials, fake).listModels());
    expect(error.code).toBe("auth");
    expect(error.message).toBe("openai-compatible needs a base URL");
    expect(error.provider).toBe("openai-compatible");
    expect(fake.requests).toHaveLength(0);
  });

  it("chat posts to the credential's base URL with a bearer key when the credential has one", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor("openai-compatible", { baseURL: LOCAL_BASE_URL, apiKey: "local-key-12345678" }, fake).chat(
      localRequest,
    );
    const sent = onlyRequest(fake);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer local-key-12345678");
    expect(sent.body?.model).toBe("local-model");
  });

  it("chat sends no authorization header when the credential has no key", async () => {
    const fake = respondWith(() => completionResponse());
    const response = await providerFor("openai-compatible", { baseURL: LOCAL_BASE_URL }, fake).chat(localRequest);
    const sent = onlyRequest(fake);
    expect(sent.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(sent.headers.has("authorization")).toBe(false);
    expect(response.message.content).toBe("Hello from the fake model");
  });

  it("listModels GETs /models under the credential's base URL", async () => {
    const fake = respondWith(() => jsonResponse({ object: "list", data: [{ id: "model-b" }, { id: "model-a" }] }));
    const models = await providerFor("openai-compatible", { baseURL: LOCAL_BASE_URL }, fake).listModels();
    const sent = onlyRequest(fake);
    expect(sent.method).toBe("GET");
    expect(sent.url).toBe("http://localhost:1234/v1/models");
    expect([...models].sort()).toEqual(["model-a", "model-b"]);
  });
});

describe("google", () => {
  const credentials: Credentials = { apiKey: GOOGLE_KEY };

  describe("chat", () => {
    it("posts to :generateContent of the model and returns the reply text", async () => {
      const fake = respondWith(() => geminiResponse("hello"));
      const response = await providerFor("google", credentials, fake).chat(googleRequest);
      const sent = onlyRequest(fake);
      expect(sent.method).toBe("POST");
      expect(urlWithoutQuery(sent)).toBe(`${GOOGLE_BASE}/models/gemini-test:generateContent`);
      expect(response.message.content).toBe("hello");
    });

    it("sends the key in x-goog-api-key and never in the URL", async () => {
      const fake = respondWith(() => geminiResponse("hello"));
      await providerFor("google", credentials, fake).chat(googleRequest);
      const sent = onlyRequest(fake);
      expect(sent.headers.get("x-goog-api-key")).toBe(GOOGLE_KEY);
      expect(sent.url).not.toContain(GOOGLE_KEY);
    });

    it("returns the parsed output for a reply that matches the outputSchema", async () => {
      const outputSchema = outputSchemaFrom(z.object({ a: z.number(), b: z.string().optional() }));
      const fake = respondWith(() => geminiResponse('{"a":1,"b":"x"}'));
      const response = await providerFor("google", credentials, fake).chat({ ...googleRequest, outputSchema });
      expect(response.output).toEqual({ a: 1, b: "x" });
      expect(response.message.content).toBe('{"a":1,"b":"x"}');
    });

    it("rejects a reply that does not match the outputSchema with code unknown and no leak", async () => {
      const outputSchema = outputSchemaFrom(z.object({ a: z.number() }));
      const fake = respondWith(() => geminiResponse(`{"a":"${MARKER}"}`));
      const error = await caught(providerFor("google", credentials, fake).chat({ ...googleRequest, outputSchema }));
      expect(error.code).toBe("unknown");
      expect(error.message.startsWith("structured output does not match outputSchema:")).toBe(true);
      expect(error.message).not.toContain(MARKER);
      expect(error.message).not.toContain(GOOGLE_KEY);
    });
  });

  describe("stream", () => {
    it("posts to :streamGenerateContent of the model with the key in a header only", async () => {
      const fake = respondWith(() => geminiStreamResponse(["hel", "lo"]));
      await collect(providerFor("google", credentials, fake).stream(googleRequest));
      const sent = onlyRequest(fake);
      expect(sent.method).toBe("POST");
      expect(sent.url.startsWith(`${GOOGLE_BASE}/models/gemini-test:streamGenerateContent`)).toBe(true);
      expect(sent.headers.get("x-goog-api-key")).toBe(GOOGLE_KEY);
      expect(sent.url).not.toContain(GOOGLE_KEY);
    });

    it("yields the text and ends with a finish event", async () => {
      const fake = respondWith(() => geminiStreamResponse(["hel", "lo"]));
      const events = await collect(providerFor("google", credentials, fake).stream(googleRequest));
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      const text = events.flatMap((event) => (event.type === "text-delta" ? [event.text] : []));
      expect(text.join("")).toBe("hello");
      expect(events.at(-1)?.type).toBe("finish");
      expect(events.filter((event) => event.type === "finish")).toHaveLength(1);
    });
  });

  describe("listModels", () => {
    it("GETs /models?pageSize=1000 with the key in a header only", async () => {
      const fake = respondWith(() => jsonResponse({ models: [modelEntry("models/gemini-a")] }));
      await providerFor("google", credentials, fake).listModels();
      const sent = onlyRequest(fake);
      const url = new URL(sent.url);
      expect(sent.method).toBe("GET");
      expect(`${url.origin}${url.pathname}`).toBe(`${GOOGLE_BASE}/models`);
      expect(url.searchParams.get("pageSize")).toBe("1000");
      expect(url.searchParams.has("pageToken")).toBe(false);
      expect(sent.headers.get("x-goog-api-key")).toBe(GOOGLE_KEY);
      expect(sent.url).not.toContain(GOOGLE_KEY);
    });

    it("strips the models/ prefix, keeps generateContent models, follows pages, dedupes and sorts", async () => {
      const fake = fakeFetch((request) => {
        const token = new URL(request.url).searchParams.get("pageToken");
        if (token === null) {
          return jsonResponse({
            models: [
              modelEntry("models/gemini-c"),
              modelEntry("models/embedding-only", ["embedContent"]),
              modelEntry("models/gemini-a"),
            ],
            nextPageToken: "t2",
          });
        }
        return jsonResponse({ models: [modelEntry("models/gemini-b"), modelEntry("models/gemini-a")] });
      });
      const models = await providerFor("google", credentials, fake).listModels();

      expect(models).toEqual(["gemini-a", "gemini-b", "gemini-c"]);
      expect(fake.requests).toHaveLength(2);
      const [first, second] = fake.requests.map((sent) => new URL(sent.url));
      expect(first?.searchParams.get("pageToken")).toBeNull();
      expect(second?.searchParams.get("pageSize")).toBe("1000");
      expect(second?.searchParams.get("pageToken")).toBe("t2");
      for (const sent of fake.requests) {
        expect(sent.method).toBe("GET");
        expect(sent.headers.get("x-goog-api-key")).toBe(GOOGLE_KEY);
        expect(sent.url).not.toContain(GOOGLE_KEY);
      }
    });

    it("stops after 10 pages when every page keeps returning a nextPageToken", async () => {
      const fake = fakeFetch((request) => {
        const token = new URL(request.url).searchParams.get("pageToken");
        const page = token === null ? 1 : Number(token.slice(1));
        return jsonResponse({ models: [modelEntry(`models/gemini-${page}`)], nextPageToken: `t${page + 1}` });
      });
      const models = await providerFor("google", credentials, fake).listModels();
      expect(models).toHaveLength(10);
      expect(fake.requests).toHaveLength(10);
      expect(new URL(fake.requests[9]?.url ?? "").searchParams.get("pageToken")).toBe("t10");
    });
  });
});

describe("azure", () => {
  const credentials: Credentials = { apiKey: AZURE_KEY, baseURL: AZURE_BASE_URL };

  it("posts the chat to the v1 chat completions route of the deployment with the api-key header", async () => {
    const fake = respondWith(() => completionResponse());
    const response = await providerFor("azure", credentials, fake).chat(azureRequest);
    const sent = onlyRequest(fake);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://my-res.openai.azure.com/openai/v1/chat/completions?api-version=v1");
    expect(sent.headers.get("api-key")).toBe(AZURE_KEY);
    expect(sent.body?.model).toBe("my-deployment");
    expect(response.message.content).toBe("Hello from the fake model");
  });

  const noBaseURL: [string, Credentials | null][] = [
    ["a credential with only a key", { apiKey: AZURE_KEY }],
    ["no credential at all", null],
  ];

  it.each(noBaseURL)("chat rejects auth without a base URL: %s", async (_label, noBaseCredentials) => {
    const fake = respondWith(() => completionResponse());
    const error = await caught(providerFor("azure", noBaseCredentials, fake).chat(azureRequest));
    expect(error.code).toBe("auth");
    expect(error.message).toBe("azure needs a base URL");
    expect(error.provider).toBe("azure");
    expect(fake.requests).toHaveLength(0);
  });

  const listCredentials: [string, Credentials | null][] = [
    ["a complete credential", credentials],
    ["no credential at all", null],
  ];

  it.each(listCredentials)("listModels rejects bad_request and calls nothing: %s", async (_label, listed) => {
    const fake = respondWith(() => jsonResponse({ data: [] }));
    const error = await caught(providerFor("azure", listed, fake).listModels());
    expect(error.code).toBe("bad_request");
    expect(error.message).toBe(
      "Azure OpenAI cannot list deployments; route to your deployment, as azure:<deployment>",
    );
    expect(error.provider).toBe("azure");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("environment isolation", () => {
  it("google chat without a credential key rejects auth and calls nothing", async () => {
    const fake = respondWith(() => geminiResponse("hello"));
    const error = await caught(providerFor("google", null, fake).chat(googleRequest));
    expect(error.code).toBe("auth");
    expect(fake.requests).toHaveLength(0);
  });

  it("google listModels without a credential key rejects auth and calls nothing", async () => {
    const fake = respondWith(() => jsonResponse({ models: [modelEntry("models/gemini-a")] }));
    const error = await caught(providerFor("google", null, fake).listModels());
    expect(error.code).toBe("auth");
    expect(fake.requests).toHaveLength(0);
  });

  it("azure chat without a credential key rejects auth and calls nothing", async () => {
    const fake = respondWith(() => completionResponse());
    const error = await caught(providerFor("azure", { baseURL: AZURE_BASE_URL }, fake).chat(azureRequest));
    expect(error.code).toBe("auth");
    expect(fake.requests).toHaveLength(0);
  });

  it("google chat sends the credential's key and nothing from the environment", async () => {
    const fake = respondWith(() => geminiResponse("hello"));
    await providerFor("google", { apiKey: GOOGLE_KEY }, fake).chat(googleRequest);
    const sent = onlyRequest(fake);
    expect(sent.headers.get("x-goog-api-key")).toBe(GOOGLE_KEY);
    expect(headerValues(sent).join("\n")).not.toContain(ENV.GOOGLE_GENERATIVE_AI_API_KEY);
    expect(sent.url).not.toContain(ENV.GOOGLE_GENERATIVE_AI_API_KEY);
  });

  it("google listModels sends the credential's key and nothing from the environment", async () => {
    const fake = respondWith(() => jsonResponse({ models: [modelEntry("models/gemini-a")] }));
    await providerFor("google", { apiKey: GOOGLE_KEY }, fake).listModels();
    const sent = onlyRequest(fake);
    expect(sent.headers.get("x-goog-api-key")).toBe(GOOGLE_KEY);
    expect(headerValues(sent).join("\n")).not.toContain(ENV.GOOGLE_GENERATIVE_AI_API_KEY);
    expect(sent.url).not.toContain(ENV.GOOGLE_GENERATIVE_AI_API_KEY);
  });

  it("azure chat sends the credential's key and nothing from the environment", async () => {
    const fake = respondWith(() => completionResponse());
    await providerFor("azure", { apiKey: AZURE_KEY, baseURL: AZURE_BASE_URL }, fake).chat(azureRequest);
    const sent = onlyRequest(fake);
    const everything = [...headerValues(sent), sent.url].join("\n");
    expect(sent.headers.get("api-key")).toBe(AZURE_KEY);
    expect(everything).not.toContain(ENV.AZURE_API_KEY);
    expect(everything).not.toContain(ENV.AZURE_RESOURCE_NAME);
  });
});

describe("createPresetRegistry with the new providers", () => {
  const registry = createPresetRegistry(new MemoryCredentialStore());

  it("lists openai-compatible, google and azure", () => {
    expect(registry.list()).toEqual(expect.arrayContaining(["openai-compatible", "google", "azure"]));
  });

  it("serves openai-compatible with an OpenAICompatibleProvider", () => {
    expect(registry.get("openai-compatible")).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("serves google with a GoogleProvider", () => {
    expect(registry.get("google")).toBeInstanceOf(GoogleProvider);
  });

  it("serves azure with an AzureOpenAIProvider", () => {
    expect(registry.get("azure")).toBeInstanceOf(AzureOpenAIProvider);
  });
});
