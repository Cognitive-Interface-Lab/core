import { describe, expect, it, vi } from "vitest";
import { CoreError, type StoredCredential } from "@core/contracts";
import { EnvCredentialStore, MemoryCredentialStore, type CredentialStore } from "@core/models";
import {
  ChainCredentialStore,
  MemorySecretStore,
  PersistentCredentialStore,
  type OAuthCredential,
  type Refresher,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const ACCESS = "access-token-secret-aaa";
const REFRESH = "refresh-token-secret-bbb";
const NEW_ACCESS = "access-token-secret-ccc";
const API_KEY = "sk-test-secret-value-123";

const oauthExpiringIn = (ms: number, extra: Partial<OAuthCredential> = {}): OAuthCredential => ({
  kind: "oauth",
  accessToken: ACCESS,
  refreshToken: REFRESH,
  expiresAt: NOW + ms,
  accountId: "acct-1",
  clientId: "client-1",
  ...extra,
});

const renewed: StoredCredential = {
  kind: "oauth",
  accessToken: NEW_ACCESS,
  refreshToken: "refresh-token-secret-ddd",
  expiresAt: NOW + 3_600_000,
  accountId: "acct-1",
  clientId: "client-1",
};

function storeWith(refreshers?: Record<string, Refresher>, secrets = new MemorySecretStore()) {
  return {
    secrets,
    store: new PersistentCredentialStore({ secrets, clock: () => NOW, ...(refreshers ? { refreshers } : {}) }),
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

describe("PersistentCredentialStore saving and mapping", () => {
  it("returns undefined for a provider with no saved sign-in", async () => {
    const { store } = storeWith();
    expect(await store.get("openrouter")).toBeUndefined();
    expect(await store.read("openrouter")).toBeUndefined();
  });

  it("maps an api-key record, with its optional fields", async () => {
    const { store } = storeWith();
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });
    await store.save("cloudflare", {
      kind: "api-key",
      apiKey: API_KEY,
      accountId: "acct-1",
      baseURL: "https://gateway.example.com/v1",
    });
    expect(await store.get("openrouter")).toEqual({ apiKey: API_KEY });
    expect(await store.get("cloudflare")).toEqual({
      apiKey: API_KEY,
      accountId: "acct-1",
      baseURL: "https://gateway.example.com/v1",
    });
  });

  it("maps a fresh oauth record to the access token and account id", async () => {
    const { store } = storeWith();
    await store.save("cloudflare", oauthExpiringIn(3_600_000));
    expect(await store.get("cloudflare")).toEqual({ apiKey: ACCESS, accountId: "acct-1" });
    expect(await store.get("cloudflare")).not.toHaveProperty("refreshToken");
  });

  it("maps an oauth record without an account id", async () => {
    const { store } = storeWith();
    await store.save("cloudflare", { kind: "oauth", accessToken: ACCESS, expiresAt: NOW + 3_600_000 });
    expect(await store.get("cloudflare")).toEqual({ apiKey: ACCESS });
  });

  it("read returns the record as saved", async () => {
    const { store } = storeWith();
    const record = oauthExpiringIn(3_600_000);
    await store.save("cloudflare", record);
    expect(await store.read("cloudflare")).toEqual(record);
  });

  it("stores each record as JSON under the provider id", async () => {
    const { store, secrets } = storeWith();
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });
    expect(JSON.parse((await secrets.get("openrouter")) ?? "")).toEqual({ kind: "api-key", apiKey: API_KEY });
  });

  it("rejects an invalid record before writing", async () => {
    const { store, secrets } = storeWith();
    const error = await caught(store.save("openrouter", { kind: "api-key", apiKey: "" }));
    expect(error.code).toBe("bad_request");
    expect(await secrets.list()).toEqual([]);
    const badShape = { kind: "api-key", apiKey: API_KEY, extra: 1 } as unknown as StoredCredential;
    expect((await caught(store.save("openrouter", badShape))).code).toBe("bad_request");
  });

  it("lists summaries sorted by provider, without any secret", async () => {
    const { store } = storeWith();
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });
    await store.save("cloudflare", oauthExpiringIn(3_600_000));
    await store.save("groq", { kind: "api-key", apiKey: API_KEY, accountId: "acct-2" });

    const summaries = await store.list();
    expect(summaries).toEqual([
      { providerId: "cloudflare", kind: "oauth", accountId: "acct-1", expiresAt: NOW + 3_600_000 },
      { providerId: "groq", kind: "api-key", accountId: "acct-2" },
      { providerId: "openrouter", kind: "api-key" },
    ]);
    const text = JSON.stringify(summaries);
    for (const secret of [API_KEY, ACCESS, REFRESH]) expect(text).not.toContain(secret);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("apiKey");
      expect(summary).not.toHaveProperty("accessToken");
      expect(summary).not.toHaveProperty("refreshToken");
    }
  });

  it("lists nothing when nothing is saved", async () => {
    expect(await storeWith().store.list()).toEqual([]);
  });

  it("removes a sign-in", async () => {
    const { store } = storeWith();
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });
    expect(await store.remove("openrouter")).toBe(true);
    expect(await store.get("openrouter")).toBeUndefined();
    expect(await store.remove("openrouter")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("exposes the secret store's location", () => {
    const { store, secrets } = storeWith();
    expect(store.location).toBe(secrets.location);
    expect(store.location).toBe("memory");
  });
});

