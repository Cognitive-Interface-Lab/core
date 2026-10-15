import { describe, expect, it } from "vitest";
import type { GraphNode, Message, ModelRef, TurnEvent } from "@core/contracts";
import { MemoryGraphStore, ProcessGraph } from "@core/graph";
import { MockProvider, ModelRouter, ProviderRegistry, type MockTurn } from "@core/models";
import { ToolRegistry, calculateTool } from "@core/tools";
import { replayBranch, runBranchTurn, type ReplayOptions } from "../src/index.js";

const FIRST: ModelRef = { provider: "mock", model: "first" };
const SECOND: ModelRef = { provider: "mock", model: "second" };
const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });
const texts = (messages: Message[]): unknown[] => messages.map((message) => message.content);

/** What `calculateTool` answers for the call below. */
const CALCULATED = JSON.stringify({ expression: "23*17", result: 391 });
const calculation = { id: "c1", name: "calculate", arguments: { expression: "23*17" } };
const toolRound: MockTurn = { text: "", toolCalls: [calculation], finishReason: "tool-calls" };
const answer = (text: string): MockTurn => ({ text, finishReason: "stop" });

function toolsWithCalculate(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculateTool);
  return registry;
}

/** Runs a turn to its end; `runBranchTurn` records it on the way. */
async function drain(events: AsyncIterable<TurnEvent>): Promise<void> {
  for await (const event of events) void event;
}

/** A router whose provider plays `script`; each call to a runtime function gets its own, so scripts never mix. */
function scripted(script: MockTurn[]) {
  const mock = new MockProvider({ script, echo: false });
  return { mock, router: new ModelRouter(new ProviderRegistry().register(mock)) };
}

/**
 * main: q1 → a1 (one turn), q2 → [call, tool result, a2] (one turn with a tool call), all on `FIRST`.
 */
async function sourceGraph() {
  const graph = await ProcessGraph.create(new MemoryGraphStore());
  const main = graph.branchId("main");
  const run = async (input: string, script: MockTurn[]) => {
    const { router } = scripted(script);
    await drain(runBranchTurn({ router, route: [{ model: FIRST }], tools: toolsWithCalculate(), channel: "local", graph, branchId: main, input: user(input) }));
  };
  await run("q1", [answer("a1")]);
  await run("q2", [toolRound, answer("It is 391.")]);
  return { graph, main, path: graph.pathNodes(main) };
}

function replayOptions(graph: ProcessGraph, branchId: string, script: MockTurn[], extra: Partial<ReplayOptions> = {}) {
  const { mock, router } = scripted(script);
  const options: ReplayOptions = { router, route: [{ model: SECOND }], tools: toolsWithCalculate(), channel: "local", graph, branchId, ...extra };
  return { mock, options };
}

const ids = (nodes: GraphNode[]) => nodes.map((node) => node.id);

