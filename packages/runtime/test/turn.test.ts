import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreError,
  type Message,
  type ModelRef,
  type StreamEvent,
  type ToolCall,
  type ToolPolicy,
  type TurnEvent,
} from "@core/contracts";
import {
  MockProvider,
  ModelRouter,
  ProviderRegistry,
  type MockTurn,
  type ModelProvider,
} from "@core/models";
import { ToolRegistry, calculateTool, type RegisteredTool, type ToolContext, type ToolHandler } from "@core/tools";
import { runTurn, type RunTurnOptions } from "../src/index.js";

const MODEL: ModelRef = { provider: "mock", model: "scripted" };
const USER: Message = { role: "user", content: "what is 23 times 17?" };
const THINKING = "let me compute that for you"; // 27 characters, so 27 output tokens from the mock

afterEach(() => {
  vi.useRealTimers();
});

/** A tool made from plain objects; the runtime only needs the registry contract. */
function plainTool(
  name: string,
  handler: ToolHandler = async () => "ok",
  policy: ToolPolicy = { sideEffects: false },
): RegisteredTool {
  return {
    definition: { name, description: `the ${name} tool`, inputSchema: { type: "object" } },
    policy,
    handler,
    source: "local",
  };
}

function registryOf(...tools: RegisteredTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

const callOf = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, arguments: args });
const calculate = (id: string, expression: string): ToolCall => callOf(id, "calculate", { expression });

/** One scripted round that asks for tool calls. */
const toolRound = (calls: ToolCall[], text = ""): MockTurn => ({ text, toolCalls: calls, finishReason: "tool-calls" });

type Setup = { mock: MockProvider; options: RunTurnOptions };

function setup(script: MockTurn[], overrides: Partial<RunTurnOptions> = {}, mockOptions: { echo?: boolean } = {}): Setup {
  const mock = new MockProvider({ script, echo: mockOptions.echo ?? false });
  const router = new ModelRouter(new ProviderRegistry().register(mock));
  return {
    mock,
    options: { router, route: [{ model: MODEL }], tools: new ToolRegistry(), channel: "local", messages: [USER], ...overrides },
  };
}

/** Drains a turn, checking in every case that `turn-finish` is emitted once and is the last event. */
async function drain(
  events: AsyncIterable<TurnEvent>,
  onEvent?: (event: TurnEvent) => void,
): Promise<TurnEvent[]> {
  const all: TurnEvent[] = [];
  for await (const event of events) {
    all.push(event);
    onEvent?.(event);
  }
  expect(all.filter((event) => event.type === "turn-finish")).toHaveLength(1);
  expect(all.at(-1)?.type).toBe("turn-finish");
  return all;
}

async function run(script: MockTurn[], overrides: Partial<RunTurnOptions> = {}) {
  const { mock, options } = setup(script, overrides);
  const events = await drain(runTurn(options));
  return { mock, events, finish: finishOf(events) };
}

function finishOf(events: TurnEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "turn-finish") throw new Error("the last event is not turn-finish");
  return last;
}

const typesOf = (events: TurnEvent[]) => events.map((event) => event.type);
const roles = (messages: Message[]) => messages.map((message) => message.role);

/** The mock streams text in chunks; collapse repeated `text-delta` so orders read simply. */
function shape(events: TurnEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    const name = event.type === "turn-finish" ? `turn-finish:${event.reason}` : event.type;
    if (name === "text-delta" && out.at(-1) === "text-delta") continue;
    out.push(name);
  }
  return out;
}

