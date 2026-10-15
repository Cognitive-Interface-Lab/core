import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESETS } from "@core/models";
import { DEFAULT_CLOUDFLARE_OAUTH_CLIENT_ID, KEY_PAGES } from "../src/commands/login.js";
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

describe("core login: Cloudflare's built-in OAuth client", () => {
  const ACCESS = "cf-access-builtin-ddd";
  const REFRESH = "cf-refresh-builtin-eee";

  const http = () =>
    providers((call) => {
      if (call.url === "https://dash.cloudflare.com/oauth2/token") {
        return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
      }
      if (call.url === "https://api.cloudflare.com/client/v4/accounts") return json({ result: [{ id: "acct-1", name: "Personal" }] });
      return json({ result: [{ name: "@cf/meta/m1" }] });
    });

  /** Runs `login cloudflare` with no flags; returns the client_id of each opened sign-in URL. */
  async function signIn(env: Record<string, string>, configClientId?: string) {
    const api = http();
    const clientIds: string[] = [];
    const opened: string[] = [];
    const result = await loginRetrying(["login", "cloudflare"], async () => {
      const fake = fakeIo({
        env,
        fetch: api.fetch,
        openUrl: async (url) => {
          opened.push(url);
          clientIds.push(new URL(url).searchParams.get("client_id") ?? "");
          await approve(url, "redirect_uri", (auth) => ({ code: "cf-code-fff", state: auth.searchParams.get("state") ?? "" }));
        },
      });
      if (configClientId !== undefined) await saveConfig(fake.io.configDir, { cloudflare: { oauthClientId: configClientId } });
      return fake;
    });
    return { ...result, clientIds, opened };
  }

  it("signs in through the browser with the built-in client ID and no setup", async () => {
    const { code, fake, clientIds, opened } = await signIn({});
    expect(code).toBe(0);
    const auth = new URL(opened.at(-1) ?? "");
    expect(`${auth.origin}${auth.pathname}`).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(clientIds.at(-1)).toBe(DEFAULT_CLOUDFLARE_OAUTH_CLIENT_ID);
    expect(fake.asked).toEqual([]);
    expect(await saved(fake, "cloudflare")).toMatchObject({ kind: "oauth", accountId: "acct-1" });
    expectNoSecrets(fake, [ACCESS, REFRESH, "cf-code-fff"]);
  });

  it("prefers the config's client ID over the built-in one", async () => {
    const { code, clientIds } = await signIn({}, "config-client-7");
    expect(code).toBe(0);
    expect(clientIds.at(-1)).toBe("config-client-7");
  });

  it("prefers the environment's client ID over the config's", async () => {
    const { code, clientIds } = await signIn({ CORE_CLOUDFLARE_OAUTH_CLIENT_ID: "env-client-8" }, "config-client-7");
    expect(code).toBe(0);
    expect(clientIds.at(-1)).toBe("env-client-8");
  });
});

