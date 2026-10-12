import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "@core/contracts";
import {
  FileSecretStore,
  KeychainSecretStore,
  openSecretStore,
  type KeyringBackend,
  type KeyringEntry,
} from "../src/index.js";

const SECRET = "sk-test-secret-value-123";

type FakeKeyring = KeyringBackend & {
  /** "service/account" → value */
  items: Map<string, string>;
  setPassword: ReturnType<typeof vi.fn>;
  entryCalls: [string, string][];
};

function fakeKeyring(): FakeKeyring {
  const items = new Map<string, string>();
  const entryCalls: [string, string][] = [];
  const setPassword = vi.fn();
  return {
    items,
    setPassword,
    entryCalls,
    entry(service: string, account: string): KeyringEntry {
      entryCalls.push([service, account]);
      const key = `${service}/${account}`;
      return {
        getPassword: async () => items.get(key) ?? null,
        setPassword: async (value: string) => {
          setPassword(service, account, value);
          items.set(key, value);
        },
        deletePassword: async () => items.delete(key),
      };
    },
    async find(service: string): Promise<string[]> {
      return [...items.keys()].filter((key) => key.startsWith(`${service}/`)).map((key) => key.slice(service.length + 1));
    },
  };
}

function throwingKeyring(message = "The name org.freedesktop.secrets was not provided"): KeyringBackend & { calls: number } {
  const backend = {
    calls: 0,
    entry(): KeyringEntry {
      backend.calls += 1;
      throw new Error(message);
    },
    async find(): Promise<string[]> {
      throw new Error(message);
    },
  };
  return backend;
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

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "core-keychain-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("KeychainSecretStore", () => {
  it("reports its kind and location", () => {
    const store = new KeychainSecretStore({ backend: fakeKeyring() });
    expect(store.kind).toBe("keychain");
    expect(store.location).toBe("OS keychain");
  });

  it("round-trips values under service core", async () => {
    const fake = fakeKeyring();
    const store = new KeychainSecretStore({ backend: fake });
    expect(await store.get("openrouter")).toBeUndefined();

    await store.set("openrouter", SECRET);
    await store.set("cloudflare", "other");
    expect(fake.items.get("core/openrouter")).toBe(SECRET);
    expect(await store.get("openrouter")).toBe(SECRET);
    expect(await store.list()).toEqual(["cloudflare", "openrouter"]);

    expect(await store.delete("openrouter")).toBe(true);
    expect(await store.delete("openrouter")).toBe(false);
    expect(await store.get("openrouter")).toBeUndefined();
    expect(await store.list()).toEqual(["cloudflare"]);
    expect(fake.entryCalls.every(([service]) => service === "core")).toBe(true);
  });

  it("uses a custom service when given one", async () => {
    const fake = fakeKeyring();
    await new KeychainSecretStore({ service: "core-test", backend: fake }).set("openrouter", SECRET);
    expect([...fake.items.keys()]).toEqual(["core-test/openrouter"]);
  });

  it("lists only valid names, ignoring the probe account and foreign entries", async () => {
    const fake = fakeKeyring();
    fake.items.set("core/__probe__", "x");
    fake.items.set("core/Some Other App", "x");
    fake.items.set("core/openrouter", SECRET);
    expect(await new KeychainSecretStore({ backend: fake }).list()).toEqual(["openrouter"]);
  });

  it("rejects bad names before touching the backend", async () => {
    const fake = fakeKeyring();
    const store = new KeychainSecretStore({ backend: fake });
    for (const name of ["", "Upper", "has space", "__probe__"]) {
      expect((await caught(store.get(name))).code).toBe("bad_request");
      expect((await caught(store.set(name, "x"))).code).toBe("bad_request");
      expect((await caught(store.delete(name))).code).toBe("bad_request");
    }
    expect(fake.entryCalls).toEqual([]);
  });

  it("turns a throwing entry() into unavailable on every operation", async () => {
    const store = new KeychainSecretStore({ backend: throwingKeyring("no dbus") });
    for (const action of [store.get("a"), store.set("a", "x"), store.delete("a"), store.list()]) {
      const error = await caught(action);
      expect(error.code).toBe("unavailable");
      expect(error.message).toBe("OS keychain: no dbus");
    }
  });

  it("turns a failing entry operation into unavailable", async () => {
    const backend: KeyringBackend = {
      entry: () => ({
        getPassword: async () => {
          throw new Error("keychain is locked");
        },
        setPassword: async () => {
          throw new Error("keychain is locked");
        },
        deletePassword: async () => {
          throw new Error("keychain is locked");
        },
      }),
      find: async () => [],
    };
    const store = new KeychainSecretStore({ backend });
    expect((await caught(store.get("a"))).message).toBe("OS keychain: keychain is locked");
    expect((await caught(store.set("a", SECRET))).code).toBe("unavailable");
    expect((await caught(store.delete("a"))).code).toBe("unavailable");
  });

  it("serialises to {}", async () => {
    const store = new KeychainSecretStore({ backend: fakeKeyring() });
    await store.set("openrouter", SECRET);
    expect(JSON.stringify(store)).toBe("{}");
  });
});

