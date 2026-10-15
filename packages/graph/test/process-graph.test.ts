import { beforeEach, describe, expect, it } from "vitest";
import { CoreError, type Message, type TurnEvent } from "@core/contracts";
import { MemoryGraphStore, ProcessGraph, pathTo } from "../src/index.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const AT = NOW.toISOString();

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });
const texts = (messages: Message[]): unknown[] => messages.map((message) => message.content);

/** A turn that called a tool and then answered: three messages. */
const toolTurn: TurnEvent[] = [
  { type: "round", round: 1 },
  { type: "route", model: { provider: "mock", model: "m1" }, attempt: 1 },
  { type: "tool-call", toolCall: { id: "c1", name: "clock", arguments: {} } },
  { type: "finish", finishReason: "tool-calls", usage: { outputTokens: 2 } },
  { type: "tool-result", result: { toolCallId: "c1", toolName: "clock", content: '"noon"', isError: false } },
  { type: "round", round: 2 },
  { type: "text-delta", text: "It is noon." },
  { type: "finish", finishReason: "stop", usage: { outputTokens: 3 } },
  {
    type: "turn-finish",
    reason: "stop",
    rounds: 2,
    usage: { outputTokens: 5 },
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "clock", arguments: {} }] },
      { role: "tool", toolCallId: "c1", toolName: "clock", content: '"noon"', isError: false },
      assistant("It is noon."),
    ],
  },
];

let store: MemoryGraphStore;
let counter: number;
/** A fixed clock and ids "id1", "id2", … so everything a graph writes is predictable. */
const opts = () => ({ clock: () => NOW, newId: () => `id${++counter}` });

beforeEach(() => {
  store = new MemoryGraphStore();
  counter = 0;
});

async function types(graphId: string): Promise<string[]> {
  return (await store.read(graphId)).map((record) => record.event.type);
}

async function code(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof CoreError ? error.code : error),
  );
}

