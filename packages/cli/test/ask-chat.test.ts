import { afterEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.js";
import { run } from "../src/run.js";
import { cleanupFakeIo, fakeIo, type FakeIo, type FakeIoOptions } from "./fake-io.js";

afterEach(cleanupFakeIo);

const OLLAMA_CHAT = "http://127.0.0.1:11434/v1/chat/completions";
const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";

type Call = { url: string; body: { model?: string; stream?: boolean; messages?: { role: string; content: unknown }[]; tools?: unknown } };

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** A streamed OpenAI-format answer made of `parts`. */
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

const failure = (status: number) =>
  new Response(JSON.stringify({ error: { message: `server said ${status}` } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** An injected `fetch` that records each request body and answers with `answer(call, index)`. */
function models(answer: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") };
    calls.push(call);
    return answer(call, calls.length - 1);
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A server that answers "answer 1", "answer 2", ... */
const counting = () => models((_call, index) => stream([`answer ${index + 1}`]));

/** Never answers until the request is aborted, as a stuck connection would. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
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

describe("core ask", () => {
  it("answers through the mock model, naming it on stderr", async () => {
    const fake = fakeIo();
    expect(await run(["ask", "--model", "mock:echo", "hi"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("echo: hi\n");
    expect(fake.stderr()).toBe("[mock:echo]\n");
  });

  it("joins the arguments with spaces into the prompt", async () => {
    const fake = fakeIo();
    expect(await run(["ask", "--model", "mock:echo", "hello", "big", "world"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("echo: hello big world\n");
  });

  it("uses piped input when there are no arguments", async () => {
    const fake = fakeIo({ stdin: "  from a pipe\n", interactive: false });
    expect(await run(["ask", "--model", "mock:echo"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("echo: from a pipe\n");
  });

  it("prefers the arguments over piped input", async () => {
    const fake = fakeIo({ stdin: "ignored", interactive: false });
    await run(["ask", "--model", "mock:echo", "typed"], fake.io);
    expect(fake.stdout()).toBe("echo: typed\n");
  });

  it("does not read the terminal when interactive: no arguments is a usage error", async () => {
    const fake = fakeIo({
      interactive: true,
      readAll: async () => {
        throw new Error("must not read stdin");
      },
    });
    expect(await run(["ask", "--model", "mock:echo"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("no prompt given");
  });

  it("returns 2 when there is no prompt at all, with the usage", async () => {
    const fake = fakeIo({ stdin: "  \n", interactive: false });
    expect(await run(["ask", "--model", "mock:echo"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("no prompt given");
    expect(fake.stderr()).toContain("usage: core ask");
  });

  it("returns 2 with the documented message when no route is set", async () => {
    const fake = fakeIo();
    expect(await run(["ask", "hi"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain(
      'no model chosen: pass --model, set CORE_ROUTE, or run "core config set route <provider:model,...>"',
    );
  });

  it("returns 2, naming the entry, for a bad route", async () => {
    const fake = fakeIo();
    expect(await run(["ask", "--model", "mock:echo,bogus", "hi"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain('"bogus"');
  });

  it.each([
    ["an unknown flag", ["ask", "--frobnicate", "hi"]],
    ["--model without a value", ["ask", "--model"]],
  ])("returns 2 for %s", async (_name, argv) => {
    const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" } });
    expect(await run(argv, fake.io)).toBe(2);
  });

  it("takes the route from CORE_ROUTE, then the config, with the flag first", async () => {
    const env = fakeIo({ env: { CORE_ROUTE: "mock:from-env" } });
    await run(["ask", "hi"], env.io);
    expect(env.stderr()).toBe("[mock:from-env]\n");

    const config = fakeIo();
    await saveConfig(config.io.configDir, { route: ["mock:from-config"] });
    await run(["ask", "hi"], config.io);
    expect(config.stderr()).toBe("[mock:from-config]\n");

    const flag = fakeIo({ env: { CORE_ROUTE: "mock:from-env" } });
    await run(["ask", "--model", "mock:from-flag", "hi"], flag.io);
    expect(flag.stderr()).toBe("[mock:from-flag]\n");
  });

  it("streams an OpenAI-format answer and sends only the user's message, with no tools", async () => {
    const server = models(() => stream(["Hel", "lo ", "there"]));
    const fake = fakeIo({ fetch: server.fetch });
    expect(await run(["ask", "--model", "ollama:llama3.1", "say hello"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("Hello there\n");
    expect(fake.stderr()).toBe("[ollama:llama3.1]\n");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe(OLLAMA_CHAT);
    expect(server.calls[0]?.body.model).toBe("llama3.1");
    expect(server.calls[0]?.body.stream).toBe(true);
    expect(conversation(server.calls[0])).toEqual(["user: say hello"]);
    expect(server.calls[0]?.body.tools).toBeUndefined();
  });

  it("falls back past a failing first step, printing the failed attempt and answering from mock", async () => {
    const server = models(() => failure(401));
    const fake = fakeIo({ env: { CORE_OPENROUTER_API_KEY: "or-secret-123456" }, fetch: server.fetch });
    expect(await run(["ask", "--model", "openrouter:some/model,mock:echo", "hi"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("echo: hi\n");
    expect(fake.stderr()).toMatch(/^attempt 1 openrouter:some\/model: auth: .*\n\[mock:echo\]\n$/);
    expect(server.calls[0]?.url).toBe(OPENROUTER_CHAT);
    expect(fake.stderr()).not.toContain("or-secret-123456");
  });

  it("reports a step with no key as a failed attempt too", async () => {
    const fake = fakeIo();
    expect(await run(["ask", "--model", "openrouter:some/model,mock:echo", "hi"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain("attempt 1 openrouter:some/model: auth: ");
    expect(fake.stderr()).toContain("[mock:echo]");
  });

  it("falls back from a provider that cannot be reached, as when the network is off", async () => {
    const server = models((call) => {
      if (call.url === OLLAMA_CHAT) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return stream(["from openrouter"]);
    });
    const fake = fakeIo({ env: { CORE_OPENROUTER_API_KEY: "or-secret-123456" }, fetch: server.fetch });
    expect(await run(["ask", "--model", "ollama:llama3.1,openrouter:some/model", "hi"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("from openrouter\n");
    expect(fake.stderr()).toContain("attempt 1 ollama:llama3.1: unavailable: ");
    expect(fake.stderr()).toContain("[openrouter:some/model]");
  });

  it("returns 1, with an attempt line per step and the final error, when every step fails", async () => {
    const server = models(() => failure(401));
    const fake = fakeIo({
      env: { CORE_OPENROUTER_API_KEY: "or-secret-123456", CORE_OPENAI_API_KEY: "oa-secret-654321" },
      fetch: server.fetch,
    });
    expect(await run(["ask", "--model", "openrouter:a,openai:b", "hi"], fake.io)).toBe(1);
    expect(fake.stdout()).toBe("");
    const lines = fake.stderr().split("\n");
    expect(lines[0]).toMatch(/^attempt 1 openrouter:a: auth: /);
    expect(lines[1]).toMatch(/^attempt 2 openai:b: auth: /);
    expect(lines[2]).toBe("error: auth: all 2 route steps failed");
    expect(fake.stderr()).not.toMatch(/\[\w+:/);
    expect(fake.stderr()).not.toContain("or-secret-123456");
    expect(fake.stderr()).not.toContain("oa-secret-654321");
  });

  it("returns 1 for a single failing step, printing the error", async () => {
    const server = models(() => failure(500));
    const fake = fakeIo({ fetch: server.fetch });
    expect(await run(["ask", "--model", "ollama:llama3.1", "hi"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("attempt 1 ollama:llama3.1: unavailable: ");
    expect(fake.stderr()).toContain("error: unavailable: ");
  });

  it("returns 130 when interrupted mid-turn, without an error line", async () => {
    const calls: string[] = [];
    const stuck = fakeIo({
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        return hang(init);
      }) as typeof fetch,
    });
    const asking = run(["ask", "--model", "ollama:llama3.1", "hi"], stuck.io);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(stuck.interruptHandlers()).toBe(1);
    expect(stuck.interrupt()).toBe(true);
    expect(await asking).toBe(130);
    expect(stuck.stdout()).toBe("");
    expect(stuck.stderr()).toBe("");
    expect(stuck.interruptHandlers()).toBe(0);
  });

  it("leaves no interrupt handler behind after a normal turn", async () => {
    const fake = fakeIo();
    await run(["ask", "--model", "mock:echo", "hi"], fake.io);
    expect(fake.interruptHandlers()).toBe(0);
  });
});

describe("core chat", () => {
  it("keeps the conversation: the second request carries the first exchange; end of input exits 0", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["first", "second"] } });
    expect(await run(["chat"], fake.io)).toBe(0);

    expect(server.calls).toHaveLength(2);
    expect(conversation(server.calls[0])).toEqual(["user: first"]);
    expect(conversation(server.calls[1])).toEqual(["user: first", "assistant: answer 1", "user: second"]);
    expect(fake.stdout()).toBe("answer 1\nanswer 2\n");
    expect(fake.asked).toEqual(["> ", "> ", "> "]);
    expect(fake.stderr()).toContain("Chatting via ollama:llama3.1.");
    expect(fake.stderr()).toContain("[ollama:llama3.1]");
  });

  it("answers from the mock model", async () => {
    const fake = fakeIo({ env: { CORE_ROUTE: "mock:echo" }, answers: { line: ["hi"] } });
    expect(await run(["chat"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("echo: hi\n");
  });

  it("puts the --system message first", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["first", "second"] } });
    expect(await run(["chat", "--system", "be brief"], fake.io)).toBe(0);
    expect(conversation(server.calls[0])).toEqual(["system: be brief", "user: first"]);
    expect(conversation(server.calls[1])).toEqual(["system: be brief", "user: first", "assistant: answer 1", "user: second"]);
  });

  it("takes --model for the first route", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["hi"] } });
    await run(["chat", "--model", "ollama:other"], fake.io);
    expect(server.calls[0]?.body.model).toBe("other");
  });

  it("/model switches the route for the next answers", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["one", "/model ollama:llama3.2, ollama:third", "two"] } });
    expect(await run(["chat"], fake.io)).toBe(0);
    expect(server.calls.map((call) => call.body.model)).toEqual(["llama3.1", "llama3.2"]);
    expect(fake.stderr()).toContain("[now using ollama:llama3.2, ollama:third]");
    // The conversation carries over to the new model.
    expect(conversation(server.calls[1])).toEqual(["user: one", "assistant: answer 1", "user: two"]);
  });

  it("reports a bad /model value and goes on with the old route", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["/model bogus", "/model", "hi"] } });
    expect(await run(["chat"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain('error: invalid model ref "bogus"');
    expect(fake.stderr()).toContain("error: usage: /model <provider:model,...> (now: ollama:llama3.1)");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.body.model).toBe("llama3.1");
  });

  it("/reset forgets the conversation but keeps the --system message", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["one", "/reset", "two"] } });
    expect(await run(["chat", "--system", "be brief"], fake.io)).toBe(0);
    expect(conversation(server.calls[1])).toEqual(["system: be brief", "user: two"]);

    const plain = counting();
    const again = ioWith({ fetch: plain.fetch, answers: { line: ["one", "/reset", "two"] } });
    await run(["chat"], again.io);
    expect(conversation(plain.calls[1])).toEqual(["user: two"]);
  });

  it("/help lists the commands on stdout and the chat goes on", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["/help", "hi"] } });
    expect(await run(["chat"], fake.io)).toBe(0);
    for (const command of ["/model", "/reset", "/help", "/exit"]) expect(fake.stdout()).toContain(command);
    expect(server.calls).toHaveLength(1);
  });

  it("/exit leaves at once with 0, without reading further input", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["/exit", "never asked"] } });
    expect(await run(["chat"], fake.io)).toBe(0);
    expect(server.calls).toHaveLength(0);
    expect(fake.asked).toEqual(["> "]);
  });

  it("reports an unknown /command and ignores blank lines", async () => {
    const server = counting();
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["/frobnicate", "   ", "", "hi"] } });
    expect(await run(["chat"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain("error: unknown command /frobnicate; try /help");
    expect(server.calls).toHaveLength(1);
    expect(conversation(server.calls[0])).toEqual(["user: hi"]);
  });

  it("stops just the current answer on Ctrl+C, drops that message, and carries on", async () => {
    const calls: Call[] = [];
    const fake = ioWith({
      answers: { line: ["slow question", "next question"] },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const call: Call = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) };
        calls.push(call);
        return calls.length === 1 ? hang(init) : stream(["fine"]);
      }) as typeof fetch,
    });
    const chatting = run(["chat"], fake.io);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(fake.interruptHandlers()).toBe(1);
    expect(fake.interrupt()).toBe(true);

    expect(await chatting).toBe(0);
    expect(fake.stderr()).toContain("[stopped]");
    expect(calls).toHaveLength(2);
    expect(conversation(calls[1])).toEqual(["user: next question"]);
    expect(fake.stdout()).toBe("fine\n");
    expect(fake.interruptHandlers()).toBe(0);
  });

  it("keeps going after a failed turn and drops that message", async () => {
    const server = models((_call, index) => (index === 0 ? failure(500) : stream(["recovered"])));
    const fake = ioWith({ fetch: server.fetch, answers: { line: ["broken", "again"] } });
    expect(await run(["chat"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain("error: unavailable: ");
    expect(conversation(server.calls[1])).toEqual(["user: again"]);
    expect(fake.stdout()).toBe("recovered\n");
  });

  it("falls back inside a chat turn and says what failed", async () => {
    const server = models((call) => (call.url === OLLAMA_CHAT ? failure(500) : stream(["from openrouter"])));
    const fake = fakeIo({
      env: { CORE_OPENROUTER_API_KEY: "or-secret-123456" },
      fetch: server.fetch,
      answers: { line: ["hi"] },
    });
    expect(await run(["chat", "--model", "ollama:llama3.1,openrouter:some/model"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe("from openrouter\n");
    expect(fake.stderr()).toContain("attempt 1 ollama:llama3.1: unavailable: ");
    expect(fake.stderr()).toContain("[openrouter:some/model]");
  });

  it("does not repeat an earlier turn's failed attempts on the next turn", async () => {
    const server = models((call, index) => (call.url === OLLAMA_CHAT && index === 0 ? failure(500) : stream(["ok"])));
    const fake = fakeIo({
      env: { CORE_OPENROUTER_API_KEY: "or-secret-123456" },
      fetch: server.fetch,
      answers: { line: ["one", "two"] },
    });
    await run(["chat", "--model", "ollama:llama3.1,openrouter:some/model"], fake.io);
    expect(fake.stderr().match(/attempt 1 ollama:llama3.1/g)).toHaveLength(1);
  });

  it("returns 2 without a route, for a stray argument, and for an unknown flag", async () => {
    expect(await run(["chat"], fakeIo().io)).toBe(2);
    expect(await run(["chat", "extra"], fakeIo({ env: { CORE_ROUTE: "mock:echo" } }).io)).toBe(2);
    expect(await run(["chat", "--frobnicate"], fakeIo({ env: { CORE_ROUTE: "mock:echo" } }).io)).toBe(2);
    const noRoute = fakeIo();
    await run(["chat"], noRoute.io);
    expect(noRoute.stderr()).toContain("no model chosen");
    expect(noRoute.asked).toEqual([]);
  });
});
