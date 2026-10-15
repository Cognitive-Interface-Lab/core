import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskResultSchema, type AskResult } from "@core/contracts";
import { saveConfig } from "../src/config.js";
import { run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, type FakeIo, type FakeIoOptions } from "./fake-io.js";

afterEach(cleanupFakeIo);

const USAGE_LINE =
  "usage: core ask [--model <provider:model,...>] [--system-file <file>] [--schema <file>] [--json] [--timeout <ms>] <prompt...>";

const SCHEMA = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };

type Call = {
  url: string;
  headers: Headers;
  body: { model?: string; stream?: boolean; messages?: { role: string; content: unknown }[] };
};

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** A streamed OpenAI-format answer. */
function stream(parts: string[]): Response {
  const chunks = [
    chunk({ role: "assistant", content: "" }),
    ...parts.map((part) => chunk({ content: part })),
    chunk({}, "stop"),
    { ...chunk({}), choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A non-streaming OpenAI-format answer: what `router.chat` receives. */
function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const failure = (status: number) =>
  new Response(JSON.stringify({ error: { message: `server said ${status}` } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** An injected `fetch` that records each request and answers with `answer(call, index, init)`. */
function models(answer: (call: Call, index: number, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    };
    calls.push(call);
    return answer(call, calls.length - 1, init);
  };
  return { fetch: impl as typeof fetch, calls };
}

/** Never answers until the request is aborted, as a stuck connection would. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

/** Answers with `make()` after `ms`, unless the request is aborted first. */
const after = (ms: number, make: () => Response) => (init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(make()), ms);
    init?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      },
      { once: true },
    );
  });

/** The text of a message in a request body (a string, or a list of text parts). */
function text(message: { content: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? "").join("");
  return "";
}

const conversation = (call: Call | undefined) => (call?.body.messages ?? []).map((m) => `${m.role}: ${text(m)}`);

/** A fake `Io` whose default route is `ollama:llama3.1`, so the injected `fetch` plays the model. */
function ioWith(options: FakeIoOptions = {}): FakeIo {
  return fakeIo({ ...options, env: { CORE_ROUTE: "ollama:llama3.1", ...options.env } });
}

/** Writes a file into the fake's temporary directory and returns its path. */
function fileIn(fake: FakeIo, name: string, content: string): string {
  const path = join(dirname(fake.io.configDir), name);
  writeFileSync(path, content);
  return path;
}

const schemaIn = (fake: FakeIo) => fileIn(fake, "schema.json", JSON.stringify(SCHEMA));

/** The one-line `AskResult` on stdout. It is returned as printed, so a stray `details` key still shows. */
function resultOf(fake: FakeIo): AskResult {
  const out = fake.stdout();
  expect(out).toMatch(/^[^\n]+\n$/);
  const printed: unknown = JSON.parse(out);
  expect(AskResultSchema.safeParse(printed).success).toBe(true);
  return printed as AskResult;
}

function successOf(fake: FakeIo): Extract<AskResult, { ok: true }> {
  const result = resultOf(fake);
  if (!result.ok) throw new Error(`expected ok: true, got ${JSON.stringify(result)}`);
  return result;
}

function failureOf(fake: FakeIo): Extract<AskResult, { ok: false }> {
  const result = resultOf(fake);
  if (result.ok) throw new Error(`expected ok: false, got ${JSON.stringify(result)}`);
  return result;
}

const OLLAMA = { provider: "ollama", model: "llama3.1" };

describe("core ask --schema", () => {
  it("prints the validated object as one line of JSON", async () => {
    const server = models(() => completion('{ "answer": 42 }'));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "what is 6 times 7"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe('{"answer":42}\n');
    expect(fake.stderr()).toBe("[ollama:llama3.1]\n");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.body.stream).not.toBe(true);
    expect(conversation(server.calls[0])).toEqual(["user: what is 6 times 7"]);
  });

  it("exits 1 with unknown when the reply is not JSON", async () => {
    const server = models(() => completion("I would rather not say."));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toMatch(
      /^attempt 1 ollama:llama3\.1: unknown: structured output is not valid JSON\nerror: unknown: .+\n$/,
    );
  });

  it("exits 1 with unknown when the reply does not match the schema", async () => {
    const server = models(() => completion('{"answer": "forty-two"}'));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toContain("attempt 1 ollama:llama3.1: unknown: structured output does not match outputSchema");
    expect(fake.stderr()).toMatch(/\nerror: unknown: .+\n$/);
  });

  it("exits 1 with unknown on mock:echo, whose reply is never JSON", async () => {
    const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" } });
    expect(await run(["ask", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toContain("attempt 1 mock:echo: unknown: ");
    expect(fake.stderr()).toMatch(/\nerror: unknown: .+\n$/);
  });

  it("falls back from a step that fails validation, naming the failed attempt and then the model", async () => {
    const server = models(() => completion('{"answer": 7}'));
    const fake = fakeIo({ env: {}, fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "--model", "mock:echo,ollama:llama3.1", "hi"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe('{"answer":7}\n');
    expect(fake.stderr()).toBe(
      "attempt 1 mock:echo: unknown: structured output is not valid JSON\n[ollama:llama3.1]\n",
    );
  });

  it("stops on Ctrl+C with exit 130 and nothing on stdout or stderr", async () => {
    const server = models((_call, _index, init) => hang(init));
    const fake = ioWith({ fetch: server.fetch });
    const finished = run(["ask", "--schema", schemaIn(fake), "hi"], fake.io);
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    expect(fake.interrupt()).toBe(true);
    expect(await finished).toBe(130);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toBe("");
  });
});

describe("input errors are usage errors, reported before any model is called", () => {
  const SECRET = "text-that-must-not-be-echoed";
  const cases: [string, (fake: FakeIo) => string[]][] = [
    ["a missing schema file", (fake) => ["--schema", join(dirname(fake.io.configDir), "absent.json")]],
    ["a schema file that is not JSON", (fake) => ["--schema", fileIn(fake, "bad.json", `{ ${SECRET}`)]],
    ["a schema file holding a JSON array", (fake) => ["--schema", fileIn(fake, "array.json", JSON.stringify([SECRET]))]],
    ["a missing system file", (fake) => ["--system-file", join(dirname(fake.io.configDir), "absent.txt")]],
    ["a system file with only whitespace", (fake) => ["--system-file", fileIn(fake, "blank.txt", " \n\t ")]],
    ["--timeout 0", () => ["--timeout", "0"]],
    ["--timeout 1.5", () => ["--timeout", "1.5"]],
    ["--timeout abc", () => ["--timeout", "abc"]],
  ];

  it.each(cases)("%s", async (_name, options) => {
    const server = models(() => completion('{"answer": 1}'));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", ...options(fake), "hi"], fake.io)).toBe(2);
    expect(server.calls).toHaveLength(0);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toMatch(/^error: /);
    expect(fake.stderr()).toContain(USAGE_LINE);
    expect(fake.stderr()).not.toContain(SECRET);
  });
});

describe("core ask --system-file", () => {
  const SYSTEM = "You are terse.\n\n  Answer in one line.\n";

  it("puts the file first as a system message on the streaming path", async () => {
    const server = models(() => stream(["ok"]));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--system-file", fileIn(fake, "system.txt", SYSTEM), "hi"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("ok\n");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.body.stream).toBe(true);
    const messages = server.calls[0]?.body.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(text(messages[0])).toBe(SYSTEM);
    expect(text(messages[1])).toBe("hi");
  });

  it("puts the file first as a system message on the --schema path", async () => {
    const server = models(() => completion('{"answer": 1}'));
    const fake = ioWith({ fetch: server.fetch });
    const system = fileIn(fake, "system.txt", SYSTEM);
    expect(await run(["ask", "--system-file", system, "--schema", schemaIn(fake), "hi"], fake.io)).toBe(0);
    expect(server.calls[0]?.body.stream).not.toBe(true);
    const messages = server.calls[0]?.body.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(text(messages[0])).toBe(SYSTEM);
    expect(text(messages[1])).toBe("hi");
  });

  it("puts the file first as a system message with --json alone", async () => {
    const server = models(() => completion("plain answer"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "--system-file", fileIn(fake, "system.txt", SYSTEM), "hi"], fake.io)).toBe(0);
    expect(conversation(server.calls[0])).toEqual([`system: ${SYSTEM}`, "user: hi"]);
  });

  it("sends no system message without the option", async () => {
    const server = models(() => stream(["ok"]));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "hi"], fake.io)).toBe(0);
    expect(conversation(server.calls[0])).toEqual(["user: hi"]);
  });
});

describe("core ask --timeout", () => {
  it("fails a slow reply with timeout on the streaming path", async () => {
    const server = models((_call, _index, init) => hang(init));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--timeout", "20", "hi"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toContain("attempt 1 ollama:llama3.1: timeout: ollama:llama3.1 timed out after 20 ms");
    expect(fake.stderr()).toMatch(/\nerror: timeout: .+\n$/);
  });

  it("fails a slow reply with timeout on the --schema path", async () => {
    const server = models((_call, _index, init) => hang(init));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--timeout", "20", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toContain("attempt 1 ollama:llama3.1: timeout: ollama:llama3.1 timed out after 20 ms");
    expect(fake.stderr()).toMatch(/\nerror: timeout: .+\n$/);
  });

  it("applies to every step of the route", async () => {
    const server = models((_call, _index, init) => hang(init));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "--timeout", "20", "--model", "ollama:a,ollama:b", "hi"], fake.io)).toBe(1);
    expect(server.calls).toHaveLength(2);
    const result = failureOf(fake);
    expect(result.attempts.map((a) => [a.model.model, a.error?.code])).toEqual([
      ["a", "timeout"],
      ["b", "timeout"],
    ]);
    expect(result.attempts.every((a) => a.error?.message.includes("timed out after 20 ms"))).toBe(true);
  });

  it("is shorter than a long timeoutMs in the config", async () => {
    const server = models((_call, _index, init) => hang(init));
    const fake = ioWith({ fetch: server.fetch });
    await saveConfig(fake.io.configDir, { timeoutMs: 60_000 });
    expect(await run(["ask", "--timeout", "20", "hi"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("timed out after 20 ms");
  });

  it("is longer than a short timeoutMs in the config", async () => {
    const slow = after(120, () => completion('{"answer": 1}'));
    const server = models((_call, _index, init) => slow(init));
    const fake = ioWith({ fetch: server.fetch });
    await saveConfig(fake.io.configDir, { timeoutMs: 20 });
    const schema = schemaIn(fake);

    // Without the option, the config's limit applies and the reply is too slow.
    expect(await run(["ask", "--schema", schema, "hi"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("timed out after 20 ms");

    const again = ioWith({ fetch: server.fetch, configDir: fake.io.configDir });
    expect(await run(["ask", "--timeout", "5000", "--schema", schema, "hi"], again.io)).toBe(0);
    expect(again.stdout()).toBe('{"answer":1}\n');
  });
});

describe("core ask --json: success", () => {
  it("prints the result with model, text, usage and attempts, and no output without --schema", async () => {
    const server = models(() => completion("plain answer"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "hi"], fake.io)).toBe(0);
    const result = successOf(fake);
    expect(result.model).toEqual(OLLAMA);
    expect(result.text).toBe("plain answer");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(result.attempts).toEqual([{ model: OLLAMA, ok: true, ms: expect.any(Number) }]);
    expect(result).not.toHaveProperty("output");
    expect(fake.stderr()).toBe("[ollama:llama3.1]\n");
    expect(server.calls[0]?.body.stream).not.toBe(true);
  });

  it("adds the validated output with --schema", async () => {
    const server = models(() => completion('{ "answer": 42 }'));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(0);
    const result = successOf(fake);
    expect(result.output).toEqual({ answer: 42 });
    expect(result.text).toBe('{ "answer": 42 }');
    expect(result.model).toEqual(OLLAMA);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(fake.stderr()).toBe("[ollama:llama3.1]\n");
  });

  it("prints the output with --schema alone as the object, without the rest of the result", async () => {
    const server = models(() => completion('{"answer": 42}'));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({ answer: 42 });
  });

  it("names the model that answered as an object, on mock:echo too", async () => {
    const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" } });
    expect(await run(["ask", "--json", "hi"], fake.io)).toBe(0);
    const result = successOf(fake);
    expect(result.model).toEqual({ provider: "mock", model: "echo" });
    expect(result.text).toBe("echo: hi");
    expect(fake.stderr()).toBe("[mock:echo]\n");
  });

  it("keeps the failed steps in attempts when a later step answers", async () => {
    const server = models(() => completion('{"answer": 7}'));
    const fake = fakeIo({ env: {}, fetch: server.fetch });
    expect(
      await run(["ask", "--json", "--schema", schemaIn(fake), "--model", "mock:echo,ollama:llama3.1", "hi"], fake.io),
    ).toBe(0);
    const result = successOf(fake);
    expect(result.model).toEqual(OLLAMA);
    expect(result.output).toEqual({ answer: 7 });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ model: { provider: "mock", model: "echo" }, ok: false });
    expect(result.attempts[0]?.error?.code).toBe("unknown");
    expect(result.attempts[1]).toMatchObject({ model: OLLAMA, ok: true });
    expect(fake.stderr()).toBe(
      "attempt 1 mock:echo: unknown: structured output is not valid JSON\n[ollama:llama3.1]\n",
    );
  });
});

describe("core ask --json: failure", () => {
  it("prints ok: false with the error and the failed attempts when the model fails validation", async () => {
    const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" } });
    expect(await run(["ask", "--json", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    const result = failureOf(fake);
    expect(result.error.code).toBe("unknown");
    expect(result.error.retryable).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ model: { provider: "mock", model: "echo" }, ok: false });
    expect(result.attempts[0]?.error?.code).toBe("unknown");
    // stderr is what it is without --json.
    expect(fake.stderr()).toMatch(/^attempt 1 mock:echo: unknown: .+\nerror: unknown: .+\n$/);
  });

  it("lists every failed step, in route order, when none answers", async () => {
    const server = models(() => failure(503));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "--model", "ollama:a,ollama:b", "hi"], fake.io)).toBe(1);
    const result = failureOf(fake);
    expect(result.error.code).toBe("unavailable");
    expect(result.error.retryable).toBe(true);
    expect(result.attempts.map((a) => [a.model.model, a.ok, a.error?.code])).toEqual([
      ["a", false, "unavailable"],
      ["b", false, "unavailable"],
    ]);
    expect(fake.stderr()).toMatch(
      /^attempt 1 ollama:a: unavailable: .+\nattempt 2 ollama:b: unavailable: .+\nerror: unavailable: .+\n$/,
    );
  });

  it("leaves details out of the error, because the attempts are already top level", async () => {
    const server = models(() => failure(503));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "--model", "ollama:a,ollama:b", "hi"], fake.io)).toBe(1);
    const result = failureOf(fake);
    expect(result.error).not.toHaveProperty("details");
    expect(Object.keys(result.error).every((key) => ["code", "message", "retryable", "provider"].includes(key))).toBe(true);
  });

  it("reports a usage error after parsing as a bad_request result, and still prints stderr and the usage", async () => {
    const server = models(() => completion("never asked"));
    const fake = ioWith({ fetch: server.fetch });
    const missing = join(dirname(fake.io.configDir), "absent.json");
    expect(await run(["ask", "--json", "--schema", missing, "hi"], fake.io)).toBe(2);
    const result = failureOf(fake);
    expect(result.error.code).toBe("bad_request");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("--schema");
    expect(result.error.message).toContain(missing);
    expect(result.attempts).toEqual([]);
    expect(fake.stderr()).toContain(`error: ${result.error.message}`);
    expect(fake.stderr()).toContain(USAGE_LINE);
    expect(server.calls).toHaveLength(0);
  });

  it.each([
    ["no prompt", ["--json"], "no prompt given"],
    ["a bad route", ["--json", "--model", "bogus", "hi"], '"bogus"'],
    ["a bad --timeout", ["--json", "--timeout", "0", "hi"], "--timeout"],
    ["an empty system file", ["--json", "--system-file", "@blank", "hi"], "--system-file"],
  ])("reports %s as a bad_request result with exit 2", async (_name, argv, expected) => {
    const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" }, stdin: "", interactive: false });
    const args = argv.map((arg) => (arg === "@blank" ? fileIn(fake, "blank.txt", "  ") : arg));
    expect(await run(["ask", ...args], fake.io)).toBe(2);
    const result = failureOf(fake);
    expect(result.error.code).toBe("bad_request");
    expect(result.error.message).toContain(expected);
    expect(result.attempts).toEqual([]);
    expect(fake.stderr()).toContain(USAGE_LINE);
  });

  it("prints nothing on stdout when the arguments themselves do not parse", async () => {
    for (const argv of [
      ["ask", "--json", "--frobnicate", "hi"],
      ["ask", "--json", "--model"],
    ]) {
      const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" } });
      expect(await run(argv, fake.io)).toBe(2);
      expect(fake.stdout()).toBe("");
      expect(fake.stderr()).toContain(USAGE_LINE);
    }
  });

  it("reports any other failure after parsing with its code and the message stderr carries, exit 1", async () => {
    const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" } });
    mkdirSync(fake.io.configDir, { recursive: true });
    writeFileSync(join(fake.io.configDir, "config.json"), "{ not json");
    expect(await run(["ask", "--json", "hi"], fake.io)).toBe(1);
    const result = failureOf(fake);
    expect(result.error.code).toBe("bad_request");
    expect(result.error.message).toContain("not valid JSON");
    expect(result.attempts).toEqual([]);
    expect(fake.stderr()).toBe(`error: bad_request: ${result.error.message}\n`);
  });

  it("reports Ctrl+C as an aborted result with exit 130 and nothing on stderr", async () => {
    const server = models((_call, _index, init) => hang(init));
    const fake = ioWith({ fetch: server.fetch });
    const finished = run(["ask", "--json", "hi"], fake.io);
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    expect(fake.interrupt()).toBe(true);
    expect(await finished).toBe(130);
    const result = failureOf(fake);
    expect(result.error.code).toBe("aborted");
    expect(fake.stderr()).toBe("");
  });
});

