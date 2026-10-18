import { describe, expect, it } from "vitest";
import type { Message, ModelRef, ToolCall, ToolDefinition, TurnEvent } from "@core/contracts";
import { MockProvider, ModelRouter, ProviderRegistry, type MockTurn } from "@core/models";
import { ToolRegistry, calculateTool, type RegisteredTool } from "@core/tools";
import { runTurn, type RunTurnOptions } from "../src/index.js";

const MODEL: ModelRef = { provider: "mock", model: "scripted" };
const USER: Message = { role: "user", content: "what is 23 times 17, and where am I?" };

const clientTool = (name: string): ToolDefinition => ({
  name,
  description: `the ${name} client tool`,
  inputSchema: { type: "object" },
});

const registryTool = (name: string): RegisteredTool => ({
  definition: { name, description: `the ${name} tool`, inputSchema: { type: "object" } },
  policy: { sideEffects: false },
  handler: async () => "ok",
  source: "local",
});

function registryOf(...tools: RegisteredTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

const callOf = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, arguments: args });
const toolRound = (calls: ToolCall[], text = ""): MockTurn => ({ text, toolCalls: calls, finishReason: "tool-calls" });

function setup(script: MockTurn[], overrides: Partial<RunTurnOptions> = {}) {
  const mock = new MockProvider({ script, echo: false });
  const router = new ModelRouter(new ProviderRegistry().register(mock));
  const options: RunTurnOptions = {
    router,
    route: [{ model: MODEL }],
    tools: new ToolRegistry(),
    channel: "local",
    messages: [USER],
    ...overrides,
  };
  return { mock, options };
}

async function drain(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const all: TurnEvent[] = [];
  for await (const event of events) all.push(event);
  expect(all.filter((event) => event.type === "turn-finish")).toHaveLength(1);
  expect(all.at(-1)?.type).toBe("turn-finish");
  return all;
}

async function run(script: MockTurn[], overrides: Partial<RunTurnOptions> = {}) {
  const { mock, options } = setup(script, overrides);
  const events = await drain(runTurn(options));
  const last = events.at(-1);
  if (last?.type !== "turn-finish") throw new Error("the last event is not turn-finish");
  return { mock, options, events, finish: last };
}

const typesOf = (events: TurnEvent[]) => events.map((event) => event.type);