describe("runTurn: a turn without tool calls", () => {
  it("runs one round and stops with one assistant message", async () => {
    const { mock, events, finish } = await run([{ text: "Hello there, friend." }]);
    expect(shape(events)).toEqual(["round", "route", "text-delta", "finish", "turn-finish:stop"]);
    expect(events[0]).toEqual({ type: "round", round: 1 });
    expect(events[1]).toEqual({ type: "route", model: MODEL, attempt: 1 });
    const text = events
      .filter((event): event is Extract<TurnEvent, { type: "text-delta" }> => event.type === "text-delta")
      .map((event) => event.text)
      .join("");
    expect(text).toBe("Hello there, friend.");
    expect(finish.rounds).toBe(1);
    expect(finish.messages).toEqual([{ role: "assistant", content: "Hello there, friend." }]);
    expect(mock.calls).toHaveLength(1);
  });

  it("sends the input messages and the route's model to the provider", async () => {
    const { mock } = await run([{ text: "ok" }]);
    expect(mock.calls[0]?.messages).toEqual([USER]);
    expect(mock.calls[0]?.model).toEqual(MODEL);
  });

  it("forwards the finish event of the model", async () => {
    const { events } = await run([{ text: "ok" }]);
    const finishEvent = events.find((event) => event.type === "finish");
    expect(finishEvent).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("does not change the caller's message list", async () => {
    const messages: Message[] = [USER];
    await run([{ text: "ok" }], { messages });
    expect(messages).toEqual([USER]);
  });

  it("passes the temperature on, and leaves it out when none is given", async () => {
    const warm = await run([{ text: "ok" }], { temperature: 0.2 });
    expect(warm.mock.calls[0]?.temperature).toBe(0.2);
    const plain = await run([{ text: "ok" }]);
    expect(plain.mock.calls[0]).not.toHaveProperty("temperature");
  });
});

describe("runTurn: tool rounds", () => {
  it("runs a tool, then answers with the result in the second request", async () => {
    const { mock, events, finish } = await run(
      [toolRound([calculate("call_1", "23*17")], THINKING), { text: "It is 391." }],
      { tools: registryOf(calculateTool) },
    );
    expect(shape(events)).toEqual([
      "round",
      "route",
      "text-delta",
      "tool-call",
      "finish",
      "tool-result",
      "round",
      "route",
      "text-delta",
      "finish",
      "turn-finish:stop",
    ]);
    const result = events.find((event) => event.type === "tool-result");
    expect(result).toEqual({
      type: "tool-result",
      result: { toolCallId: "call_1", toolName: "calculate", content: '{"expression":"23*17","result":391}', isError: false },
    });
    expect(events.filter((event) => event.type === "round")).toEqual([
      { type: "round", round: 1 },
      { type: "round", round: 2 },
    ]);

    const toolMessage: Message = {
      role: "tool",
      toolCallId: "call_1",
      toolName: "calculate",
      content: '{"expression":"23*17","result":391}',
      isError: false,
    };
    const assistantWithCall: Message = { role: "assistant", content: THINKING, toolCalls: [calculate("call_1", "23*17")] };
    expect(finish.rounds).toBe(2);
    expect(finish.messages).toEqual([assistantWithCall, toolMessage, { role: "assistant", content: "It is 391." }]);

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.messages).toEqual([USER]);
    expect(mock.calls[1]?.messages).toEqual([USER, assistantWithCall, toolMessage]);
  });

  it("offers the tools the channel may call in every request", async () => {
    const { mock } = await run([toolRound([calculate("c1", "1+1")]), { text: "2" }], { tools: registryOf(calculateTool) });
    for (const request of mock.calls) {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["calculate"]);
    }
  });

  it("leaves tools out of the request when the channel has none", async () => {
    const onlyVoice = registryOf(plainTool("speak", async () => "spoken", { channels: ["voice"], sideEffects: false }));
    const forbidden = await run([{ text: "ok" }], { tools: onlyVoice, channel: "local" });
    expect(forbidden.mock.calls[0]).not.toHaveProperty("tools");
    const empty = await run([{ text: "ok" }], { tools: new ToolRegistry() });
    expect(empty.mock.calls[0]).not.toHaveProperty("tools");
    const allowed = await run([{ text: "ok" }], { tools: onlyVoice, channel: "voice" });
    expect(allowed.mock.calls[0]?.tools?.map((tool) => tool.name)).toEqual(["speak"]);
  });

  it("runs several tool calls one at a time, in the model's order", async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number): RegisteredTool =>
      plainTool(name, async () => {
        log.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`end ${name}`);
        return name;
      });
    const { events, finish } = await run(
      [toolRound([callOf("a", "first"), callOf("b", "second"), callOf("c", "third")]), { text: "done" }],
      { tools: registryOf(slow("first", 30), slow("second", 5), slow("third", 1)) },
    );
    expect(log).toEqual(["start first", "end first", "start second", "end second", "start third", "end third"]);
    expect(events.filter((event) => event.type === "tool-result").map((event) => (event as { result: { toolCallId: string } }).result.toolCallId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(roles(finish.messages)).toEqual(["assistant", "tool", "tool", "tool", "assistant"]);
  });

  it("gives tools the channel, a signal and the confirm function", async () => {
    let seen: ToolContext | undefined;
    const confirm = async () => true;
    const tools = registryOf(
      plainTool("probe", async (_args, ctx) => {
        seen = ctx;
        return "ok";
      }),
    );
    await run([toolRound([callOf("p", "probe", { x: 1 })]), { text: "done" }], { tools, channel: "voice", confirm });
    expect(seen?.channel).toBe("voice");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal?.aborted).toBe(false);
    expect(seen?.confirm).toBe(confirm);
  });

  it("runs a side-effect tool only when confirm accepts", async () => {
    const wrote: string[] = [];
    const save = plainTool(
      "save",
      async (args) => {
        wrote.push(String(args["text"]));
        return "saved";
      },
      { sideEffects: true },
    );
    const script = () => [toolRound([callOf("s", "save", { text: "milk" })]), { text: "done" }];

    const refused = await run(script(), { tools: registryOf(save) });
    const refusedResult = refused.events.find((event) => event.type === "tool-result");
    expect(refusedResult).toMatchObject({ result: { isError: true, content: 'tool "save" needs confirmation' } });

    const declined = await run(script(), { tools: registryOf(save), confirm: async () => false });
    expect(declined.events.find((event) => event.type === "tool-result")).toMatchObject({
      result: { isError: true, content: 'tool "save" was declined' },
    });
    expect(wrote).toEqual([]);

    const accepted = await run(script(), { tools: registryOf(save), confirm: async () => true });
    expect(accepted.events.find((event) => event.type === "tool-result")).toMatchObject({
      result: { isError: false, content: "saved" },
    });
    expect(wrote).toEqual(["milk"]);
  });
});

