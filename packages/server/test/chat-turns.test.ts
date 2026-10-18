import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TurnEventSchema,
  type ApiErrorBody,
  type AskResult,
  type ChatCall,
  type ChatRequest,
  type ModelRef,
  type Principal,
  type StreamEvent,
  type ToolDefinition,
  type TurnCall,
  type TurnEvent,
} from "@core/contracts";
import {
  MockProvider,
  askResultFrom,
  type ChatOptions,
  type MockTurn,
} from "@core/models";
import { PRINCIPAL, createTestHandlerWith, post, readJson } from "./helpers.js";

const MODEL: ModelRef = { provider: "mock", model: "scripted" };
const USER = { role: "user", content: "hello" } as const;

/** A mock that records the signal of each model call and can hold a call until `gate` resolves. */
class SpyProvider extends MockProvider {
  readonly signals: (AbortSignal | undefined)[] = [];
  gate: Promise<void> | undefined;

  constructor(script: MockTurn[]) {
    super({ id: "mock", script, echo: false });
  }

  override stream(req: ChatRequest, opts?: ChatOptions): AsyncIterable<StreamEvent> {
    this.signals.push(opts?.signal);
    const inner = super.stream(req, opts);
    const gate = this.gate;
    if (gate === undefined) return inner;
    return (async function* () {
      await gate;
      yield* inner;
    })();
  }

  override chat(req: ChatRequest, opts?: ChatOptions) {
    this.signals.push(opts?.signal);
    return super.chat(req, opts);
  }
}

type Frame = { event?: string; data?: string; comment?: string };

/** Parses one SSE frame (lines up to a blank line). */
function parseFrame(raw: string): Frame {
  const frame: Frame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1).trim();
    else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("data:")) frame.data = (frame.data === undefined ? "" : frame.data + "\n") + line.slice(5).trim();
  }
  return frame;
}

/** Reads a stream frame by frame; `next()` resolves null at the end of the stream. */
function frameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<Frame | null> => {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (raw.trim() !== "") return parseFrame(raw);
        continue;
      }
      const { done, value } = await reader.read();
      if (done) {
        const rest = buffer;
        buffer = "";
        return rest.trim() === "" ? null : parseFrame(rest);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const all = async (): Promise<Frame[]> => {
    const frames: Frame[] = [];
    for (let frame = await next(); frame !== null; frame = await next()) frames.push(frame);
    return frames;
  };
  return { next, all };
}

const turnEvents = (frames: Frame[]): TurnEvent[] =>
  frames.filter((frame) => frame.comment === undefined).map((frame) => TurnEventSchema.parse(JSON.parse(frame.data ?? "null")));

const finishOf = (events: TurnEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== "turn-finish") throw new Error("the last event is not turn-finish");
  return last;
};

const chatCall = (extra: Partial<ChatCall> = {}): ChatCall => ({ route: [MODEL], messages: [USER], ...extra });
const turnCall = (extra: Partial<TurnCall> = {}): TurnCall => ({ route: [MODEL], messages: [USER], ...extra });

