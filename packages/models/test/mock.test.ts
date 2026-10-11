import { describe, expect, it } from "vitest";
import { CoreError, type ChatRequest, type StreamEvent } from "@core/contracts";
import { MockProvider, type MockTurn } from "../src/index.js";

const model = { provider: "mock", model: "echo" };

function request(...contents: string[]): ChatRequest {
  return { model, messages: contents.map((content) => ({ role: "user" as const, content })) };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const all: StreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
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

const deltas = (events: StreamEvent[]) =>
  events.flatMap((event) => (event.type === "text-delta" ? [event.text] : []));

describe("MockProvider basics", () => {
  it("has id mock by default and honours a custom id", () => {
    expect(new MockProvider().id).toBe("mock");
    expect(new MockProvider({ id: "fake" }).id).toBe("fake");
  });

  it("reports streaming and tools but not vision", () => {
    expect(new MockProvider().capabilities()).toEqual({ streaming: true, tools: true, vision: false });
  });
});

describe("MockProvider echo", () => {
  it("echoes the content of the last user message", async () => {
    const provider = new MockProvider();
    const response = await provider.chat({
      model,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ignored" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "also ignored" },
      ],
    });
    expect(response.message).toEqual({ role: "assistant", content: "echo: hi" });
    expect(response.model).toEqual(model);
    expect(response.finishReason).toBe("stop");
  });

  it("reports usage as total input characters and output characters", async () => {
    const response = await new MockProvider().chat(request("abc", "de"));
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: "echo: de".length });
  });

  it("keeps echoing on every call when there is no script", async () => {
    const provider = new MockProvider();
    expect((await provider.chat(request("one"))).message.content).toBe("echo: one");
    expect((await provider.chat(request("two"))).message.content).toBe("echo: two");
  });

  it("echoes in stream too and ends with finish", async () => {
    const events = await collect(new MockProvider().stream(request("hi")));
    expect(deltas(events).join("")).toBe("echo: hi");
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });
});

describe("MockProvider script", () => {
  const script: MockTurn[] = [{ text: "first" }, { text: "second" }];

  it("replies with the turns in order", async () => {
    const provider = new MockProvider({ script });
    expect((await provider.chat(request("x"))).message.content).toBe("first");
    expect((await provider.chat(request("x"))).message.content).toBe("second");
  });

  it("shares one turn counter between chat and stream", async () => {
    const provider = new MockProvider({ script });
    expect((await provider.chat(request("x"))).message.content).toBe("first");
    expect(deltas(await collect(provider.stream(request("x")))).join("")).toBe("second");
  });

  it("fails with unavailable once the script is exhausted and echo is off", async () => {
    const provider = new MockProvider({ script: [{ text: "only" }], echo: false });
    await provider.chat(request("x"));
    const error = await caught(provider.chat(request("x")));
    expect(error.code).toBe("unavailable");
    expect(error.message).toBe("mock script exhausted");
  });

  it("does not echo by default when a script is given", async () => {
    const provider = new MockProvider({ script: [{ text: "only" }] });
    await provider.chat(request("x"));
    expect((await caught(provider.chat(request("x")))).code).toBe("unavailable");
  });

  it("falls back to echo after the script when echo is true", async () => {
    const provider = new MockProvider({ script: [{ text: "scripted" }], echo: true });
    expect((await provider.chat(request("a"))).message.content).toBe("scripted");
    expect((await provider.chat(request("b"))).message.content).toBe("echo: b");
  });

  it("emits a final error event, and does not throw, when exhausted in stream", async () => {
    const provider = new MockProvider({ script: [], echo: false });
    const events = await collect(provider.stream(request("x")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "unavailable", message: "mock script exhausted" } });
  });

  it("uses an explicit finishReason over the default", async () => {
    const provider = new MockProvider({ script: [{ text: "cut", finishReason: "length" }] });
    expect((await provider.chat(request("x"))).finishReason).toBe("length");
  });
});

