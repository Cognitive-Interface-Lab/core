import { describe, expect, it } from "vitest";
import { CoreError, type GraphEvent, type GraphEventRecord, type GraphState, type Message, type TurnEvent } from "@core/contracts";
import { applyEvent, emptyState, project } from "../src/index.js";

const AT = "2026-10-14T12:00:00.000Z";

/** Numbers events as one graph's log from seq 1. */
function log(events: GraphEvent[], graphId = "g1"): GraphEventRecord[] {
  return events.map((event, index) => ({ graphId, seq: index + 1, at: AT, event }));
}

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

/** A minimal turn that added `messages`, routed to `model`. */
function turnEvents(messages: Message[], model = "m1"): TurnEvent[] {
  return [
    { type: "round", round: 1 },
    { type: "route", model: { provider: "mock", model }, attempt: 1 },
    { type: "finish", finishReason: "stop", usage: { outputTokens: 1 } },
    { type: "turn-finish", reason: "stop", rounds: 1, usage: { outputTokens: 1 }, messages },
  ];
}

const toolTurn: TurnEvent[] = [
  { type: "round", round: 1 },
  { type: "route", model: { provider: "mock", model: "first" }, attempt: 1 },
  { type: "tool-call", toolCall: { id: "c1", name: "clock", arguments: {} } },
  { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 2 } },
  { type: "tool-result", result: { toolCallId: "c1", toolName: "clock", content: '"noon"', isError: false } },
  { type: "round", round: 2 },
  { type: "route", model: { provider: "mock", model: "second" }, attempt: 2 },
  { type: "text-delta", text: "It is noon." },
  { type: "finish", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 3 } },
  {
    type: "turn-finish",
    reason: "stop",
    rounds: 2,
    usage: { inputTokens: 14, outputTokens: 5 },
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "clock", arguments: {} }] },
      { role: "tool", toolCallId: "c1", toolName: "clock", content: '"noon"', isError: false },
      assistant("It is noon."),
    ],
  },
];

const base: GraphEvent[] = [
  { type: "graph-created", title: "demo" },
  { type: "branch-created", branchId: "main", name: "main", from: null },
  { type: "message-added", nodeId: "n1", branchId: "main", message: { role: "system", content: "be brief" } },
  { type: "message-added", nodeId: "n2", branchId: "main", message: user("what time is it?") },
  { type: "turn-recorded", turnId: "t1", branchId: "main", nodeIds: ["n3", "n4", "n5"], events: toolTurn },
];