describe("core login: key pages", () => {
  const LABELS: Record<string, string> = {
    openai: "OpenAI",
    groq: "Groq",
    vercel: "Vercel AI Gateway",
    openrouter: "OpenRouter",
    cloudflare: "Cloudflare",
  };

  const anyProvider = () =>
    providers((call) =>
      call.url.startsWith("https://api.cloudflare.com/") ? json({ result: [{ name: "@cf/meta/m1" }] }) : modelList(["m1", "m2"]),
    );

  it.each(["openai", "groq", "vercel"])("%s opens its key page, then asks for the key", async (provider) => {
    const fake = fakeIo({ interactive: true, answers: { secret: ["key-page-value-1"] }, fetch: anyProvider().fetch });
    expect(await run(["login", provider], fake.io)).toBe(0);
    expect(fake.opened).toEqual([KEY_PAGES[provider]]);
    expect(fake.stderr()).toContain(`Create a ${LABELS[provider]} API key on this page, then paste it below:`);
    expect(fake.stderr()).toContain(KEY_PAGES[provider]);
    expect(await saved(fake, provider)).toEqual({ kind: "api-key", apiKey: "key-page-value-1" });
  });

  it.each([
    ["openrouter", ["login", "openrouter", "--key"]],
    ["cloudflare", ["login", "cloudflare", "--key", "--account-id", "acct-1"]],
  ])("%s with --key opens its key page", async (provider, argv) => {
    const fake = fakeIo({ interactive: true, answers: { secret: ["key-page-value-2"] }, fetch: anyProvider().fetch });
    expect(await run(argv, fake.io)).toBe(0);
    expect(fake.opened).toEqual([KEY_PAGES[provider]]);
    expect(fake.stderr()).toContain(`Create a ${LABELS[provider]} API key on this page, then paste it below:`);
  });

  it("--no-open prints the key page without opening it", async () => {
    const fake = fakeIo({ interactive: true, answers: { secret: ["key-page-value-3"] }, fetch: anyProvider().fetch });
    expect(await run(["login", "openai", "--no-open"], fake.io)).toBe(0);
    expect(fake.opened).toEqual([]);
    expect(fake.stderr()).toContain(KEY_PAGES["openai"]);
  });

  it("opens and prints nothing when the key comes from piped input", async () => {
    const fake = fakeIo({ interactive: false, answers: { secret: ["key-page-value-4"] }, fetch: anyProvider().fetch });
    expect(await run(["login", "openai"], fake.io)).toBe(0);
    expect(fake.opened).toEqual([]);
    expect(fake.stderr()).toBe("");
  });

  it("opens no key page on the browser path", async () => {
    const opened: string[] = [];
    const http = providers((call) =>
      call.url === "https://openrouter.ai/api/v1/auth/keys" ? json({ key: "sk-or-issued-key-999" }) : modelList(["a"]),
    );
    const fake = fakeIo({
      interactive: true,
      fetch: http.fetch,
      openUrl: async (url) => {
        opened.push(url);
        await approve(url, "callback_url", () => ({ code: "the-code-000" }));
      },
    });
    expect(await run(["login", "openrouter"], fake.io)).toBe(0);
    expect(opened).toHaveLength(1);
    const auth = new URL(opened[0] ?? "");
    expect(`${auth.origin}${auth.pathname}`).toBe("https://openrouter.ai/auth");
  });

  it("has a key page for every preset that needs a key", () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      if (preset.requiresKey) expect(Object.keys(KEY_PAGES)).toContain(id);
    }
  });
});

describe("core login: Vercel AI Gateway", () => {
  it("verifies the key against the gateway's /models and saves it", async () => {
    const http = providers(() => modelList(["anthropic/claude-sonnet-4", "openai/gpt-5", "xai/grok-4"]));
    const fake = fakeIo({ answers: { secret: ["vck-secret-777"] }, fetch: http.fetch });
    expect(await run(["login", "vercel"], fake.io)).toBe(0);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/models");
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer vck-secret-777");
    expect(fake.stdout()).toContain("Signed in to vercel (3 models available).");
    expect(await saved(fake, "vercel")).toEqual({ kind: "api-key", apiKey: "vck-secret-777" });
    expectNoSecrets(fake, ["vck-secret-777"]);
  });

  it("has no browser sign-in", async () => {
    const fake = fakeIo({ fetch: providers(() => modelList(["m"])).fetch });
    expect(await run(["login", "vercel", "--browser"], fake.io)).toBe(2);
    expect(await fake.secrets.list()).toEqual([]);
  });
});

