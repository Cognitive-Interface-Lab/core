import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredCredential } from "@core/contracts";
import { PersistentCredentialStore } from "@core/credentials";
import { saveConfig } from "../src/config.js";
import { run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, type FakeIo, type FakeIoOptions } from "./fake-io.js";

afterEach(cleanupFakeIo);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const modelList = (ids: string[]) => json({ object: "list", data: ids.map((id) => ({ id })) });

type Call = { url: string; headers: Headers };

/** An injected `fetch`: `answer` gets the URL and returns a response (or throws to simulate no connection). */
function providers(answer: (url: string, call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), headers: new Headers(init?.headers) };
    calls.push(call);
    return answer(call.url, call);
  };
  return { fetch: impl as typeof fetch, calls };
}

const refused = () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
};

/** A fake `Io` plus a credential store over the same secret store, to seed saved sign-ins. */
function setup(options: FakeIoOptions = {}) {
  const fake = fakeIo(options);
  const store = new PersistentCredentialStore({ secrets: fake.secrets });
  return { fake, store, again: (more: FakeIoOptions = {}) => fakeIo({ secretStore: fake.secrets, configDir: fake.io.configDir, ...more }) };
}

const minutes = (n: number) => Date.now() + n * 60_000;

const oauth = (extra: Partial<Extract<StoredCredential, { kind: "oauth" }>> = {}): StoredCredential => ({
  kind: "oauth",
  accessToken: "access-secret-aaa",
  refreshToken: "refresh-secret-bbb",
  expiresAt: minutes(60),
  accountId: "acct-1",
  clientId: "client-1",
  ...extra,
});

/** A browser sign-in that cannot be renewed: the same record with no refresh token. */
function withoutRefreshToken(expiresAt: number): StoredCredential {
  const record = oauth({ expiresAt }) as Extract<StoredCredential, { kind: "oauth" }>;
  delete record.refreshToken;
  return record;
}

function expectNoSecrets(fake: FakeIo, secrets: string[]): void {
  for (const secret of secrets) {
    expect(fake.stdout()).not.toContain(secret);
    expect(fake.stderr()).not.toContain(secret);
  }
}

