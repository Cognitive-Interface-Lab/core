import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "@core/contracts";
import {
  EnvCredentialStore,
  MemoryCredentialStore,
  MockProvider,
  ProviderRegistry,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ProviderRegistry", () => {
  it("registers providers, chains, and looks them up by id", () => {
    const a = new MockProvider({ id: "a" });
    const b = new MockProvider({ id: "b" });
    const registry = new ProviderRegistry();
    expect(registry.register(a)).toBe(registry);
    registry.register(b);
    expect(registry.get("a")).toBe(a);
    expect(registry.get("b")).toBe(b);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("zzz")).toBe(false);
  });

  it("rejects a duplicate id with bad_request", () => {
    const registry = new ProviderRegistry().register(new MockProvider({ id: "dup" }));
    try {
      registry.register(new MockProvider({ id: "dup" }));
      expect.unreachable("duplicate registration should throw");
    } catch (error) {
      expect(CoreError.is(error)).toBe(true);
      expect((error as CoreError).code).toBe("bad_request");
    }
  });

  it("rejects an unknown id with not_found", () => {
    const registry = new ProviderRegistry();
    try {
      registry.get("nope");
      expect.unreachable("unknown id should throw");
    } catch (error) {
      expect(CoreError.is(error)).toBe(true);
      expect((error as CoreError).code).toBe("not_found");
    }
  });

  it("lists ids sorted, independent of registration order", () => {
    const registry = new ProviderRegistry();
    for (const id of ["groq", "mock", "ollama", "anthropic"]) registry.register(new MockProvider({ id }));
    expect(registry.list()).toEqual(["anthropic", "groq", "mock", "ollama"]);
    expect(new ProviderRegistry().list()).toEqual([]);
  });
});

describe("MemoryCredentialStore", () => {
  it("returns undefined for an unknown provider", async () => {
    expect(await new MemoryCredentialStore().get("openai")).toBeUndefined();
  });

  it("returns what was set, from the constructor or set()", async () => {
    const store = new MemoryCredentialStore({ openai: { apiKey: "sk-one" } });
    store.set("ollama", { baseURL: "http://localhost:1234/v1", headers: { "x-team": "t" } });
    expect(await store.get("openai")).toEqual({ apiKey: "sk-one" });
    expect(await store.get("ollama")).toEqual({
      baseURL: "http://localhost:1234/v1",
      headers: { "x-team": "t" },
    });
  });

  it("set() replaces earlier credentials for the same provider", async () => {
    const store = new MemoryCredentialStore({ openai: { apiKey: "old" } });
    store.set("openai", { apiKey: "new" });
    expect(await store.get("openai")).toEqual({ apiKey: "new" });
  });

  it("never shows a key in JSON.stringify or string conversion", () => {
    const secret = "sk-memory-secret-123";
    const store = new MemoryCredentialStore({ openai: { apiKey: secret, headers: { authorization: secret } } });
    expect(JSON.stringify(store)).toBe("{}");
    expect(String(store)).not.toContain(secret);
    expect(`${store}`).not.toContain(secret);
    expect(JSON.stringify({ wrapped: store })).not.toContain(secret);
  });
});

describe("EnvCredentialStore", () => {
  it("reads <prefix><ID>_API_KEY and _BASE_URL", async () => {
    const store = new EnvCredentialStore({
      CORE_OPENAI_API_KEY: "sk-env",
      CORE_OLLAMA_BASE_URL: "http://localhost:11434/v1",
    });
    expect(await store.get("openai")).toEqual({ apiKey: "sk-env" });
    expect(await store.get("ollama")).toEqual({ baseURL: "http://localhost:11434/v1" });
  });

  it("returns both values when both are set", async () => {
    const store = new EnvCredentialStore({ CORE_GROQ_API_KEY: "k", CORE_GROQ_BASE_URL: "https://proxy/v1" });
    expect(await store.get("groq")).toEqual({ apiKey: "k", baseURL: "https://proxy/v1" });
  });

  it("returns undefined when neither variable is set", async () => {
    const store = new EnvCredentialStore({ CORE_OTHER_API_KEY: "k", UNRELATED: "x" });
    expect(await store.get("openai")).toBeUndefined();
  });

  it("uppercases the id and replaces every non-alphanumeric character with _", async () => {
    const store = new EnvCredentialStore({
      CORE_OPENAI_COMPAT_API_KEY: "dash",
      CORE_MY_CLOUD_V2_API_KEY: "mixed",
      CORE_A_B_C_BASE_URL: "http://x",
    });
    expect(await store.get("openai-compat")).toEqual({ apiKey: "dash" });
    expect(await store.get("my.cloud/v2")).toEqual({ apiKey: "mixed" });
    expect(await store.get("a b-c")).toEqual({ baseURL: "http://x" });
  });

  it("honours a custom prefix and ignores the default one", async () => {
    const env = { APP_OPENAI_API_KEY: "custom", CORE_OPENAI_API_KEY: "default" };
    expect(await new EnvCredentialStore(env, "APP_").get("openai")).toEqual({ apiKey: "custom" });
    expect(await new EnvCredentialStore(env).get("openai")).toEqual({ apiKey: "default" });
  });

  it("treats an empty value as not set", async () => {
    const store = new EnvCredentialStore({ CORE_OPENAI_API_KEY: "", CORE_OPENAI_BASE_URL: undefined });
    expect(await store.get("openai")).toBeUndefined();
  });

  it("reads process.env by default", async () => {
    vi.stubEnv("CORE_ZZTESTPROVIDER_API_KEY", "from-process-env");
    expect(await new EnvCredentialStore().get("zztestprovider")).toEqual({ apiKey: "from-process-env" });
  });

  it("sees later changes to the env object it was given", async () => {
    const env: Record<string, string | undefined> = {};
    const store = new EnvCredentialStore(env);
    expect(await store.get("openai")).toBeUndefined();
    env["CORE_OPENAI_API_KEY"] = "late";
    expect(await store.get("openai")).toEqual({ apiKey: "late" });
  });

  it("never shows a key in JSON.stringify or string conversion", () => {
    const secret = "sk-env-secret-456";
    const store = new EnvCredentialStore({ CORE_OPENAI_API_KEY: secret });
    expect(JSON.stringify(store)).toBe("{}");
    expect(String(store)).not.toContain(secret);
    expect(JSON.stringify({ wrapped: store })).not.toContain(secret);
  });
});