describe("replayBranch", () => {
  it("replays a two-turn branch on another model, next to the original", async () => {
    const { graph, main, path } = await sourceGraph();
    expect(path.map((node) => node.message?.role)).toEqual(["user", "assistant", "user", "assistant", "tool", "assistant"]);
    const sourceBefore = structuredClone(graph.state.branches[main]);
    const events: TurnEvent[] = [];
    const { mock, options } = replayOptions(graph, main, [answer("b1"), toolRound, answer("391 it is")], {
      onEvent: (event) => events.push(event),
    });

    const result = await replayBranch(options);

    expect(result).toEqual({ branchId: expect.any(String), turns: 2, completed: true });
    const branch = graph.state.branches[result.branchId];
    expect(branch).toMatchObject({ name: "main replay", from: null, replayOf: main });
    expect(texts(graph.conversation(result.branchId))).toEqual(["q1", "b1", "q2", "", CALCULATED, "391 it is"]);

    const replayed = graph.pathNodes(result.branchId);
    // Inputs carry the node they were copied from; turn nodes are new.
    expect(replayed.filter((node) => node.turnId === undefined).map((node) => node.origin)).toEqual([
      { graphId: graph.id, nodeId: path[0]?.id },
      { graphId: graph.id, nodeId: path[2]?.id },
    ]);
    expect(replayed.some((node) => node.turnId !== undefined && path.some((old) => old.id === node.id))).toBe(false);

    // New turn summaries name the replay model; the original turns still name the first one.
    const turns = Object.values(graph.state.turns);
    expect(turns.filter((turn) => turn.branchId === result.branchId).map((turn) => turn.model)).toEqual([SECOND, SECOND]);
    expect(turns.filter((turn) => turn.branchId === main).map((turn) => turn.model)).toEqual([FIRST, FIRST]);

    // The source branch is unchanged.
    expect(graph.state.branches[main]).toEqual(sourceBefore);
    expect(ids(graph.pathNodes(main))).toEqual(ids(path));

    expect(events.filter((event) => event.type === "turn-finish")).toHaveLength(2);
    expect(mock.calls).toHaveLength(3);
  });

  it("shares the prefix up to a middle node and runs only the later turns", async () => {
    const { graph, main, path } = await sourceGraph();
    const a1 = path[1] as GraphNode;
    const { mock, options } = replayOptions(graph, main, [toolRound, answer("redone")], { from: a1.id });

    const result = await replayBranch(options);

    expect(result).toMatchObject({ turns: 1, completed: true });
    expect(graph.state.branches[result.branchId]).toMatchObject({ from: a1.id, replayOf: main });
    const replayed = graph.pathNodes(result.branchId);
    expect(ids(replayed.slice(0, 2))).toEqual(ids(path.slice(0, 2)));
    expect(texts(graph.conversation(result.branchId))).toEqual(["q1", "a1", "q2", "", CALCULATED, "redone"]);
    expect(replayed[2]?.origin).toEqual({ graphId: graph.id, nodeId: path[2]?.id });
    expect(Object.values(graph.state.turns).filter((turn) => turn.branchId === result.branchId)).toHaveLength(1);
    // One turn ran: the model saw the shared prefix and the copied input.
    expect(mock.calls[0]?.messages.map((message) => message.content)).toEqual(["q1", "a1", "q2"]);
  });

  it("re-runs the rest of a turn as one turn when from is the tool message inside it", async () => {
    const { graph, main, path } = await sourceGraph();
    const toolNode = path[4] as GraphNode;
    expect(toolNode.message?.role).toBe("tool");
    const { mock, options } = replayOptions(graph, main, [answer("continued")], { from: toolNode.id });

    const result = await replayBranch(options);

    expect(result).toMatchObject({ turns: 1, completed: true });
    expect(ids(graph.pathNodes(result.branchId).slice(0, 5))).toEqual(ids(path.slice(0, 5)));
    // The model continues from the tool result.
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "tool"]);
    expect(graph.conversation(result.branchId).at(-1)).toEqual(assistant("continued"));
    expect(graph.pathNodes(result.branchId)).toHaveLength(6);
  });

  it("replays nothing when from is the last node", async () => {
    const { graph, main, path } = await sourceGraph();
    const { mock, options } = replayOptions(graph, main, [], { from: path.at(-1)?.id });

    const result = await replayBranch(options);

    expect(result).toMatchObject({ turns: 0, completed: true });
    expect(mock.calls).toHaveLength(0);
    expect(ids(graph.pathNodes(result.branchId))).toEqual(ids(path));
  });

  it("replays a branch with an append merge as one linear branch, merged messages as inputs", async () => {
    const graph = await ProcessGraph.create(new MemoryGraphStore());
    const main = graph.branchId("main");
    const u1 = await graph.addMessage(main, user("u1"));
    const alt = await graph.branch("alt", u1);
    await graph.addMessage(alt, user("from alt"));
    await graph.addMessage(main, user("u2"));
    const mergeId = await graph.merge({ source: alt, target: main, strategy: "append" });
    const { router } = scripted([answer("a-main")]);
    await drain(runBranchTurn({ router, route: [{ model: FIRST }], tools: new ToolRegistry(), channel: "local", graph, branchId: main }));
    const path = graph.pathNodes(main);
    expect(texts(graph.conversation(main))).toEqual(["u1", "u2", "from alt", "a-main"]);
    expect(path.some((node) => node.id === mergeId)).toBe(false); // an append merge carries no message and is not on the message path

    const { mock, options } = replayOptions(graph, main, [answer("a-replay")]);
    const result = await replayBranch(options);

    expect(result).toMatchObject({ turns: 1, completed: true });
    const replayed = graph.pathNodes(result.branchId);
    expect(texts(graph.conversation(result.branchId))).toEqual(["u1", "u2", "from alt", "a-replay"]);
    // Linear: every node has at most one parent and none is a merge.
    expect(replayed.every((node) => node.merge === undefined && node.parentIds.length <= 1)).toBe(true);
    expect(replayed.slice(0, 3).every((node) => node.origin?.graphId === graph.id)).toBe(true);
    expect(mock.calls[0]?.messages.map((message) => message.content)).toEqual(["u1", "u2", "from alt"]);
  });

  it("stops at a failing turn with completed false and its reason", async () => {
    const { graph, main } = await sourceGraph();
    const error = { code: "unavailable" as const, message: "down", retryable: true };
    const { mock, options } = replayOptions(graph, main, [{ error }, answer("never")]);

    const result = await replayBranch(options);

    expect(result).toMatchObject({ turns: 1, completed: false, reason: "error" });
    // The failing turn is recorded; q2 was not copied and the second turn did not run.
    expect(texts(graph.conversation(result.branchId))).toEqual(["q1"]);
    expect(Object.values(graph.state.turns).filter((turn) => turn.branchId === result.branchId).map((turn) => turn.reason)).toEqual(["error"]);
    expect(mock.calls).toHaveLength(1);
  });

  it("stops after an aborted turn", async () => {
    const { graph, main } = await sourceGraph();
    const { options } = replayOptions(graph, main, [answer("x")], { signal: AbortSignal.abort() });

    expect(await replayBranch(options)).toMatchObject({ turns: 1, completed: false, reason: "aborted" });
  });

  it("names a second replay of the same branch '<name> replay 2', then 3", async () => {
    const { graph, main, path } = await sourceGraph();
    const from = path.at(-1)?.id;
    const names: string[] = [];
    for (let run = 0; run < 3; run++) {
      const { options } = replayOptions(graph, main, [], { from });
      const result = await replayBranch(options);
      names.push(graph.state.branches[result.branchId]?.name as string);
    }
    expect(names).toEqual(["main replay", "main replay 2", "main replay 3"]);
  });

  it("uses an explicit name as given", async () => {
    const { graph, main, path } = await sourceGraph();
    const { options } = replayOptions(graph, main, [], { from: path.at(-1)?.id, name: "on the second model" });
    const result = await replayBranch(options);
    expect(graph.state.branches[result.branchId]?.name).toBe("on the second model");
  });

  it("throws bad_request for a from that is not on the path, and creates no branch", async () => {
    const { graph, main } = await sourceGraph();
    const side = await graph.branch("side", null);
    const elsewhere = await graph.addMessage(side, user("not on main"));
    const branchesBefore = Object.keys(graph.state.branches);
    const { mock, options } = replayOptions(graph, main, [answer("x")], { from: elsewhere });

    await expect(replayBranch(options)).rejects.toMatchObject({ code: "bad_request" });
    await expect(replayBranch({ ...options, from: "nope" })).rejects.toMatchObject({ code: "bad_request" });
    expect(Object.keys(graph.state.branches)).toEqual(branchesBefore);
    expect(mock.calls).toHaveLength(0);
  });

  it("throws not_found for an unknown branch", async () => {
    const { graph } = await sourceGraph();
    const { options } = replayOptions(graph, "nope", []);
    await expect(replayBranch(options)).rejects.toMatchObject({ code: "not_found" });
  });
});
