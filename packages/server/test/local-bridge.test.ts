import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody, Principal } from "@core/contracts";
import { MemoryCredentialStore } from "@core/models";
import { ServeTokens, localBridge, type PairApprover, type TokenSecrets } from "../src/index.js";
import { BASE_URL, createTestHandler, readJson, registryOf } from "./helpers.js";

const PORT = 8977;
const LOCAL_TOKEN = "local-token-for-tests";
const APP_A = "https://app-a.example";
const APP_B = "https://app-b.example";
const CODE = "ABC234";

/** A Map-backed `TokenSecrets`; the map is exposed so tests can look at what is stored. */
function memorySecrets(): TokenSecrets & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (name) => store.get(name),
    set: async (name, value) => {
      store.set(name, value);
    },
    delete: async (name) => store.delete(name),
    list: async () => [...store.keys()],
  };
}

interface Setup {
  secrets: ReturnType<typeof memorySecrets>;
  tokens: ServeTokens;
  bridge: ReturnType<typeof localBridge>;
  fetch: (request: Request) => Promise<Response>;
  seen: Principal[];
}

function setup(options: { approve?: PairApprover; now?: () => number } = {}): Setup {
  const secrets = memorySecrets();
  const tokens = new ServeTokens(secrets);
  const seen: Principal[] = [];
  const bridge = localBridge({
    port: PORT,
    tokens,
    localToken: LOCAL_TOKEN,
    approve: options.approve ?? (async () => true),
    ...(options.now !== undefined && { now: options.now }),
  });
  const handler = createTestHandler({
    middleware: [bridge.middleware],
    authenticate: bridge.authenticate,
    credentialsFor: (principal) => {
      seen.push(principal);
      return new MemoryCredentialStore();
    },
    registryFor: () => registryOf(),
  });
  return { secrets, tokens, bridge, fetch: (request) => handler.fetch(request), seen };
}