describe("KeychainSecretStore.probe", () => {
  it("is true with a working backend and only reads", async () => {
    const fake = fakeKeyring();
    expect(await KeychainSecretStore.probe(fake)).toBe(true);
    expect(fake.entryCalls).toEqual([["core", "__probe__"]]);
    expect(fake.setPassword).not.toHaveBeenCalled();
    expect(fake.items.size).toBe(0);
  });

  it("is false when entry() throws, and never writes", async () => {
    const backend = throwingKeyring();
    expect(await KeychainSecretStore.probe(backend)).toBe(false);
    expect(backend.calls).toBe(1);
  });

  it("is false when reading rejects", async () => {
    const backend: KeyringBackend = {
      entry: () => ({
        getPassword: async () => {
          throw new Error("locked");
        },
        setPassword: vi.fn(),
        deletePassword: vi.fn(),
      }),
      find: async () => [],
    };
    expect(await KeychainSecretStore.probe(backend)).toBe(false);
  });
});

describe("openSecretStore", () => {
  it('"auto" returns the keychain when the backend works', async () => {
    const warn = vi.fn();
    const store = await openSecretStore({ configDir: root, backend: fakeKeyring(), warn });
    expect(store.kind).toBe("keychain");
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults to auto", async () => {
    const store = await openSecretStore({ configDir: root, mode: "auto", backend: fakeKeyring() });
    expect(store.kind).toBe("keychain");
  });

  it('"auto" falls back to the file at <configDir>/credentials.json and warns once', async () => {
    const warn = vi.fn();
    const store = await openSecretStore({ configDir: root, backend: throwingKeyring(), warn });
    expect(store).toBeInstanceOf(FileSecretStore);
    expect(store.kind).toBe("file");
    expect(store.location).toBe(join(root, "credentials.json"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `No OS keychain found; saving credentials to ${join(root, "credentials.json")} (readable only by you)`,
    );
  });

  it('"auto" falls back silently when no warn callback is given', async () => {
    const store = await openSecretStore({ configDir: root, backend: throwingKeyring() });
    expect(store.kind).toBe("file");
  });

  it('"keychain" with a throwing backend rejects with unavailable', async () => {
    const warn = vi.fn();
    const error = await caught(openSecretStore({ configDir: root, mode: "keychain", backend: throwingKeyring(), warn }));
    expect(error.code).toBe("unavailable");
    expect(warn).not.toHaveBeenCalled();
  });

  it('"keychain" with a working backend returns the keychain', async () => {
    const store = await openSecretStore({ configDir: root, mode: "keychain", backend: fakeKeyring() });
    expect(store.kind).toBe("keychain");
  });

  it('"file" ignores the backend', async () => {
    const fake = fakeKeyring();
    const warn = vi.fn();
    const store = await openSecretStore({ configDir: root, mode: "file", backend: fake, warn });
    expect(store.kind).toBe("file");
    expect(store.location).toBe(join(root, "credentials.json"));
    expect(fake.entryCalls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stores through the chosen store", async () => {
    const fake = fakeKeyring();
    const store = await openSecretStore({ configDir: root, backend: fake });
    await store.set("openrouter", SECRET);
    expect(fake.items.get("core/openrouter")).toBe(SECRET);
  });
});
