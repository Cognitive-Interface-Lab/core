import { describe, expect, it } from "vitest";
import { CoreError, type Message, type ModelRef, type TurnEvent } from "@core/contracts";
import { MemoryGraphStore, ProcessGraph } from "@core/graph";
import { MockProvider, ModelRouter, ProviderRegistry, type MockTurn } from "@core/models";
import { ToolRegistry, calculateTool, type RegisteredTool } from "@core/tools";
import { runBranchTurn, type BranchTurnOptions } from "../src/index.js";

const MODEL: ModelRef = { provider: "mock", model: "scripted" };
const user = (content: string): Message => ({ role: "user", content });

function routerOf(script: MockTurn[]): { mock: MockProvider; router: ModelRouter } {
  const mock = new MockProvider({ script, echo: false });
  return { mock, router: new ModelRouter(new ProviderRegistry().register(mock)) };
}

function registryOf(...tools: RegisteredTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

async function setup() {
  const store = new MemoryGraphStore();
  const graph = await ProcessGraph.create(store);
  return { store, graph, main: graph.branchId("main") };
}

function optionsFor(graph: ProcessGraph, branchId: string, script: MockTurn[], extra: Partial<BranchTurnOptions> = {}) {
  const { mock, router } = routerOf(script);
  const options: BranchTurnOptions = { router, route: [{ model: MODEL }], tools: new ToolRegistry(), channel: "local", graph, branchId, ...extra };
  return { mock, options };
}

async function drain(events: AsyncIterable<TurnEvent>, onEvent?: (event: TurnEvent) => Promise<void>): Promise<TurnEvent[]> {
  const all: TurnEvent[] = [];
  for await (const event of events) {
    all.push(event);
    await onEvent?.(event);
  }
  return all;
}

const calculation = { id: "c1", name: "calculate", arguments: { expression: "23*17" } };

describe("runBranchTurn", () => {
  it("adds the input, then records the whole turn with its provenance", async () => {
    const { graph, main } = await setup();
    const { options } = optionsFor(graph, main, [{ text: "hello there", finishReason: "stop" }], { input: user("hi") });

    const events = await drain(runBranchTurn(options));

    expect(graph.conversation(main)).toEqual([user("hi"), { role: "assistant", content: "hello there" }]);
    const nodes = graph.pathNodes(main);
    expect(nodes.map((node) => node.turnId === undefined)).toEqual([true, false]);
    const turnId = nodes[1]?.turnId as string;
    expect(graph.state.turns[turnId]).toMatchObject({
      branchId: main,
      nodeIds: [nodes[1]?.id],
      reason: "stop",
      model: MODEL,
    });
    expect(events.at(-1)?.type).toBe("turn-finish");
  });

  it("yields exactly the events it records, and records before it yields turn-finish", async () => {
    const { store, graph, main } = await setup();
    const { options } = optionsFor(graph, main, [{ text: "hello there", finishReason: "stop" }], { input: user("hi") });

    let heldWhenFinishArrived: string | undefined;
    const events = await drain(runBranchTurn(options), async (event) => {
      if (event.type === "turn-finish") heldWhenFinishArrived = (await store.read(graph.id)).at(-1)?.event.type;
    });

    expect(heldWhenFinishArrived).toBe("turn-recorded");
    const recorded = (await store.read(graph.id)).at(-1)?.event;
    expect(recorded?.type === "turn-recorded" && recorded.events).toEqual(events);
    expect(events.filter((event) => event.type === "turn-finish")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn-finish");
  });

  it("records the assistant, tool and final assistant nodes of a tool turn in order", async () => {
    const { graph, main } = await setup();
    const { options } = optionsFor(
      graph,
      main,
      [{ text: "", toolCalls: [calculation], finishReason: "tool-calls" }, { text: "It is 391.", finishReason: "stop" }],
      { input: user("23 times 17?"), tools: registryOf(calculateTool) },
    );

    await drain(runBranchTurn(options));

    const nodes = graph.pathNodes(main);
    expect(nodes.map((node) => node.message?.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(nodes[1]?.message).toMatchObject({ toolCalls: [calculation] });
    expect(nodes[2]?.message).toMatchObject({ role: "tool", toolCallId: "c1", toolName: "calculate", isError: false });
    expect(graph.conversation(main).at(-1)).toEqual({ role: "assistant", content: "It is 391." });
    const turnId = nodes[1]?.turnId as string;
    expect(new Set(nodes.slice(1).map((node) => node.turnId))).toEqual(new Set([turnId]));
    expect(graph.state.turns[turnId]?.nodeIds).toEqual(nodes.slice(1).map((node) => node.id));
  });

  it("answers the branch's own conversation when there is no input", async () => {
    const { graph, main } = await setup();
    await graph.addMessage(main, user("already here"));
    const { mock, options } = optionsFor(graph, main, [{ text: "ok", finishReason: "stop" }]);

    await drain(runBranchTurn(options));

    expect(mock.calls[0]?.messages).toEqual([user("already here")]);
    expect(graph.conversation(main)).toEqual([user("already here"), { role: "assistant", content: "ok" }]);
  });

  it("records a turn that ends in error, with no message nodes", async () => {
    const { store, graph, main } = await setup();
    const error = { code: "unavailable" as const, message: "down for maintenance", retryable: true };
    const { options } = optionsFor(graph, main, [{ error }], { input: user("hi") });

    const events = await drain(runBranchTurn(options));

    expect(events.at(-1)).toMatchObject({ type: "turn-finish", reason: "error", messages: [] });
    expect(graph.conversation(main)).toEqual([user("hi")]);
    const turn = Object.values(graph.state.turns)[0];
    expect(turn).toMatchObject({ branchId: main, nodeIds: [], reason: "error" });
    expect((await store.read(graph.id)).at(-1)?.event.type).toBe("turn-recorded");
  });

  it("records an aborted turn too", async () => {
    const { graph, main } = await setup();
    const { options } = optionsFor(graph, main, [{ text: "never", finishReason: "stop" }], {
      input: user("hi"),
      signal: AbortSignal.abort(),
    });

    const events = await drain(runBranchTurn(options));

    expect(events.at(-1)).toMatchObject({ type: "turn-finish", reason: "aborted" });
    expect(Object.values(graph.state.turns)[0]?.reason).toBe("aborted");
  });

  it("throws conflict, and records nothing, when another writer appends mid-turn", async () => {
    const { store, graph, main } = await setup();
    const other = await ProcessGraph.open(store, graph.id);
    const interfering: RegisteredTool = {
      definition: { name: "interfere", description: "a tool that lets another writer in", inputSchema: { type: "object" } },
      policy: { sideEffects: false },
      handler: async () => {
        await other.refresh();
        await other.addMessage(main, user("from the other writer"));
        return "done";
      },
      source: "local",
    };
    const { options } = optionsFor(
      graph,
      main,
      [{ text: "", toolCalls: [{ id: "i1", name: "interfere", arguments: {} }], finishReason: "tool-calls" }, { text: "done", finishReason: "stop" }],
      { input: user("go"), tools: registryOf(interfering) },
    );

    const seen: TurnEvent[] = [];
    const error = await drain(runBranchTurn(options), async (event) => void seen.push(event)).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CoreError);
    expect(error).toMatchObject({ code: "conflict" });
    expect(seen.some((event) => event.type === "turn-finish")).toBe(false);
    const types = (await store.read(graph.id)).map((record) => record.event.type);
    expect(types).not.toContain("turn-recorded");
    expect(Object.keys(graph.state.turns)).toEqual([]);
  });

  it("records nothing when the consumer stops early", async () => {
    const { store, graph, main } = await setup();
    const { options } = optionsFor(graph, main, [{ text: "hello there", finishReason: "stop" }], { input: user("hi") });

    const run = runBranchTurn(options);
    await run.next();
    await run.return();

    expect((await store.read(graph.id)).map((record) => record.event.type)).not.toContain("turn-recorded");
  });

  it("refuses an unknown branch before running the model", async () => {
    const { graph } = await setup();
    const withInput = optionsFor(graph, "nope", [{ text: "x", finishReason: "stop" }], { input: user("hi") });
    await expect(drain(runBranchTurn(withInput.options))).rejects.toMatchObject({ code: "bad_request" });
    expect(withInput.mock.calls).toHaveLength(0);

    const withoutInput = optionsFor(graph, "nope", [{ text: "x", finishReason: "stop" }]);
    await expect(drain(runBranchTurn(withoutInput.options))).rejects.toMatchObject({ code: "not_found" });
    expect(withoutInput.mock.calls).toHaveLength(0);
  });
});
