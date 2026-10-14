import { mkdtemp, readdir, readFile, rm, stat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreError } from "@core/contracts";
import { FileSecretStore, MemorySecretStore, type SecretStore } from "../src/index.js";

const posix = process.platform !== "win32";
const SECRET = "sk-test-secret-value-123";

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
  root = await mkdtemp(join(tmpdir(), "core-secret-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const stores: [string, () => SecretStore][] = [
  ["MemorySecretStore", () => new MemorySecretStore()],
  ["FileSecretStore", () => new FileSecretStore(join(root, "config", "credentials.json"))],
];

describe.each(stores)("%s", (_name, make) => {
  it("round-trips set, get, delete and a sorted list", async () => {
    const store = make();
    expect(await store.get("openrouter")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    await store.set("openrouter", SECRET);
    await store.set("cloudflare", "other-value");
    await store.set("a1-b2", "third");
    expect(await store.get("openrouter")).toBe(SECRET);
    expect(await store.list()).toEqual(["a1-b2", "cloudflare", "openrouter"]);

    await store.set("openrouter", "replaced");
    expect(await store.get("openrouter")).toBe("replaced");

    expect(await store.delete("openrouter")).toBe(true);
    expect(await store.get("openrouter")).toBeUndefined();
    expect(await store.list()).toEqual(["a1-b2", "cloudflare"]);
  });

  it("returns false when deleting a missing name", async () => {
    const store = make();
    expect(await store.delete("nothing")).toBe(false);
    await store.set("kept", "value");
    expect(await store.delete("nothing")).toBe(false);
    expect(await store.list()).toEqual(["kept"]);
  });

  it("keeps concurrent writes", async () => {
    const store = make();
    await Promise.all(["a", "b", "c", "d", "e"].map((name) => store.set(name, `value-${name}`)));
    expect(await store.list()).toEqual(["a", "b", "c", "d", "e"]);
    expect(await store.get("c")).toBe("value-c");
  });

  it.each(["", "Upper", "1starts-with-digit", "has space", "under_score", "dot.ted", "a".repeat(65), "-dash"])(
    "rejects the bad name %j",
    async (name) => {
      const store = make();
      expect((await caught(store.set(name, "x"))).code).toBe("bad_request");
      expect((await caught(store.get(name))).code).toBe("bad_request");
      expect((await caught(store.delete(name))).code).toBe("bad_request");
    },
  );

  it("accepts the longest valid name", async () => {
    const store = make();
    const name = `a${"b".repeat(63)}`;
    await store.set(name, "x");
    expect(await store.get(name)).toBe("x");
  });

  it("serialises to {} so a value cannot leak through JSON.stringify", async () => {
    const store = make();
    await store.set("openrouter", SECRET);
    expect(JSON.stringify(store)).toBe("{}");
    expect(JSON.stringify({ store })).toBe('{"store":{}}');
  });
});

describe("MemorySecretStore", () => {
  it("reports its kind and location", () => {
    const store = new MemorySecretStore();
    expect(store.kind).toBe("memory");
    expect(store.location).toBe("memory");
  });

  it("starts from initial values and validates their names", async () => {
    const store = new MemorySecretStore({ openrouter: SECRET });
    expect(await store.get("openrouter")).toBe(SECRET);
    expect(() => new MemorySecretStore({ "Bad Name": "x" })).toThrow(CoreError);
  });
});

describe("FileSecretStore", () => {
  const file = () => join(root, "config", "credentials.json");

  it("reports its kind and the path as its location", () => {
    const store = new FileSecretStore(file());
    expect(store.kind).toBe("file");
    expect(store.location).toBe(file());
  });

  it("treats a missing file as an empty store and does not create it by reading", async () => {
    const store = new FileSecretStore(file());
    expect(await store.list()).toEqual([]);
    expect(await store.delete("nothing")).toBe(false);
    await expect(stat(file())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes the documented format", async () => {
    const store = new FileSecretStore(file());
    await store.set("openrouter", SECRET);
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ version: 1, secrets: { openrouter: SECRET } });
  });

  it("persists across instances", async () => {
    await new FileSecretStore(file()).set("openrouter", SECRET);
    expect(await new FileSecretStore(file()).get("openrouter")).toBe(SECRET);
  });

  it.runIf(posix)("creates the file with mode 0600 and its directory with mode 0700", async () => {
    await new FileSecretStore(file()).set("openrouter", SECRET);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "config"))).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)("keeps mode 0600 across rewrites", async () => {
    const store = new FileSecretStore(file());
    await store.set("a", "1");
    await store.set("b", "2");
    await store.delete("a");
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary files behind", async () => {
    const store = new FileSecretStore(file());
    await store.set("a", "1");
    await store.set("a", "2");
    await store.set("b", "3");
    await store.delete("b");
    await Promise.all([store.set("c", "4"), store.set("d", "5")]);
    expect(await readdir(join(root, "config"))).toEqual(["credentials.json"]);
  });

  it.runIf(posix)("refuses a file that other users can read", async () => {
    const store = new FileSecretStore(file());
    await store.set("openrouter", SECRET);
    await chmod(file(), 0o644);
    for (const action of [store.get("openrouter"), store.list(), store.set("a", "1"), store.delete("a")]) {
      const error = await caught(action);
      expect(error.code).toBe("auth");
      expect(error.message).toContain("chmod 600");
      expect(error.message).toContain(file());
      expect(error.message).not.toContain(SECRET);
    }
    expect(JSON.parse(await readFile(file(), "utf8")).secrets).toEqual({ openrouter: SECRET });
  });

  it.runIf(posix)("also refuses a file that only the group can read", async () => {
    const store = new FileSecretStore(file());
    await store.set("openrouter", SECRET);
    await chmod(file(), 0o640);
    expect((await caught(store.get("openrouter"))).code).toBe("auth");
  });

  it.runIf(posix)("accepts the file again once it is locked down", async () => {
    const store = new FileSecretStore(file());
    await store.set("openrouter", SECRET);
    await chmod(file(), 0o644);
    await caught(store.get("openrouter"));
    await chmod(file(), 0o600);
    expect(await store.get("openrouter")).toBe(SECRET);
  });

  describe("a corrupt file", () => {
    const corrupt: [string, string][] = [
      ["malformed JSON", `{ "version": 1, "secrets": { "openrouter": "${SECRET}"`],
      ["not an object", JSON.stringify([SECRET])],
      ["a wrong version", JSON.stringify({ version: 2, secrets: { openrouter: SECRET } })],
      ["a missing secrets map", JSON.stringify({ version: 1 })],
      ["a non-string value", JSON.stringify({ version: 1, secrets: { openrouter: 5 } })],
      ["an invalid name", JSON.stringify({ version: 1, secrets: { "Bad Name": SECRET } })],
    ];

    it.each(corrupt)("gives bad_request for %s, without echoing the content", async (_name, content) => {
      const store = new FileSecretStore(file());
      await store.set("seed", "x");
      await writeFile(file(), content, { mode: 0o600 });
      for (const action of [store.get("openrouter"), store.list(), store.set("a", "1")]) {
        const error = await caught(action);
        expect(error.code).toBe("bad_request");
        expect(error.message).toContain(file());
        expect(error.message).toContain("is not a valid credentials file");
        expect(error.message).not.toContain(SECRET);
        expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
      }
    });
  });

  it("does not use __proto__ as a name", async () => {
    const store = new FileSecretStore(file());
    expect((await caught(store.set("__proto__", "x"))).code).toBe("bad_request");
  });
});
