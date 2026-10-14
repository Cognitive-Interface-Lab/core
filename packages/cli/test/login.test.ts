import { afterEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.js";
import { run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, type FakeIo, type FakeIoOptions } from "./fake-io.js";

afterEach(cleanupFakeIo);

type Call = { url: string; method: string; headers: Headers; body: string | undefined };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const modelList = (ids: string[]) => json({ object: "list", data: ids.map((id) => ({ id })) });

/** An injected `fetch` that records every call and answers with `answer` (provider traffic only; never the browser). */
function providers(answer: (call: Call) => Response | Promise<Response>) {
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

/** Plays the browser: requests the redirect URI found under `redirectKey` in the sign-in URL. */
async function approve(url: string, redirectKey: string, extra: (auth: URL) => Record<string, string>): Promise<void> {
  const auth = new URL(url);
  const callback = new URL(auth.searchParams.get(redirectKey) ?? "");
  callback.hostname = "127.0.0.1";
  for (const [key, value] of Object.entries(extra(auth))) callback.searchParams.set(key, value);
  await (await fetch(callback)).text();
}

async function saved(fake: FakeIo, provider: string): Promise<unknown> {
  const text = await fake.secrets.get(provider);
  return text === undefined ? undefined : JSON.parse(text);
}

function expectNoSecrets(fake: FakeIo, secrets: string[]): void {
  for (const secret of secrets) {
    expect(fake.stdout()).not.toContain(secret);
    expect(fake.stderr()).not.toContain(secret);
  }
}

/** Cloudflare's browser flow listens on the fixed port 8976; retry if another test run holds it for a moment. */
async function loginRetrying(argv: string[], make: () => FakeIo | Promise<FakeIo>): Promise<{ code: number; fake: FakeIo }> {
  for (let attempt = 0; ; attempt++) {
    const fake = await make();
    const code = await run(argv, fake.io);
    if (code === 1 && fake.stderr().includes("port 8976 is in use") && attempt < 20) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    return { code, fake };
  }
}

describe("core login: API keys", () => {
  it("verifies an OpenRouter key against /models, saves it, and reports the model count", async () => {
    const http = providers(() => modelList(["b/two", "a/one", "c/three"]));
    const fake = fakeIo({ answers: { secret: ["sk-or-secret-111"] }, fetch: http.fetch });

    expect(await run(["login", "openrouter", "--key"], fake.io)).toBe(0);

    expect(fake.asked).toEqual(["OpenRouter API key: "]);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer sk-or-secret-111");
    expect(fake.stdout()).toBe("Signed in to openrouter (3 models available). Saved in memory.\n");
    expect(await saved(fake, "openrouter")).toEqual({ kind: "api-key", apiKey: "sk-or-secret-111" });
    expectNoSecrets(fake, ["sk-or-secret-111"]);
  });

  it("trims what was typed", async () => {
    const http = providers(() => modelList(["m"]));
    const fake = fakeIo({ answers: { secret: ["  sk-groq-trim-222  "] }, fetch: http.fetch });
    expect(await run(["login", "groq"], fake.io)).toBe(0);
    expect(await saved(fake, "groq")).toEqual({ kind: "api-key", apiKey: "sk-groq-trim-222" });
    expect(http.calls[0]?.url).toBe("https://api.groq.com/openai/v1/models");
  });

  it.each(["openai", "groq"])("signs in to %s with a key by default", async (provider) => {
    const http = providers(() => modelList(["m1", "m2"]));
    const fake = fakeIo({ answers: { secret: ["key-value-333"] }, fetch: http.fetch });
    expect(await run(["login", provider], fake.io)).toBe(0);
    expect(fake.stdout()).toContain(`Signed in to ${provider} (2 models available).`);
    expect(await saved(fake, provider)).toEqual({ kind: "api-key", apiKey: "key-value-333" });
  });

  it("accepts --key for openai and groq too", async () => {
    const fake = fakeIo({ answers: { secret: ["key-value-333"] }, fetch: providers(() => modelList(["m"])).fetch });
    expect(await run(["login", "openai", "--key"], fake.io)).toBe(0);
  });

  it.each([
    ["an empty answer", [""]],
    ["only spaces", ["   "]],
    ["end of input", [undefined]],
    ["no answer at all", []],
  ])("returns 2 and saves nothing for %s", async (_name, secret) => {
    const http = providers(() => modelList(["m"]));
    const fake = fakeIo({ answers: { secret }, fetch: http.fetch });
    expect(await run(["login", "openrouter", "--key"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("nothing entered");
    expect(http.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("verifies with the new key only, even when an environment key is set", async () => {
    const http = providers(() => modelList(["m"]));
    const fake = fakeIo({
      env: { CORE_OPENROUTER_API_KEY: "env-key-444" },
      answers: { secret: ["new-key-555"] },
      fetch: http.fetch,
    });
    expect(await run(["login", "openrouter", "--key"], fake.io)).toBe(0);
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer new-key-555");
  });

  it("warns that an environment variable takes precedence over the saved sign-in", async () => {
    const fake = fakeIo({
      env: { CORE_OPENROUTER_API_KEY: "env-key-444" },
      answers: { secret: ["new-key-555"] },
      fetch: providers(() => modelList(["m"])).fetch,
    });
    expect(await run(["login", "openrouter", "--key"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain("CORE_OPENROUTER_API_KEY is set and takes precedence over the saved sign-in");
    expectNoSecrets(fake, ["env-key-444", "new-key-555"]);
  });

  it("does not warn when no environment variable is set", async () => {
    const fake = fakeIo({ answers: { secret: ["new-key-555"] }, fetch: providers(() => modelList(["m"])).fetch });
    await run(["login", "openrouter", "--key"], fake.io);
    expect(fake.stderr()).toBe("");
  });
});

describe("core login: verification", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
  ])("HTTP %i returns 1, prints the error and saves nothing", async (status, code) => {
    const fake = fakeIo({
      answers: { secret: ["bad-key-666"] },
      fetch: providers(() => json({ error: { message: "nope" } }, status)).fetch,
    });
    expect(await run(["login", "openai"], fake.io)).toBe(1);
    expect(fake.stderr()).toMatch(new RegExp(`^error: ${code}: `));
    expect(fake.stdout()).toBe("");
    expect(await fake.secrets.list()).toEqual([]);
    expectNoSecrets(fake, ["bad-key-666"]);
  });

  it.each([
    ["a server error", () => json({}, 500), "unavailable"],
    ["a rate limit", () => json({}, 429), "rate_limit"],
    [
      "a refused connection",
      () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
      "unavailable",
    ],
    ["a body that is not a model list", () => json({ nothing: true }), "unknown"],
  ])("%s saves anyway and warns that it could not verify", async (_name, answer, code) => {
    const fake = fakeIo({ answers: { secret: ["maybe-key-777"] }, fetch: providers(answer).fetch });
    expect(await run(["login", "openai"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain(`saved, but could not verify: ${code}: `);
    expect(fake.stdout()).toBe("Signed in to openai. Saved in memory.\n");
    expect(await saved(fake, "openai")).toEqual({ kind: "api-key", apiKey: "maybe-key-777" });
    expectNoSecrets(fake, ["maybe-key-777"]);
  });
});

describe("core login: ollama and usage errors", () => {
  it("needs no sign-in: returns 0 without a prompt or a request", async () => {
    const http = providers(() => modelList([]));
    const fake = fakeIo({ fetch: http.fetch });
    expect(await run(["login", "ollama"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("ollama needs no sign-in (it runs on this machine at http://127.0.0.1:11434/v1)\n");
    expect(fake.asked).toEqual([]);
    expect(http.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("returns 2 and lists the valid providers for an unknown one", async () => {
    const fake = fakeIo();
    expect(await run(["login", "nonesuch"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain('unknown provider "nonesuch"');
    for (const id of ["cloudflare", "groq", "ollama", "openai", "openrouter"]) expect(fake.stderr()).toContain(id);
    expect(fake.stderr()).toContain("usage: core login");
  });

  it.each([
    ["no provider", ["login"]],
    ["two providers", ["login", "openai", "groq"]],
    ["mock, which is not a preset", ["login", "mock"]],
    ["an unknown flag", ["login", "openai", "--frobnicate"]],
    ["--key with --browser", ["login", "openrouter", "--key", "--browser"]],
    ["--browser for openai", ["login", "openai", "--browser"]],
    ["--browser for groq", ["login", "groq", "--browser"]],
    ["--account-id for openrouter", ["login", "openrouter", "--account-id", "abc"]],
  ])("returns 2 for %s, before asking anything", async (_name, argv) => {
    const fake = fakeIo({ answers: { secret: ["key"] } });
    expect(await run(argv, fake.io)).toBe(2);
    expect(fake.asked).toEqual([]);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("opens the secret store before asking for anything", async () => {
    const fake = fakeIo({
      answers: { secret: ["key-value-333"] },
      fetch: providers(() => modelList(["m"])).fetch,
    });
    await run(["login", "openai"], fake.io);
    expect(fake.secretsOpened()).toBe(1);
  });

  it("leaves no interrupt handler behind", async () => {
    const fake = fakeIo({ answers: { secret: ["key-value-333"] }, fetch: providers(() => modelList(["m"])).fetch });
    await run(["login", "openai"], fake.io);
    expect(fake.interruptHandlers()).toBe(0);
  });
});

describe("core login: OpenRouter in the browser", () => {
  const KEY = "sk-or-issued-key-888";

  function openRouter(extra: Partial<FakeIoOptions> = {}, reply: (auth: URL) => Record<string, string> = () => ({ code: "the-code-999" })) {
    const opened: string[] = [];
    const http = providers((call) =>
      call.url === "https://openrouter.ai/api/v1/auth/keys" ? json({ key: KEY }) : modelList(["a", "b"]),
    );
    const fake = fakeIo({
      fetch: http.fetch,
      openUrl: async (url) => {
        opened.push(url);
        await approve(url, "callback_url", reply);
      },
      ...extra,
    });
    return { fake, http, opened };
  }

  it("opens the sign-in page, exchanges the code, verifies the issued key and saves it", async () => {
    const { fake, http, opened } = openRouter();
    expect(await run(["login", "openrouter"], fake.io)).toBe(0);

    expect(opened).toHaveLength(1);
    const auth = new URL(opened[0] ?? "");
    expect(`${auth.origin}${auth.pathname}`).toBe("https://openrouter.ai/auth");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("callback_url")).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    expect(http.calls.map((call) => call.url)).toEqual([
      "https://openrouter.ai/api/v1/auth/keys",
      "https://openrouter.ai/api/v1/models",
    ]);
    expect(http.calls[1]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(fake.stdout()).toBe("Signed in to openrouter (2 models available). Saved in memory.\n");
    expect(fake.stderr()).toContain("Opening your browser to sign in to openrouter. If it does not open, visit:");
    expect(fake.stderr()).toContain(opened[0]);
    expect(await saved(fake, "openrouter")).toEqual({ kind: "api-key", apiKey: KEY });
    expectNoSecrets(fake, [KEY, "the-code-999"]);
  });

  it("does not ask for a key", async () => {
    const { fake } = openRouter();
    await run(["login", "openrouter"], fake.io);
    expect(fake.asked).toEqual([]);
  });

  it("--no-open only prints the URL", async () => {
    const opened: string[] = [];
    const http = providers((call) =>
      call.url === "https://openrouter.ai/api/v1/auth/keys" ? json({ key: KEY }) : modelList(["a"]),
    );
    const fake = fakeIo({ fetch: http.fetch, openUrl: async (url) => void opened.push(url) });

    const login = run(["login", "openrouter", "--no-open"], fake.io);
    await vi.waitFor(() => expect(fake.stderr()).toContain("https://openrouter.ai/auth?"));
    const printed = fake.stderr().split("\n").find((line) => line.startsWith("https://openrouter.ai/auth?"));
    await approve(printed ?? "", "callback_url", () => ({ code: "the-code-999" }));

    expect(await login).toBe(0);
    expect(opened).toEqual([]);
    expect(await saved(fake, "openrouter")).toEqual({ kind: "api-key", apiKey: KEY });
  });

  it("returns 1 and saves nothing when the browser comes back without a code", async () => {
    const { fake, http } = openRouter({}, () => ({ error: "access_denied" }));
    expect(await run(["login", "openrouter"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("error: auth: OpenRouter sign-in was cancelled");
    expect(http.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("returns 1 and saves nothing when OpenRouter refuses the code", async () => {
    const opened: string[] = [];
    const http = providers(() => json({ error: { message: "Invalid code_verifier" } }, 400));
    const fake = fakeIo({
      fetch: http.fetch,
      openUrl: async (url) => {
        opened.push(url);
        await approve(url, "callback_url", () => ({ code: "the-code-999" }));
      },
    });
    expect(await run(["login", "openrouter"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("Invalid code_verifier");
    expectNoSecrets(fake, ["the-code-999"]);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("is cancelled by Ctrl+C, returns 1 and leaves no handler behind", async () => {
    const http = providers(() => modelList(["a"]));
    const fake = fakeIo({ fetch: http.fetch, openUrl: async () => undefined });
    const login = run(["login", "openrouter"], fake.io);
    await vi.waitFor(() => expect(fake.interruptHandlers()).toBe(1));
    await vi.waitFor(() => expect(fake.stderr()).toContain("Opening your browser"));
    expect(fake.interrupt()).toBe(true);
    expect(await login).toBe(1);
    expect(fake.stderr()).toContain("error: aborted: ");
    expect(fake.interruptHandlers()).toBe(0);
    expect(await fake.secrets.list()).toEqual([]);
  });
});

describe("core login: Cloudflare with an API token", () => {
  const TOKEN = "cf-api-token-secret-123";

  const http = () =>
    providers((call) =>
      call.url.startsWith("https://api.cloudflare.com/client/v4/accounts/") ? json({ result: [{ name: "@cf/meta/a" }, { name: "@cf/meta/b" }] }) : json({}, 404),
    );

  it("asks for the token and the account ID, verifies through the model search, and saves both", async () => {
    const api = http();
    const fake = fakeIo({ answers: { secret: [TOKEN], line: ["acct-123"] }, fetch: api.fetch });
    expect(await run(["login", "cloudflare", "--key"], fake.io)).toBe(0);

    expect(fake.asked).toEqual(["Cloudflare API token (Workers AI read + edit): ", "Cloudflare account ID: "]);
    expect(api.calls).toHaveLength(1);
    const url = new URL(api.calls[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://api.cloudflare.com/client/v4/accounts/acct-123/ai/models/search");
    expect(api.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(fake.stdout()).toBe("Signed in to cloudflare (2 models available). Saved in memory.\n");
    expect(await saved(fake, "cloudflare")).toEqual({ kind: "api-key", apiKey: TOKEN, accountId: "acct-123" });
    expectNoSecrets(fake, [TOKEN]);
  });

  it("does not ask for the account ID when --account-id is given", async () => {
    const api = http();
    const fake = fakeIo({ answers: { secret: [TOKEN] }, fetch: api.fetch });
    expect(await run(["login", "cloudflare", "--key", "--account-id", "acct-flag"], fake.io)).toBe(0);
    expect(fake.asked).toEqual(["Cloudflare API token (Workers AI read + edit): "]);
    expect(api.calls[0]?.url).toContain("/accounts/acct-flag/ai/models/search");
    expect(await saved(fake, "cloudflare")).toMatchObject({ accountId: "acct-flag" });
  });

  it("accepts --key as the same token flow", async () => {
    const fake = fakeIo({ answers: { secret: [TOKEN] }, fetch: http().fetch });
    expect(await run(["login", "cloudflare", "--key", "--account-id", "acct-1"], fake.io)).toBe(0);
  });

  it.each([
    ["no token", { secret: [""], line: ["acct-1"] }],
    ["no account ID", { secret: [TOKEN], line: [""] }],
    ["end of input at the account ID", { secret: [TOKEN], line: [undefined] }],
  ])("returns 2 for %s and saves nothing", async (_name, answers) => {
    const api = http();
    const fake = fakeIo({ answers, fetch: api.fetch });
    expect(await run(["login", "cloudflare", "--key"], fake.io)).toBe(2);
    expect(api.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("returns 1 and saves nothing when Cloudflare rejects the token", async () => {
    const fake = fakeIo({
      answers: { secret: [TOKEN], line: ["acct-1"] },
      fetch: providers(() => json({ success: false, errors: [{ code: 10000 }] }, 403)).fetch,
    });
    expect(await run(["login", "cloudflare", "--key"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("error: auth: ");
    expect(await fake.secrets.list()).toEqual([]);
    expectNoSecrets(fake, [TOKEN]);
  });
});

describe("core login: Cloudflare in the browser", () => {
  const CLIENT = "oauth-client-1";
  const ACCESS = "cf-access-secret-aaa";
  const REFRESH = "cf-refresh-secret-bbb";

  function cloudflare(accounts: { id: string; name?: string }[], extra: Partial<FakeIoOptions> = {}) {
    const opened: string[] = [];
    const api = providers((call) => {
      if (call.url === "https://dash.cloudflare.com/oauth2/token") {
        return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
      }
      if (call.url === "https://api.cloudflare.com/client/v4/accounts") return json({ result: accounts });
      return json({ result: [{ name: "@cf/meta/m1" }] });
    });
    const options: FakeIoOptions = {
      env: { CORE_CLOUDFLARE_OAUTH_CLIENT_ID: CLIENT },
      fetch: api.fetch,
      openUrl: async (url) => {
        opened.push(url);
        await approve(url, "redirect_uri", (auth) => ({ code: "cf-code-ccc", state: auth.searchParams.get("state") ?? "" }));
      },
      ...extra,
    };
    return { api, opened, make: () => fakeIo(options) };
  }

  it("signs in with the only account, verifies with the new token, and saves an oauth record", async () => {
    const { api, opened, make } = cloudflare([{ id: "acct-1", name: "Personal" }]);
    const { code, fake } = await loginRetrying(["login", "cloudflare", "--browser"], make);
    expect(code).toBe(0);
    expect(fake.asked).toEqual([]);

    const auth = new URL(opened[0] ?? "");
    expect(`${auth.origin}${auth.pathname}`).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(auth.searchParams.get("client_id")).toBe(CLIENT);
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:8976/oauth/callback");

    const last = api.calls.at(-1);
    expect(last?.url).toContain("/accounts/acct-1/ai/models/search");
    expect(last?.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(fake.stdout()).toBe("Signed in to cloudflare (1 models available). Saved in memory.\n");
    expect(await saved(fake, "cloudflare")).toMatchObject({
      kind: "oauth",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accountId: "acct-1",
      clientId: CLIENT,
    });
    expect(fake.stderr()).toContain("Opening your browser to sign in to cloudflare.");
    expectNoSecrets(fake, [ACCESS, REFRESH, "cf-code-ccc"]);
  });

  it("takes the client ID from the config when the environment has none", async () => {
    const { api } = cloudflare([{ id: "acct-1" }]);
    const clientIds: string[] = [];
    const { code } = await loginRetrying(["login", "cloudflare", "--browser"], async () => {
      const fake = fakeIo({
        fetch: api.fetch,
        openUrl: async (url) => {
          clientIds.push(new URL(url).searchParams.get("client_id") ?? "");
          await approve(url, "redirect_uri", (auth) => ({ code: "cf-code-ccc", state: auth.searchParams.get("state") ?? "" }));
        },
      });
      await saveConfig(fake.io.configDir, { cloudflare: { oauthClientId: "config-client-2" } });
      return fake;
    });
    expect(code).toBe(0);
    expect(clientIds).toEqual(["config-client-2"]);
  });

  it("prefers the environment's client ID over the config's", async () => {
    const { api } = cloudflare([{ id: "acct-1" }]);
    const clientIds: string[] = [];
    const { code } = await loginRetrying(["login", "cloudflare", "--browser"], async () => {
      const fake = fakeIo({
        env: { CORE_CLOUDFLARE_OAUTH_CLIENT_ID: CLIENT },
        fetch: api.fetch,
        openUrl: async (url) => {
          clientIds.push(new URL(url).searchParams.get("client_id") ?? "");
          await approve(url, "redirect_uri", (auth) => ({ code: "cf-code-ccc", state: auth.searchParams.get("state") ?? "" }));
        },
      });
      await saveConfig(fake.io.configDir, { cloudflare: { oauthClientId: "config-client-2" } });
      return fake;
    });
    expect(code).toBe(0);
    expect(clientIds).toEqual([CLIENT]);
  });

  it("lets the user choose among several accounts, shown by name and id", async () => {
    const accounts = [{ id: "acct-1", name: "Personal" }, { id: "acct-2", name: "Work" }];
    const { make } = cloudflare(accounts);
    let asked: string[] = [];
    const { code, fake } = await loginRetrying(["login", "cloudflare", "--browser"], () => {
      const fake = make();
      fake.io.prompt.choose = async (question, options) => {
        asked = [question, ...options];
        return 1;
      };
      return fake;
    });
    expect(code).toBe(0);
    expect(asked).toEqual(["Which Cloudflare account?", "Personal (acct-1)", "Work (acct-2)"]);
    expect(await saved(fake, "cloudflare")).toMatchObject({ accountId: "acct-2" });
  });

  it("returns 2 when no account is chosen", async () => {
    const { make } = cloudflare([{ id: "acct-1" }, { id: "acct-2" }]);
    const { code, fake } = await loginRetrying(["login", "cloudflare", "--browser"], make);
    expect(code).toBe(2);
    expect(fake.stderr()).toContain("--account-id");
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("uses --account-id when it is one of the accounts, without asking", async () => {
    const { make } = cloudflare([{ id: "acct-1" }, { id: "acct-2" }]);
    const { code, fake } = await loginRetrying(["login", "cloudflare", "--browser", "--account-id", "acct-2"], make);
    expect(code).toBe(0);
    expect(fake.asked).toEqual([]);
    expect(await saved(fake, "cloudflare")).toMatchObject({ accountId: "acct-2" });
  });

  it("returns 1 and saves nothing when --account-id is not one of the accounts", async () => {
    const { make } = cloudflare([{ id: "acct-1", name: "Personal" }]);
    const { code, fake } = await loginRetrying(["login", "cloudflare", "--browser", "--account-id", "acct-9"], make);
    expect(code).toBe(1);
    expect(fake.stderr()).toContain("acct-9");
    expect(fake.stderr()).toContain("Personal (acct-1)");
    expect(await fake.secrets.list()).toEqual([]);
    expectNoSecrets(fake, [ACCESS, REFRESH]);
  });

  it("returns 1 when the sign-in has no accounts", async () => {
    const { make } = cloudflare([]);
    const { code, fake } = await loginRetrying(["login", "cloudflare", "--browser"], make);
    expect(code).toBe(1);
    expect(fake.stderr()).toContain("no accounts");
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("returns 1 when the reply does not match the request (state mismatch)", async () => {
    const { make } = cloudflare([{ id: "acct-1" }], {
      openUrl: async (url) => approve(url, "redirect_uri", () => ({ code: "cf-code-ccc", state: "forged" })),
    });
    const { code, fake } = await loginRetrying(["login", "cloudflare", "--browser"], make);
    expect(code).toBe(1);
    expect(fake.stderr()).toContain("did not match this request");
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("--no-open prints the URL instead of opening it", async () => {
    const { api } = cloudflare([{ id: "acct-1" }]);
    const opened: string[] = [];
    const login = loginRetrying(["login", "cloudflare", "--browser", "--no-open"], () => {
      const fake = fakeIo({ env: { CORE_CLOUDFLARE_OAUTH_CLIENT_ID: CLIENT }, fetch: api.fetch, openUrl: async (url) => void opened.push(url) });
      // Answer the callback as soon as the URL has been printed.
      void (async () => {
        await vi.waitFor(() => expect(fake.stderr()).toContain("https://dash.cloudflare.com/oauth2/auth?"));
        const printed = fake.stderr().split("\n").find((line) => line.startsWith("https://dash.cloudflare.com/oauth2/auth?"));
        await approve(printed ?? "", "redirect_uri", (auth) => ({ code: "cf-code-ccc", state: auth.searchParams.get("state") ?? "" }));
      })();
      return fake;
    });
    const { code } = await login;
    expect(code).toBe(0);
    expect(opened).toEqual([]);
  });
});
