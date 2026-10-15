import { afterEach, describe, expect, it } from "vitest";
import { PRESETS } from "@core/models";
import { completeRoute } from "../src/completion/route.js";
import { completionSpec } from "../src/completion/spec.js";
import { commands, run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, type FakeIo } from "./fake-io.js";

afterEach(cleanupFakeIo);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A fake `fetch` that records each URL and answers with `answer`. */
function recordingFetch(answer: (url: string, init?: RequestInit) => Promise<Response>) {
  const urls: string[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    urls.push(String(input));
    return answer(String(input), init);
  };
  return { fetch: impl as typeof fetch, urls };
}

const ollamaLists = () => recordingFetch(async () => json({ data: [{ id: "llama3" }, { id: "qwen" }] }));

/** Every case also checks that nothing touched the secret store or wrote output. */
function expectNoSideEffects(fake: FakeIo): void {
  expect(fake.secretsOpened()).toBe(0);
  expect(fake.stdout()).toBe("");
  expect(fake.stderr()).toBe("");
}

describe("completionSpec", () => {
  it("lists every registered command plus help, and never __complete", () => {
    const spec = completionSpec();
    expect(Object.keys(spec.commands).sort()).toEqual([...Object.keys(commands), "help"].sort());
    expect(spec.commands).not.toHaveProperty("__complete");
  });

  it("takes options and value options from each synopsis", () => {
    const spec = completionSpec();
    expect(spec.commands["login"]?.options).toEqual(["--key", "--browser", "--account-id", "--no-open", "--help"]);
    expect(spec.commands["login"]?.valueOptions).toEqual(["--account-id"]);
    expect(spec.commands["ask"]?.valueOptions).toEqual(["--model", "--system-file", "--schema", "--timeout"]);
    expect(spec.commands["chat"]?.valueOptions).toEqual(["--model", "--system"]);
  });

  it("gives each command its positional kind", () => {
    const { commands: specs } = completionSpec();
    expect(specs["help"]?.positional).toBe("command");
    for (const name of ["login", "logout", "models"]) expect(specs[name]?.positional).toBe("provider");
    expect(specs["config"]?.positional).toBe("config");
    expect(specs["completion"]?.positional).toBe("shell");
    expect(specs["ask"]?.positional).toBeUndefined();
  });

  it("lists providers and config keys", () => {
    const spec = completionSpec();
    expect(spec.providers).toEqual(Object.keys(PRESETS).sort());
    expect(spec.configKeys).toEqual(["route", "timeout-ms", "cloudflare.oauth-client-id"]);
  });
});

describe("completeRoute", () => {
  it("offers every provider prefix for an empty word", async () => {
    const fake = fakeIo();
    expect(await completeRoute("", fake.io)).toEqual(Object.keys(PRESETS).sort().map((id) => `${id}:`));
    expectNoSideEffects(fake);
  });

  it("filters provider prefixes by what was typed", async () => {
    const fake = fakeIo();
    expect(await completeRoute("ol", fake.io)).toEqual(["ollama:"]);
    expectNoSideEffects(fake);
  });

  it("lists the local Ollama's models after ollama:", async () => {
    const { fetch } = ollamaLists();
    const fake = fakeIo({ fetch });
    expect(await completeRoute("ollama:", fake.io)).toEqual(["ollama:llama3", "ollama:qwen"]);
    expect(await completeRoute("ollama:q", fake.io)).toEqual(["ollama:qwen"]);
    expectNoSideEffects(fake);
  });

  it("completes the segment after the last comma", async () => {
    const fake = fakeIo();
    expect(await completeRoute("ollama:llama3,op", fake.io)).toEqual([
      "ollama:llama3,openai:",
      "ollama:llama3,openrouter:",
    ]);
    expectNoSideEffects(fake);
  });

  it("gives no models when Ollama cannot be reached", async () => {
    const fake = fakeIo({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(await completeRoute("ollama:", fake.io)).toEqual([]);
    expectNoSideEffects(fake);
  });

  it("gives up on an Ollama that never answers", async () => {
    const { fetch } = recordingFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const fake = fakeIo({ fetch });
    expect(await completeRoute("ollama:", fake.io)).toEqual([]);
    expectNoSideEffects(fake);
  });

  it("never asks a remote provider", async () => {
    const recorded = ollamaLists();
    const fake = fakeIo({ fetch: recorded.fetch });
    expect(await completeRoute("openrouter:", fake.io)).toEqual([]);
    expect(recorded.urls).toEqual([]);
    expectNoSideEffects(fake);
  });

  it("asks the Ollama at CORE_OLLAMA_BASE_URL", async () => {
    const recorded = ollamaLists();
    const fake = fakeIo({ fetch: recorded.fetch, env: { CORE_OLLAMA_BASE_URL: "http://gpu-box:11434/v1" } });
    expect(await completeRoute("ollama:", fake.io)).toEqual(["ollama:llama3", "ollama:qwen"]);
    expect(recorded.urls.length).toBeGreaterThan(0);
    for (const url of recorded.urls) expect(url.startsWith("http://gpu-box:11434/v1")).toBe(true);
    expectNoSideEffects(fake);
  });
});

describe("run: completion entry points", () => {
  it("__complete route prints one candidate per line", async () => {
    const fake = fakeIo();
    expect(await run(["__complete", "route", "ol"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("ollama:\n");
    expect(fake.stderr()).toBe("");
  });

  it("any other __complete call prints nothing", async () => {
    const fake = fakeIo();
    expect(await run(["__complete", "bogus"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toBe("");
  });

  it("the overall help never mentions __complete", async () => {
    const fake = fakeIo();
    expect(await run(["--help"], fake.io)).toBe(0);
    expect(fake.stdout()).not.toContain("__complete");
  });

  it("completion bash prints the script", async () => {
    const fake = fakeIo();
    expect(await run(["completion", "bash"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("complete -F _core core");
  });

  it("completion without a shell, or with an unknown one, is a usage error", async () => {
    expect(await run(["completion"], fakeIo().io)).toBe(2);
    const fake = fakeIo();
    expect(await run(["completion", "zsh"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain('unknown shell "zsh"; supported: bash');
  });
});