describe("MockProvider streaming", () => {
  it("chunks text into 8-character deltas by default", async () => {
    const text = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    const events = await collect(new MockProvider({ script: [{ text }] }).stream(request("x")));
    expect(deltas(events)).toEqual(["abcdefgh", "ijklmnop", "qrstuvwx", "yz"]);
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("honours chunkSize", async () => {
    const events = await collect(new MockProvider({ script: [{ text: "abcdefg", chunkSize: 3 }] }).stream(request("x")));
    expect(deltas(events)).toEqual(["abc", "def", "g"]);
  });

  it("yields no deltas for empty text and still finishes", async () => {
    const events = await collect(new MockProvider({ script: [{ text: "" }] }).stream(request("x")));
    expect(events.map((event) => event.type)).toEqual(["finish"]);
  });

  it("reports usage on the finish event", async () => {
    const events = await collect(new MockProvider({ script: [{ text: "four" }] }).stream(request("abc")));
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });

  it("never emits route events", async () => {
    const events = await collect(new MockProvider().stream(request("hi")));
    expect(events.some((event) => event.type === "route")).toBe(false);
  });
});

describe("MockProvider tool calls", () => {
  const toolCalls = [
    { id: "c1", name: "search", arguments: { q: "x" } },
    { id: "c2", name: "open", arguments: {} },
  ];

  it("streams text, then one tool-call event per call, then finish with tool-calls", async () => {
    const events = await collect(new MockProvider({ script: [{ text: "ok", toolCalls }] }).stream(request("x")));
    expect(events.map((event) => event.type)).toEqual(["text-delta", "tool-call", "tool-call", "finish"]);
    expect(events[1]).toEqual({ type: "tool-call", toolCall: toolCalls[0] });
    expect(events[2]).toEqual({ type: "tool-call", toolCall: toolCalls[1] });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  it("returns tool calls from chat with finishReason tool-calls", async () => {
    const response = await new MockProvider({ script: [{ toolCalls }] }).chat(request("x"));
    expect(response.message).toEqual({ role: "assistant", content: "", toolCalls });
    expect(response.finishReason).toBe("tool-calls");
  });
});

describe("MockProvider error turns", () => {
  const shape = { code: "rate_limit", message: "slow down", provider: "mock", retryable: true } as const;

  it("throws the error from chat", async () => {
    const error = await caught(new MockProvider({ script: [{ error: shape }] }).chat(request("x")));
    expect(error.toJSON()).toEqual(shape);
  });

  it("yields only an error event from stream", async () => {
    const events = await collect(new MockProvider({ script: [{ text: "ignored", error: shape }] }).stream(request("x")));
    expect(events).toEqual([{ type: "error", error: shape }]);
  });

  it("recovers on the next turn after an error turn", async () => {
    const provider = new MockProvider({ script: [{ error: shape }, { text: "fine" }] });
    await caught(provider.chat(request("x")));
    expect((await provider.chat(request("x"))).message.content).toBe("fine");
  });
});

describe("MockProvider abort", () => {
  it("aborts chat during delayMs with code aborted", async () => {
    const provider = new MockProvider({ script: [{ text: "late", delayMs: 5_000 }] });
    const controller = new AbortController();
    const pending = caught(provider.chat(request("x"), { signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    expect((await pending).code).toBe("aborted");
  });

  it("emits an aborted error event, and does not throw, during delayMs in stream", async () => {
    const provider = new MockProvider({ script: [{ text: "late", delayMs: 5_000 }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const events = await collect(provider.stream(request("x"), { signal: controller.signal }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "aborted" } });
  });

  it("is aborted at once when the signal is already aborted", async () => {
    const provider = new MockProvider({ script: [{ text: "late", delayMs: 5_000 }] });
    const started = Date.now();
    const error = await caught(provider.chat(request("x"), { signal: AbortSignal.abort() }));
    expect(error.code).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("answers normally after waiting when not aborted", async () => {
    const provider = new MockProvider({ script: [{ text: "slow", delayMs: 20 }] });
    expect((await provider.chat(request("x"))).message.content).toBe("slow");
  });
});

describe("MockProvider calls", () => {
  it("records every request in order, for chat and stream alike", async () => {
    const provider = new MockProvider();
    const first = request("one");
    const second = request("two");
    const third = request("three");
    await provider.chat(first);
    await collect(provider.stream(second));
    await provider.chat(third);
    expect(provider.calls).toEqual([first, second, third]);
  });

  it("records a request even when its turn fails", async () => {
    const provider = new MockProvider({ script: [{ error: { code: "auth", message: "no", retryable: false } }] });
    const req = request("x");
    await caught(provider.chat(req));
    expect(provider.calls).toEqual([req]);
  });
});