describe("POST /v1/chat", () => {
  it("answers 200 with the AskResult that askResultFrom gives", async () => {
    const provider = new SpyProvider([{ text: "hi there" }]);
    const response = await createTestHandlerWith([provider]).fetch(post("/v1/chat", chatCall()));
    expect(response.status).toBe(200);
    const body = await readJson<AskResult>(response);
    expect(body).toMatchObject({ ok: true, text: "hi there", model: MODEL });
    expect(body).not.toHaveProperty("output");
    if (!body.ok) throw new Error("expected ok");
    expect(body.attempts.length).toBeGreaterThan(0);
    expect(body.usage.outputTokens).toBe("hi there".length);
    expect(body).toEqual(
      askResultFrom(
        { response: { model: MODEL, message: { role: "assistant", content: "hi there" }, finishReason: "stop", usage: body.usage, attempts: body.attempts } },
        { withOutput: false },
      ),
    );
  });

  it("includes output when an outputSchema is given", async () => {
    const provider = new SpyProvider([{ text: '{"answer":42}' }]);
    const outputSchema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
    const response = await createTestHandlerWith([provider]).fetch(post("/v1/chat", chatCall({ outputSchema })));
    expect(response.status).toBe(200);
    const body = await readJson<AskResult>(response);
    expect(body).toMatchObject({ ok: true, output: { answer: 42 } });
    expect(provider.calls[0]?.outputSchema).toEqual(outputSchema);
  });

  it("answers 400 bad_request when there is neither a route nor a defaultRoute", async () => {
    const response = await createTestHandlerWith([new SpyProvider([])]).fetch(post("/v1/chat", { messages: [USER] }));
    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
  });

  it("calls a defaultRoute function with the principal and uses its route", async () => {
    const provider = new SpyProvider([{ text: "via default" }]);
    const defaultRoute = vi.fn((principal: Principal): ModelRef[] => (principal.id === PRINCIPAL.id ? [MODEL] : []));
    const handler = createTestHandlerWith([provider], { defaultRoute });
    const response = await handler.fetch(post("/v1/chat", { messages: [USER] }));
    expect(response.status).toBe(200);
    expect(await readJson<AskResult>(response)).toMatchObject({ ok: true, text: "via default" });
    expect(defaultRoute).toHaveBeenCalledWith(PRINCIPAL);
    expect(provider.calls).toHaveLength(1);
  });

  it("answers the status of the error code with an AskResult listing the attempts when the route fails", async () => {
    const provider = new SpyProvider([{ error: { code: "rate_limit", message: "slow down", retryable: false } }]);
    const response = await createTestHandlerWith([provider]).fetch(post("/v1/chat", chatCall()));
    expect(response.status).toBe(429);
    const body = await readJson<AskResult>(response);
    expect(body.ok).toBe(false);
    if (body.ok) throw new Error("expected a failure");
    expect(body.error.code).toBe("rate_limit");
    expect(body.attempts.length).toBeGreaterThan(0);
  });

  it("passes timeoutMs to the route step: a slower provider fails with timeout", async () => {
    const provider = new SpyProvider([{ text: "too late", delayMs: 5000 }]);
    const response = await createTestHandlerWith([provider]).fetch(post("/v1/chat", chatCall({ timeoutMs: 30 })));
    expect(response.status).toBe(504);
    const body = await readJson<AskResult>(response);
    expect(body).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});

describe("POST /v1/turns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams every TurnEvent as an event: turn frame and ends with turn-finish", async () => {
    const provider = new SpyProvider([{ text: "streamed answer", chunkSize: 4 }]);
    const response = await createTestHandlerWith([provider]).fetch(post("/v1/turns", turnCall()));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = await frameReader(response).all();
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.event === "turn")).toBe(true);
    const events = turnEvents(frames);
    expect(finishOf(events)).toMatchObject({ reason: "stop" });
    expect(events.filter((event) => event.type === "turn-finish")).toHaveLength(1);
  });

  it("answers failures before the stream starts as JSON errors, not SSE", async () => {
    const handler = createTestHandlerWith([new SpyProvider([])]);
    const noRoute = await handler.fetch(post("/v1/turns", { messages: [USER] }));
    expect(noRoute.status).toBe(400);
    expect(noRoute.headers.get("content-type")).toContain("application/json");
    expect((await readJson<ApiErrorBody>(noRoute)).error.code).toBe("bad_request");

    const noAuth = await handler.fetch(post("/v1/turns", turnCall(), { auth: false }));
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("content-type")).toContain("application/json");
  });

  it("offers clientTools to the model and ends the stream with client-tools when one is called", async () => {
    const clientTool: ToolDefinition = {
      name: "get_location",
      description: "where the user is",
      inputSchema: { type: "object" },
    };
    const call = { id: "c1", name: "get_location", arguments: {} };
    const provider = new SpyProvider([{ text: "", toolCalls: [call], finishReason: "tool-calls" }]);
    const response = await createTestHandlerWith([provider]).fetch(post("/v1/turns", turnCall({ clientTools: [clientTool] })));
    const events = turnEvents(await frameReader(response).all());
    expect(provider.calls[0]?.tools?.map((tool) => tool.name)).toEqual(["get_location"]);
    expect(finishOf(events).reason).toBe("client-tools");
    expect(events.some((event) => event.type === "tool-call")).toBe(true);
  });

  it("aborts the turn when the client's request signal aborts", async () => {
    const provider = new SpyProvider([{ text: "never delivered", delayMs: 10_000 }]);
    const controller = new AbortController();
    const response = await createTestHandlerWith([provider]).fetch(
      post("/v1/turns", turnCall(), { signal: controller.signal }),
    );
    const reader = frameReader(response);
    const first = await reader.next();
    expect(first?.event).toBe("turn");
    controller.abort();
    const rest = await reader.all();
    const events = turnEvents([first!, ...rest]);
    expect(finishOf(events).reason).toBe("aborted");
    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it("writes a : keep-alive comment after 15 s of waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let release!: () => void;
    const provider = new SpyProvider([{ text: "finally" }]);
    provider.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = await createTestHandlerWith([provider]).fetch(post("/v1/turns", turnCall()));
    const reader = frameReader(response);
    // Frames sent before the model answers (e.g. the round start) come first; the comment follows the wait.
    const pending = (async () => {
      for (let frame = await reader.next(); frame !== null; frame = await reader.next()) {
        if (frame.comment === "keep-alive") return frame;
      }
      return null;
    })();
    await vi.advanceTimersByTimeAsync(15_000);
    const frame = await pending;
    expect(frame).toEqual({ comment: "keep-alive" });

    release();
    const rest = await reader.all();
    const events = turnEvents(rest);
    expect(finishOf(events).reason).toBe("stop");
  });
});