describe("PersistentCredentialStore unreadable records", () => {
  it.each([
    ["not JSON", "this is not json"],
    ["a wrong shape", JSON.stringify({ kind: "api-key" })],
    ["an unknown kind", JSON.stringify({ kind: "password", apiKey: API_KEY })],
    ["an extra key", JSON.stringify({ kind: "api-key", apiKey: API_KEY, extra: true })],
  ])("gives bad_request naming the provider for %s", async (_name, garbage) => {
    const secrets = new MemorySecretStore({ openrouter: garbage });
    const { store } = storeWith(undefined, secrets);
    for (const action of [store.get("openrouter"), store.read("openrouter"), store.list()]) {
      const error = await caught(action);
      expect(error.code).toBe("bad_request");
      expect(error.message).toContain("openrouter");
      expect(error.message).toContain("sign in again");
      expect(error.message).not.toContain(API_KEY);
    }
  });

  it("can still remove an unreadable record", async () => {
    const secrets = new MemorySecretStore({ openrouter: "garbage" });
    const { store } = storeWith(undefined, secrets);
    expect(await store.remove("openrouter")).toBe(true);
    expect(await store.get("openrouter")).toBeUndefined();
  });
});

describe("PersistentCredentialStore renewal", () => {
  it("does not renew a token 61 seconds from expiry", async () => {
    const refresher = vi.fn<Refresher>(async () => renewed);
    const { store } = storeWith({ cloudflare: refresher });
    await store.save("cloudflare", oauthExpiringIn(61_000));
    expect(await store.get("cloudflare")).toEqual({ apiKey: ACCESS, accountId: "acct-1" });
    expect(refresher).not.toHaveBeenCalled();
  });

  it("renews a token 59 seconds from expiry once, and saves the renewed record", async () => {
    const refresher = vi.fn<Refresher>(async () => renewed);
    const { store } = storeWith({ cloudflare: refresher });
    const old = oauthExpiringIn(59_000);
    await store.save("cloudflare", old);

    expect(await store.get("cloudflare")).toEqual({ apiKey: NEW_ACCESS, accountId: "acct-1" });
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(refresher.mock.calls[0]?.[0]).toEqual(old);
    expect(await store.read("cloudflare")).toEqual(renewed);

    expect(await store.get("cloudflare")).toEqual({ apiKey: NEW_ACCESS, accountId: "acct-1" });
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("renews a token that is exactly at the skew and one that has already expired", async () => {
    const refresher = vi.fn<Refresher>(async () => renewed);
    const { store } = storeWith({ cloudflare: refresher, groq: refresher });
    await store.save("cloudflare", oauthExpiringIn(60_000));
    await store.save("groq", oauthExpiringIn(-5_000));
    await store.get("cloudflare");
    await store.get("groq");
    expect(refresher).toHaveBeenCalledTimes(2);
  });

  it("honours a custom skew", async () => {
    const refresher = vi.fn<Refresher>(async () => renewed);
    const secrets = new MemorySecretStore();
    const store = new PersistentCredentialStore({
      secrets,
      clock: () => NOW,
      refreshSkewMs: 5_000,
      refreshers: { cloudflare: refresher },
    });
    await store.save("cloudflare", oauthExpiringIn(10_000));
    await store.get("cloudflare");
    expect(refresher).not.toHaveBeenCalled();
    await store.save("cloudflare", oauthExpiringIn(4_000));
    await store.get("cloudflare");
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("never renews an api-key record", async () => {
    const refresher = vi.fn<Refresher>(async () => renewed);
    const { store } = storeWith({ openrouter: refresher });
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });
    await store.get("openrouter");
    expect(refresher).not.toHaveBeenCalled();
  });

  it("triggers exactly one refresher call for two concurrent gets", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const refresher = vi.fn<Refresher>(async () => {
      await gate;
      return renewed;
    });
    const { store } = storeWith({ cloudflare: refresher });
    await store.save("cloudflare", oauthExpiringIn(1_000));

    const first = store.get("cloudflare");
    const second = store.get("cloudflare");
    await vi.waitFor(() => expect(refresher).toHaveBeenCalled());
    release?.();
    expect(await Promise.all([first, second])).toEqual([
      { apiKey: NEW_ACCESS, accountId: "acct-1" },
      { apiKey: NEW_ACCESS, accountId: "acct-1" },
    ]);
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("renews different providers independently", async () => {
    const refresher = vi.fn<Refresher>(async (current) => ({ ...current, accessToken: `${current.accessToken}-new`, expiresAt: NOW + 3_600_000 }));
    const { store } = storeWith({ cloudflare: refresher, other: refresher });
    await store.save("cloudflare", oauthExpiringIn(1_000, { accessToken: "aaaa-cf" }));
    await store.save("other", oauthExpiringIn(1_000, { accessToken: "aaaa-other" }));
    const [cf, other] = await Promise.all([store.get("cloudflare"), store.get("other")]);
    expect(cf?.apiKey).toBe("aaaa-cf-new");
    expect(other?.apiKey).toBe("aaaa-other-new");
    expect(refresher).toHaveBeenCalledTimes(2);
  });

  it("can renew again after a failed renewal", async () => {
    const refresher = vi
      .fn<Refresher>()
      .mockRejectedValueOnce(new CoreError("unavailable", "offline"))
      .mockResolvedValueOnce(renewed);
    const { store } = storeWith({ cloudflare: refresher });
    await store.save("cloudflare", oauthExpiringIn(1_000));
    expect((await caught(store.get("cloudflare"))).code).toBe("unavailable");
    expect(await store.get("cloudflare")).toEqual({ apiKey: NEW_ACCESS, accountId: "acct-1" });
    expect(refresher).toHaveBeenCalledTimes(2);
  });
});

describe("PersistentCredentialStore renewal errors", () => {
  const expired = "the sign-in expired and could not be renewed; sign in again";

  it("gives auth when there is no refresher for the provider", async () => {
    const { store } = storeWith();
    await store.save("cloudflare", oauthExpiringIn(1_000));
    const error = await caught(store.get("cloudflare"));
    expect(error.code).toBe("auth");
    expect(error.message).toBe(`cloudflare: ${expired}`);
  });

  it("gives auth when the refresher is registered for another provider", async () => {
    const { store } = storeWith({ other: async () => renewed });
    await store.save("cloudflare", oauthExpiringIn(1_000));
    expect((await caught(store.get("cloudflare"))).code).toBe("auth");
  });

  it("gives auth without the token when the refresher throws an error containing it", async () => {
    const refresher: Refresher = async () => {
      throw new Error(`token endpoint rejected refresh_token=${REFRESH} access=${ACCESS}`);
    };
    const { store } = storeWith({ cloudflare: refresher });
    await store.save("cloudflare", oauthExpiringIn(1_000));
    const error = await caught(store.get("cloudflare"));
    expect(error.code).toBe("auth");
    expect(error.message).toBe(`cloudflare: ${expired}`);
    const text = `${error.message} ${JSON.stringify(error.toJSON())}`;
    for (const secret of [REFRESH, ACCESS]) expect(text).not.toContain(secret);
  });

  it("gives auth, without the token, when the refresher throws a CoreError with another code", async () => {
    const refresher: Refresher = async () => {
      throw new CoreError("bad_request", `invalid_grant for ${REFRESH}`);
    };
    const { store } = storeWith({ cloudflare: refresher });
    await store.save("cloudflare", oauthExpiringIn(1_000));
    const error = await caught(store.get("cloudflare"));
    expect(error.code).toBe("auth");
    expect(error.message).not.toContain(REFRESH);
  });

  it.each(["unavailable", "timeout"] as const)("keeps the %s code from the refresher", async (code) => {
    const refresher: Refresher = async () => {
      throw new CoreError(code, `network down while sending ${REFRESH}`);
    };
    const { store } = storeWith({ cloudflare: refresher });
    await store.save("cloudflare", oauthExpiringIn(1_000));
    const error = await caught(store.get("cloudflare"));
    expect(error.code).toBe(code);
    expect(error.message).toContain("cloudflare");
    expect(`${error.message} ${JSON.stringify(error.toJSON())}`).not.toContain(REFRESH);
  });

  it("gives auth when the refresher returns something that is not a valid record", async () => {
    const refresher = (async () => ({ kind: "oauth", accessToken: "" })) as unknown as Refresher;
    const { store } = storeWith({ cloudflare: refresher });
    await store.save("cloudflare", oauthExpiringIn(1_000));
    expect((await caught(store.get("cloudflare"))).code).toBe("auth");
  });

  it("keeps the old record when renewal fails", async () => {
    const refresher: Refresher = async () => {
      throw new Error("boom");
    };
    const { store } = storeWith({ cloudflare: refresher });
    const old = oauthExpiringIn(1_000);
    await store.save("cloudflare", old);
    await caught(store.get("cloudflare"));
    expect(await store.read("cloudflare")).toEqual(old);
  });
});

describe("ChainCredentialStore", () => {
  it("returns the first non-undefined result, so the environment wins over saved sign-ins", async () => {
    const env = new EnvCredentialStore({ CORE_OPENROUTER_API_KEY: "env-key-value" });
    const { store: saved } = storeWith();
    await saved.save("openrouter", { kind: "api-key", apiKey: API_KEY });
    await saved.save("groq", { kind: "api-key", apiKey: API_KEY });

    const chain = new ChainCredentialStore([env, saved]);
    expect(await chain.get("openrouter")).toEqual({ apiKey: "env-key-value" });
    expect(await chain.get("groq")).toEqual({ apiKey: API_KEY });
    expect(await chain.get("openai")).toBeUndefined();
  });

  it("respects the order it was given", async () => {
    const first = new MemoryCredentialStore({ p: { apiKey: "first-key" } });
    const second = new MemoryCredentialStore({ p: { apiKey: "second-key" } });
    expect(await new ChainCredentialStore([second, first]).get("p")).toEqual({ apiKey: "second-key" });
  });

  it("does not ask later stores once one answers", async () => {
    const later = { get: vi.fn(async () => ({ apiKey: "later" })) } satisfies CredentialStore;
    const chain = new ChainCredentialStore([new MemoryCredentialStore({ p: { apiKey: "first" } }), later]);
    await chain.get("p");
    expect(later.get).not.toHaveBeenCalled();
  });

  it("is empty-safe", async () => {
    expect(await new ChainCredentialStore([]).get("p")).toBeUndefined();
  });

  it("propagates an error from a store", async () => {
    const { store } = storeWith(undefined, new MemorySecretStore({ openrouter: "garbage" }));
    const chain = new ChainCredentialStore([new EnvCredentialStore({}), store]);
    expect((await caught(chain.get("openrouter"))).code).toBe("bad_request");
  });
});

describe("serialising", () => {
  it("JSON.stringify of both classes is {}", async () => {
    const { store } = storeWith();
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });
    const chain = new ChainCredentialStore([store]);
    expect(JSON.stringify(store)).toBe("{}");
    expect(JSON.stringify(chain)).toBe("{}");
    expect(JSON.stringify({ store, chain })).toBe('{"store":{},"chain":{}}');
  });
});

describe("PersistentCredentialStore region and workspaceId", () => {
  it("carries both from a saved key sign-in into the credentials", async () => {
    const { store } = storeWith();
    await store.save("anthropic-aws", {
      kind: "api-key",
      apiKey: API_KEY,
      region: "us-west-2",
      workspaceId: "wrkspc_01",
    });
    expect(await store.get("anthropic-aws")).toEqual({
      apiKey: API_KEY,
      region: "us-west-2",
      workspaceId: "wrkspc_01",
    });
  });

  it("puts both in that provider's summary and never the key", async () => {
    const { store } = storeWith();
    await store.save("anthropic-aws", {
      kind: "api-key",
      apiKey: API_KEY,
      region: "us-west-2",
      workspaceId: "wrkspc_01",
    });
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });

    const summaries = await store.list();
    expect(summaries).toEqual([
      { providerId: "anthropic-aws", kind: "api-key", region: "us-west-2", workspaceId: "wrkspc_01" },
      { providerId: "openrouter", kind: "api-key" },
    ]);
    expect(JSON.stringify(summaries)).not.toContain(API_KEY);
  });

  it("leaves both keys out, rather than undefined, when the record has neither", async () => {
    const { store } = storeWith();
    await store.save("openrouter", { kind: "api-key", apiKey: API_KEY });

    const credentials = await store.get("openrouter");
    expect(credentials).not.toHaveProperty("region");
    expect(credentials).not.toHaveProperty("workspaceId");
    const [summary] = await store.list();
    expect(summary).not.toHaveProperty("region");
    expect(summary).not.toHaveProperty("workspaceId");
  });
});