describe("core login: Anthropic", () => {
  const claudeModels = (ids: string[]) =>
    json({ data: ids.map((id) => ({ type: "model", id })), has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null });

  const SYNOPSIS = "usage: core login <provider> [--key] [--browser] [--account-id <id>] [--no-open]";

  it("opens the Claude Console key page, asks for the key, verifies it against /models and saves it", async () => {
    const http = providers(() => claudeModels(["claude-sonnet-4-5", "claude-opus-5-5", "claude-haiku-4-5"]));
    const fake = fakeIo({ interactive: true, answers: { secret: ["sk-ant-secret-111"] }, fetch: http.fetch });

    expect(await run(["login", "anthropic"], fake.io)).toBe(0);

    expect(fake.opened).toEqual(["https://platform.claude.com/settings/keys"]);
    expect(fake.stderr()).toContain("Create a Anthropic API key on this page, then paste it below:");
    expect(fake.stderr()).toContain("https://platform.claude.com/settings/keys");
    expect(fake.asked).toEqual(["Anthropic API key: "]);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.method).toBe("GET");
    expect(http.calls[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(http.calls[0]?.headers.get("x-api-key")).toBe("sk-ant-secret-111");
    expect(http.calls[0]?.headers.has("authorization")).toBe(false);
    expect(fake.stdout()).toBe("Signed in to anthropic (3 models available). Saved in memory.\n");
    expect(await saved(fake, "anthropic")).toEqual({ kind: "api-key", apiKey: "sk-ant-secret-111" });
    expectNoSecrets(fake, ["sk-ant-secret-111"]);
  });

  it("--no-open prints the key page without opening it", async () => {
    const fake = fakeIo({ interactive: true, answers: { secret: ["sk-ant-secret-112"] }, fetch: providers(() => claudeModels(["m"])).fetch });
    expect(await run(["login", "anthropic", "--no-open"], fake.io)).toBe(0);
    expect(fake.opened).toEqual([]);
    expect(fake.stderr()).toContain("https://platform.claude.com/settings/keys");
  });

  it("opens and prints nothing when the key comes from piped input, and trims it", async () => {
    const http = providers(() => claudeModels(["m"]));
    const fake = fakeIo({ interactive: false, answers: { secret: ["  sk-ant-secret-113  "] }, fetch: http.fetch });
    expect(await run(["login", "anthropic"], fake.io)).toBe(0);
    expect(fake.opened).toEqual([]);
    expect(fake.stderr()).toBe("");
    expect(http.calls[0]?.headers.get("x-api-key")).toBe("sk-ant-secret-113");
    expect(await saved(fake, "anthropic")).toEqual({ kind: "api-key", apiKey: "sk-ant-secret-113" });
  });

  it("accepts --key", async () => {
    const fake = fakeIo({ answers: { secret: ["sk-ant-secret-114"] }, fetch: providers(() => claudeModels(["m"])).fetch });
    expect(await run(["login", "anthropic", "--key"], fake.io)).toBe(0);
    expect(await saved(fake, "anthropic")).toEqual({ kind: "api-key", apiKey: "sk-ant-secret-114" });
  });

  it("returns 2 and saves nothing for an empty key", async () => {
    const http = providers(() => claudeModels(["m"]));
    const fake = fakeIo({ answers: { secret: ["   "] }, fetch: http.fetch });
    expect(await run(["login", "anthropic"], fake.io)).toBe(2);
    expect(http.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("lists the models with the AWS region and workspace for anthropic-aws, and saves all three", async () => {
    const http = providers(() => claudeModels(["claude-opus-5-5", "claude-haiku-4-5"]));
    const fake = fakeIo({
      interactive: true,
      answers: { line: ["  us-west-2 ", " wrkspc_01 "], secret: ["  sk-aws-secret-211  "] },
      fetch: http.fetch,
    });

    expect(await run(["login", "anthropic-aws"], fake.io)).toBe(0);

    expect(fake.opened).toEqual(["https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws"]);
    expect(fake.stderr()).toContain("Create a Claude Platform on AWS API key on this page, then paste it below:");
    expect(fake.asked).toEqual([
      "AWS region (for example us-west-2): ",
      "Claude workspace ID: ",
      "Claude Platform on AWS API key: ",
    ]);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe("https://aws-external-anthropic.us-west-2.api.aws/v1/models?limit=1000");
    expect(http.calls[0]?.headers.get("x-api-key")).toBe("sk-aws-secret-211");
    expect(http.calls[0]?.headers.get("anthropic-workspace-id")).toBe("wrkspc_01");
    expect(fake.stdout()).toBe("Signed in to anthropic-aws (2 models available). Saved in memory.\n");
    expect(await saved(fake, "anthropic-aws")).toEqual({
      kind: "api-key",
      apiKey: "sk-aws-secret-211",
      region: "us-west-2",
      workspaceId: "wrkspc_01",
    });
    expectNoSecrets(fake, ["sk-aws-secret-211"]);
  });

  it.each([["US West"], ["a/b"], ["us_west_2"], ["us-west-2.evil.example"]])(
    "returns 2 for the region %j, asks nothing more, sends nothing and saves nothing",
    async (region) => {
      const http = providers(() => claudeModels(["m"]));
      const fake = fakeIo({ answers: { line: [region, "wrkspc_01"], secret: ["sk-aws-secret-212"] }, fetch: http.fetch });

      expect(await run(["login", "anthropic-aws"], fake.io)).toBe(2);

      expect(fake.stderr()).toContain(`not an AWS region: ${region}`);
      expect(fake.asked).toEqual(["AWS region (for example us-west-2): "]);
      expect(http.calls).toHaveLength(0);
      expect(await fake.secrets.list()).toEqual([]);
      expectNoSecrets(fake, ["sk-aws-secret-212"]);
    },
  );

  it.each([
    ["no region", { line: ["  "], secret: ["sk-aws-secret-213"] }],
    ["no workspace ID", { line: ["us-west-2", "  "], secret: ["sk-aws-secret-213"] }],
    ["no key", { line: ["us-west-2", "wrkspc_01"], secret: ["  "] }],
  ])("returns 2 and saves nothing for %s", async (_name, answers) => {
    const http = providers(() => claudeModels(["m"]));
    const fake = fakeIo({ answers, fetch: http.fetch });
    expect(await run(["login", "anthropic-aws"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("nothing entered");
    expect(http.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it("saves nothing, exits non-zero with auth, and never prints the key when the workspace ID is wrong", async () => {
    const http = providers(() =>
      json({ type: "error", error: { type: "permission_error", message: "no access for sk-aws-secret-214" } }, 403),
    );
    const fake = fakeIo({ answers: { line: ["us-west-2", "wrkspc_wrong"], secret: ["sk-aws-secret-214"] }, fetch: http.fetch });

    const code = await run(["login", "anthropic-aws"], fake.io);

    expect(code).not.toBe(0);
    expect(fake.stderr()).toContain("auth");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.headers.get("anthropic-workspace-id")).toBe("wrkspc_wrong");
    expect(await fake.secrets.list()).toEqual([]);
    expectNoSecrets(fake, ["sk-aws-secret-214"]);
  });

  it("saves nothing and exits non-zero with auth for a rejected Anthropic key", async () => {
    const http = providers(() => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    const fake = fakeIo({ answers: { secret: ["sk-ant-secret-115"] }, fetch: http.fetch });
    expect(await run(["login", "anthropic"], fake.io)).not.toBe(0);
    expect(fake.stderr()).toContain("auth");
    expect(await fake.secrets.list()).toEqual([]);
    expectNoSecrets(fake, ["sk-ant-secret-115"]);
  });

  it.each(["anthropic", "anthropic-aws"])("returns 2 for %s with --browser, since it has no browser sign-in", async (provider) => {
    const http = providers(() => claudeModels(["m"]));
    const fake = fakeIo({ fetch: http.fetch });
    expect(await run(["login", provider, "--browser"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain(`${provider} has no browser sign-in`);
    expect(http.calls).toHaveLength(0);
    expect(await fake.secrets.list()).toEqual([]);
  });

  it.each(["anthropic", "anthropic-aws"])("returns 2 for %s with --account-id, which is Cloudflare's", async (provider) => {
    const fake = fakeIo({ fetch: providers(() => claudeModels(["m"])).fetch });
    expect(await run(["login", provider, "--account-id", "acct"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("--account-id only applies to cloudflare");
  });

  it("warns when an environment variable of anthropic-aws will take precedence over the saved sign-in", async () => {
    const fake = fakeIo({
      env: { CORE_ANTHROPIC_AWS_REGION: "eu-west-1" },
      answers: { line: ["us-west-2", "wrkspc_01"], secret: ["sk-aws-secret-215"] },
      fetch: providers(() => claudeModels(["m"])).fetch,
    });
    expect(await run(["login", "anthropic-aws"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain("warning: CORE_ANTHROPIC_AWS_REGION is set and takes precedence over the saved sign-in");
  });

  it("keeps the synopsis line byte-identical and lists both providers in the help", async () => {
    const fake = fakeIo();
    expect(await run(["login", "--help"], fake.io)).toBe(0);
    const lines = fake.stdout().split("\n");
    expect(lines[0]).toBe(SYNOPSIS);
    expect(lines).toContain("  anthropic             paste an API key; core opens the page that creates one");
    expect(lines).toContain("  anthropic-aws         Claude Platform on AWS: asks for region, workspace ID and API key");
    // The new lines sit at the same column as the existing ones.
    const column = (name: string) => (lines.find((line) => line.startsWith(`  ${name} `)) ?? "").search(/\S/, name.length + 2);
    expect(column("anthropic")).toBe(column("openrouter"));
    expect(column("anthropic-aws")).toBe(column("openrouter"));
  });
});
