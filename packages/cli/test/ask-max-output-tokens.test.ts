import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AskResultSchema, type AskResult } from "@core/contracts";
import { run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, type FakeIo, type FakeIoOptions } from "./fake-io.js";

afterEach(cleanupFakeIo);

const SCHEMA = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
const CUT_OFF = 'structured output was cut off at the output-token limit (finish reason "length")';
const HINT = "hint: raise --max-output-tokens\n";
const NOTE = 'note: the answer was cut off at the output-token limit (finish reason "length")\n';

type Call = { url: string; body: Record<string, unknown> };

/** An injected `fetch` that records each request body and answers with `answer(call, index)`. */
function models(answer: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") };
    calls.push(call);
    return answer(call, calls.length - 1);
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A non-streaming OpenAI-format answer. */
function completion(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** A streamed OpenAI-format answer that ends with `finishReason`. */
function stream(parts: string[], finishReason = "stop"): Response {
  const chunks = [
    chunk({ role: "assistant", content: "" }),
    ...parts.map((part) => chunk({ content: part })),
    chunk({}, finishReason),
    { ...chunk({}), choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const serverError = () =>
  new Response(JSON.stringify({ error: { message: "server said 500" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

/** A fake `Io` whose default route is `ollama:llama3.1`, so the injected `fetch` plays the model. */
function ioWith(options: FakeIoOptions = {}): FakeIo {
  return fakeIo({ ...options, env: { CORE_ROUTE: "ollama:llama3.1", ...options.env } });
}

function schemaIn(fake: FakeIo): string {
  const path = join(dirname(fake.io.configDir), "schema.json");
  writeFileSync(path, JSON.stringify(SCHEMA));
  return path;
}

function resultOf(fake: FakeIo): AskResult {
  const printed: unknown = JSON.parse(fake.stdout());
  expect(AskResultSchema.safeParse(printed).success).toBe(true);
  return printed as AskResult;
}

function failureOf(fake: FakeIo): Extract<AskResult, { ok: false }> {
  const result = resultOf(fake);
  if (result.ok) throw new Error(`expected ok: false, got ${JSON.stringify(result)}`);
  return result;
}

describe("core ask --max-output-tokens reaches the provider", () => {
  it("sends max_tokens on the --schema path", async () => {
    const server = models(() => completion('{"answer": 1}'));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--max-output-tokens", "8192", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(0);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.body["max_tokens"]).toBe(8192);
  });

  it("sends max_tokens with --json alone", async () => {
    const server = models(() => completion("hello"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--max-output-tokens", "8192", "--json", "hi"], fake.io)).toBe(0);
    expect(server.calls[0]?.body["max_tokens"]).toBe(8192);
  });

  it("sends max_tokens on the streamed path", async () => {
    const server = models(() => stream(["hel", "lo"]));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--max-output-tokens", "8192", "hi"], fake.io)).toBe(0);
    expect(server.calls[0]?.body["stream"]).toBe(true);
    expect(server.calls[0]?.body["max_tokens"]).toBe(8192);
  });

  it("sends no max_tokens without the option, on every path", async () => {
    const structured = models(() => completion('{"answer": 1}'));
    const a = ioWith({ fetch: structured.fetch });
    expect(await run(["ask", "--schema", schemaIn(a), "hi"], a.io)).toBe(0);
    const json = models(() => completion("hello"));
    const b = ioWith({ fetch: json.fetch });
    expect(await run(["ask", "--json", "hi"], b.io)).toBe(0);
    const streamed = models(() => stream(["hello"]));
    const c = ioWith({ fetch: streamed.fetch });
    expect(await run(["ask", "hi"], c.io)).toBe(0);
    for (const call of [...structured.calls, ...json.calls, ...streamed.calls]) {
      expect(call.body).not.toHaveProperty("max_tokens");
    }
  });

  it("reaches an anthropic route as max_tokens, and leaves the SDK default without the option", async () => {
    const env = { CORE_ANTHROPIC_API_KEY: "sk-ant-test-key-150" };
    const limited = models(serverError);
    const a = fakeIo({ env, fetch: limited.fetch });
    await run(["ask", "--json", "--model", "anthropic:claude-test", "--max-output-tokens", "8192", "hi"], a.io);
    expect(limited.calls.length).toBeGreaterThan(0);
    for (const call of limited.calls) expect(call.body["max_tokens"]).toBe(8192);

    const unlimited = models(serverError);
    const b = fakeIo({ env, fetch: unlimited.fetch });
    await run(["ask", "--json", "--model", "anthropic:claude-test", "hi"], b.io);
    expect(unlimited.calls.length).toBeGreaterThan(0);
    for (const call of unlimited.calls) {
      expect(typeof call.body["max_tokens"]).toBe("number");
      expect(call.body["max_tokens"]).not.toBe(8192);
    }
  });

  it("applies to every step of a two-step route, whose first step fails", async () => {
    const server = models((_call, index) => (index === 0 ? serverError() : completion("second")));
    const fake = fakeIo({ env: {}, fetch: server.fetch });
    expect(
      await run(["ask", "--json", "--max-output-tokens", "8192", "--model", "ollama:a,ollama:b", "hi"], fake.io),
    ).toBe(0);
    expect(server.calls.map((call) => call.body["model"])).toEqual(["a", "b"]);
    expect(server.calls.map((call) => call.body["max_tokens"])).toEqual([8192, 8192]);
  });
});

describe("core ask --max-output-tokens input errors", () => {
  it.each([["0"], ["abc"], ["1.5"], ["=-1"]])("rejects %s with exit 2 and no model call", async (value) => {
    const args = value === "=-1" ? ["--max-output-tokens=-1"] : ["--max-output-tokens", value];
    const server = models(() => completion("never"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", ...args, "hi"], fake.io)).toBe(2);
    expect(server.calls).toHaveLength(0);
    expect(fake.stderr()).toContain("--max-output-tokens must be a positive whole number");
  });

  it.each([["0"], ["abc"], ["1.5"], ["=-1"]])("prints a bad_request result for %s under --json", async (value) => {
    const args = value === "=-1" ? ["--max-output-tokens=-1"] : ["--max-output-tokens", value];
    const server = models(() => completion("never"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", ...args, "hi"], fake.io)).toBe(2);
    expect(server.calls).toHaveLength(0);
    const result = failureOf(fake);
    expect(result.error.code).toBe("bad_request");
    expect(result.error.message).toContain("--max-output-tokens");
  });

  // `-1` as a separate token looks like an option to the argument parser, which rejects it before
  // `--json` is known, so it is exit 2 with a stderr message and no result, as `--timeout -1` is.
  it("rejects -1 as a separate token with exit 2 and no model call", async () => {
    const server = models(() => completion("never"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--max-output-tokens", "-1", "hi"], fake.io)).toBe(2);
    expect(server.calls).toHaveLength(0);
    expect(fake.stderr()).toContain("--max-output-tokens");
  });
});

describe("a structured answer cut off under --schema", () => {
  it.each([
    ["empty content", ""],
    ["truncated JSON", '{"answer": 4'],
  ])("fails with the cut-off message and the hint (%s)", async (_name, content) => {
    const server = models(() => completion(content, "length"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    expect(fake.stderr()).toContain(`attempt 1 ollama:llama3.1: unknown: ${CUT_OFF}\n`);
    expect(fake.stderr().endsWith(HINT)).toBe(true);
    expect(fake.stderr().indexOf("error: unknown: ")).toBeLessThan(fake.stderr().indexOf(HINT));
  });

  it.each([
    ["empty content", ""],
    ["truncated JSON", '{"answer": 4'],
  ])("carries details.finishReason in the --json attempt (%s)", async (_name, content) => {
    const server = models(() => completion(content, "length"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    const result = failureOf(fake);
    expect(result.attempts[0]?.error?.message).toBe(CUT_OFF);
    expect(result.attempts[0]?.error?.details?.["finishReason"]).toBe("length");
    expect(fake.stderr().endsWith(HINT)).toBe(true);
  });

  it("does not add the hint to a failure that was not a cut-off", async () => {
    const server = models(() => completion("not json", "stop"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(1);
    expect(fake.stderr()).not.toContain("hint:");
  });

  it("returns a cut-off reply that still validates, without the hint", async () => {
    const server = models(() => completion('{"answer": 42}', "length"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--schema", schemaIn(fake), "hi"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe('{"answer":42}\n');
    expect(fake.stderr()).toBe("[ollama:llama3.1]\n");
    expect(fake.stderr()).not.toContain("hint:");
  });
});

describe("an answer cut off without a schema", () => {
  it("prints the streamed text on stdout and the note on stderr, before the model line", async () => {
    const server = models(() => stream(["par", "tial"], "length"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "hi"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("partial\n");
    expect(fake.stderr()).toBe(`${NOTE}[ollama:llama3.1]\n`);
  });

  it("does the same with --json alone", async () => {
    const server = models(() => completion("partial", "length"));
    const fake = ioWith({ fetch: server.fetch });
    expect(await run(["ask", "--json", "hi"], fake.io)).toBe(0);
    const result = resultOf(fake);
    expect(result.ok && result.text).toBe("partial");
    expect(fake.stderr()).toBe(`${NOTE}[ollama:llama3.1]\n`);
  });

  it("writes no note for a normal stop", async () => {
    const streamed = models(() => stream(["fine"]));
    const a = ioWith({ fetch: streamed.fetch });
    expect(await run(["ask", "hi"], a.io)).toBe(0);
    expect(a.stderr()).toBe("[ollama:llama3.1]\n");
    const json = models(() => completion("fine"));
    const b = ioWith({ fetch: json.fetch });
    expect(await run(["ask", "--json", "hi"], b.io)).toBe(0);
    expect(b.stderr()).toBe("[ollama:llama3.1]\n");
  });
});

describe("core help ask", () => {
  it("documents --max-output-tokens", async () => {
    const fake = fakeIo({ env: {} });
    expect(await run(["help", "ask"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("[--max-output-tokens <n>]");
    expect(fake.stdout()).toContain("--max-output-tokens limits the output tokens of each model request");
  });
});