describe("project", () => {
  it("builds nodes, parents, heads and the turn summary", () => {
    const state = project(log(base));
    expect(state.graphId).toBe("g1");
    expect(state.title).toBe("demo");
    expect(state.createdAt).toBe(AT);
    expect(state.lastSeq).toBe(5);
    expect(state.branches["main"]).toEqual({ id: "main", name: "main", from: null, head: "n5" });
    expect(Object.values(state.nodes).map((node) => [node.id, node.parentIds])).toEqual([
      ["n1", []],
      ["n2", ["n1"]],
      ["n3", ["n2"]],
      ["n4", ["n3"]],
      ["n5", ["n4"]],
    ]);
    for (const id of ["n3", "n4", "n5"]) expect(state.nodes[id]?.turnId).toBe("t1");
    expect(state.nodes["n2"]?.turnId).toBeUndefined();
    expect(state.nodes["n4"]?.message?.role).toBe("tool");
    expect(state.turns["t1"]).toEqual({
      id: "t1",
      branchId: "main",
      nodeIds: ["n3", "n4", "n5"],
      reason: "stop",
      model: { provider: "mock", model: "second" },
      usage: { inputTokens: 14, outputTokens: 5 },
    });
  });

  it("throws not_found for an empty log", () => {
    expect(() => project([])).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("records a failed turn without messages as a summary and no node", () => {
    const failed: TurnEvent[] = [
      { type: "round", round: 1 },
      { type: "error", error: { code: "unavailable", message: "down", retryable: true } },
      { type: "turn-finish", reason: "error", rounds: 1, usage: {}, messages: [] },
    ];
    const state = project(log([...base, { type: "turn-recorded", turnId: "t2", branchId: "main", nodeIds: [], events: failed }]));
    expect(state.turns["t2"]).toEqual({ id: "t2", branchId: "main", nodeIds: [], reason: "error", usage: {} });
    expect(Object.keys(state.nodes)).toHaveLength(5);
    expect(state.branches["main"]?.head).toBe("n5");
  });

  it("records merges with two parents and moves only the target head", () => {
    const state = project(
      log([
        ...base,
        { type: "branch-created", branchId: "side", name: "side", from: "n2" },
        { type: "message-added", nodeId: "s1", branchId: "side", message: user("aside") },
        { type: "branches-merged", nodeId: "m1", sourceBranchId: "side", targetBranchId: "main", strategy: "append" },
        { type: "cross-referenced", refId: "r1", from: "m1", to: { graphId: "elsewhere", nodeId: "unknown" }, label: "x" },
      ]),
    );
    expect(state.nodes["m1"]).toEqual({
      id: "m1",
      branchId: "main",
      parentIds: ["n5", "s1"],
      merge: { strategy: "append", sourceBranchId: "side" },
    });
    expect(state.branches["main"]?.head).toBe("m1");
    expect(state.branches["side"]?.head).toBe("s1");
    expect(state.refs).toEqual([{ id: "r1", from: "m1", to: { graphId: "elsewhere", nodeId: "unknown" }, label: "x" }]);
  });

  it("starts a branch at its from node", () => {
    const state = project(log([...base, { type: "branch-created", branchId: "b2", name: "b2", from: "n2", replayOf: "main" }]));
    expect(state.branches["b2"]).toEqual({ id: "b2", name: "b2", from: "n2", head: "n2", replayOf: "main" });
  });
});

describe("applyEvent refuses an event that would corrupt the graph", () => {
  const state = project(
    log([
      ...base,
      { type: "branch-created", branchId: "side", name: "side", from: "n2" },
      { type: "message-added", nodeId: "s1", branchId: "side", message: user("aside") },
      { type: "branch-created", branchId: "empty", name: "empty", from: null },
      { type: "cross-referenced", refId: "r1", from: "n1", to: { graphId: "g1", nodeId: "n2" } },
    ]),
  );
  const next = (event: GraphEvent): GraphEventRecord => ({ graphId: "g1", seq: state.lastSeq + 1, at: AT, event });
  const message = (nodeId: string, branchId = "main"): GraphEvent => ({ type: "message-added", nodeId, branchId, message: user("x") });
  const turn = (overrides: Partial<Extract<GraphEvent, { type: "turn-recorded" }>>): GraphEvent => ({
    type: "turn-recorded",
    turnId: "t9",
    branchId: "main",
    nodeIds: ["a1"],
    events: turnEvents([assistant("a")]),
    ...overrides,
  });
  const merge = (overrides: Partial<Extract<GraphEvent, { type: "branches-merged" }>>): GraphEvent => ({
    type: "branches-merged",
    nodeId: "m9",
    sourceBranchId: "side",
    targetBranchId: "main",
    strategy: "append",
    ...overrides,
  });

  const cases: [string, GraphEventRecord][] = [
    ["a record of another graph", { ...next(message("x1")), graphId: "g2" }],
    ["a seq that skips one", { ...next(message("x1")), seq: state.lastSeq + 2 }],
    ["a repeated seq", { ...next(message("x1")), seq: state.lastSeq }],
    ["graph-created after seq 1", next({ type: "graph-created" })],
    ["a duplicate branch id", next({ type: "branch-created", branchId: "side", name: "other", from: null })],
    ["a duplicate branch name", next({ type: "branch-created", branchId: "b9", name: "side", from: null })],
    ["a branch from an unknown node", next({ type: "branch-created", branchId: "b9", name: "b9", from: "nope" })],
    ["a message on an unknown branch", next(message("x1", "nope"))],
    ["a duplicate node id", next(message("n1"))],
    ["a turn on an unknown branch", next(turn({ branchId: "nope" }))],
    ["a duplicate turn id", next(turn({ turnId: "t1" }))],
    ["a turn not ending in turn-finish", next(turn({ events: turnEvents([assistant("a")]).slice(0, -1) }))],
    ["node ids that do not match the messages", next(turn({ nodeIds: ["a1", "a2"] }))],
    ["a turn reusing an existing node id", next(turn({ nodeIds: ["n1"] }))],
    ["a turn repeating a node id", next(turn({ nodeIds: ["a1", "a1"], events: turnEvents([assistant("a"), assistant("b")]) }))],
    ["a merge from an unknown branch", next(merge({ sourceBranchId: "nope" }))],
    ["a merge into an unknown branch", next(merge({ targetBranchId: "nope" }))],
    ["a merge of a branch into itself", next(merge({ sourceBranchId: "main" }))],
    ["a merge from an empty branch", next(merge({ sourceBranchId: "empty" }))],
    ["a merge into an empty branch", next(merge({ targetBranchId: "empty" }))],
    ["a merge reusing a node id", next(merge({ nodeId: "n1" }))],
    ["a summary merge without a message", next(merge({ strategy: "summary" }))],
    ["an append merge with a message", next(merge({ message: assistant("sum") }))],
    ["a duplicate reference id", next({ type: "cross-referenced", refId: "r1", from: "n1", to: { graphId: "g1", nodeId: "n2" } })],
    ["a reference from an unknown node", next({ type: "cross-referenced", refId: "r2", from: "nope", to: { graphId: "g1", nodeId: "n2" } })],
    ["a reference to an unknown node of this graph", next({ type: "cross-referenced", refId: "r2", from: "n1", to: { graphId: "g1", nodeId: "nope" } })],
  ];

  it.each(cases)("throws bad_request for %s and leaves the state unchanged", (_name, record) => {
    const before = structuredClone(state);
    let thrown: unknown;
    try {
      applyEvent(state, record);
    } catch (error) {
      thrown = error;
    }
    expect(CoreError.is(thrown) && thrown.code).toBe("bad_request");
    expect(state).toEqual(before);
  });

  it("throws bad_request when seq 1 is not graph-created", () => {
    const record: GraphEventRecord = { graphId: "g1", seq: 1, at: AT, event: { type: "branch-created", branchId: "b", name: "b", from: null } };
    expect(() => applyEvent(emptyState("g1"), record)).toThrow(expect.objectContaining({ code: "bad_request" }));
  });

  it("never mutates the state it is given, even on success", () => {
    const before = structuredClone(state);
    const after: GraphState = applyEvent(state, next(message("x1")));
    expect(state).toEqual(before);
    expect(after.nodes["x1"]).toBeDefined();
    expect(after.lastSeq).toBe(state.lastSeq + 1);
  });
});
