import { afterEach, describe, expect, it } from "vitest";
import { CoreError, type ChatRequest } from "@core/contracts";
import { AnthropicProvider, OpenAICompatibleProvider, PRESETS } from "@core/models";
import { cleanupFakeIo, fakeIo } from "./fake-io.js";
import { envSource, makeProvider, openGateway } from "../src/setup.js";

afterEach(cleanupFakeIo);

type Call = { url: string; method: string; headers: Headers; body: string | undefined };

function recordingFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return answer(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const completion = (content = "hello") =>
  json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const request = (provider: string, model: string): Omit<ChatRequest, "model"> & { route: [{ model: { provider: string; model: string } }] } => ({
  messages: [{ role: "user", content: "hi" }],
  route: [{ model: { provider, model } }],
});

async function chat(gateway: Awaited<ReturnType<typeof openGateway>>, provider: string, model: string) {
  const { route, ...rest } = request(provider, model);
  return gateway.router.chat(rest, route);
}

describe("openGateway", () => {
  it("registers mock and every preset provider", async () => {
    const fake = fakeIo();
    const gateway = await openGateway(fake.io, {});
    const expected = [...Object.keys(PRESETS), "mock"].sort();
    expect(gateway.registry.list()).toEqual(expected);
    expect(gateway.providers).toEqual(Object.keys(PRESETS).sort());
    expect(gateway.providers).toEqual(expect.arrayContaining(["cloudflare", "groq", "ollama", "openai", "openrouter"]));
  });

  it("opens the secret store once, through io", async () => {
    const fake = fakeIo();
    await openGateway(fake.io, {});
    expect(fake.secretsOpened()).toBe(1);
  });

  it("answers through the mock provider", async () => {
    const gateway = await openGateway(fakeIo().io, {});
    const response = await chat(gateway, "mock", "echo");
    expect(response.message.content).toContain("hi");
  });

  it("uses the saved sign-ins through its store", async () => {
    const fake = fakeIo();
    const gateway = await openGateway(fake.io, {});
    await gateway.store.save("openrouter", { kind: "api-key", apiKey: "saved-key-123" });
    expect(await gateway.credentials.get("openrouter")).toEqual({ apiKey: "saved-key-123" });
    expect(await gateway.credentials.get("groq")).toBeUndefined();
  });

  it("sends the environment key, not the saved one, when both exist", async () => {
    const http = recordingFetch(() => completion());
    const fake = fakeIo({ env: { CORE_OPENROUTER_API_KEY: "env-key-aaa" }, fetch: http.fetch });
    const gateway = await openGateway(fake.io, {});
    await gateway.store.save("openrouter", { kind: "api-key", apiKey: "saved-key-bbb" });

    await chat(gateway, "openrouter", "some/model");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer env-key-aaa");
  });

  it("sends the saved key when the environment has none", async () => {
    const http = recordingFetch(() => completion());
    const fake = fakeIo({ fetch: http.fetch });
    const gateway = await openGateway(fake.io, {});
    await gateway.store.save("openrouter", { kind: "api-key", apiKey: "saved-key-bbb" });

    await chat(gateway, "openrouter", "some/model");
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer saved-key-bbb");
  });

  it("falls back from a provider with no key to the next route step", async () => {
    const http = recordingFetch(() => completion("from ollama"));
    const gateway = await openGateway(fakeIo({ fetch: http.fetch }).io, {});
    const response = await gateway.router.chat(
      { messages: [{ role: "user", content: "hi" }] },
      [{ model: { provider: "openrouter", model: "m" } }, { model: { provider: "ollama", model: "llama3.1" } }],
    );
    expect(response.message.content).toBe("from ollama");
    expect(response.attempts.map((attempt) => [attempt.model.provider, attempt.ok])).toEqual([
      ["openrouter", false],
      ["ollama", true],
    ]);
    expect(response.attempts[0]?.error?.code).toBe("auth");
    expect(http.calls.map((call) => call.url)).toEqual(["http://127.0.0.1:11434/v1/chat/completions"]);
  });

  it("renews a Cloudflare sign-in that expires in 30 seconds before the chat call", async () => {
    const http = recordingFetch((call) =>
      call.url === "https://dash.cloudflare.com/oauth2/token"
        ? json({ access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 3600 })
        : completion("renewed"),
    );
    const fake = fakeIo({ fetch: http.fetch });
    const gateway = await openGateway(fake.io, {});
    await gateway.store.save("cloudflare", {
      kind: "oauth",
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() + 30_000,
      accountId: "acct-1",
      clientId: "client-1",
    });

    const response = await chat(gateway, "cloudflare", "@cf/meta/llama-3.1-8b-instruct");
    expect(response.message.content).toBe("renewed");

    expect(http.calls.map((call) => call.url)).toEqual([
      "https://dash.cloudflare.com/oauth2/token",
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions",
    ]);
    const form = new URLSearchParams(http.calls[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh-token");
    expect(form.get("client_id")).toBe("client-1");
    expect(http.calls[1]?.headers.get("authorization")).toBe("Bearer new-access-token");

    const saved = await gateway.store.read("cloudflare");
    expect(saved).toMatchObject({ kind: "oauth", accessToken: "new-access-token", refreshToken: "new-refresh-token" });
  });

  it("does not renew a Cloudflare sign-in that is still good", async () => {
    const http = recordingFetch(() => completion());
    const gateway = await openGateway(fakeIo({ fetch: http.fetch }).io, {});
    await gateway.store.save("cloudflare", {
      kind: "oauth",
      accessToken: "good-access-token",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acct-1",
      clientId: "client-1",
    });
    await chat(gateway, "cloudflare", "@cf/meta/llama-3.1-8b-instruct");
    expect(http.calls.map((call) => call.url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions",
    ]);
  });

  it("uses a Cloudflare API token and account id from the environment", async () => {
    const http = recordingFetch(() => completion());
    const fake = fakeIo({
      env: { CORE_CLOUDFLARE_API_KEY: "cf-env-token", CORE_CLOUDFLARE_ACCOUNT_ID: "acct-env" },
      fetch: http.fetch,
    });
    const gateway = await openGateway(fake.io, {});
    await chat(gateway, "cloudflare", "@cf/m");
    expect(http.calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-env/ai/v1/chat/completions");
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer cf-env-token");
  });

  it("applies timeoutMs from the config to each attempt", async () => {
    // Never answers until the router's timer aborts the request, as a real server that hangs would.
    const hanging = {
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })) as typeof fetch,
    };
    const fake = fakeIo({ env: { CORE_OPENROUTER_API_KEY: "env-key-aaa" }, fetch: hanging.fetch });
    const gateway = await openGateway(fake.io, { timeoutMs: 40 });
    try {
      await chat(gateway, "openrouter", "m");
      throw new Error("expected a timeout");
    } catch (error) {
      expect(CoreError.is(error)).toBe(true);
      expect((error as CoreError).code).toBe("timeout");
    }
  });
});

describe("makeProvider", () => {
  it("builds a provider with the given id on the shared credentials and fetch", async () => {
    const http = recordingFetch(() => completion());
    const fake = fakeIo({ env: { CORE_GROQ_API_KEY: "groq-key-1" }, fetch: http.fetch });
    const gateway = await openGateway(fake.io, {});
    const provider = makeProvider("groq", gateway.credentials, fake.io);
    expect(provider.id).toBe("groq");
    await provider.chat({ model: { provider: "groq", model: "m" }, messages: [{ role: "user", content: "hi" }] });
    expect(http.calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer groq-key-1");
  });
});

describe("envSource", () => {
  const KEY = "super-secret-value-123";

  it("names the variable that is set, never its value", () => {
    const name = envSource({ CORE_OPENROUTER_API_KEY: KEY }, "openrouter");
    expect(name).toBe("CORE_OPENROUTER_API_KEY");
    expect(String(name)).not.toContain(KEY);
  });

  it("checks the key, then the base URL, then the account id", () => {
    const all = {
      CORE_CLOUDFLARE_API_KEY: KEY,
      CORE_CLOUDFLARE_BASE_URL: "https://x.example.com",
      CORE_CLOUDFLARE_ACCOUNT_ID: "acct",
    };
    expect(envSource(all, "cloudflare")).toBe("CORE_CLOUDFLARE_API_KEY");
    expect(envSource({ CORE_CLOUDFLARE_BASE_URL: "https://x", CORE_CLOUDFLARE_ACCOUNT_ID: "acct" }, "cloudflare")).toBe(
      "CORE_CLOUDFLARE_BASE_URL",
    );
    expect(envSource({ CORE_CLOUDFLARE_ACCOUNT_ID: "acct" }, "cloudflare")).toBe("CORE_CLOUDFLARE_ACCOUNT_ID");
  });

  it("is undefined when nothing is set, and treats an empty value as unset", () => {
    expect(envSource({}, "openrouter")).toBeUndefined();
    expect(envSource({ CORE_OPENROUTER_API_KEY: "" }, "openrouter")).toBeUndefined();
    expect(envSource({ CORE_OPENROUTER_API_KEY: undefined }, "openrouter")).toBeUndefined();
  });

  it("only looks at the named provider", () => {
    expect(envSource({ CORE_GROQ_API_KEY: KEY }, "openrouter")).toBeUndefined();
  });

  it("normalises the provider id the way the environment store does", () => {
    expect(envSource({ CORE_MY_PROVIDER_API_KEY: KEY }, "my-provider")).toBe("CORE_MY_PROVIDER_API_KEY");
  });
});

describe("envSource: region and workspace ID", () => {
  it("returns CORE_ANTHROPIC_AWS_REGION when only that variable is set", () => {
    expect(envSource({ CORE_ANTHROPIC_AWS_REGION: "us-west-2" }, "anthropic-aws")).toBe("CORE_ANTHROPIC_AWS_REGION");
  });

  it("returns CORE_ANTHROPIC_AWS_WORKSPACE_ID when only that variable is set", () => {
    expect(envSource({ CORE_ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01" }, "anthropic-aws")).toBe(
      "CORE_ANTHROPIC_AWS_WORKSPACE_ID",
    );
  });

  it("checks API key, base URL, account ID, region, then workspace ID", () => {
    const all: Record<string, string> = {
      CORE_ANTHROPIC_AWS_API_KEY: "k",
      CORE_ANTHROPIC_AWS_BASE_URL: "https://x",
      CORE_ANTHROPIC_AWS_ACCOUNT_ID: "a",
      CORE_ANTHROPIC_AWS_REGION: "us-west-2",
      CORE_ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_01",
    };
    const order = ["API_KEY", "BASE_URL", "ACCOUNT_ID", "REGION", "WORKSPACE_ID"];
    for (let first = 0; first < order.length; first++) {
      const rest = Object.fromEntries(order.slice(first).map((suffix) => [`CORE_ANTHROPIC_AWS_${suffix}`, all[`CORE_ANTHROPIC_AWS_${suffix}`]]));
      expect(envSource(rest, "anthropic-aws")).toBe(`CORE_ANTHROPIC_AWS_${order[first]}`);
    }
  });

  it("lets _API_KEY win when API_KEY and REGION are both set", () => {
    expect(envSource({ CORE_ANTHROPIC_AWS_REGION: "us-west-2", CORE_ANTHROPIC_AWS_API_KEY: "k" }, "anthropic-aws")).toBe(
      "CORE_ANTHROPIC_AWS_API_KEY",
    );
  });

  it("treats an empty region or workspace ID as unset, and keeps anthropic and anthropic-aws apart", () => {
    expect(envSource({ CORE_ANTHROPIC_AWS_REGION: "", CORE_ANTHROPIC_AWS_WORKSPACE_ID: "" }, "anthropic-aws")).toBeUndefined();
    expect(envSource({ CORE_ANTHROPIC_AWS_REGION: "us-west-2" }, "anthropic")).toBeUndefined();
    expect(envSource({ CORE_ANTHROPIC_API_KEY: "k" }, "anthropic-aws")).toBeUndefined();
  });
});

describe("makeProvider: adapter choice", () => {
  const messageBody = (text: string) =>
    json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    });

  it("builds an AnthropicProvider for anthropic and anthropic-aws", async () => {
    const fake = fakeIo();
    const gateway = await openGateway(fake.io, {});
    for (const id of ["anthropic", "anthropic-aws"]) {
      const provider = makeProvider(id, gateway.credentials, fake.io);
      expect(provider).toBeInstanceOf(AnthropicProvider);
      expect(provider.id).toBe(id);
    }
  });

  it("builds an OpenAICompatibleProvider for every other preset, and for an id with no preset", async () => {
    const fake = fakeIo();
    const gateway = await openGateway(fake.io, {});
    const others = Object.keys(PRESETS).filter((id) => PRESETS[id]?.api !== "anthropic");
    expect(others).toEqual(expect.arrayContaining(["groq", "openai", "openrouter", "ollama", "cloudflare", "vercel"]));
    for (const id of [...others, "not-a-preset"]) {
      const provider = makeProvider(id, gateway.credentials, fake.io);
      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(provider).not.toBeInstanceOf(AnthropicProvider);
    }
  });

  it("registers an AnthropicProvider for both ids in the gateway", async () => {
    const gateway = await openGateway(fakeIo().io, {});
    expect(gateway.providers).toEqual(expect.arrayContaining(["anthropic", "anthropic-aws"]));
    expect(gateway.registry.get("anthropic")).toBeInstanceOf(AnthropicProvider);
    expect(gateway.registry.get("anthropic-aws")).toBeInstanceOf(AnthropicProvider);
    expect(gateway.registry.get("groq")).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("chats with Claude through the Messages API using the environment's key", async () => {
    const http = recordingFetch(() => messageBody("Bonjour"));
    const fake = fakeIo({ env: { CORE_ANTHROPIC_API_KEY: "sk-ant-env-411" }, fetch: http.fetch });
    const gateway = await openGateway(fake.io, {});
    const response = await makeProvider("anthropic", gateway.credentials, fake.io).chat({
      model: { provider: "anthropic", model: "claude-opus-5-5" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message.content).toBe("Bonjour");
    expect(http.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(http.calls[0]?.headers.get("x-api-key")).toBe("sk-ant-env-411");
    expect(http.calls[0]?.headers.has("anthropic-workspace-id")).toBe(false);
  });

  it("chats on Claude Platform on AWS with the region and workspace from the environment", async () => {
    const http = recordingFetch(() => messageBody("Hallo"));
    const fake = fakeIo({
      env: {
        CORE_ANTHROPIC_AWS_API_KEY: "sk-aws-env-412",
        CORE_ANTHROPIC_AWS_REGION: "eu-central-1",
        CORE_ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_env",
      },
      fetch: http.fetch,
    });
    const gateway = await openGateway(fake.io, {});
    const response = await makeProvider("anthropic-aws", gateway.credentials, fake.io).chat({
      model: { provider: "anthropic-aws", model: "claude-opus-5-5" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.message.content).toBe("Hallo");
    expect(http.calls[0]?.url).toBe("https://aws-external-anthropic.eu-central-1.api.aws/v1/messages");
    expect(http.calls[0]?.headers.get("x-api-key")).toBe("sk-aws-env-412");
    expect(http.calls[0]?.headers.get("anthropic-workspace-id")).toBe("wrkspc_env");
  });
});