describe("runTurn: tool errors are passed to the model", () => {
  it("an unknown tool becomes an error result and the turn goes on", async () => {
    const { mock, events, finish } = await run([toolRound([callOf("x", "nope")]), { text: "Sorry, I could not do that." }], {
      tools: registryOf(calculateTool),
    });
    expect(finish.reason).toBe("stop");
    expect(finish.rounds).toBe(2);
    expect(events.find((event) => event.type === "tool-result")).toEqual({
      type: "tool-result",
      result: { toolCallId: "x", toolName: "nope", content: 'unknown tool "nope"', isError: true },
    });
    const toolMessage = mock.calls[1]?.messages.at(-1);
    expect(toolMessage).toEqual({
      role: "tool",
      toolCallId: "x",
      toolName: "nope",
      content: 'unknown tool "nope"',
      isError: true,
    });
  });

  it("a throwing handler becomes an error result and the turn goes on", async () => {
    const tools = registryOf(
      plainTool("explode", async () => {
        throw new Error("disk is full");
      }),
    );
    const { mock, finish } = await run([toolRound([callOf("e", "explode")]), { text: "That failed." }], { tools });
    expect(finish.reason).toBe("stop");
    expect(mock.calls[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "disk is full", isError: true });
  });

  it("a bad calculation is an error result the model can read", async () => {
    const { mock, finish } = await run([toolRound([calculate("c", "1/0")]), { text: "Cannot divide by zero." }], {
      tools: registryOf(calculateTool),
    });
    expect(finish.reason).toBe("stop");
    expect(mock.calls[1]?.messages.at(-1)).toMatchObject({ content: "result is not a finite number", isError: true });
  });

  it("a tool refused on this channel is an error result", async () => {
    const tools = registryOf(plainTool("speak", async () => "spoken", { channels: ["voice"], sideEffects: false }));
    const { events } = await run([toolRound([callOf("v", "speak")]), { text: "ok" }], { tools, channel: "local" });
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      result: { isError: true, content: 'tool "speak" is not allowed on channel "local"' },
    });
  });
});