interface CallOptions {
  host?: string;
  origin?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** A request with an explicit Host header (a bare `new Request(url)` in Node carries none). */
function call(method: string, path: string, options: CallOptions = {}): Request {
  const headers = new Headers(options.headers);
  headers.set("host", options.host ?? `127.0.0.1:${PORT}`);
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function preflight(path: string, origin: string, extra: Record<string, string> = {}): Request {
  return call("OPTIONS", path, {
    origin,
    headers: { "access-control-request-method": "POST", ...extra },
  });
}

/** Pairs `origin` through the handler and returns the issued token. */
async function pair(s: Setup, origin: string): Promise<string> {
  const response = await s.fetch(call("POST", "/v1/pair", { origin, body: { code: CODE, name: "Test app" } }));
  expect(response.status).toBe(200);
  const body = await readJson<{ origin: string; token: string }>(response);
  expect(body.origin).toBe(origin);
  return body.token;
}

async function errorCode(response: Response): Promise<string> {
  const body = await readJson<ApiErrorBody>(response);
  expect(body.ok).toBe(false);
  return body.error.code;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("host check", () => {
  it("answers 421 for a foreign host or port and passes localhost and 127.0.0.1 on the bridge port", async () => {
    const s = setup();
    const foreign = await s.fetch(call("GET", "/v1/health", { host: "evil.example:8977" }));
    expect(foreign.status).toBe(421);
    const wrongPort = await s.fetch(call("GET", "/v1/health", { host: "127.0.0.1:9999" }));
    expect(wrongPort.status).toBe(421);

    const localhost = await s.fetch(call("GET", "/v1/health", { host: "localhost:8977" }));
    expect(localhost.status).toBe(200);
    const loopback = await s.fetch(call("GET", "/v1/health", { host: "127.0.0.1:8977" }));
    expect(loopback.status).toBe(200);
  });
});

describe("origin gate", () => {
  it("answers 403 auth without an allow-origin header for an unpaired origin", async () => {
    const s = setup();
    const response = await s.fetch(call("GET", "/v1/providers", { origin: APP_A }));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await errorCode(response)).toBe("auth");
  });

  it("answers CORS for a paired origin on every answer, even a 401", async () => {
    const s = setup();
    await pair(s, APP_A);
    const response = await s.fetch(call("GET", "/v1/providers", { origin: APP_A, token: "wrong" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_A);
    expect(response.headers.get("vary") ?? "").toMatch(/origin/i);
  });
});

describe("pairing", () => {
  it("lets an unpaired https origin preflight /v1/pair but refuses to pair http://evil.example", async () => {
    const s = setup();
    const allowed = await s.fetch(preflight("/v1/pair", APP_A));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(APP_A);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE");
    expect(allowed.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    expect(allowed.headers.get("access-control-max-age")).toBe("600");

    const evil = "http://evil.example";
    const refusedPreflight = await s.fetch(preflight("/v1/pair", evil));
    expect(refusedPreflight.status).toBe(403);
    const refused = await s.fetch(call("POST", "/v1/pair", { origin: evil, body: { code: CODE } }));
    expect(refused.status).toBe(403);
    expect(await s.tokens.origins()).toEqual([]);
  });

  it("answers 400 to POST and DELETE /v1/pair without an Origin", async () => {
    const s = setup();
    const posted = await s.fetch(call("POST", "/v1/pair", { token: LOCAL_TOKEN, body: { code: CODE } }));
    expect(posted.status).toBe(400);
    const deleted = await s.fetch(call("DELETE", "/v1/pair", { token: LOCAL_TOKEN }));
    expect(deleted.status).toBe(400);
  });

  it("issues a token on approval, and the token works only with its own origin", async () => {
    const approve = vi.fn<PairApprover>(async () => true);
    const s = setup({ approve });
    const tokenA = await pair(s, APP_A);
    const tokenB = await pair(s, APP_B);
    expect(tokenA).not.toBe(tokenB);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ origin: APP_A, code: CODE, name: "Test app" });
    expect(await s.tokens.origins()).toEqual([APP_A, APP_B]);

    const own = await s.fetch(call("GET", "/v1/providers", { origin: APP_A, token: tokenA }));
    expect(own.status).toBe(200);
    expect(own.headers.get("access-control-allow-origin")).toBe(APP_A);

    const crossed = await s.fetch(call("GET", "/v1/providers", { origin: APP_B, token: tokenA }));
    expect(crossed.status).toBe(401);
    expect(await errorCode(crossed)).toBe("auth");
  });

  it("answers 403 auth when the approver denies, then 429 within 60 s, then allows again", async () => {
    let clock = 1_000_000;
    let answer = false;
    const s = setup({ approve: async () => answer, now: () => clock });

    const denied = await s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: CODE } }));
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("auth");
    expect(denied.headers.get("access-control-allow-origin")).toBe(APP_A);

    answer = true;
    clock += 30_000;
    const tooSoon = await s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: CODE } }));
    expect(tooSoon.status).toBe(429);
    expect(await errorCode(tooSoon)).toBe("rate_limit");
    expect(tooSoon.headers.get("access-control-allow-origin")).toBe(APP_A);

    clock += 31_000;
    const later = await s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: CODE } }));
    expect(later.status).toBe(200);
    expect((await readJson<{ origin: string }>(later)).origin).toBe(APP_A);
  });

  it("answers 429 rate_limit to a second pairing while one is pending", async () => {
    let release: (approved: boolean) => void = () => {};
    let started: () => void = () => {};
    const approverCalled = new Promise<void>((resolve) => {
      started = resolve;
    });
    const approve: PairApprover = (request) => {
      if (request.origin === APP_A) {
        started();
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(true);
    };
    const s = setup({ approve });

    const first = s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: CODE } }));
    await approverCalled;

    const second = await s.fetch(call("POST", "/v1/pair", { origin: APP_B, body: { code: "XYZ234" } }));
    expect(second.status).toBe(429);
    expect(await errorCode(second)).toBe("rate_limit");

    release(true);
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect((await readJson<{ origin: string }>(firstResponse)).origin).toBe(APP_A);
  });

  it("answers 504 timeout after 120 s and aborts the approver's signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let started: () => void = () => {};
    const approverCalled = new Promise<void>((resolve) => {
      started = resolve;
    });
    const s = setup({
      approve: (_request, abortSignal) => {
        signal = abortSignal;
        started();
        return new Promise<boolean>(() => {});
      },
    });

    const pending = s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: CODE } }));
    await approverCalled;
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    const response = await pending;
    expect(response.status).toBe(504);
    expect(await errorCode(response)).toBe("timeout");
    expect(signal?.aborted).toBe(true);
    expect(await s.tokens.origins()).toEqual([]);
  });

  it("a disconnect while the approver waits answers 499 aborted, aborts its signal and frees the slot at once, even when the approver ignores the signal", async () => {
    let signal: AbortSignal | undefined;
    let started: () => void = () => {};
    const approverCalled = new Promise<void>((resolve) => {
      started = resolve;
    });
    const approve: PairApprover = (request, abortSignal) => {
      if (request.origin === APP_A) {
        signal = abortSignal;
        started();
        return new Promise<boolean>(() => {});
      }
      return Promise.resolve(true);
    };
    const s = setup({ approve });

    const controller = new AbortController();
    const pending = s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: CODE }, signal: controller.signal }));
    await approverCalled;
    expect(signal?.aborted).toBe(false);

    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await errorCode(response)).toBe("aborted");
    expect(signal?.aborted).toBe(true);
    expect(await s.tokens.origins()).toEqual([]);

    // No timers advanced: the pending slot is already free for the next pairing.
    const next = await s.fetch(call("POST", "/v1/pair", { origin: APP_B, body: { code: CODE } }));
    expect(next.status).toBe(200);
    expect((await readJson<{ origin: string }>(next)).origin).toBe(APP_B);
  });

  it("an already-aborted request does not call the approver", async () => {
    const approve = vi.fn<PairApprover>(async () => true);
    const s = setup({ approve });

    const response = await s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: CODE }, signal: AbortSignal.abort() }));
    expect(response.status).toBe(499);
    expect(await errorCode(response)).toBe("aborted");
    expect(approve).not.toHaveBeenCalled();
    expect(await s.tokens.origins()).toEqual([]);

    // The aborted request holds no slot.
    const next = await s.fetch(call("POST", "/v1/pair", { origin: APP_B, body: { code: CODE } }));
    expect(next.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("a malformed pairing body answers 400 with CORS", async () => {
    const approve = vi.fn<PairApprover>(async () => true);
    const s = setup({ approve });

    const invalidJson = await s.fetch(
      new Request(`${BASE_URL}/v1/pair`, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, origin: APP_A, "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.headers.get("access-control-allow-origin")).toBe(APP_A);

    const badCode = await s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code: "bad" } }));
    expect(badCode.status).toBe(400);
    expect(badCode.headers.get("access-control-allow-origin")).toBe(APP_A);
    expect(approve).not.toHaveBeenCalled();
  });

  it("rejects a malformed pairing code with 400", async () => {
    const approve = vi.fn<PairApprover>(async () => true);
    const s = setup({ approve });
    for (const code of ["abc234", "ABC23", "ABCO23", "ABC2345"]) {
      const response = await s.fetch(call("POST", "/v1/pair", { origin: APP_A, body: { code } }));
      expect(response.status).toBe(400);
    }
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("principals", () => {
  it("gives channel local to the local token and channel web to a paired origin's token", async () => {
    const s = setup();
    const token = await pair(s, APP_A);

    const program = await s.bridge.authenticate(call("GET", "/v1/providers", { token: LOCAL_TOKEN }));
    expect(program).toEqual({ id: "local", channel: "local" });
    const web = await s.bridge.authenticate(call("GET", "/v1/providers", { origin: APP_A, token }));
    expect(web).toEqual({ id: "local", channel: "web" });
    const unknown = await s.bridge.authenticate(call("GET", "/v1/providers", { origin: APP_A, token: LOCAL_TOKEN }));
    expect(unknown).toBeNull();

    s.seen.length = 0;
    const viaProgram = await s.fetch(call("GET", "/v1/providers", { token: LOCAL_TOKEN }));
    expect(viaProgram.status).toBe(200);
    const viaWeb = await s.fetch(call("GET", "/v1/providers", { origin: APP_A, token }));
    expect(viaWeb.status).toBe(200);
    expect(s.seen).toEqual([
      { id: "local", channel: "local" },
      { id: "local", channel: "web" },
    ]);
  });

  it("answers 401 without Origin when the bearer is not the local token", async () => {
    const s = setup();
    const token = await pair(s, APP_A);
    const response = await s.fetch(call("GET", "/v1/providers", { token }));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("auth");
  });
});

describe("forgetting", () => {
  it("DELETE /v1/pair forgets the token; the next request with it is 403 without CORS", async () => {
    const s = setup();
    const token = await pair(s, APP_A);

    const forgotten = await s.fetch(call("DELETE", "/v1/pair", { origin: APP_A, token }));
    expect(forgotten.status).toBe(204);
    // The origin is unpaired again, so its other requests are refused outright.
    const other = await s.fetch(call("GET", "/v1/providers", { origin: APP_A, token }));
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(await s.tokens.origins()).toEqual([]);

    const again = await s.fetch(call("DELETE", "/v1/pair", { origin: APP_A, token }));
    expect(again.status).toBe(401);
    const withoutOrigin = await s.fetch(call("GET", "/v1/providers", { token }));
    expect(withoutOrigin.status).toBe(401);
  });

  it("DELETE /v1/pair without a valid token answers 401 and keeps the pairing", async () => {
    const s = setup();
    const token = await pair(s, APP_A);
    const response = await s.fetch(call("DELETE", "/v1/pair", { origin: APP_A, token: "wrong" }));
    expect(response.status).toBe(401);
    expect(await s.tokens.origins()).toEqual([APP_A]);
    const stillWorks = await s.fetch(call("GET", "/v1/providers", { origin: APP_A, token }));
    expect(stillWorks.status).toBe(200);
  });
});

describe("preflight", () => {
  it("sends access-control-allow-private-network only when the preflight asked for it", async () => {
    const s = setup();
    await pair(s, APP_A);

    const without = await s.fetch(preflight("/v1/providers", APP_A));
    expect(without.status).toBe(204);
    expect(without.headers.get("access-control-allow-origin")).toBe(APP_A);
    expect(without.headers.get("access-control-allow-private-network")).toBeNull();

    const withPna = await s.fetch(preflight("/v1/providers", APP_A, { "access-control-request-private-network": "true" }));
    expect(withPna.status).toBe(204);
    expect(withPna.headers.get("access-control-allow-private-network")).toBe("true");
    expect(withPna.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE");
    expect(withPna.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    expect(withPna.headers.get("access-control-max-age")).toBe("600");

    const pairPna = await s.fetch(preflight("/v1/pair", APP_B, { "access-control-request-private-network": "true" }));
    expect(pairPna.status).toBe(204);
    expect(pairPna.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("refuses a preflight from an unpaired origin on any other path", async () => {
    const s = setup();
    const response = await s.fetch(preflight("/v1/providers", APP_A));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("ServeTokens", () => {
  it("stores a hash and never the token", async () => {
    const secrets = memorySecrets();
    const tokens = new ServeTokens(secrets);
    const token = await tokens.issue(APP_A);

    expect(secrets.store.size).toBe(1);
    const [stored] = [...secrets.store.values()];
    expect(stored).toBeDefined();
    for (const value of secrets.store.values()) expect(value).not.toContain(token);
    const parsed = JSON.parse(stored as string) as { origin: string; hash: string };
    expect(parsed).toEqual({ origin: APP_A, hash: createHash("sha256").update(token).digest("hex") });
    expect(await tokens.verify(APP_A, token)).toBe(true);
    expect(await tokens.verify(APP_B, token)).toBe(false);
  });

  it("replaces the earlier token when an origin is issued again", async () => {
    const secrets = memorySecrets();
    const tokens = new ServeTokens(secrets);
    const first = await tokens.issue(APP_A);
    const second = await tokens.issue(APP_A);

    expect(second).not.toBe(first);
    expect(await tokens.verify(APP_A, first)).toBe(false);
    expect(await tokens.verify(APP_A, second)).toBe(true);
    expect(secrets.store.size).toBe(1);
  });

  it("lists origins sorted and forgets one by one", async () => {
    const tokens = new ServeTokens(memorySecrets());
    await tokens.issue("https://c.example");
    await tokens.issue("https://a.example");
    await tokens.issue("https://b.example");
    expect(await tokens.origins()).toEqual(["https://a.example", "https://b.example", "https://c.example"]);

    expect(await tokens.forget("https://b.example")).toBe(true);
    expect(await tokens.forget("https://b.example")).toBe(false);
    expect(await tokens.origins()).toEqual(["https://a.example", "https://c.example"]);
  });
});