describe("create and open", () => {
  it("opens the same state that create left, from the same store", async () => {
    const graph = await ProcessGraph.create(store, { ...opts(), title: "demo" });
    await graph.addMessage(graph.branchId("main"), user("hi"));
    const opened = await ProcessGraph.open(store, graph.id, opts());
    expect(opened.state).toEqual(graph.state);
    expect(opened.id).toBe(graph.id);
  });

  it("starts with an empty main branch and a stamped creation time", async () => {
    const graph = await ProcessGraph.create(store, { ...opts(), title: "demo" });
    expect(await types(graph.id)).toEqual(["graph-created", "branch-created"]);
    expect(graph.state).toMatchObject({ title: "demo", createdAt: AT, lastSeq: 2 });
    expect(graph.state.branches[graph.branchId("main")]).toMatchObject({ name: "main", from: null, head: null });
    expect(graph.conversation(graph.branchId("main"))).toEqual([]);
  });

  it("works with its default clock and ids", async () => {
    const first = await ProcessGraph.create(store);
    const second = await ProcessGraph.create(store);
    expect(first.id).not.toBe(second.id);
    expect(first.state.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await store.listGraphs()).toHaveLength(2);
  });

  it("throws not_found for an unknown graph", async () => {
    expect(await code(ProcessGraph.open(store, "nope", opts()))).toBe("not_found");
  });

  it("throws not_found for an unknown branch name", async () => {
    const graph = await ProcessGraph.create(store, opts());
    expect(() => graph.branchId("nope")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("writes", () => {
  it("builds the conversation, branches, merges and references, and logs each event in order", async () => {
    const graph = await ProcessGraph.create(store, opts());
    const main = graph.branchId("main");
    const n1 = await graph.addMessage(main, user("question"));
    const n2 = await graph.addMessage(main, assistant("answer"));

    const alt = await graph.branch("alt", n1, { replayOf: main });
    const alt1 = await graph.addMessage(alt, assistant("other answer"));
    const main3 = await graph.addMessage(main, user("follow-up"));

    const turnNodes = await graph.recordTurn(main, toolTurn);
    expect(turnNodes).toHaveLength(3);

    const merged = await graph.merge({ source: alt, target: main, strategy: "append" });
    const side = await graph.branch("side", n2);
    await graph.addMessage(side, user("aside"));
    const summary = await graph.merge({ source: side, target: main, strategy: "summary", message: assistant("the aside") });
    const ref = await graph.crossReference(n1, { graphId: "elsewhere", nodeId: "x" }, "see also");

    expect(texts(graph.conversation(alt))).toEqual(["question", "other answer"]);
    expect(texts(graph.conversation(main))).toEqual([
      "question",
      "answer",
      "follow-up",
      "",
      '"noon"',
      "It is noon.",
      "other answer",
      "the aside",
    ]);
    expect(graph.pathNodes(main).map((node) => node.id)).toEqual([
      n1,
      n2,
      main3,
      ...turnNodes,
      alt1,
      summary,
    ]);

    const { state } = graph;
    expect(state.branches[main]?.head).toBe(summary);
    expect(state.nodes[merged]).toMatchObject({ branchId: main, merge: { strategy: "append", sourceBranchId: alt } });
    expect(state.nodes[merged]?.parentIds).toEqual([turnNodes[2], alt1]);
    expect(state.nodes[summary]?.merge).toEqual({ strategy: "summary", sourceBranchId: side });
    expect(state.branches[alt]).toMatchObject({ from: n1, replayOf: main });
    expect(state.turns[state.nodes[turnNodes[0] as string]?.turnId as string]).toMatchObject({
      branchId: main,
      nodeIds: turnNodes,
      reason: "stop",
      model: { provider: "mock", model: "m1" },
    });
    expect(state.refs).toEqual([{ id: ref, from: n1, to: { graphId: "elsewhere", nodeId: "x" }, label: "see also" }]);

    expect(await types(graph.id)).toEqual([
      "graph-created",
      "branch-created",
      "message-added",
      "message-added",
      "branch-created",
      "message-added",
      "message-added",
      "turn-recorded",
      "branches-merged",
      "branch-created",
      "message-added",
      "branches-merged",
      "cross-referenced",
    ]);
    expect(state.lastSeq).toBe(13);
    expect((await ProcessGraph.open(store, graph.id, opts())).state).toEqual(state);
  });

  it("stamps every record with the clock", async () => {
    const graph = await ProcessGraph.create(store, opts());
    await graph.addMessage(graph.branchId("main"), user("hi"));
    expect((await store.read(graph.id)).map((record) => record.at)).toEqual([AT, AT, AT]);
  });

  it("returns node ids that exist in the state", async () => {
    const graph = await ProcessGraph.create(store, opts());
    const id = await graph.addMessage(graph.branchId("main"), user("hi"), { origin: { graphId: "other", nodeId: "o1" } });
    expect(graph.state.nodes[id]).toMatchObject({ origin: { graphId: "other", nodeId: "o1" } });
  });

  describe("an invalid write", () => {
    const cases: [string, (graph: ProcessGraph, main: string) => Promise<unknown>][] = [
      ["a message on an unknown branch", (graph) => graph.addMessage("nope", user("x"))],
      ["a turn on an unknown branch", (graph) => graph.recordTurn("nope", toolTurn)],
      ["a turn not ending in turn-finish", (graph, main) => graph.recordTurn(main, toolTurn.slice(0, -1))],
      ["an empty turn", (graph, main) => graph.recordTurn(main, [])],
      ["a branch from an unknown node", (graph) => graph.branch("b", "nope")],
      ["a branch with a taken name", (graph) => graph.branch("main", null)],
      [
        "an append merge with a message",
        async (graph, main) => {
          await graph.addMessage(main, user("a"));
          const other = await graph.branch("other", null);
          await graph.addMessage(other, user("b"));
          return graph.merge({ source: other, target: main, strategy: "append", message: assistant("x") } as never);
        },
      ],
      [
        "a summary merge without a message",
        async (graph, main) => {
          await graph.addMessage(main, user("a"));
          const other = await graph.branch("other", null);
          await graph.addMessage(other, user("b"));
          return graph.merge({ source: other, target: main, strategy: "summary" } as never);
        },
      ],
      ["a merge of a branch into itself", (graph, main) => graph.merge({ source: main, target: main, strategy: "append" })],
      ["a reference from an unknown node", (graph) => graph.crossReference("nope", { graphId: "g", nodeId: "n" })],
    ];

    it.each(cases)("%s throws bad_request and stores nothing", async (_name, write) => {
      const graph = await ProcessGraph.create(store, opts());
      const main = graph.branchId("main");
      // Some cases write setup messages first; the log must only ever grow by those, never by the failing write.
      const before = await store.read(graph.id);
      expect(await code(write(graph, main))).toBe("bad_request");
      const after = await store.read(graph.id);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.map((record) => record.event.type)).not.toContain("branches-merged");
      expect(after.map((record) => record.event.type)).not.toContain("turn-recorded");
      expect(graph.state.lastSeq).toBe(after.length);
    });
  });

  it("leaves the state and the log alone when a write is rejected", async () => {
    const graph = await ProcessGraph.create(store, opts());
    const before = graph.state;
    expect(await code(graph.addMessage("nope", user("x")))).toBe("bad_request");
    expect(graph.state).toBe(before);
    expect(await types(graph.id)).toEqual(["graph-created", "branch-created"]);
  });
});

describe("concurrent writers", () => {
  it("fails the stale writer with conflict, keeps its state, and succeeds after refresh", async () => {
    const first = await ProcessGraph.create(store, opts());
    const main = first.branchId("main");
    const second = await ProcessGraph.open(store, first.id, opts());

    await second.addMessage(main, user("from second"));

    const stale = first.state;
    expect(await code(first.addMessage(main, user("from first")))).toBe("conflict");
    expect(first.state).toBe(stale);
    expect(await types(first.id)).toHaveLength(3);

    await first.refresh();
    expect(texts(first.conversation(main))).toEqual(["from second"]);
    await first.addMessage(main, user("from first"));
    expect(texts(first.conversation(main))).toEqual(["from second", "from first"]);
    await second.refresh();
    expect(second.state).toEqual(first.state);
  });

  it("refresh with nothing new changes nothing", async () => {
    const graph = await ProcessGraph.create(store, opts());
    const before = graph.state;
    await graph.refresh();
    expect(graph.state).toBe(before);
  });
});

describe("state snapshots", () => {
  it("never changes a state read before a write", async () => {
    const graph = await ProcessGraph.create(store, opts());
    const main = graph.branchId("main");
    const n1 = await graph.addMessage(main, user("a"));
    const before = graph.state;
    const copy = structuredClone(before);

    await graph.addMessage(main, assistant("b"));
    const side = await graph.branch("side", n1);
    await graph.recordTurn(side, toolTurn);
    await graph.merge({ source: side, target: main, strategy: "append" });
    await graph.crossReference(n1, { graphId: "g", nodeId: "n" });

    expect(before).toEqual(copy);
    expect(graph.state).not.toBe(before);
    expect(graph.state.lastSeq).toBeGreaterThan(before.lastSeq);
  });
});

describe("fork", () => {
  it("copies a middle node's conversation into a new graph in the same store", async () => {
    const graph = await ProcessGraph.create(store, opts());
    const main = graph.branchId("main");
    const n1 = await graph.addMessage(main, user("one"));
    const n2 = await graph.addMessage(main, assistant("two"));
    await graph.addMessage(main, user("three"));
    const logBefore = await store.read(graph.id);
    const stateBefore = graph.state;

    const forked = await graph.fork(n2, { title: "what if" });

    expect(forked.id).not.toBe(graph.id);
    expect(forked.store).toBe(store);
    expect(forked.state).toMatchObject({ title: "what if", forkedFrom: { graphId: graph.id, nodeId: n2 } });
    const forkMain = forked.branchId("main");
    expect(texts(forked.conversation(forkMain))).toEqual(["one", "two"]);
    expect(forked.pathNodes(forkMain).map((node) => node.origin)).toEqual([
      { graphId: graph.id, nodeId: n1 },
      { graphId: graph.id, nodeId: n2 },
    ]);
    expect(await types(forked.id)).toEqual(["graph-created", "branch-created", "message-added", "message-added"]);

    expect(await store.read(graph.id)).toEqual(logBefore);
    expect(graph.state).toBe(stateBefore);
    expect((await ProcessGraph.open(store, forked.id, opts())).state).toEqual(forked.state);
    expect(await store.listGraphs()).toEqual([graph.id, forked.id]);
  });

  it("copies a merged path, summary node included, and the fork keeps growing on its own", async () => {
    const graph = await ProcessGraph.create(store, opts());
    const main = graph.branchId("main");
    const n1 = await graph.addMessage(main, user("one"));
    const side = await graph.branch("side", n1);
    await graph.addMessage(side, user("aside"));
    const appended = await graph.merge({ source: side, target: main, strategy: "append" });

    const forked = await graph.fork(appended);
    expect(texts(forked.conversation(forked.branchId("main")))).toEqual(texts(graph.conversation(main)));
    expect(forked.pathNodes(forked.branchId("main"))).toHaveLength(pathTo(graph.state, appended).length);

    await forked.addMessage(forked.branchId("main"), user("only in the fork"));
    expect(graph.state.lastSeq).toBe((await store.read(graph.id)).length);
    expect(texts(graph.conversation(main))).not.toContain("only in the fork");
  });

  it("throws not_found for an unknown node and stores nothing", async () => {
    const graph = await ProcessGraph.create(store, opts());
    expect(await code(graph.fork("nope"))).toBe("not_found");
    expect(await store.listGraphs()).toEqual([graph.id]);
  });
});