describe("runTurn: rounds", () => {
  it("stops with max-rounds after the last round's tool results", async () => {
    const script = [1, 2, 3].map((n) => toolRound([calculate(`c${n}`, "1+1")]));
    const { mock, events, finish } = await run(script, { tools: registryOf(calculateTool), budget: { maxRounds: 2 } });
    expect(finish.reason).toBe("max-rounds");
    expect(finish.rounds).toBe(2);
    expect(mock.calls).toHaveLength(2);
    expect(shape(events).slice(-3)).toEqual(["finish", "tool-result", "turn-finish:max-rounds"]);
    expect(roles(finish.messages)).toEqual(["assistant", "tool", "assistant", "tool"]);
  });

  it("defaults to 8 rounds", async () => {
    const script = Array.from({ length: 12 }, (_, n) => toolRound([calculate(`c${n}`, "1+1")]));
    const { mock, finish } = await run(script, { tools: registryOf(calculateTool) });
    expect(finish.reason).toBe("max-rounds");
    expect(finish.rounds).toBe(8);
    expect(mock.calls).toHaveLength(8);
  });

  it("a final answer in the last allowed round is a stop, not max-rounds", async () => {
    const { finish } = await run([toolRound([calculate("c", "1+1")]), { text: "2" }], {
      tools: registryOf(calculateTool),
      budget: { maxRounds: 2 },
    });
    expect(finish.reason).toBe("stop");
    expect(finish.rounds).toBe(2);
  });

  it("maxRounds of 1 runs the tools and then stops", async () => {
    const { mock, finish } = await run([toolRound([calculate("c", "1+1")]), { text: "never asked" }], {
      tools: registryOf(calculateTool),
      budget: { maxRounds: 1 },
    });
    expect(finish.reason).toBe("max-rounds");
    expect(mock.calls).toHaveLength(1);
  });
});

describe("runTurn: model errors", () => {
  it("forwards the error event and finishes with error", async () => {
    const error = { code: "unavailable" as const, message: "down for maintenance", retryable: true };
    const { events, finish } = await run([{ error }]);
    expect(shape(events)).toEqual(["round", "route", "error", "turn-finish:error"]);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toMatchObject({ type: "error", error: { code: "unavailable" } });
    expect(finish.reason).toBe("error");
    expect(finish.rounds).toBe(1);
    expect(finish.messages).toEqual([]);
  });

  it("keeps what an earlier round added when a later round fails", async () => {
    const { events, finish } = await run(
      [toolRound([calculate("c", "1+1")], THINKING), { error: { code: "timeout", message: "too slow", retryable: true } }],
      { tools: registryOf(calculateTool) },
    );
    expect(finish.reason).toBe("error");
    expect(finish.rounds).toBe(2);
    expect(roles(finish.messages)).toEqual(["assistant", "tool"]);
    expect(typesOf(events).filter((type) => type === "error")).toHaveLength(1);
  });

  it("does not run the tool calls of a round that failed", async () => {
    const handler = vi.fn(async () => "ran");
    const { finish } = await run(
      [{ toolCalls: [callOf("t", "probe")], error: { code: "unavailable", message: "x", retryable: true } }],
      { tools: registryOf(plainTool("probe", handler)) },
    );
    expect(finish.reason).toBe("error");
    expect(handler).not.toHaveBeenCalled();
  });

  it("an error with code aborted finishes with aborted", async () => {
    const { events, finish } = await run([{ error: { code: "aborted", message: "cancelled", retryable: false } }]);
    expect(finish.reason).toBe("aborted");
    expect(typesOf(events)).toContain("error");
  });

  it("an empty route is an error event and a finished turn, not a throw", async () => {
    const { events, finish } = await run([{ text: "unused" }], { route: [] });
    expect(finish.reason).toBe("error");
    expect(typesOf(events)).toContain("error");
  });

  it("a provider stream that ends without finish becomes an error event and a finished turn", async () => {
    const silent: ModelProvider = {
      id: "silent",
      capabilities: () => ({ streaming: true, tools: true, vision: false }),
      chat: async () => {
        throw new CoreError("unknown", "not used");
      },
      stream: () => (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "cut off" };
      })(),
    };
    const router = new ModelRouter(new ProviderRegistry().register(silent));
    const events = await drain(
      runTurn({ router, route: [{ model: { provider: "silent", model: "m" } }], tools: new ToolRegistry(), channel: "local", messages: [USER] }),
    );
    expect(finishOf(events).reason).toBe("error");
    // The router already turns this into an error event; the runtime forwards it.
    expect(events.find((event) => event.type === "error")).toMatchObject({
      error: { message: expect.stringContaining("without a finish event") },
    });
  });

  it("never throws: a failing registry becomes an error event and a finished turn", async () => {
    const tools = registryOf(calculateTool);
    vi.spyOn(tools, "call").mockRejectedValue(new Error("registry exploded"));
    const { events, finish } = await run([toolRound([calculate("c", "1+1")]), { text: "unused" }], { tools });
    expect(finish.reason).toBe("error");
    expect(events.find((event) => event.type === "error")).toMatchObject({
      error: { code: "unknown", message: "registry exploded" },
    });
  });
});