describe("secrets", () => {
  const KEY = "or-secret-key-9f3a7c1d";
  const sources: [string, () => FakeIo][] = [
    ["an environment key", () => fakeIo({ env: { CORE_OPENROUTER_API_KEY: KEY } })],
    ["a saved key", () => fakeIo()],
  ];

  async function withKey(make: () => FakeIo, fetchImpl: typeof fetch): Promise<FakeIo> {
    const base = make();
    // Rebuilt around the same secret store and config directory, now with the injected `fetch`.
    const fake = fakeIo({ env: base.io.env, fetch: fetchImpl, secretStore: base.secrets, configDir: base.io.configDir });
    if (base.io.env["CORE_OPENROUTER_API_KEY"] === undefined) {
      await fake.secrets.set("openrouter", JSON.stringify({ kind: "api-key", apiKey: KEY }));
    }
    return fake;
  }

  it.each(sources)("never prints %s, on success or failure, with or without --json", async (_name, make) => {
    const answering = models(() => completion('{"answer": 1}'));
    // Some servers repeat the key they reject; it must still not reach the output.
    const failing = models(
      () =>
        new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const route = ["--model", "openrouter:some/model"];

    const ok = await withKey(make, answering.fetch);
    expect(await run(["ask", "--json", "--schema", schemaIn(ok), ...route, "hi"], ok.io)).toBe(0);
    // The key was in use, so its absence from the output means something.
    expect(answering.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(ok.stdout()).not.toContain(KEY);
    expect(ok.stderr()).not.toContain(KEY);

    for (const extra of [["--json"], ["--json", "--schema", "SCHEMA"], ["--schema", "SCHEMA"], []]) {
      const bad = await withKey(make, failing.fetch);
      const argv = extra.map((arg) => (arg === "SCHEMA" ? schemaIn(bad) : arg));
      expect(await run(["ask", ...argv, ...route, "hi"], bad.io)).toBe(1);
      expect(bad.stdout()).not.toContain(KEY);
      expect(bad.stderr()).not.toContain(KEY);
      // The server's message did reach the output, with the key taken out.
      expect(bad.stderr()).toContain("Incorrect API key provided");
      if (extra.includes("--json")) expect(bad.stdout()).toContain("Incorrect API key provided");
    }
    expect(failing.calls.length).toBeGreaterThan(0);
    expect(failing.calls.every((call) => call.headers.get("authorization") === `Bearer ${KEY}`)).toBe(true);
  });
});

describe("core help ask", () => {
  it.each([
    ["help ask", ["help", "ask"]],
    ["ask --help", ["ask", "--help"]],
  ])("documents the four options (%s)", async (_name, argv) => {
    const fake = fakeIo();
    expect(await run(argv, fake.io)).toBe(0);
    const out = fake.stdout();
    expect(out).toContain(USAGE_LINE);
    for (const option of ["--system-file", "--schema", "--json", "--timeout"]) {
      // Once in the synopsis and once in the paragraph that explains it.
      expect(out.split(option).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});