describe("runTurn: client tools", () => {
  it("ends the turn with client-tools when only a client tool is called, running and answering nothing", async () => {
    const call = callOf("c1", "get_location", { precise: true });
    const { mock, events, finish } = await run([toolRound([call])], { clientTools: [clientTool("get_location")] });
    expect(typesOf(events)).toEqual(["round", "route", "tool-call", "finish", "turn-finish"]);
    expect(finish.reason).toBe("client-tools");
    expect(finish.rounds).toBe(1);
    expect(finish.messages).toEqual([{ role: "assistant", content: "", toolCalls: [call] }]);
    expect(events.some((event) => event.type === "tool-result")).toBe(false);
    expect(mock.calls).toHaveLength(1);
  });

  it("runs the registry call of a mixed round and leaves the client call to the caller", async () => {
    const registryCall = callOf("r1", "calculate", { expression: "23*17" });
    const clientCall = callOf("c1", "get_location");
    const { mock, events, finish } = await run([toolRound([registryCall, clientCall], "checking")], {
      tools: registryOf(calculateTool),
      clientTools: [clientTool("get_location")],
    });
    const results = events.filter((event): event is Extract<TurnEvent, { type: "tool-result" }> => event.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toMatchObject({ toolCallId: "r1", toolName: "calculate", isError: false });
    expect(finish.reason).toBe("client-tools");
    expect(finish.messages).toEqual([
      { role: "assistant", content: "checking", toolCalls: [registryCall, clientCall] },
      {
        role: "tool",
        toolCallId: "r1",
        toolName: "calculate",
        content: results[0]?.result.content,
        isError: false,
      },
    ]);
    expect(mock.calls).toHaveLength(1);
  });

  it("runs the registry calls of a mixed round in model order, even when the client call comes first", async () => {
    const calls = [callOf("a", "alpha"), callOf("c", "get_location"), callOf("b", "beta")];
    const { events, finish } = await run([toolRound(calls)], {
      tools: registryOf(registryTool("alpha"), registryTool("beta")),
      clientTools: [clientTool("get_location")],
    });
    const ids = events.flatMap((event) => (event.type === "tool-result" ? [event.result.toolCallId] : []));
    expect(ids).toEqual(["a", "b"]);
    expect(finish.messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool"]);
    expect(finish.messages[0]).toMatchObject({ toolCalls: calls });
  });

  it("lets the caller continue by appending the client call's tool message and starting a new turn", async () => {
    const call = callOf("c1", "get_location");
    const first = setup([toolRound([call]), { text: "You are in Montreal." }], { clientTools: [clientTool("get_location")] });
    const firstEvents = await drain(runTurn(first.options));
    const firstFinish = firstEvents.at(-1);
    if (firstFinish?.type !== "turn-finish") throw new Error("no turn-finish");
    expect(firstFinish.reason).toBe("client-tools");

    const answer: Message = { role: "tool", toolCallId: "c1", toolName: "get_location", content: "Montreal", isError: false };
    const history = [USER, ...firstFinish.messages, answer];
    const second = await drain(runTurn({ ...first.options, messages: history }));

    const secondFinish = second.at(-1);
    if (secondFinish?.type !== "turn-finish") throw new Error("no turn-finish");
    expect(secondFinish.reason).toBe("stop");
    expect(secondFinish.messages).toEqual([{ role: "assistant", content: "You are in Montreal." }]);
    expect(first.mock.calls).toHaveLength(2);
    expect(first.mock.calls[1]?.messages).toEqual(history);
  });

  it("offers the registry's definitions first, then the client tools in the given order, every round", async () => {
    const registry = registryOf(registryTool("alpha"), registryTool("beta"));
    const expectedRegistry = registry.listFor("local").map((tool) => tool.name);
    expect(expectedRegistry.sort()).toEqual(["alpha", "beta"]);
    const clients = [clientTool("zeta"), clientTool("get_location"), clientTool("mid")];
    const { mock } = await run([toolRound([callOf("a", "alpha")]), toolRound([callOf("c", "mid")])], {
      tools: registry,
      clientTools: clients,
    });
    expect(mock.calls).toHaveLength(2);
    for (const request of mock.calls) {
      const names = request.tools?.map((tool) => tool.name) ?? [];
      expect(names).toEqual([...registry.listFor("local").map((tool) => tool.name), "zeta", "get_location", "mid"]);
      expect(request.tools?.slice(-3)).toEqual(clients);
    }
  });

  it("offers only the client tools when the registry has none for the channel", async () => {
    const { mock } = await run([{ text: "ok" }], { clientTools: [clientTool("get_location")] });
    expect(mock.calls[0]?.tools).toEqual([clientTool("get_location")]);
  });

  it("refuses, before any model call, a client tool named like a registry tool on the channel", async () => {
    const { mock, events, finish } = await run([{ text: "never sent" }], {
      tools: registryOf(calculateTool),
      clientTools: [clientTool("calculate")],
    });
    expect(typesOf(events)).toEqual(["error", "turn-finish"]);
    const errors = events.filter((event): event is Extract<TurnEvent, { type: "error" }> => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.code).toBe("bad_request");
    expect(errors[0]?.error.message).toContain("calculate");
    expect(finish.reason).toBe("error");
    expect(finish.rounds).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });

  it("accepts a client tool named like a registry tool that is not offered on this channel", async () => {
    const voiceOnly: RegisteredTool = { ...registryTool("speak"), policy: { channels: ["voice"], sideEffects: false } };
    const { mock, finish } = await run([{ text: "ok" }], {
      tools: registryOf(voiceOnly),
      channel: "local",
      clientTools: [clientTool("speak")],
    });
    expect(finish.reason).toBe("stop");
    expect(mock.calls[0]?.tools?.map((tool) => tool.name)).toEqual(["speak"]);
  });

  it("ends with client-tools, not max-rounds, when the last allowed round calls a client tool", async () => {
    const { mock, events, finish } = await run([toolRound([callOf("c1", "get_location")])], {
      clientTools: [clientTool("get_location")],
      budget: { maxRounds: 1 },
    });
    expect(finish.reason).toBe("client-tools");
    expect(finish.rounds).toBe(1);
    expect(typesOf(events)).not.toContain("error");
    expect(mock.calls).toHaveLength(1);
  });

  it("without client tools, a plain answer behaves as before whether clientTools is omitted, undefined or empty", async () => {
    const expectedTypes = ["round", "route", "text-delta", "finish", "turn-finish"];
    const answer = { role: "assistant", content: "Hello." };

    const omitted = await run([{ text: "Hello." }]);
    const undef = await run([{ text: "Hello." }], { clientTools: undefined });
    const empty = await run([{ text: "Hello." }], { clientTools: [] });

    for (const result of [omitted, undef, empty]) {
      expect(typesOf(result.events)).toEqual(expectedTypes);
      expect(result.finish.reason).toBe("stop");
      expect(result.finish.rounds).toBe(1);
      expect(result.finish.messages).toEqual([answer]);
      expect(result.mock.calls[0]).not.toHaveProperty("tools");
    }
    expect(undef.events).toEqual(omitted.events);
    expect(empty.events).toEqual(omitted.events);
  });

  it("without client tools, a call to an unknown tool is still an error result and the turn goes on", async () => {
    const { finish, events } = await run([toolRound([callOf("x", "get_location")]), { text: "Sorry." }], {
      tools: registryOf(calculateTool),
    });
    expect(finish.reason).toBe("stop");
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      result: { toolCallId: "x", isError: true },
    });
  });
});