describe("runTurn: aborting", () => {
  it("a signal aborted before the turn finishes with aborted and calls no model", async () => {
    const { mock, options } = setup([{ text: "unused" }], { signal: AbortSignal.abort() });
    const events = await drain(runTurn(options));
    expect(typesOf(events)).toEqual(["turn-finish"]);
    expect(finishOf(events)).toMatchObject({ reason: "aborted", rounds: 0, messages: [] });
    expect(mock.calls).toHaveLength(0);
  });

  it("an abort between rounds finishes with aborted and makes no further model call", async () => {
    const controller = new AbortController();
    const { mock, options } = setup([toolRound([calculate("c", "1+1")]), { text: "never reached" }], {
      tools: registryOf(calculateTool),
      signal: controller.signal,
    });
    const events = await drain(runTurn(options), (event) => {
      if (event.type === "tool-result") controller.abort();
    });
    const finish = finishOf(events);
    expect(finish.reason).toBe("aborted");
    expect(finish.rounds).toBe(1);
    expect(mock.calls).toHaveLength(1);
    expect(roles(finish.messages)).toEqual(["assistant", "tool"]);
    expect(typesOf(events)).not.toContain("error");
    expect(events.filter((event) => event.type === "round")).toHaveLength(1);
  });

  it("an abort while the model is answering forwards the aborted error and finishes with aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { options } = setup([{ text: "too late", delayMs: 2000 }], { signal: controller.signal });
    const started = Date.now();
    const events = await drain(runTurn(options));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(events.find((event) => event.type === "error")).toMatchObject({ error: { code: "aborted" } });
    expect(finishOf(events).reason).toBe("aborted");
  });

  it("an abort during several tool calls still gives every call a result", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const tool = (name: string) =>
      plainTool(name, async () => {
        ran.push(name);
        return name;
      });
    const { options } = setup([toolRound([callOf("a", "one"), callOf("b", "two")]), { text: "never" }], {
      tools: registryOf(tool("one"), tool("two")),
      signal: controller.signal,
    });
    const events = await drain(runTurn(options), (event) => {
      if (event.type === "tool-result" && event.result.toolCallId === "a") controller.abort();
    });
    const finish = finishOf(events);
    expect(finish.reason).toBe("aborted");
    expect(ran).toEqual(["one"]);
    expect(finish.messages).toHaveLength(3);
    expect(finish.messages[2]).toMatchObject({ role: "tool", toolCallId: "b", content: 'tool "two" was aborted', isError: true });
  });

  it("an abort while a tool runs reaches the tool's signal", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const waiting = plainTool(
      "wait",
      (_args, ctx) =>
        new Promise((_resolve, reject) => {
          seen = ctx.signal;
          ctx.signal?.addEventListener("abort", () => reject(new Error("tool cancelled")), { once: true });
          setTimeout(() => controller.abort(), 10);
        }),
    );
    const { mock, options } = setup([toolRound([callOf("w", "wait")]), { text: "never" }], {
      tools: registryOf(waiting),
      signal: controller.signal,
    });
    const events = await drain(runTurn(options));
    expect(seen?.aborted).toBe(true);
    expect(finishOf(events).reason).toBe("aborted");
    expect(mock.calls).toHaveLength(1);
  });
});

