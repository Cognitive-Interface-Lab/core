import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { CoreError, type StoredCredential } from "@core/contracts";
import {
  CLOUDFLARE_CALLBACK_PORT,
  CLOUDFLARE_DEFAULT_SCOPES,
  cloudflareRefresher,
  listCloudflareAccounts,
  signInCloudflare,
  signInOpenRouter,
  type OAuthCredential,
  type OpenUrl,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const clock = () => NOW;

type Call = { url: string; method: string; headers: Headers; body: string | undefined };
type Fake = { fetch: typeof fetch; calls: Call[] };

/** Plays the providers: records each call and answers with `handler`. The browser never goes through it. */
function fakeProviders(handler: (call: Call) => Response | Promise<Response>): Fake {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Plays the browser: parses the sign-in URL it is given and requests the callback at `redirectKey`
 * with the parameters `reply` chooses (or does nothing when `reply` returns undefined).
 */
function browser(
  redirectKey: "callback_url" | "redirect_uri",
  reply: (authUrl: URL) => Record<string, string> | undefined,
  seen: URL[] = [],
): OpenUrl {
  return async (opened) => {
    const authUrl = new URL(opened);
    seen.push(authUrl);
    const params = reply(authUrl);
    if (!params) return;
    const callback = new URL(authUrl.searchParams.get(redirectKey) ?? "");
    callback.hostname = "127.0.0.1";
    for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
    await (await fetch(callback)).text();
  };
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

const sha256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function expectNoSecrets(error: CoreError, secrets: string[]): void {
  const text = `${error.message} ${JSON.stringify(error.toJSON())}`;
  for (const secret of secrets) expect(text).not.toContain(secret);
}

async function callbackIsClosed(url: string): Promise<boolean> {
  try {
    await fetch(new URL(url.replace("localhost", "127.0.0.1")));
    return false;
  } catch {
    return true;
  }
}

describe("signInOpenRouter", () => {
  const KEY = "sk-or-v1-secret-key-value";
  const CODE = "or-code-1234567";

  it("opens the auth page with the S256 challenge, the callback and the default label", async () => {
    const seen: URL[] = [];
    const providers = fakeProviders(() => json({ key: KEY }));
    await signInOpenRouter({
      openUrl: browser("callback_url", () => ({ code: CODE }), seen),
      fetch: providers.fetch,
      timeoutMs: 5_000,
    });
    const url = seen[0];
    expect(`${url?.origin}${url?.pathname}`).toBe("https://openrouter.ai/auth");
    expect(url?.searchParams.get("callback_url")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(url?.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url?.searchParams.get("key_label")).toBe("core");
  });

  it("uses a custom key label", async () => {
    const seen: URL[] = [];
    await signInOpenRouter({
      openUrl: browser("callback_url", () => ({ code: CODE }), seen),
      fetch: fakeProviders(() => json({ key: KEY })).fetch,
      keyLabel: "my laptop",
      timeoutMs: 5_000,
    });
    expect(seen[0]?.searchParams.get("key_label")).toBe("my laptop");
  });

  it("exchanges the code with the verifier and returns an api-key record", async () => {
    const seen: URL[] = [];
    const providers = fakeProviders(() => json({ key: KEY }));
    const credential = await signInOpenRouter({
      openUrl: browser("callback_url", () => ({ code: CODE }), seen),
      fetch: providers.fetch,
      timeoutMs: 5_000,
    });
    expect(credential).toEqual({ kind: "api-key", apiKey: KEY });

    expect(providers.calls).toHaveLength(1);
    const call = providers.calls[0];
    expect(call?.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(call?.body ?? "{}") as Record<string, string>;
    expect(body["code"]).toBe(CODE);
    expect(body["code_challenge_method"]).toBe("S256");
    expect(sha256(body["code_verifier"] ?? "")).toBe(seen[0]?.searchParams.get("code_challenge"));
  });

  it("uses a different PKCE pair for every sign-in", async () => {
    const challenges: string[] = [];
    for (let i = 0; i < 2; i++) {
      const seen: URL[] = [];
      await signInOpenRouter({
        openUrl: browser("callback_url", () => ({ code: CODE }), seen),
        fetch: fakeProviders(() => json({ key: KEY })).fetch,
        timeoutMs: 5_000,
      });
      challenges.push(seen[0]?.searchParams.get("code_challenge") ?? "");
    }
    expect(challenges[0]).not.toBe(challenges[1]);
  });

  it("closes the callback server afterwards", async () => {
    const seen: URL[] = [];
    await signInOpenRouter({
      openUrl: browser("callback_url", () => ({ code: CODE }), seen),
      fetch: fakeProviders(() => json({ key: KEY })).fetch,
      timeoutMs: 5_000,
    });
    expect(await callbackIsClosed(seen[0]?.searchParams.get("callback_url") ?? "")).toBe(true);
  });

  it("fails with auth, and no exchange, when the callback has no code", async () => {
    const providers = fakeProviders(() => json({ key: KEY }));
    const error = await caught(
      signInOpenRouter({ openUrl: browser("callback_url", () => ({}), []), fetch: providers.fetch, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("auth");
    expect(error.message).toBe("OpenRouter sign-in was cancelled");
    expect(providers.calls).toHaveLength(0);
  });

  it("fails with auth, including OpenRouter's message, on a non-2xx exchange", async () => {
    const providers = fakeProviders(() => json({ error: { message: "Invalid code_verifier" } }, 400));
    const error = await caught(
      signInOpenRouter({ openUrl: browser("callback_url", () => ({ code: CODE })), fetch: providers.fetch, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("auth");
    expect(error.message).toContain("Invalid code_verifier");
    expect(error.message).toContain("400");
    expectNoSecrets(error, [CODE]);
  });

  it("keeps the code and verifier out of the message even when OpenRouter echoes them", async () => {
    let verifier = "";
    const providers = fakeProviders((call) => {
      verifier = (JSON.parse(call.body ?? "{}") as Record<string, string>)["code_verifier"] ?? "";
      return json({ error: { message: `bad exchange for code ${CODE} and verifier ${verifier}` } }, 403);
    });
    const error = await caught(
      signInOpenRouter({ openUrl: browser("callback_url", () => ({ code: CODE })), fetch: providers.fetch, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("auth");
    expect(verifier).not.toBe("");
    expectNoSecrets(error, [CODE, verifier]);
  });

  it("fails with auth on a non-2xx exchange without a readable body", async () => {
    const providers = fakeProviders(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await caught(
      signInOpenRouter({ openUrl: browser("callback_url", () => ({ code: CODE })), fetch: providers.fetch, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("auth");
  });

  it.each([
    ["no key", {}],
    ["an empty key", { key: "" }],
    ["a non-string key", { key: 7 }],
  ])("fails with auth when the response has %s", async (_name, body) => {
    const providers = fakeProviders(() => json(body));
    const error = await caught(
      signInOpenRouter({ openUrl: browser("callback_url", () => ({ code: CODE })), fetch: providers.fetch, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("auth");
  });

  it("fails with unavailable when the exchange cannot connect", async () => {
    const providers = fakeProviders(() => {
      throw new TypeError("fetch failed");
    });
    const error = await caught(
      signInOpenRouter({ openUrl: browser("callback_url", () => ({ code: CODE })), fetch: providers.fetch, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("unavailable");
    expectNoSecrets(error, [CODE]);
  });

  it("times out when the browser never comes back, and closes the server", async () => {
    const seen: URL[] = [];
    const error = await caught(
      signInOpenRouter({
        openUrl: browser("callback_url", () => undefined, seen),
        fetch: fakeProviders(() => json({ key: KEY })).fetch,
        timeoutMs: 40,
      }),
    );
    expect(error.code).toBe("timeout");
    expect(await callbackIsClosed(seen[0]?.searchParams.get("callback_url") ?? "")).toBe(true);
  });

  it("is cancelled by the abort signal", async () => {
    const controller = new AbortController();
    const error = await caught(
      signInOpenRouter({
        openUrl: () => controller.abort(),
        fetch: fakeProviders(() => json({ key: KEY })).fetch,
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    );
    expect(error.code).toBe("aborted");
  });

  it("fails with unavailable when the requested port is busy", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const error = await caught(
        signInOpenRouter({ openUrl: () => undefined, fetch: fakeProviders(() => json({})).fetch, port, timeoutMs: 100 }),
      );
      expect(error.code).toBe("unavailable");
      expect(error.message).toContain(String(port));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("signInCloudflare", () => {
  const CLIENT = "client-id-123";
  const CODE = "cf-code-abcdef";
  const ACCESS = "cf-access-token-secret";
  const REFRESH = "cf-refresh-token-secret";

  const accountsBody = { result: [{ id: "acct-1", name: "Personal" }, { id: "acct-2" }] };

  /** Token endpoint answers `token`, the accounts endpoint answers `accounts`. */
  function cloudflare(token: () => Response, accounts: () => Response = () => json(accountsBody)): Fake {
    return fakeProviders((call) => (call.url.startsWith("https://dash.cloudflare.com/oauth2/token") ? token() : accounts()));
  }

  const goodToken = () => json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: "bearer" });

  /** A browser that answers with the right code and the state it was given. */
  const approving = (seen: URL[] = []) =>
    browser("redirect_uri", (url) => ({ code: CODE, state: url.searchParams.get("state") ?? "" }), seen);

  const base = (providers: Fake) => ({ clientId: CLIENT, fetch: providers.fetch, port: 0, timeoutMs: 5_000, clock });

  it("pins the documented constants", () => {
    expect(CLOUDFLARE_CALLBACK_PORT).toBe(8976);
    expect(CLOUDFLARE_DEFAULT_SCOPES).toBe("account-settings.read ai.read ai.write");
  });

  it("opens the auth page with the PKCE and state parameters and the default scopes", async () => {
    const seen: URL[] = [];
    const providers = cloudflare(goodToken);
    await signInCloudflare({ ...base(providers), openUrl: approving(seen) });
    const url = seen[0];
    expect(`${url?.origin}${url?.pathname}`).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url?.searchParams.get("response_type")).toBe("code");
    expect(url?.searchParams.get("client_id")).toBe(CLIENT);
    expect(url?.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/oauth\/callback$/);
    expect(url?.searchParams.get("scope")).toBe(CLOUDFLARE_DEFAULT_SCOPES);
    expect(url?.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url?.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url?.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("uses custom scopes", async () => {
    const seen: URL[] = [];
    await signInCloudflare({ ...base(cloudflare(goodToken)), scopes: "ai.read", openUrl: approving(seen) });
    expect(seen[0]?.searchParams.get("scope")).toBe("ai.read");
  });

  it("uses port 8976 by default", async () => {
    const seen: URL[] = [];
    const options: Omit<ReturnType<typeof base>, "port"> & { port?: number } = base(cloudflare(goodToken));
    delete options.port;
    try {
      await signInCloudflare({ ...options, openUrl: approving(seen) });
    } catch (error) {
      // Something else on this machine holds the port; the default is still pinned by the constant above.
      if (CoreError.is(error) && error.code === "unavailable") return;
      throw error;
    }
    expect(seen[0]?.searchParams.get("redirect_uri")).toBe("http://localhost:8976/oauth/callback");
  });

  it("uses a different state and PKCE pair every time", async () => {
    const seen: URL[] = [];
    await signInCloudflare({ ...base(cloudflare(goodToken)), openUrl: approving(seen) });
    await signInCloudflare({ ...base(cloudflare(goodToken)), openUrl: approving(seen) });
    expect(seen[0]?.searchParams.get("state")).not.toBe(seen[1]?.searchParams.get("state"));
    expect(seen[0]?.searchParams.get("code_challenge")).not.toBe(seen[1]?.searchParams.get("code_challenge"));
  });

  it("exchanges the code as a form with the verifier, redirect URI and client id", async () => {
    const seen: URL[] = [];
    const providers = cloudflare(goodToken);
    await signInCloudflare({ ...base(providers), openUrl: approving(seen) });

    const tokenCall = providers.calls.find((call) => call.url === "https://dash.cloudflare.com/oauth2/token");
    expect(tokenCall?.method).toBe("POST");
    expect(tokenCall?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(tokenCall?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE);
    expect(form.get("client_id")).toBe(CLIENT);
    expect(form.get("redirect_uri")).toBe(seen[0]?.searchParams.get("redirect_uri"));
    expect(sha256(form.get("code_verifier") ?? "")).toBe(seen[0]?.searchParams.get("code_challenge"));
  });

  it("returns an oauth credential with the client id and no account, plus the accounts", async () => {
    const providers = cloudflare(goodToken);
    const { credential, accounts } = await signInCloudflare({ ...base(providers), openUrl: approving() });
    expect(credential).toEqual({
      kind: "oauth",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: NOW + 3_600_000,
      clientId: CLIENT,
    });
    expect(credential).not.toHaveProperty("accountId");
    expect(accounts).toEqual([
      { id: "acct-1", name: "Personal" },
      { id: "acct-2", name: "acct-2" },
    ]);
    const accountsCall = providers.calls.find((call) => call.url.startsWith("https://api.cloudflare.com/client/v4/accounts"));
    expect(accountsCall?.method).toBe("GET");
    expect(accountsCall?.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
  });

  it("follows the fake clock for expiresAt", async () => {
    const providers = cloudflare(() => json({ access_token: ACCESS, expires_in: 120 }));
    const { credential } = await signInCloudflare({ ...base(providers), clock: () => 5_000, openUrl: approving() });
    expect(credential).toMatchObject({ expiresAt: 5_000 + 120_000 });
  });

  it.each([
    ["missing", {}],
    ["zero", { expires_in: 0 }],
    ["negative", { expires_in: -5 }],
    ["a string", { expires_in: "3600" }],
    ["not finite", { expires_in: null }],
  ])("uses 60 seconds when expires_in is %s", async (_name, extra) => {
    const providers = cloudflare(() => json({ access_token: ACCESS, ...extra }));
    const { credential } = await signInCloudflare({ ...base(providers), openUrl: approving() });
    expect(credential).toMatchObject({ expiresAt: NOW + 60_000 });
  });

  it("accepts a token response without a refresh token", async () => {
    const providers = cloudflare(() => json({ access_token: ACCESS, expires_in: 3600 }));
    const { credential } = await signInCloudflare({ ...base(providers), openUrl: approving() });
    expect(credential).not.toHaveProperty("refreshToken");
  });

  it("closes the callback server afterwards", async () => {
    const seen: URL[] = [];
    await signInCloudflare({ ...base(cloudflare(goodToken)), openUrl: approving(seen) });
    expect(await callbackIsClosed(seen[0]?.searchParams.get("redirect_uri") ?? "")).toBe(true);
  });

  it("fails with auth on a state mismatch, without exchanging the code", async () => {
    const providers = cloudflare(goodToken);
    const error = await caught(
      signInCloudflare({ ...base(providers), openUrl: browser("redirect_uri", () => ({ code: CODE, state: "forged" })) }),
    );
    expect(error.code).toBe("auth");
    expect(error.message).toBe("the sign-in reply did not match this request; try again");
    expect(providers.calls).toHaveLength(0);
    expectNoSecrets(error, [CODE]);
  });

  it("fails with auth on a reply without a state", async () => {
    const providers = cloudflare(goodToken);
    const error = await caught(signInCloudflare({ ...base(providers), openUrl: browser("redirect_uri", () => ({ code: CODE })) }));
    expect(error.code).toBe("auth");
    expect(providers.calls).toHaveLength(0);
  });

  it("fails with auth, including the description, on an error callback", async () => {
    const providers = cloudflare(goodToken);
    const error = await caught(
      signInCloudflare({
        ...base(providers),
        openUrl: browser("redirect_uri", () => ({ error: "access_denied", error_description: "The user said no" })),
      }),
    );
    expect(error.code).toBe("auth");
    expect(error.message).toBe("Cloudflare sign-in failed: access_denied: The user said no");
    expect(providers.calls).toHaveLength(0);
  });

  it("fails with auth on an error callback without a description", async () => {
    const error = await caught(
      signInCloudflare({ ...base(cloudflare(goodToken)), openUrl: browser("redirect_uri", () => ({ error: "server_error" })) }),
    );
    expect(error.message).toBe("Cloudflare sign-in failed: server_error");
  });

  it("fails with auth when the state is right but the code is missing", async () => {
    const error = await caught(
      signInCloudflare({
        ...base(cloudflare(goodToken)),
        openUrl: browser("redirect_uri", (url) => ({ state: url.searchParams.get("state") ?? "" })),
      }),
    );
    expect(error.code).toBe("auth");
  });

  it("maps a rejected code to auth without echoing the code, verifier or tokens", async () => {
    let verifier = "";
    const providers = cloudflare(() => json({ error: "invalid_grant", error_description: `code ${CODE} is spent` }, 400));
    const original = providers.fetch;
    const spying = fakeProviders(async (call) => {
      if (call.body) verifier = new URLSearchParams(call.body).get("code_verifier") ?? verifier;
      return original(call.url, { method: call.method, headers: call.headers, ...(call.body ? { body: call.body } : {}) });
    });
    const error = await caught(signInCloudflare({ ...base(spying), openUrl: approving() }));
    expect(error.code).toBe("auth");
    expect(error.message).toContain("invalid_grant");
    expect(verifier).not.toBe("");
    expectNoSecrets(error, [CODE, verifier, ACCESS, REFRESH]);
  });

  it("maps a token endpoint failure with the shared status table", async () => {
    const error = await caught(
      signInCloudflare({ ...base(cloudflare(() => json({}, 503))), openUrl: approving() }),
    );
    expect(error.code).toBe("unavailable");
  });

  it("fails with auth when no access token comes back", async () => {
    const error = await caught(
      signInCloudflare({ ...base(cloudflare(() => json({ token_type: "bearer" }))), openUrl: approving() }),
    );
    expect(error.code).toBe("auth");
  });

  it("fails with unavailable when the token endpoint cannot be reached", async () => {
    const providers = fakeProviders(() => {
      throw new TypeError("fetch failed");
    });
    const error = await caught(signInCloudflare({ ...base(providers), openUrl: approving() }));
    expect(error.code).toBe("unavailable");
  });

  it("fails when the account listing is refused, without leaking the token", async () => {
    const error = await caught(
      signInCloudflare({ ...base(cloudflare(goodToken, () => json({ errors: [] }, 403))), openUrl: approving() }),
    );
    expect(error.code).toBe("auth");
    expectNoSecrets(error, [ACCESS, REFRESH]);
  });

  it("times out when the browser never comes back", async () => {
    const error = await caught(
      signInCloudflare({ ...base(cloudflare(goodToken)), timeoutMs: 40, openUrl: () => undefined }),
    );
    expect(error.code).toBe("timeout");
  });

  it("is cancelled by the abort signal", async () => {
    const controller = new AbortController();
    const error = await caught(
      signInCloudflare({ ...base(cloudflare(goodToken)), signal: controller.signal, openUrl: () => controller.abort() }),
    );
    expect(error.code).toBe("aborted");
  });
});

describe("listCloudflareAccounts", () => {
  it("lists id and name, falling back to the id, and skips entries without an id", async () => {
    const providers = fakeProviders(() =>
      json({ result: [{ id: "a1", name: "One" }, { id: "a2", name: "" }, { name: "no id" }, null, { id: "a3" }] }),
    );
    expect(await listCloudflareAccounts("tok-123456", { fetch: providers.fetch })).toEqual([
      { id: "a1", name: "One" },
      { id: "a2", name: "a2" },
      { id: "a3", name: "a3" },
    ]);
    expect(providers.calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts");
    expect(providers.calls[0]?.headers.get("authorization")).toBe("Bearer tok-123456");
  });

  it("returns an empty list for an account-less token", async () => {
    const providers = fakeProviders(() => json({ result: [] }));
    expect(await listCloudflareAccounts("tok-123456", { fetch: providers.fetch })).toEqual([]);
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "unavailable"],
  ] as const)("maps HTTP %i to %s without the token", async (status, code) => {
    const providers = fakeProviders(() => json({ errors: [{ message: "tok-123456 rejected" }] }, status));
    const error = await caught(listCloudflareAccounts("tok-123456", { fetch: providers.fetch }));
    expect(error.code).toBe(code);
    expectNoSecrets(error, ["tok-123456"]);
  });

  it.each([
    ["no result", {}],
    ["a non-array result", { result: "x" }],
  ])("gives unknown for %s", async (_name, body) => {
    const providers = fakeProviders(() => json(body));
    expect((await caught(listCloudflareAccounts("tok-123456", { fetch: providers.fetch }))).code).toBe("unknown");
  });

  it("gives unknown for a body that is not JSON", async () => {
    const providers = fakeProviders(() => new Response("<html>", { status: 200 }));
    expect((await caught(listCloudflareAccounts("tok-123456", { fetch: providers.fetch }))).code).toBe("unknown");
  });

  it("gives unavailable when the request cannot connect", async () => {
    const providers = fakeProviders(() => {
      throw new TypeError("fetch failed");
    });
    expect((await caught(listCloudflareAccounts("tok-123456", { fetch: providers.fetch }))).code).toBe("unavailable");
  });
});

describe("cloudflareRefresher", () => {
  const REFRESH = "cf-refresh-token-old";
  const NEW_REFRESH = "cf-refresh-token-new";
  const ACCESS = "cf-access-token-old";
  const NEW_ACCESS = "cf-access-token-new";

  const current: OAuthCredential = {
    kind: "oauth",
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: NOW - 1_000,
    accountId: "acct-1",
    clientId: "client-1",
  };

  it("posts the refresh grant to the token URL", async () => {
    const providers = fakeProviders(() => json({ access_token: NEW_ACCESS, expires_in: 3600 }));
    await cloudflareRefresher({ fetch: providers.fetch, clock })(current);
    expect(providers.calls).toHaveLength(1);
    const call = providers.calls[0];
    expect(call?.url).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call?.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: "client-1" });
  });

  it("keeps the old refresh token, the account id and the client id when none are returned", async () => {
    const providers = fakeProviders(() => json({ access_token: NEW_ACCESS, expires_in: 3600 }));
    const renewed: StoredCredential = await cloudflareRefresher({ fetch: providers.fetch, clock })(current);
    expect(renewed).toEqual({
      kind: "oauth",
      accessToken: NEW_ACCESS,
      refreshToken: REFRESH,
      expiresAt: NOW + 3_600_000,
      accountId: "acct-1",
      clientId: "client-1",
    });
  });

  it("takes the new refresh token when one is returned", async () => {
    const providers = fakeProviders(() => json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 60 }));
    const renewed = await cloudflareRefresher({ fetch: providers.fetch, clock })(current);
    expect(renewed).toMatchObject({ refreshToken: NEW_REFRESH, expiresAt: NOW + 60_000 });
  });

  it("uses 60 seconds when expires_in is missing, and omits accountId when there was none", async () => {
    const withoutAccount: OAuthCredential = { ...current };
    delete withoutAccount.accountId;
    const providers = fakeProviders(() => json({ access_token: NEW_ACCESS }));
    const renewed = await cloudflareRefresher({ fetch: providers.fetch, clock })(withoutAccount);
    expect(renewed).toMatchObject({ expiresAt: NOW + 60_000 });
    expect(renewed).not.toHaveProperty("accountId");
  });

  it.each([
    ["a refresh token", { refreshToken: undefined }],
    ["a client id", { clientId: undefined }],
  ])("fails with auth, without calling Cloudflare, when the record has no %s", async (_name, patch) => {
    const providers = fakeProviders(() => json({ access_token: NEW_ACCESS }));
    const incomplete = { ...current, ...patch } as OAuthCredential;
    const error = await caught(cloudflareRefresher({ fetch: providers.fetch, clock })(incomplete));
    expect(error.code).toBe("auth");
    expect(providers.calls).toHaveLength(0);
  });

  it("maps invalid_grant to auth without the tokens", async () => {
    const providers = fakeProviders(() =>
      json({ error: "invalid_grant", error_description: `refresh token ${REFRESH} was revoked` }, 400),
    );
    const error = await caught(cloudflareRefresher({ fetch: providers.fetch, clock })(current));
    expect(error.code).toBe("auth");
    expect(error.message).toContain("invalid_grant");
    expectNoSecrets(error, [REFRESH, ACCESS]);
  });

  it("maps a fetch rejection to unavailable", async () => {
    const providers = fakeProviders(() => {
      throw new TypeError(`fetch failed for ${REFRESH}`);
    });
    const error = await caught(cloudflareRefresher({ fetch: providers.fetch, clock })(current));
    expect(error.code).toBe("unavailable");
    expectNoSecrets(error, [REFRESH, ACCESS]);
  });

  it("maps a server error to unavailable", async () => {
    const providers = fakeProviders(() => json({}, 500));
    expect((await caught(cloudflareRefresher({ fetch: providers.fetch, clock })(current))).code).toBe("unavailable");
  });

  it("fails with auth when no access token comes back", async () => {
    const providers = fakeProviders(() => json({}));
    expect((await caught(cloudflareRefresher({ fetch: providers.fetch, clock })(current))).code).toBe("auth");
  });
});