describe("core logout", () => {
  it("removes the saved sign-in, and says so only the first time", async () => {
    const { fake, store, again } = setup();
    await store.save("openrouter", { kind: "api-key", apiKey: "key-secret-111" });
    await store.save("groq", { kind: "api-key", apiKey: "key-secret-222" });

    expect(await run(["logout", "openrouter"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("Signed out of openrouter.\n");
    expect(await fake.secrets.list()).toEqual(["groq"]);

    const second = again();
    expect(await run(["logout", "openrouter"], second.io)).toBe(0);
    expect(second.stdout()).toBe("Not signed in to openrouter.\n");
    expect(await fake.secrets.list()).toEqual(["groq"]);
  });

  it("mentions that the grant stays on Cloudflare after removing a browser sign-in", async () => {
    const { fake, store } = setup();
    await store.save("cloudflare", oauth());
    expect(await run(["logout", "cloudflare"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe(
      "Signed out of cloudflare.\nThe grant stays on your Cloudflare account; remove it in the Cloudflare dashboard if you no longer want it.\n",
    );
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("does not mention the grant after removing an API token", async () => {
    const { fake, store } = setup();
    await store.save("cloudflare", { kind: "api-key", apiKey: "cf-token-333", accountId: "acct-1" });
    await run(["logout", "cloudflare"], fake.io);
    expect(fake.stdout()).toBe("Signed out of cloudflare.\n");
  });

  it("can remove a saved record that has become unreadable", async () => {
    const { fake } = setup();
    await fake.secrets.set("openrouter", "this is not json");
    expect(await run(["logout", "openrouter"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("Signed out of openrouter.\n");
    expect(await fake.secrets.list()).toEqual([]);
  });

  it.each([
    ["an unknown provider", ["logout", "nonesuch"]],
    ["no provider", ["logout"]],
    ["two providers", ["logout", "openai", "groq"]],
    ["mock, which is not a preset", ["logout", "mock"]],
  ])("returns 2 for %s", async (_name, argv) => {
    const { fake } = setup();
    expect(await run(argv, fake.io)).toBe(2);
    expect(fake.stderr()).toContain("usage: core logout");
  });
});

describe("core status", () => {
  const lineFor = (fake: FakeIo, provider: string) =>
    fake.stdout().split("\n").find((line) => line.startsWith(provider));

  it("shows each state: environment, key, browser that renews, browser that expires, expired, Ollama, not signed in", async () => {
    const { fake, store } = setup({ env: { CORE_GROQ_API_KEY: "env-secret-999", CORE_ROUTE: "ollama:llama3.1,openrouter:openrouter/free" } });
    await store.save("openrouter", { kind: "api-key", apiKey: "key-secret-111" });
    await store.save("cloudflare", oauth());

    expect(await run(["status"], fake.io)).toBe(0);
    expect(lineFor(fake, "cloudflare")).toBe("cloudflare     signed in (browser, account acct-1, renews automatically)");
    expect(lineFor(fake, "groq")).toBe("groq           from CORE_GROQ_API_KEY");
    expect(lineFor(fake, "ollama")).toBe("ollama         no sign-in needed (http://127.0.0.1:11434/v1)");
    expect(lineFor(fake, "openai")).toBe("openai         not signed in");
    expect(lineFor(fake, "openrouter")).toBe("openrouter     signed in (key)");
    expect(fake.stdout()).toContain("\nCredentials: memory\n");
    expect(fake.stdout()).toContain("Models: ollama:llama3.1, openrouter:openrouter/free\n");
    expect(fake.stderr()).toBe("");
    expectNoSecrets(fake, ["env-secret-999", "key-secret-111", "access-secret-aaa", "refresh-secret-bbb"]);
  });

  it("lists the providers in order, one aligned line each", async () => {
    const { fake } = setup();
    await run(["status"], fake.io);
    const lines = fake.stdout().split("\n");
    const names = lines.slice(0, 8).map((line) => line.split(/\s+/)[0]);
    expect(names).toEqual([
      "anthropic",
      "anthropic-aws",
      "cloudflare",
      "groq",
      "ollama",
      "openai",
      "openrouter",
      "vercel",
    ]);
    for (const line of lines.slice(0, 8)) expect(line.slice(0, 15).trimEnd()).toBe(line.split(/\s+/)[0]);
    expect(lines[8]).toBe("");
  });

  it("shows the account of a saved key", async () => {
    const { fake, store } = setup();
    await store.save("cloudflare", { kind: "api-key", apiKey: "cf-token-333", accountId: "acct-7" });
    await run(["status"], fake.io);
    expect(lineFor(fake, "cloudflare")).toBe("cloudflare     signed in (key, account acct-7)");
    expectNoSecrets(fake, ["cf-token-333"]);
  });

  it("shows a browser sign-in without a refresh token and its time left", async () => {
    const { fake, store } = setup();
    await store.save("cloudflare", withoutRefreshToken(minutes(9.5)));
    await run(["status"], fake.io);
    expect(lineFor(fake, "cloudflare")).toBe("cloudflare     signed in (browser, account acct-1, expires in 10 min)");
    expectNoSecrets(fake, ["access-secret-aaa"]);
  });

  it("says the sign-in expired once the expiry has passed and there is no refresh token", async () => {
    const { fake, store } = setup();
    await store.save("cloudflare", withoutRefreshToken(Date.now() - 1000));
    await run(["status"], fake.io);
    expect(lineFor(fake, "cloudflare")).toBe("cloudflare     sign-in expired");
  });

  it("still says it renews automatically when a refresh token exists past the expiry", async () => {
    const { fake, store } = setup();
    await store.save("cloudflare", oauth({ expiresAt: Date.now() - 1000 }));
    await run(["status"], fake.io);
    expect(lineFor(fake, "cloudflare")).toBe("cloudflare     signed in (browser, account acct-1, renews automatically)");
  });

  it("puts an environment variable ahead of a saved sign-in, and names the first variable set", async () => {
    const { fake, store } = setup({ env: { CORE_OPENROUTER_BASE_URL: "https://proxy.example.com/v1", CORE_OPENROUTER_ACCOUNT_ID: "a" } });
    await store.save("openrouter", { kind: "api-key", apiKey: "key-secret-111" });
    await run(["status"], fake.io);
    expect(lineFor(fake, "openrouter")).toBe("openrouter     from CORE_OPENROUTER_BASE_URL");
    expect(fake.stdout()).not.toContain("proxy.example.com");
  });

  it("shows Ollama's environment override instead of the default address", async () => {
    const { fake } = setup({ env: { CORE_OLLAMA_BASE_URL: "http://gpu-box:11434/v1" } });
    await run(["status"], fake.io);
    expect(lineFor(fake, "ollama")).toBe("ollama         from CORE_OLLAMA_BASE_URL");
  });

  it("says the models are not set when there is no route", async () => {
    const { fake } = setup();
    await run(["status"], fake.io);
    expect(fake.stdout()).toContain("Models: not set (core config set route ...)\n");
  });

  it("shows the route saved in the config", async () => {
    const { fake } = setup();
    await saveConfig(fake.io.configDir, { route: ["cloudflare:@cf/meta/llama-3.1-8b-instruct", "ollama:llama3.1"] });
    await run(["status"], fake.io);
    expect(fake.stdout()).toContain("Models: cloudflare:@cf/meta/llama-3.1-8b-instruct, ollama:llama3.1\n");
  });

  it("prefers CORE_ROUTE over the config's route", async () => {
    const { fake } = setup({ env: { CORE_ROUTE: "mock:echo" } });
    await saveConfig(fake.io.configDir, { route: ["ollama:llama3.1"] });
    await run(["status"], fake.io);
    expect(fake.stdout()).toContain("Models: mock:echo\n");
  });

  it("returns 2 for an argument", async () => {
    const { fake } = setup();
    expect(await run(["status", "openai"], fake.io)).toBe(2);
  });

  it("returns 1 and names the provider when a saved record is unreadable", async () => {
    const { fake } = setup();
    await fake.secrets.set("openrouter", "this is not json");
    expect(await run(["status"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("openrouter");
    expect(fake.stderr()).toContain("sign in again");
  });

  it("returns 1 when the config file is invalid", async () => {
    const { fake } = setup();
    await saveConfig(fake.io.configDir, {});
    await writeFile(`${fake.io.configDir}/config.json`, '{"nope":1}');
    expect(await run(["status"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("error: bad_request");
  });
});

describe("core models", () => {
  it("prints provider:model lines for one provider, sorted, and returns 0", async () => {
    const api = providers(() => modelList(["g2", "g1"]));
    const { fake } = setup({ env: { CORE_GROQ_API_KEY: "env-secret-999" }, fetch: api.fetch });
    expect(await run(["models", "groq"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("groq:g1\ngroq:g2\n");
    expect(api.calls[0]?.url).toBe("https://api.groq.com/openai/v1/models");
    expect(api.calls[0]?.headers.get("authorization")).toBe("Bearer env-secret-999");
    expectNoSecrets(fake, ["env-secret-999"]);
  });

  it("lists Cloudflare models as cloudflare:@cf/... lines", async () => {
    const api = providers(() => json({ result: [{ name: "@cf/meta/llama-3.1-8b-instruct" }, { name: "@cf/mistral/mistral-7b" }] }));
    const { fake, store } = setup({ fetch: api.fetch });
    await store.save("cloudflare", { kind: "api-key", apiKey: "cf-token-333", accountId: "acct-1" });
    expect(await run(["models", "cloudflare"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("cloudflare:@cf/meta/llama-3.1-8b-instruct\ncloudflare:@cf/mistral/mistral-7b\n");
    expect(api.calls[0]?.url).toContain("/accounts/acct-1/ai/models/search");
  });

  it("uses a saved sign-in", async () => {
    const api = providers(() => modelList(["m"]));
    const { fake, store } = setup({ fetch: api.fetch });
    await store.save("openrouter", { kind: "api-key", apiKey: "key-secret-111" });
    expect(await run(["models", "openrouter"], fake.io)).toBe(0);
    expect(api.calls[0]?.headers.get("authorization")).toBe("Bearer key-secret-111");
  });

  it("returns 1 with error: <code>: <message> when the provider fails", async () => {
    const api = providers(() => json({}, 401));
    const { fake } = setup({ env: { CORE_GROQ_API_KEY: "env-secret-999" }, fetch: api.fetch });
    expect(await run(["models", "groq"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toMatch(/^error: auth: /);
    expectNoSecrets(fake, ["env-secret-999"]);
  });

  it("returns 1 when a provider has no sign-in", async () => {
    const api = providers(() => modelList(["m"]));
    const { fake } = setup({ fetch: api.fetch });
    expect(await run(["models", "openai"], fake.io)).toBe(1);
    expect(fake.stderr()).toMatch(/^error: auth: /);
    expect(api.calls).toHaveLength(0);
  });

  it("lists Ollama's models without any sign-in", async () => {
    const api = providers(() => modelList(["llama3.2:3b", "llama3.1"]));
    const { fake } = setup({ fetch: api.fetch });
    expect(await run(["models", "ollama"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("ollama:llama3.1\nollama:llama3.2:3b\n");
  });

  it.each([
    ["an unknown provider", ["models", "nonesuch"]],
    ["mock, which is not a preset", ["models", "mock"]],
    ["two providers", ["models", "openai", "groq"]],
  ])("returns 2 for %s", async (_name, argv) => {
    const { fake } = setup();
    expect(await run(argv, fake.io)).toBe(2);
    expect(fake.stderr()).toContain("usage: core models");
  });

  describe("without a provider", () => {
    it("lists every provider that has credentials, plus Ollama, and skips the rest", async () => {
      const api = providers((url) => {
        if (url.includes("groq")) return modelList(["g1"]);
        if (url.includes("openrouter")) return modelList(["or/free", "or/paid"]);
        if (url.includes("127.0.0.1")) return modelList(["llama3.1"]);
        return json({}, 500);
      });
      const { fake, store } = setup({ env: { CORE_GROQ_API_KEY: "env-secret-999" }, fetch: api.fetch });
      await store.save("openrouter", { kind: "api-key", apiKey: "key-secret-111" });

      expect(await run(["models"], fake.io)).toBe(0);
      expect(fake.stdout().split("\n").filter(Boolean)).toEqual(["groq:g1", "ollama:llama3.1", "openrouter:or/free", "openrouter:or/paid"]);
      expect(fake.stderr()).toBe("");
      expect(api.calls.map((call) => new URL(call.url).host).sort()).toEqual(["127.0.0.1:11434", "api.groq.com", "openrouter.ai"]);
      expectNoSecrets(fake, ["env-secret-999", "key-secret-111"]);
    });

    it("prints lines that can be pasted into `core config set route`", async () => {
      const api = providers((url) => (url.includes("127.0.0.1") ? modelList(["llama3.2:3b"]) : modelList(["a/b"])));
      const { fake } = setup({ env: { CORE_OPENROUTER_API_KEY: "env-secret-999" }, fetch: api.fetch });
      await run(["models"], fake.io);
      for (const line of fake.stdout().split("\n").filter(Boolean)) expect(line).toMatch(/^[a-z]+:\S+$/);
    });

    it("reports a failing provider on stderr and still lists the others", async () => {
      const api = providers((url) => (url.includes("127.0.0.1") ? refused() : url.includes("groq") ? json({}, 401) : modelList(["or/free"])));
      const { fake, store } = setup({ env: { CORE_GROQ_API_KEY: "env-secret-999" }, fetch: api.fetch });
      await store.save("openrouter", { kind: "api-key", apiKey: "key-secret-111" });

      expect(await run(["models"], fake.io)).toBe(0);
      expect(fake.stdout()).toBe("openrouter:or/free\n");
      expect(fake.stderr()).toContain("groq: auth: ");
      expect(fake.stderr()).toContain("ollama: unavailable: ");
      expect(fake.stderr()).not.toContain("ollama: unavailable: ollama:");
      expectNoSecrets(fake, ["env-secret-999", "key-secret-111"]);
    });

    it("returns 1 only when every provider failed", async () => {
      const api = providers(() => refused());
      const { fake } = setup({ fetch: api.fetch });
      expect(await run(["models"], fake.io)).toBe(1);
      expect(fake.stdout()).toBe("");
      expect(fake.stderr()).toContain("ollama: unavailable: ");

      const failing = providers((url) => (url.includes("127.0.0.1") ? refused() : json({}, 500)));
      const both = setup({ env: { CORE_GROQ_API_KEY: "env-secret-999" }, fetch: failing.fetch });
      expect(await run(["models"], both.fake.io)).toBe(1);
      expect(both.fake.stderr()).toContain("groq: unavailable: ");
      expect(both.fake.stderr()).toContain("ollama: unavailable: ");
    });

    it("reports a saved Cloudflare sign-in that cannot be renewed as a failure and lists the rest", async () => {
      const api = providers((url) => (url.includes("127.0.0.1") ? modelList(["llama3.1"]) : json({}, 500)));
      const { fake, store } = setup({ fetch: api.fetch });
      await store.save("cloudflare", withoutRefreshToken(Date.now() - 1000));

      expect(await run(["models"], fake.io)).toBe(0);
      expect(fake.stdout()).toBe("ollama:llama3.1\n");
      expect(fake.stderr()).toContain("cloudflare: auth: ");
      expectNoSecrets(fake, ["access-secret-aaa"]);
    });

    it("leaves no interrupt handler behind", async () => {
      const { fake } = setup({ fetch: providers(() => modelList(["m"])).fetch });
      await run(["models"], fake.io);
      expect(fake.interruptHandlers()).toBe(0);
    });
  });
});