describe("runTurn: maxOutputTokens", () => {
  const script = () => [
    toolRound([calculate("c1", "1+1")], THINKING),
    toolRound([calculate("c2", "2+2")], THINKING),
    { text: "done" },
  ];

  it("ends with budget after the tool results once the output tokens reach the limit", async () => {
    const { mock, events, finish } = await run(script(), { tools: registryOf(calculateTool), budget: { maxOutputTokens: 10 } });
    expect(finish.reason).toBe("budget");
    expect(finish.rounds).toBe(1);
    expect(finish.usage.outputTokens).toBe(THINKING.length);
    expect(mock.calls).toHaveLength(1);
    expect(shape(events).slice(-3)).toEqual(["finish", "tool-result", "turn-finish:budget"]);
    expect(roles(finish.messages)).toEqual(["assistant", "tool"]);
  });

  it("counts the limit as reached when the total equals it, not before", async () => {
    const equal = await run(script(), { tools: registryOf(calculateTool), budget: { maxOutputTokens: THINKING.length } });
    expect(equal.finish.reason).toBe("budget");
    expect(equal.finish.rounds).toBe(1);
    const above = await run(script(), { tools: registryOf(calculateTool), budget: { maxOutputTokens: THINKING.length + 1 } });
    expect(above.finish.rounds).toBe(2);
    expect(above.finish.reason).toBe("budget");
  });

  it("sums the tokens of all rounds", async () => {
    const { finish } = await run(script(), { tools: registryOf(calculateTool), budget: { maxOutputTokens: THINKING.length * 2 } });
    expect(finish.reason).toBe("budget");
    expect(finish.rounds).toBe(2);
    expect(finish.usage.outputTokens).toBe(THINKING.length * 2);
  });

  it("does not stop a turn that stays under the limit", async () => {
    const { finish } = await run(script(), { tools: registryOf(calculateTool), budget: { maxOutputTokens: 100_000 } });
    expect(finish.reason).toBe("stop");
    expect(finish.rounds).toBe(3);
  });

  it("does not turn a final answer into a budget stop", async () => {
    const { finish } = await run([{ text: "a long answer that is over the limit" }], { budget: { maxOutputTokens: 1 } });
    expect(finish.reason).toBe("stop");
  });

  it("max-rounds wins when no further round would follow anyway", async () => {
    const { finish } = await run(script(), {
      tools: registryOf(calculateTool),
      budget: { maxOutputTokens: 1, maxRounds: 1 },
    });
    expect(finish.reason).toBe("max-rounds");
  });
});

describe("runTurn: the per-request maxOutputTokens", () => {
  const script = () => [toolRound([calculate("c1", "1+1")], THINKING), { text: "done" }];

  it("reaches every model request of a turn with a tool round", async () => {
    const { mock, finish } = await run(script(), { tools: registryOf(calculateTool), maxOutputTokens: 300 });
    expect(finish.reason).toBe("stop");
    expect(mock.calls).toHaveLength(2);
    for (const call of mock.calls) expect(call.maxOutputTokens).toBe(300);
  });

  it("leaves the property out of every request when the option is not given", async () => {
    const { mock } = await run(script(), { tools: registryOf(calculateTool) });
    expect(mock.calls).toHaveLength(2);
    for (const call of mock.calls) expect(call).not.toHaveProperty("maxOutputTokens");
  });

  it("is what the requests carry when budget.maxOutputTokens is also given, and the budget still ends the turn", async () => {
    const { mock, finish } = await run(script(), {
      tools: registryOf(calculateTool),
      maxOutputTokens: 300,
      budget: { maxOutputTokens: 10 },
    });
    expect(finish.reason).toBe("budget");
    expect(finish.rounds).toBe(1);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.maxOutputTokens).toBe(300);
  });
});

