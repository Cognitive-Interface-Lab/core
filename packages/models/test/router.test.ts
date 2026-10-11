import { describe, expect, it } from "vitest";
import {
  CoreError,
  type ChatRequest,
  type CoreErrorShape,
  type ModelRef,
  type StreamEvent,
} from "@core/contracts";
import {
  MockProvider,
  ModelRouter,
  ProviderRegistry,
  type MockTurn,
  type ModelProvider,
  type RouteStep,
} from "../src/index.js";

const request: Omit<ChatRequest, "model"> = { messages: [{ role: "user", content: "hi" }] };

const ref = (provider: string, model = "m"): ModelRef => ({ provider, model });
const step = (provider: string, timeoutMs?: number): RouteStep => ({
  model: ref(provider),
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

const failure = (code: CoreErrorShape["code"]): MockTurn => ({
  error: { code, message: `${code} from mock`, retryable: code === "unavailable" },
});

function routerFor(...providers: ModelProvider[]): ModelRouter {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return new ModelRouter(registry);
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

const finalError = (events: StreamEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== "error") throw new Error(`expected a final error event, got ${last?.type}`);
  return last.error;
};

/** A provider that streams some text and then fails, to test the no-fallback-after-content rule. */
function cutOffProvider(id: string, code: CoreErrorShape["code"]): ModelProvider & { streams: number } {
  const provider = {
    id,
    streams: 0,
    capabilities: () => ({ streaming: true, tools: true, vision: false }),
    chat: async () => {
      throw new CoreError(code, `${id} chat failed`);
    },
    stream: async function* (): AsyncGenerator<StreamEvent> {
      provider.streams += 1;
      yield { type: "text-delta", text: "partial " };
      yield { type: "error", error: new CoreError(code, `${id} cut off`).toJSON() };
    },
  };
  return provider;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

const abortedEvent = (): StreamEvent => ({ type: "error", error: new CoreError("aborted", "stopped").toJSON() });

/**
 * A streaming provider with controllable pacing. It waits `firstDelayMs` before its first content
 * event, then sends `count` content events `gapMs` apart, then finishes. It honours the signal
 * and reports a cancellation as an `aborted` error event.
 */
function pacedProvider(
  id: string,
  pacing: { firstDelayMs: number; gapMs: number; count: number; kind?: "text-delta" | "tool-call" },
): ModelProvider {
  return {
    id,
    capabilities: () => ({ streaming: true, tools: true, vision: false }),
    chat: async () => {
      throw new CoreError("unknown", `${id} does not support chat`);
    },
    stream: async function* (_request, opts): AsyncGenerator<StreamEvent> {
      try {
        await sleep(pacing.firstDelayMs, opts?.signal);
        for (let index = 0; index < pacing.count; index++) {
          if (index > 0) await sleep(pacing.gapMs, opts?.signal);
          yield pacing.kind === "tool-call"
            ? { type: "tool-call", toolCall: { id: `call-${index}`, name: "tool", arguments: {} } }
            : { type: "text-delta", text: `chunk-${index} ` };
        }
        yield { type: "finish", finishReason: "stop", usage: {} };
      } catch {
        yield abortedEvent();
      }
    },
  };
}

describe("ModelRouter.chat", () => {
  it("answers from the first step with a single attempt", async () => {
    const first = new MockProvider({ id: "first" });
    const second = new MockProvider({ id: "second" });
    const response = await routerFor(first, second).chat(request, [step("first"), step("second")]);
    expect(response.message.content).toBe("echo: hi");
    expect(response.model).toEqual(ref("first"));
    expect(response.attempts).toHaveLength(1);
    expect(response.attempts[0]).toMatchObject({ model: ref("first"), ok: true });
    expect(response.attempts[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(response.attempts[0]?.error).toBeUndefined();
    expect(second.calls).toHaveLength(0);
  });

  it("sends the step's model with the request", async () => {
    const provider = new MockProvider({ id: "p" });
    await routerFor(provider).chat(request, [{ model: ref("p", "big-one") }]);
    expect(provider.calls[0]?.model).toEqual(ref("p", "big-one"));
    expect(provider.calls[0]?.messages).toEqual(request.messages);
  });

  for (const code of ["unavailable", "auth", "rate_limit", "not_found", "unknown"] as const) {
    it(`falls back to the next step on ${code}`, async () => {
      const broken = new MockProvider({ id: "broken", script: [failure(code)] });
      const healthy = new MockProvider({ id: "healthy" });
      const response = await routerFor(broken, healthy).chat(request, [step("broken"), step("healthy")]);
      expect(response.message.content).toBe("echo: hi");
      expect(response.model).toEqual(ref("healthy"));
      expect(response.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
      expect(response.attempts[0]?.error).toMatchObject({ code });
    });
  }

  it("falls back past an unknown provider id", async () => {
    const healthy = new MockProvider({ id: "healthy" });
    const response = await routerFor(healthy).chat(request, [step("ghost"), step("healthy")]);
    expect(response.attempts).toHaveLength(2);
    expect(response.attempts[0]).toMatchObject({ model: ref("ghost"), ok: false, error: { code: "not_found" } });
    expect(response.attempts[1]).toMatchObject({ model: ref("healthy"), ok: true });
  });

  it("does not fall back on bad_request, and throws that error", async () => {
    const strict = new MockProvider({ id: "strict", script: [failure("bad_request")] });
    const spare = new MockProvider({ id: "spare" });
    const error = await caught(routerFor(strict, spare).chat(request, [step("strict"), step("spare")]));
    expect(error.code).toBe("bad_request");
    expect(spare.calls).toHaveLength(0);
  });

  it("does not fall back on content_filter", async () => {
    const filtered = new MockProvider({ id: "filtered", script: [failure("content_filter")] });
    const spare = new MockProvider({ id: "spare" });
    const error = await caught(routerFor(filtered, spare).chat(request, [step("filtered"), step("spare")]));
    expect(error.code).toBe("content_filter");
    expect(spare.calls).toHaveLength(0);
  });

  it("does not fall back when the caller aborts", async () => {
    const slow = new MockProvider({ id: "slow", script: [{ text: "late", delayMs: 5_000 }] });
    const spare = new MockProvider({ id: "spare" });
    const controller = new AbortController();
    const pending = caught(
      routerFor(slow, spare).chat(request, [step("slow"), step("spare")], { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    const error = await pending;
    expect(error.code).toBe("aborted");
    expect(spare.calls).toHaveLength(0);
  });

  it("does not fall back when a provider itself reports aborted", async () => {
    const stopped = new MockProvider({ id: "stopped", script: [failure("aborted")] });
    const spare = new MockProvider({ id: "spare" });
    const error = await caught(routerFor(stopped, spare).chat(request, [step("stopped"), step("spare")]));
    expect(error.code).toBe("aborted");
    expect(spare.calls).toHaveLength(0);
  });

  it("rejects with aborted, trying nothing, when the signal is already aborted", async () => {
    const provider = new MockProvider({ id: "p" });
    const error = await caught(routerFor(provider).chat(request, [step("p")], { signal: AbortSignal.abort() }));
    expect(error.code).toBe("aborted");
    expect(provider.calls).toHaveLength(0);
  });

  it("reports a per-step timeout as timeout and falls back", async () => {
    const slow = new MockProvider({ id: "slow", script: [{ text: "late", delayMs: 5_000 }] });
    const healthy = new MockProvider({ id: "healthy" });
    const response = await routerFor(slow, healthy).chat(request, [step("slow", 25), step("healthy")]);
    expect(response.model).toEqual(ref("healthy"));
    expect(response.attempts[0]).toMatchObject({ model: ref("slow"), ok: false, error: { code: "timeout" } });
    expect(response.attempts[1]).toMatchObject({ ok: true });
  });

  it("uses defaultTimeoutMs for steps without their own timeout", async () => {
    const slow = new MockProvider({ id: "slow", script: [{ text: "late", delayMs: 5_000 }] });
    const registry = new ProviderRegistry().register(slow);
    const router = new ModelRouter(registry, { defaultTimeoutMs: 25 });
    const error = await caught(router.chat(request, [step("slow")]));
    expect(error.code).toBe("timeout");
  });

  it("throws when every step fails, with the last code and the attempt log", async () => {
    const first = new MockProvider({ id: "first", script: [failure("unavailable")] });
    const second = new MockProvider({ id: "second", script: [failure("rate_limit")] });
    const error = await caught(routerFor(first, second).chat(request, [step("first"), step("second")]));
    expect(error.code).toBe("rate_limit");
    expect(error.message).toBe("all 2 route steps failed");
    const attempts = error.details?.["attempts"] as { model: ModelRef; ok: boolean; ms: number; error?: CoreErrorShape }[];
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.ok)).toEqual([false, false]);
    expect(attempts.map((attempt) => attempt.error?.code)).toEqual(["unavailable", "rate_limit"]);
    expect(attempts.map((attempt) => attempt.model.provider)).toEqual(["first", "second"]);
    expect(attempts.every((attempt) => typeof attempt.ms === "number")).toBe(true);
  });

  it("counts a single failing step too", async () => {
    const only = new MockProvider({ id: "only", script: [failure("auth")] });
    const error = await caught(routerFor(only).chat(request, [step("only")]));
    expect(error.code).toBe("auth");
    expect(error.message).toBe("all 1 route steps failed");
  });

  it("rejects an empty route with bad_request", async () => {
    const error = await caught(routerFor(new MockProvider()).chat(request, []));
    expect(error.code).toBe("bad_request");
  });
});

describe("ModelRouter.stream", () => {
  it("emits a route event with attempt 1 before the first step's events", async () => {
    const events = await collect(routerFor(new MockProvider({ id: "p" })).stream(request, [step("p")]));
    expect(events[0]).toEqual({ type: "route", model: ref("p"), attempt: 1 });
    expect(events.filter((event) => event.type === "route")).toHaveLength(1);
    expect(events.slice(1).map((event) => event.type)).toEqual(["text-delta", "finish"]);
  });

  it("falls back with 1-based route events when an attempt fails before any content", async () => {
    const broken = new MockProvider({ id: "broken", script: [failure("unavailable")] });
    const healthy = new MockProvider({ id: "healthy" });
    const events = await collect(routerFor(broken, healthy).stream(request, [step("broken"), step("healthy")]));
    expect(events.filter((event) => event.type === "route")).toEqual([
      { type: "route", model: ref("broken"), attempt: 1 },
      { type: "route", model: ref("healthy"), attempt: 2 },
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["route", "route", "text-delta", "finish"]);
  });

  it("falls back past an unknown provider id", async () => {
    const events = await collect(routerFor(new MockProvider({ id: "healthy" })).stream(request, [step("ghost"), step("healthy")]));
    expect(events.filter((event) => event.type === "route")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("finish");
  });

  it("does not fall back once a text-delta was emitted, passing the error through last", async () => {
    const flaky = cutOffProvider("flaky", "unavailable");
    const spare = new MockProvider({ id: "spare" });
    const events = await collect(routerFor(flaky, spare).stream(request, [step("flaky"), step("spare")]));
    expect(events.map((event) => event.type)).toEqual(["route", "text-delta", "error"]);
    expect(finalError(events).code).toBe("unavailable");
    expect(spare.calls).toHaveLength(0);
  });

  it("does not fall back once a tool-call was emitted", async () => {
    const toolCall = { id: "c1", name: "t", arguments: {} };
    const calling = new MockProvider({
      id: "calling",
      script: [{ toolCalls: [toolCall] }],
    });
    // Make the first provider fail after its tool call by wrapping it.
    const wrapped: ModelProvider = {
      id: "calling",
      capabilities: () => calling.capabilities(),
      chat: (req, opts) => calling.chat(req, opts),
      stream: async function* (req, opts) {
        for await (const event of calling.stream(req, opts)) {
          if (event.type === "finish") {
            yield { type: "error", error: new CoreError("unavailable", "cut").toJSON() };
            return;
          }
          yield event;
        }
      },
    };
    const spare = new MockProvider({ id: "spare" });
    const events = await collect(routerFor(wrapped, spare).stream(request, [step("calling"), step("spare")]));
    expect(events.map((event) => event.type)).toEqual(["route", "tool-call", "error"]);
    expect(spare.calls).toHaveLength(0);
  });

  it("does not fall back on bad_request", async () => {
    const strict = new MockProvider({ id: "strict", script: [failure("bad_request")] });
    const spare = new MockProvider({ id: "spare" });
    const events = await collect(routerFor(strict, spare).stream(request, [step("strict"), step("spare")]));
    expect(events.map((event) => event.type)).toEqual(["route", "error"]);
    expect(finalError(events).code).toBe("bad_request");
    expect(spare.calls).toHaveLength(0);
  });

  it("does not fall back when the caller aborts", async () => {
    const slow = new MockProvider({ id: "slow", script: [{ text: "late", delayMs: 5_000 }] });
    const spare = new MockProvider({ id: "spare" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const events = await collect(
      routerFor(slow, spare).stream(request, [step("slow"), step("spare")], { signal: controller.signal }),
    );
    expect(finalError(events).code).toBe("aborted");
    expect(spare.calls).toHaveLength(0);
  });

  it("does not fall back when a provider itself reports aborted", async () => {
    const stopped = new MockProvider({ id: "stopped", script: [failure("aborted")] });
    const spare = new MockProvider({ id: "spare" });
    const events = await collect(routerFor(stopped, spare).stream(request, [step("stopped"), step("spare")]));
    expect(events.map((event) => event.type)).toEqual(["route", "error"]);
    expect(finalError(events).code).toBe("aborted");
    expect(spare.calls).toHaveLength(0);
  });

  it("reports a per-step timeout as timeout and falls back", async () => {
    const slow = new MockProvider({ id: "slow", script: [{ text: "late", delayMs: 5_000 }] });
    const healthy = new MockProvider({ id: "healthy" });
    const events = await collect(routerFor(slow, healthy).stream(request, [step("slow", 25), step("healthy")]));
    expect(events.filter((event) => event.type === "route")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("finish");
  });

  for (const kind of ["text-delta", "tool-call"] as const) {
    it(`lets a stream that keeps sending ${kind} events run longer than timeoutMs`, async () => {
      // The first event is immediate; the rest take about 140 ms in total, far past the 50 ms timeout.
      const steady = pacedProvider("steady", { firstDelayMs: 0, gapMs: 20, count: 8, kind });
      const spare = new MockProvider({ id: "spare" });
      const started = Date.now();
      const events = await collect(routerFor(steady, spare).stream(request, [step("steady", 50), step("spare")]));
      expect(Date.now() - started).toBeGreaterThan(50);
      expect(events.filter((event) => event.type === kind)).toHaveLength(8);
      expect(events.filter((event) => event.type === "route")).toHaveLength(1);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)?.type).toBe("finish");
      expect(spare.calls).toHaveLength(0);
    });
  }

  it("times out a stream that stalls before its first content, and falls back", async () => {
    const stalled = pacedProvider("stalled", { firstDelayMs: 5_000, gapMs: 0, count: 1 });
    const healthy = new MockProvider({ id: "healthy" });
    const events = await collect(routerFor(stalled, healthy).stream(request, [step("stalled", 30), step("healthy")]));
    expect(events.map((event) => event.type)).toEqual(["route", "route", "text-delta", "finish"]);
    expect(events.filter((event) => event.type === "route").map((event) => (event as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(healthy.calls).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("reports timeout when the only step stalls before its first content", async () => {
    const stalled = pacedProvider("stalled", { firstDelayMs: 5_000, gapMs: 0, count: 1 });
    const events = await collect(routerFor(stalled).stream(request, [step("stalled", 30)]));
    expect(events.map((event) => event.type)).toEqual(["route", "error"]);
    expect(finalError(events)).toMatchObject({ code: "timeout", message: "all 1 route steps failed" });
  });

  it("still ends a stream with aborted when the caller aborts after content has started", async () => {
    const steady = pacedProvider("steady", { firstDelayMs: 0, gapMs: 30, count: 50 });
    const spare = new MockProvider({ id: "spare" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const events = await collect(
      routerFor(steady, spare).stream(request, [step("steady", 50), step("spare")], { signal: controller.signal }),
    );
    expect(events.some((event) => event.type === "text-delta")).toBe(true);
    expect(finalError(events).code).toBe("aborted");
    expect(spare.calls).toHaveLength(0);
  });

  it("ends with a timeout error event when the only step times out", async () => {
    const slow = new MockProvider({ id: "slow", script: [{ text: "late", delayMs: 5_000 }] });
    const events = await collect(routerFor(slow).stream(request, [step("slow", 25)]));
    expect(finalError(events).code).toBe("timeout");
  });

  it("ends with an error event carrying details.attempts when every step fails", async () => {
    const first = new MockProvider({ id: "first", script: [failure("unavailable")] });
    const second = new MockProvider({ id: "second", script: [failure("auth")] });
    const events = await collect(routerFor(first, second).stream(request, [step("first"), step("second")]));
    expect(events.map((event) => event.type)).toEqual(["route", "route", "error"]);
    const error = finalError(events);
    expect(error.code).toBe("auth");
    expect(error.message).toBe("all 2 route steps failed");
    const attempts = error.details?.["attempts"] as { ok: boolean; error?: CoreErrorShape }[];
    expect(attempts.map((attempt) => attempt.error?.code)).toEqual(["unavailable", "auth"]);
  });

  it("emits a bad_request error event for an empty route instead of throwing", async () => {
    const events = await collect(routerFor(new MockProvider()).stream(request, []));
    expect(events).toHaveLength(1);
    expect(finalError(events).code).toBe("bad_request");
  });

  it("never emits an event after the final error", async () => {
    const broken = new MockProvider({ id: "broken", script: [failure("unavailable")] });
    const events = await collect(routerFor(broken).stream(request, [step("broken")]));
    const errorIndex = events.findIndex((event) => event.type === "error");
    expect(errorIndex).toBe(events.length - 1);
  });
});
