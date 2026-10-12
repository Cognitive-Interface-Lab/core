import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreError } from "@core/contracts";
import { commands, run, UsageError } from "../src/run.js";
import { defaultConfigDir } from "../src/io.js";
import { loadConfig, resolveRoute, saveConfig, type Config } from "../src/config.js";
import { cleanupFakeIo, fakeIo } from "./fake-io.js";

afterEach(() => {
  cleanupFakeIo();
  for (const name of ["boom-usage", "boom-core", "boom-plain", "boom-odd", "ok"]) delete commands[name];
});

const posix = process.platform !== "win32";

async function caught(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    expect(CoreError.is(error)).toBe(true);
    return error as CoreError;
  }
  throw new Error("expected the promise to reject");
}

describe("run", () => {
  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("prints the usage to stdout and returns 0 for %j", async (argv) => {
    const fake = fakeIo();
    expect(await run(argv, fake.io)).toBe(0);
    expect(fake.stdout()).toContain("usage: core <command> [options]");
    expect(fake.stdout()).toContain("commands:");
    expect(fake.stdout()).toContain("--version");
    expect(fake.stderr()).toBe("");
  });

  it("lists every command with its summary", async () => {
    const fake = fakeIo();
    await run(["--help"], fake.io);
    for (const [name, command] of Object.entries(commands)) {
      expect(fake.stdout()).toContain(name);
      expect(fake.stdout()).toContain(command.summary);
    }
    expect(fake.stdout()).toContain("config");
  });

  it("prints a command's usage for `help <command>` and `<command> --help`", async () => {
    for (const argv of [["help", "config"], ["config", "--help"], ["config", "-h"]]) {
      const fake = fakeIo();
      expect(await run(argv, fake.io)).toBe(0);
      expect(fake.stdout()).toContain("usage: core config");
      expect(fake.stdout()).toContain(commands["config"]?.summary);
      expect(fake.stderr()).toBe("");
    }
  });

  it("prints the version", async () => {
    const fake = fakeIo();
    expect(await run(["--version"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("0.1.0\n");
  });

  it("ignores a single leading --, as `pnpm start -- --help` passes it", async () => {
    const fake = fakeIo();
    expect(await run(["--", "--version"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("0.1.0\n");
    const help = fakeIo();
    expect(await run(["--", "--help"], help.io)).toBe(0);
    expect(help.stdout()).toContain("usage: core");
  });

  it.each([[["bogus"]], [["help", "bogus"]], [["toString"]], [["__proto__"]], [["constructor"]]])(
    "returns 2 with the usage on stderr for %j",
    async (argv) => {
      const fake = fakeIo();
      expect(await run(argv, fake.io)).toBe(2);
      expect(fake.stdout()).toBe("");
      expect(fake.stderr()).toContain("error: unknown command");
      expect(fake.stderr()).toContain("usage: core <command> [options]");
    },
  );

  it("returns 2 for a command that throws UsageError, printing the message and that command's usage", async () => {
    commands["boom-usage"] = {
      summary: "throws a usage error",
      usage: "<thing>",
      run: async () => {
        throw new UsageError("missing <thing>");
      },
    };
    const fake = fakeIo();
    expect(await run(["boom-usage"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("error: missing <thing>");
    expect(fake.stderr()).toContain("usage: core boom-usage <thing>");
    expect(fake.stdout()).toBe("");
  });

  it("returns 1 for a command that throws CoreError, printing `error: <code>: <message>`", async () => {
    commands["boom-core"] = {
      summary: "throws a core error",
      usage: "",
      run: async () => {
        throw new CoreError("auth", "no key");
      },
    };
    const fake = fakeIo();
    expect(await run(["boom-core"], fake.io)).toBe(1);
    expect(fake.stderr()).toBe("error: auth: no key\n");
  });

  it("returns 1 for any other error, printing `error: <message>`", async () => {
    commands["boom-plain"] = {
      summary: "throws",
      usage: "",
      run: async () => {
        throw new Error("boom");
      },
    };
    commands["boom-odd"] = {
      summary: "throws a non-error",
      usage: "",
      run: async () => {
        throw "just a string";
      },
    };
    const plain = fakeIo();
    expect(await run(["boom-plain"], plain.io)).toBe(1);
    expect(plain.stderr()).toBe("error: boom\n");
    const odd = fakeIo();
    expect(await run(["boom-odd"], odd.io)).toBe(1);
    expect(odd.stderr()).toBe("error: unexpected failure\n");
  });

  it("returns the command's own exit code and passes it the remaining arguments and the io", async () => {
    let seen: string[] = [];
    commands["ok"] = {
      summary: "works",
      usage: "[args]",
      run: async (args, io) => {
        seen = args;
        io.stdout.write("done\n");
        return 7;
      },
    };
    const fake = fakeIo();
    expect(await run(["ok", "a", "--flag", "b"], fake.io)).toBe(7);
    expect(seen).toEqual(["a", "--flag", "b"]);
    expect(fake.stdout()).toBe("done\n");
  });
});

describe("defaultConfigDir", () => {
  it("prefers CORE_CONFIG_DIR", () => {
    expect(defaultConfigDir({ CORE_CONFIG_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe("/custom");
  });

  it("then $XDG_CONFIG_HOME/core", () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe("/xdg/core");
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "darwin", "/Users/me")).toBe("/xdg/core");
  });

  it("then ~/.config/core", () => {
    expect(defaultConfigDir({}, "linux", "/home/me")).toBe("/home/me/.config/core");
    expect(defaultConfigDir({}, "darwin", "/Users/me")).toBe("/Users/me/.config/core");
  });

  it("ignores empty variables", () => {
    expect(defaultConfigDir({ CORE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, "linux", "/home/me")).toBe("/home/me/.config/core");
  });

  describe("on win32", () => {
    it("uses %APPDATA%\\core", () => {
      expect(defaultConfigDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me")).toBe(
        "C:\\Users\\me\\AppData\\Roaming\\core",
      );
    });

    it("still prefers CORE_CONFIG_DIR and then XDG_CONFIG_HOME", () => {
      const env = { CORE_CONFIG_DIR: "D:\\core", XDG_CONFIG_HOME: "D:\\xdg", APPDATA: "C:\\Roaming" };
      expect(defaultConfigDir(env, "win32", "C:\\Users\\me")).toBe("D:\\core");
      expect(defaultConfigDir({ XDG_CONFIG_HOME: "D:\\xdg", APPDATA: "C:\\Roaming" }, "win32", "C:\\Users\\me")).toBe(
        "D:\\xdg\\core",
      );
    });

    it("falls back to the home directory without APPDATA", () => {
      expect(defaultConfigDir({}, "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\.config\\core");
    });
  });

  it("does not use APPDATA outside win32", () => {
    expect(defaultConfigDir({ APPDATA: "/ignored" }, "linux", "/home/me")).toBe("/home/me/.config/core");
  });
});

describe("loadConfig and saveConfig", () => {
  const sample: Config = {
    route: ["ollama:llama3.2:3b", "openrouter:openrouter/free"],
    timeoutMs: 8000,
    cloudflare: { oauthClientId: "client-1" },
  };

  it("round-trips a config", async () => {
    const { io } = fakeIo();
    await saveConfig(io.configDir, sample);
    expect(await loadConfig(io.configDir)).toEqual(sample);
  });

  it("round-trips an empty config", async () => {
    const { io } = fakeIo();
    await saveConfig(io.configDir, {});
    expect(await loadConfig(io.configDir)).toEqual({});
  });

  it("treats a missing file, and a missing directory, as {}", async () => {
    const { io } = fakeIo();
    expect(await loadConfig(io.configDir)).toEqual({});
    expect(await loadConfig(join(io.configDir, "nowhere", "deeper"))).toEqual({});
  });

  it("writes pretty JSON to config.json and leaves no temporary files", async () => {
    const { io } = fakeIo();
    await saveConfig(io.configDir, sample);
    await saveConfig(io.configDir, { ...sample, timeoutMs: 9000 });
    expect(await readdir(io.configDir)).toEqual(["config.json"]);
    const text = await readFile(join(io.configDir, "config.json"), "utf8");
    expect(text).toContain("\n  ");
    expect(JSON.parse(text)).toEqual({ ...sample, timeoutMs: 9000 });
  });

  it.runIf(posix)("creates the directory with mode 0700", async () => {
    const { io } = fakeIo();
    await saveConfig(io.configDir, sample);
    expect((await stat(io.configDir)).mode & 0o777).toBe(0o700);
  });

  it("names the path for malformed JSON, without echoing the content", async () => {
    const { io } = fakeIo();
    await mkdir(io.configDir, { recursive: true });
    const path = join(io.configDir, "config.json");
    await writeFile(path, '{ "route": ["leaky-content-marker"');
    const error = await caught(loadConfig(io.configDir));
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain(path);
    expect(error.message).not.toContain("leaky-content-marker");
  });

  it.each([
    ["an unknown key", { route: ["a:b"], extra: 1 }],
    ["an unknown nested key", { cloudflare: { oauthClientId: "x", extra: 1 } }],
    ["an empty route", { route: [] }],
    ["an empty route entry", { route: [""] }],
    ["a non-string route entry", { route: [5] }],
    ["a negative timeout", { timeoutMs: -1 }],
    ["a zero timeout", { timeoutMs: 0 }],
    ["a fractional timeout", { timeoutMs: 1.5 }],
    ["a string timeout", { timeoutMs: "8000" }],
    ["an empty client id", { cloudflare: { oauthClientId: "" } }],
    ["a top-level array", ["a:b"]],
  ])("rejects %s with bad_request naming the path", async (_name, content) => {
    const { io } = fakeIo();
    await mkdir(io.configDir, { recursive: true });
    const path = join(io.configDir, "config.json");
    await writeFile(path, JSON.stringify(content));
    const error = await caught(loadConfig(io.configDir));
    expect(error.code).toBe("bad_request");
    expect(error.message.startsWith(`${path}: `)).toBe(true);
  });

  it("refuses to save an invalid config and writes nothing", async () => {
    const { io } = fakeIo();
    const error = await caught(saveConfig(io.configDir, { timeoutMs: -5 }));
    expect(error.code).toBe("bad_request");
    await expect(stat(join(io.configDir, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("resolveRoute", () => {
  const config: Config = { route: ["config:one", "config:two"] };

  it("prefers the flag over the environment over the config", () => {
    expect(resolveRoute("flag:a,flag:b", { CORE_ROUTE: "env:a" }, config)).toEqual([
      { provider: "flag", model: "a" },
      { provider: "flag", model: "b" },
    ]);
    expect(resolveRoute(undefined, { CORE_ROUTE: "env:a" }, config)).toEqual([{ provider: "env", model: "a" }]);
    expect(resolveRoute(undefined, {}, config)).toEqual([
      { provider: "config", model: "one" },
      { provider: "config", model: "two" },
    ]);
  });

  it("splits on the first colon only, so model names may contain colons and slashes", () => {
    expect(resolveRoute("ollama:llama3.2:3b,cloudflare:@cf/meta/llama-3.1-8b-instruct", {}, {})).toEqual([
      { provider: "ollama", model: "llama3.2:3b" },
      { provider: "cloudflare", model: "@cf/meta/llama-3.1-8b-instruct" },
    ]);
  });

  it("trims entries and ignores empty ones", () => {
    expect(resolveRoute(" a:b , ,c:d,", {}, {})).toEqual([
      { provider: "a", model: "b" },
      { provider: "c", model: "d" },
    ]);
  });

  it("treats an empty flag or variable as unset", () => {
    expect(resolveRoute("", { CORE_ROUTE: "env:a" }, config)).toEqual([{ provider: "env", model: "a" }]);
    expect(resolveRoute(undefined, { CORE_ROUTE: "" }, config)).toHaveLength(2);
  });

  it.each([
    ["flag", (entry: string) => resolveRoute(`ok:model,${entry}`, {}, {})],
    ["environment", (entry: string) => resolveRoute(undefined, { CORE_ROUTE: `ok:model,${entry}` }, {})],
    ["config", (entry: string) => resolveRoute(undefined, {}, { route: ["ok:model", entry] })],
  ])("rejects a bad %s entry with bad_request, naming it", (_name, resolve) => {
    for (const entry of ["bogus", ":model", "provider:"]) {
      try {
        resolve(entry);
        throw new Error("expected resolveRoute to throw");
      } catch (error) {
        expect(CoreError.is(error)).toBe(true);
        expect((error as CoreError).code).toBe("bad_request");
        expect((error as CoreError).message).toContain(`"${entry}"`);
      }
    }
  });

  it("gives the documented message when nothing is set", () => {
    for (const call of [() => resolveRoute(undefined, {}, {}), () => resolveRoute("", { CORE_ROUTE: "" }, { })]) {
      try {
        call();
        throw new Error("expected resolveRoute to throw");
      } catch (error) {
        expect((error as CoreError).code).toBe("bad_request");
        expect((error as CoreError).message).toBe(
          'no model chosen: pass --model, set CORE_ROUTE, or run "core config set route <provider:model,...>"',
        );
      }
    }
  });
});

describe("core config", () => {
  async function config(argv: string[], fake = fakeIo()) {
    const code = await run(["config", ...argv], fake.io);
    return { code, fake };
  }

  it("prints the effective config as JSON", async () => {
    const fake = fakeIo();
    expect((await config([], fake)).code).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({});

    await saveConfig(fake.io.configDir, { timeoutMs: 5000 });
    const again = fakeIo({ configDir: fake.io.configDir });
    await config([], again);
    expect(JSON.parse(again.stdout())).toEqual({ timeoutMs: 5000 });
  });

  it("sets, gets and unsets route", async () => {
    const fake = fakeIo();
    expect((await config(["set", "route", "ollama:llama3.2:3b, openrouter:openrouter/free"], fake)).code).toBe(0);
    expect(await loadConfig(fake.io.configDir)).toEqual({ route: ["ollama:llama3.2:3b", "openrouter:openrouter/free"] });

    const get = fakeIo({ configDir: fake.io.configDir });
    expect((await config(["get", "route"], get)).code).toBe(0);
    expect(get.stdout()).toBe("ollama:llama3.2:3b,openrouter:openrouter/free\n");

    const unset = fakeIo({ configDir: fake.io.configDir });
    expect((await config(["unset", "route"], unset)).code).toBe(0);
    expect(await loadConfig(fake.io.configDir)).toEqual({});
  });

  it("sets, gets and unsets timeout-ms", async () => {
    const fake = fakeIo();
    expect((await config(["set", "timeout-ms", "12000"], fake)).code).toBe(0);
    expect(await loadConfig(fake.io.configDir)).toEqual({ timeoutMs: 12000 });
    const get = fakeIo({ configDir: fake.io.configDir });
    await config(["get", "timeout-ms"], get);
    expect(get.stdout()).toBe("12000\n");
    expect((await config(["unset", "timeout-ms"], fakeIo({ configDir: fake.io.configDir }))).code).toBe(0);
    expect(await loadConfig(fake.io.configDir)).toEqual({});
  });

  it("sets, gets and unsets cloudflare.oauth-client-id", async () => {
    const fake = fakeIo();
    expect((await config(["set", "cloudflare.oauth-client-id", " client-xyz "], fake)).code).toBe(0);
    expect(await loadConfig(fake.io.configDir)).toEqual({ cloudflare: { oauthClientId: "client-xyz" } });
    const get = fakeIo({ configDir: fake.io.configDir });
    await config(["get", "cloudflare.oauth-client-id"], get);
    expect(get.stdout()).toBe("client-xyz\n");
    expect((await config(["unset", "cloudflare.oauth-client-id"], fakeIo({ configDir: fake.io.configDir }))).code).toBe(0);
    expect(await loadConfig(fake.io.configDir)).toEqual({});
  });

  it("keeps the other settings when one changes", async () => {
    const fake = fakeIo();
    await config(["set", "route", "a:b"], fake);
    await config(["set", "timeout-ms", "100"], fakeIo({ configDir: fake.io.configDir }));
    await config(["set", "cloudflare.oauth-client-id", "c"], fakeIo({ configDir: fake.io.configDir }));
    await config(["unset", "timeout-ms"], fakeIo({ configDir: fake.io.configDir }));
    expect(await loadConfig(fake.io.configDir)).toEqual({ route: ["a:b"], cloudflare: { oauthClientId: "c" } });
  });

  it("exits 1 and prints nothing when getting an unset key", async () => {
    const { code, fake } = await config(["get", "route"]);
    expect(code).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toBe("");
  });

  it("unsetting an unset key is fine", async () => {
    expect((await config(["unset", "route"])).code).toBe(0);
  });

  it.each([
    ["an unknown key (get)", ["get", "nope"]],
    ["an unknown key (set)", ["set", "nope", "1"]],
    ["an unknown key (unset)", ["unset", "nope"]],
    ["a missing key", ["get"]],
    ["a missing value", ["set", "route"]],
    ["a surplus argument", ["set", "route", "a:b", "c:d"]],
    ["a surplus argument to get", ["get", "route", "x"]],
    ["an unknown action", ["frobnicate"]],
    ["a route without a provider", ["set", "route", "bogus"]],
    ["an empty route", ["set", "route", " , "]],
    ["a route with one bad entry", ["set", "route", "a:b,bogus"]],
    ["timeout-ms zero", ["set", "timeout-ms", "0"]],
    ["timeout-ms negative", ["set", "timeout-ms", "-5"]],
    ["timeout-ms fractional", ["set", "timeout-ms", "1.5"]],
    ["timeout-ms with letters", ["set", "timeout-ms", "12abc"]],
    ["timeout-ms empty", ["set", "timeout-ms", ""]],
    ["an empty client id", ["set", "cloudflare.oauth-client-id", "  "]],
  ])("returns 2 for %s, with the usage on stderr, and changes nothing", async (_name, argv) => {
    const fake = fakeIo();
    expect((await config(argv, fake)).code).toBe(2);
    expect(fake.stderr()).toContain("error: ");
    expect(fake.stderr()).toContain("usage: core config");
    expect(await loadConfig(fake.io.configDir)).toEqual({});
  });

  it("returns 1 with a bad_request error when the saved file is invalid", async () => {
    const fake = fakeIo();
    await mkdir(fake.io.configDir, { recursive: true });
    await writeFile(join(fake.io.configDir, "config.json"), '{"nope":1}');
    expect((await config([], fake)).code).toBe(1);
    expect(fake.stderr()).toContain("error: bad_request: ");
    expect(fake.stderr()).toContain(join(fake.io.configDir, "config.json"));
  });
});
