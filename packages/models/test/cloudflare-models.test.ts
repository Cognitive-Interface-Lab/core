import { describe, expect, it } from "vitest";
import { CoreError, type ChatRequest } from "@core/contracts";
import {
  EnvCredentialStore,
  MemoryCredentialStore,
  ModelRouter,
  MockProvider,
  OpenAICompatibleProvider,
  PRESETS,
  ProviderRegistry,
  type Credentials,
} from "../src/index.js";
import { completionResponse, fakeFetch, hangingFetch, type FakeFetch } from "./fixtures/openai-responses.js";

const KEY = "cf-secret-token-789";
const ACCOUNT = "0123456789abcdef";
const CF_BASE = "https://api.cloudflare.com/client/v4/accounts";

const request: ChatRequest = {
  model: { provider: "cloudflare", model: "@cf/meta/llama-3.1-8b-instruct" },
  messages: [{ role: "user", content: "hi" }],
};

function providerFor(id: string, fake: FakeFetch, credentials: Credentials | null) {
  return new OpenAICompatibleProvider({
    id,
    ...(PRESETS[id] ? { preset: PRESETS[id] } : {}),
    credentials: new MemoryCredentialStore(credentials ? { [id]: credentials } : {}),
    fetch: fake.fetch,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

describe("cloudflare preset", () => {
  it("defines the Cloudflare Workers AI server", () => {
    expect(PRESETS["cloudflare"]).toEqual({
      baseURL: `${CF_BASE}/{accountId}/ai/v1`,
      requiresKey: true,
      models: "cloudflare",
    });
  });
});

describe("Cloudflare chat", () => {
  it("puts the account id in the URL", async () => {
    const fake = fakeFetch(() => completionResponse());
    await providerFor("cloudflare", fake, { apiKey: KEY, accountId: ACCOUNT }).chat(request);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe(`${CF_BASE}/${ACCOUNT}/ai/v1/chat/completions`);
    expect(fake.requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("URL-encodes the account id", async () => {
    const fake = fakeFetch(() => completionResponse());
    await providerFor("cloudflare", fake, { apiKey: KEY, accountId: "a/b c?d" }).chat(request);
    expect(fake.requests[0]?.url).toBe(`${CF_BASE}/a%2Fb%20c%3Fd/ai/v1/chat/completions`);
  });

  it("fails with auth when no account id is configured", async () => {
    const fake = fakeFetch(() => completionResponse());
    const error = await caught(providerFor("cloudflare", fake, { apiKey: KEY }).chat(request));
    expect(error.code).toBe("auth");
    expect(error.message).toContain("no account ID configured");
    expect(error.message).not.toContain(KEY);
    expect(fake.requests).toHaveLength(0);
  });

  it("lets the router fall back past a missing account id", async () => {
    const fake = fakeFetch(() => completionResponse());
    const registry = new ProviderRegistry();
    registry.register(providerFor("cloudflare", fake, { apiKey: KEY }));
    registry.register(new MockProvider({ id: "mock", script: [{ text: "from mock" }] }));
    const response = await new ModelRouter(registry).chat(
      { messages: request.messages },
      [{ model: request.model }, { model: { provider: "mock", model: "echo" } }],
    );
    expect(response.message.content).toBe("from mock");
    expect(response.attempts.map((attempt) => [attempt.model.provider, attempt.ok])).toEqual([
      ["cloudflare", false],
      ["mock", true],
    ]);
    expect(response.attempts[0]?.error?.code).toBe("auth");
    expect(fake.requests).toHaveLength(0);
  });

  it("lets an explicit base URL override the placeholder", async () => {
    const fake = fakeFetch(() => completionResponse());
    await providerFor("cloudflare", fake, { apiKey: KEY, baseURL: "https://gateway.example.com/v1" }).chat(request);
    expect(fake.requests[0]?.url).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("does not need an account id when an explicit base URL is given", async () => {
    const fake = fakeFetch(() => completionResponse());
    const provider = providerFor("cloudflare", fake, {
      apiKey: KEY,
      accountId: ACCOUNT,
      baseURL: "https://gateway.example.com/v1",
    });
    await provider.chat(request);
    expect(fake.requests[0]?.url).toBe("https://gateway.example.com/v1/chat/completions");
  });
});

describe("EnvCredentialStore account id", () => {
  it("reads CORE_CLOUDFLARE_ACCOUNT_ID", async () => {
    const store = new EnvCredentialStore({ CORE_CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CORE_CLOUDFLARE_API_KEY: KEY });
    expect(await store.get("cloudflare")).toEqual({ apiKey: KEY, accountId: ACCOUNT });
  });

  it("returns an account id on its own", async () => {
    const store = new EnvCredentialStore({ CORE_CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(await store.get("cloudflare")).toEqual({ accountId: ACCOUNT });
  });

  it("treats an empty account id as unset", async () => {
    const store = new EnvCredentialStore({ CORE_CLOUDFLARE_ACCOUNT_ID: "" });
    expect(await store.get("cloudflare")).toBeUndefined();
  });

  it("is unaffected for providers without an account id", async () => {
    const store = new EnvCredentialStore({ CORE_OPENAI_API_KEY: KEY });
    expect(await store.get("openai")).toEqual({ apiKey: KEY });
  });
});

describe("MemoryCredentialStore account id", () => {
  it("round-trips the account id as a copy", async () => {
    const store = new MemoryCredentialStore({ cloudflare: { apiKey: KEY, accountId: ACCOUNT } });
    expect(await store.get("cloudflare")).toEqual({ apiKey: KEY, accountId: ACCOUNT });
  });
});

describe("listModels, OpenAI shape", () => {
  it("returns sorted, unique ids and sends the Bearer key", async () => {
    const fake = fakeFetch(() => json({ object: "list", data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: "c" }] }));
    const models = await providerFor("openrouter", fake, { apiKey: KEY }).listModels?.();
    expect(models).toEqual(["a", "b", "c"]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(fake.requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("needs no key for Ollama and sends no Authorization header", async () => {
    const fake = fakeFetch(() => json({ data: [{ id: "llama3.1" }, { id: "llama3.2:3b" }] }));
    const models = await providerFor("ollama", fake, null).listModels?.();
    expect(models).toEqual(["llama3.1", "llama3.2:3b"]);
    expect(fake.requests[0]?.url).toBe("http://127.0.0.1:11434/v1/models");
    expect(fake.requests[0]?.headers.has("authorization")).toBe(false);
  });

  it("sends no Authorization header when there is no key", async () => {
    const fake = fakeFetch(() => json({ data: [] }));
    const provider = providerFor("local", fake, { baseURL: "http://localhost:9999/v1" });
    expect(await provider.listModels?.()).toEqual([]);
    expect(fake.requests[0]?.headers.has("authorization")).toBe(false);
  });

  it("fails with auth, without calling the server, when a hosted provider has no key", async () => {
    const fake = fakeFetch(() => json({ data: [] }));
    const error = await caught(providerFor("openai", fake, null).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe("auth");
    expect(fake.requests).toHaveLength(0);
  });

  it("honours an explicit base URL", async () => {
    const fake = fakeFetch(() => json({ data: [{ id: "x" }] }));
    await providerFor("openai", fake, { apiKey: KEY, baseURL: "https://proxy.example.com/v1/" }).listModels?.();
    expect(fake.requests[0]?.url).toBe("https://proxy.example.com/v1/models");
  });
});

describe("listModels, Cloudflare shape", () => {
  const page = (prefix: string, count: number) => ({
    success: true,
    result: Array.from({ length: count }, (_, index) => ({ name: `${prefix}${String(index).padStart(3, "0")}` })),
  });

  it("asks the model search for text-generation models with the Bearer key", async () => {
    const fake = fakeFetch(() => json({ result: [{ name: "@cf/b" }, { name: "@cf/a" }] }));
    const models = await providerFor("cloudflare", fake, { apiKey: KEY, accountId: ACCOUNT }).listModels?.();
    expect(models).toEqual(["@cf/a", "@cf/b"]);
    expect(fake.requests).toHaveLength(1);
    const url = new URL(fake.requests[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${CF_BASE}/${ACCOUNT}/ai/models/search`);
    expect(fake.requests[0]?.url).toContain("task=Text%20Generation");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("page")).toBe("1");
    expect(fake.requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("follows pages until a short page", async () => {
    const fake = fakeFetch((req) => {
      const number = Number(new URL(req.url).searchParams.get("page"));
      return json(number < 3 ? page(`p${number}-`, 100) : page("p3-", 7));
    });
    const models = await providerFor("cloudflare", fake, { apiKey: KEY, accountId: ACCOUNT }).listModels?.();
    expect(models).toHaveLength(207);
    expect(fake.requests.map((req) => new URL(req.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("stops after one page when the first page is empty", async () => {
    const fake = fakeFetch(() => json({ result: [] }));
    expect(await providerFor("cloudflare", fake, { apiKey: KEY, accountId: ACCOUNT }).listModels?.()).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it("reads at most ten pages", async () => {
    const fake = fakeFetch((req) => json(page(`p${new URL(req.url).searchParams.get("page")}-`, 100)));
    const models = await providerFor("cloudflare", fake, { apiKey: KEY, accountId: ACCOUNT }).listModels?.();
    expect(fake.requests).toHaveLength(10);
    expect(models).toHaveLength(1000);
  });

  it("fails with auth when the account id is missing", async () => {
    const fake = fakeFetch(() => json({ result: [] }));
    const error = await caught(providerFor("cloudflare", fake, { apiKey: KEY }).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe("auth");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a base URL that does not end in /ai/v1", async () => {
    const fake = fakeFetch(() => json({ result: [] }));
    const provider = providerFor("cloudflare", fake, { apiKey: KEY, baseURL: "https://gateway.example.com/v1" });
    const error = await caught(provider.listModels?.() ?? Promise.resolve());
    expect(error.code).toBe("bad_request");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("listModels errors", () => {
  const creds = { apiKey: KEY, accountId: ACCOUNT };

  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "rate_limit"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i to %s (OpenAI shape)", async (status, code) => {
    const fake = fakeFetch(() => json({ error: { message: "nope" } }, status));
    const error = await caught(providerFor("openrouter", fake, { apiKey: KEY }).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe(code);
  });

  it.each([
    [401, "auth"],
    [500, "unavailable"],
  ] as const)("maps HTTP %i to %s (Cloudflare shape)", async (status, code) => {
    const fake = fakeFetch(() => json({ success: false, errors: [{ message: "nope" }] }, status));
    const error = await caught(providerFor("cloudflare", fake, creds).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe(code);
  });

  it.each([
    ["a missing data array", { models: [] }],
    ["a non-array data field", { data: "x" }],
    ["an item without an id", { data: [{ name: "a" }] }],
    ["a non-string id", { data: [{ id: 3 }] }],
    ["an empty id", { data: [{ id: "" }] }],
    ["a body that is not an object", ["a"]],
  ])("treats %s as unknown (OpenAI shape)", async (_name, body) => {
    const fake = fakeFetch(() => json(body));
    const error = await caught(providerFor("openrouter", fake, { apiKey: KEY }).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe("unknown");
  });

  it.each([
    ["a missing result array", { data: [] }],
    ["an item without a name", { result: [{ id: "a" }] }],
  ])("treats %s as unknown (Cloudflare shape)", async (_name, body) => {
    const fake = fakeFetch(() => json(body));
    const error = await caught(providerFor("cloudflare", fake, creds).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe("unknown");
  });

  it("treats a body that is not JSON as unknown", async () => {
    const fake = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const error = await caught(providerFor("openrouter", fake, { apiKey: KEY }).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe("unknown");
  });

  it("maps a refused connection to unavailable", async () => {
    const fake = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const error = await caught(providerFor("ollama", fake, null).listModels?.() ?? Promise.resolve());
    expect(error.code).toBe("unavailable");
  });

  it("maps a cancelled request to aborted", async () => {
    const controller = new AbortController();
    const pending = providerFor("ollama", hangingFetch(), null).listModels?.({ signal: controller.signal });
    controller.abort();
    expect((await caught(pending ?? Promise.resolve())).code).toBe("aborted");
  });

  it("never puts the key in an error message, even when the server echoes it", async () => {
    const statuses = [401, 500, 429];
    for (const status of statuses) {
      const fake = fakeFetch(() => new Response(`bad key ${KEY} for account`, { status }));
      const error = await caught(providerFor("openrouter", fake, { apiKey: KEY }).listModels?.() ?? Promise.resolve());
      expect(error.message).not.toContain(KEY);
      expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
    }
    const malformed = fakeFetch(() => json({ echo: KEY }));
    const error = await caught(providerFor("openrouter", malformed, { apiKey: KEY }).listModels?.() ?? Promise.resolve());
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
  });
});