describe("runTurn: maxWallMs", () => {
  it("ends with budget when the model is slower than the budget, without forwarding the aborted error", async () => {
    const { mock, options } = setup([{ text: "too late", delayMs: 2000 }], { budget: { maxWallMs: 50 } });
    const started = Date.now();
    const events = await drain(runTurn(options));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(shape(events)).toEqual(["round", "route", "turn-finish:budget"]);
    expect(typesOf(events)).not.toContain("error");
    expect(finishOf(events)).toMatchObject({ reason: "budget", rounds: 1, messages: [] });
    expect(mock.calls).toHaveLength(1);
  });

  it("aborts a running tool through its signal and ends with budget", async () => {
    let toolSignal: AbortSignal | undefined;
    const waiting = plainTool(
      "wait",
      (_args, ctx) =>
        new Promise((_resolve, reject) => {
          toolSignal = ctx.signal;
          ctx.signal?.addEventListener("abort", () => reject(new Error("tool cancelled")), { once: true });
        }),
    );
    const { mock, options } = setup([toolRound([callOf("w", "wait")]), { text: "never" }], {
      tools: registryOf(waiting),
      budget: { maxWallMs: 50 },
    });
    const events = await drain(runTurn(options));
    const finish = finishOf(events);
    expect(toolSignal?.aborted).toBe(true);
    expect(finish.reason).toBe("budget");
    expect(mock.calls).toHaveLength(1);
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      result: { toolCallId: "w", content: "tool cancelled", isError: true },
    });
    expect(roles(finish.messages)).toEqual(["assistant", "tool"]);
    expect(typesOf(events)).not.toContain("error");
  });

  it("is one timer for the whole turn, not one per round", async () => {
    const slowTool = plainTool("nap", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "rested";
    });
    const { mock, options } = setup(
      [toolRound([callOf("n1", "nap")]), toolRound([callOf("n2", "nap")]), toolRound([callOf("n3", "nap")]), { text: "done" }],
      { tools: registryOf(slowTool), budget: { maxWallMs: 100 } },
    );
    const finish = finishOf(await drain(runTurn(options)));
    expect(finish.reason).toBe("budget");
    expect(mock.calls.length).toBeLessThan(4);
  });

  it("a caller abort still ends with aborted and forwards the error, even with a wall budget set", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { options } = setup([{ text: "too late", delayMs: 2000 }], { signal: controller.signal, budget: { maxWallMs: 5000 } });
    const events = await drain(runTurn(options));
    expect(finishOf(events).reason).toBe("aborted");
    expect(events.find((event) => event.type === "error")).toMatchObject({ error: { code: "aborted" } });
  });

  it("a generous budget changes nothing", async () => {
    const { finish } = await run([{ text: "quick" }], { budget: { maxWallMs: 60_000 } });
    expect(finish.reason).toBe("stop");
  });

  it("a very large budget does not fire at once", async () => {
    const { finish } = await run([{ text: "quick" }], { budget: { maxWallMs: 10 ** 12 } });
    expect(finish.reason).toBe("stop");
  });

  it("clears its timer when the turn ends, and when the consumer stops early", async () => {
    vi.useFakeTimers();
    const done = await run([{ text: "quick" }], { budget: { maxWallMs: 60_000 } });
    expect(done.finish.reason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);

    const { options } = setup([{ text: "quick" }], { budget: { maxWallMs: 60_000 } });
    for await (const event of runTurn(options)) {
      if (event.type === "route") break;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave a listener on the caller's signal", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await run([{ text: "quick" }], { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("runTurn: usage", () => {
  it("sums the token counts of every round", async () => {
    const { mock, finish } = await run([toolRound([calculate("c", "1+1")], THINKING), { text: "It is 2." }], {
      tools: registryOf(calculateTool),
    });
    // The mock reports input tokens as the characters in the request and output tokens as the characters it answers.
    const expectedInput = mock.calls.reduce(
      (total, request) => total + request.messages.reduce((sum, message) => sum + message.content.length, 0),
      0,
    );
    expect(finish.usage).toEqual({ inputTokens: expectedInput, outputTokens: THINKING.length + "It is 2.".length });
    expect(expectedInput).toBeGreaterThan(USER.content.length);
  });

  it("leaves a count out when the model never reported it", async () => {
    const quiet: ModelProvider = {
      id: "quiet",
      capabilities: () => ({ streaming: true, tools: true, vision: false }),
      chat: async () => {
        throw new CoreError("unknown", "not used");
      },
      stream: () => (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "hi" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      })(),
    };
    const router = new ModelRouter(new ProviderRegistry().register(quiet));
    const events = await drain(
      runTurn({ router, route: [{ model: { provider: "quiet", model: "m" } }], tools: new ToolRegistry(), channel: "local", messages: [USER] }),
    );
    expect(finishOf(events)).toMatchObject({ reason: "stop", usage: {} });
    expect(finishOf(events).usage).toEqual({});
  });

  it("is empty when the turn never reached a model", async () => {
    const { options } = setup([{ text: "unused" }], { signal: AbortSignal.abort() });
    expect(finishOf(await drain(runTurn(options))).usage).toEqual({});
  });
});
