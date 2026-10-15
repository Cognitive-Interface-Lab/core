import { describe, expect, it } from "vitest";
import {
  ErrorCodeSchema,
  GraphEventRecordSchema,
  GraphEventSchema,
  GraphStateSchema,
  isRetryableCode,
  type GraphEvent,
  type TurnEvent,
} from "../src/index.js";

const AT = "2026-10-14T12:00:00.000Z";

/** A whole turn: a tool call, its result, then the final answer. */
const fullTurn: TurnEvent[] = [
  { type: "round", round: 1 },
  { type: "route", model: { provider: "mock", model: "m1" }, attempt: 1 },
  { type: "text-delta", text: "Let me check." },
  { type: "tool-call", toolCall: { id: "call-1", name: "clock", arguments: { zone: "UTC" } } },
  { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 4 } },
  { type: "tool-result", result: { toolCallId: "call-1", toolName: "clock", content: '"12:00"', isError: false } },
  { type: "round", round: 2 },
  { type: "route", model: { provider: "mock", model: "m1" }, attempt: 1 },
  { type: "text-delta", text: "It is noon." },
  { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 5 } },
  {
    type: "turn-finish",
    reason: "stop",
    rounds: 2,
    usage: { inputTokens: 30, outputTokens: 9 },
    messages: [
      {
        role: "assistant",
        content: "Let me check.",
        toolCalls: [{ id: "call-1", name: "clock", arguments: { zone: "UTC" } }],
      },
      { role: "tool", toolCallId: "call-1", toolName: "clock", content: '"12:00"', isError: false },
      { role: "assistant", content: "It is noon." },
    ],
  },
];

const variants: GraphEvent[] = [
  { type: "graph-created", title: "demo", forkedFrom: { graphId: "g0", nodeId: "n0" } },
  { type: "branch-created", branchId: "b1", name: "main", from: null },
  { type: "branch-created", branchId: "b2", name: "replay", from: "n1", replayOf: "b1" },
  { type: "message-added", nodeId: "n1", branchId: "b1", message: { role: "user", content: "hi" } },
  {
    type: "message-added",
    nodeId: "n2",
    branchId: "b1",
    message: { role: "system", content: "be brief" },
    origin: { graphId: "g0", nodeId: "n0" },
  },
  { type: "turn-recorded", turnId: "t1", branchId: "b1", nodeIds: ["n3", "n4", "n5"], events: fullTurn },
  { type: "branches-merged", nodeId: "n6", sourceBranchId: "b2", targetBranchId: "b1", strategy: "append" },
  {
    type: "branches-merged",
    nodeId: "n7",
    sourceBranchId: "b2",
    targetBranchId: "b1",
    strategy: "summary",
    message: { role: "assistant", content: "In short: yes." },
  },
  { type: "cross-referenced", refId: "r1", from: "n1", to: { graphId: "g2", nodeId: "x" }, label: "see also" },
];

describe("GraphEventSchema", () => {
  it.each(variants.map((event) => [event.type, event] as const))("parses a %s event", (_type, event) => {
    expect(GraphEventSchema.parse(event)).toEqual(event);
  });

  it("covers all six event types", () => {
    expect(new Set(variants.map((event) => event.type)).size).toBe(6);
  });

  it("rejects an unknown type", () => {
    expect(GraphEventSchema.safeParse({ type: "node-deleted", nodeId: "n1" }).success).toBe(false);
  });

  it("round-trips a recorded full turn through JSON unchanged", () => {
    const event: GraphEvent = { type: "turn-recorded", turnId: "t1", branchId: "b1", nodeIds: ["n3", "n4", "n5"], events: fullTurn };
    expect(GraphEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("accepts a branch from nothing but requires from", () => {
    expect(GraphEventSchema.safeParse({ type: "branch-created", branchId: "b1", name: "main", from: null }).success).toBe(true);
    expect(GraphEventSchema.safeParse({ type: "branch-created", branchId: "b1", name: "main" }).success).toBe(false);
  });
});

describe("GraphEventRecordSchema", () => {
  const record = { graphId: "g1", seq: 1, at: AT, event: { type: "graph-created" } };

  it("parses a record", () => {
    expect(GraphEventRecordSchema.parse(record)).toEqual(record);
  });

  it.each([
    ["seq 0", { seq: 0 }],
    ["a non-integer seq", { seq: 1.5 }],
    ["an empty graphId", { graphId: "" }],
    ["a non-ISO at", { at: "yesterday" }],
  ])("rejects %s", (_name, change) => {
    expect(GraphEventRecordSchema.safeParse({ ...record, ...change }).success).toBe(false);
  });
});

describe("GraphStateSchema", () => {
  it("parses a small state with a merge node and no message", () => {
    const state = {
      graphId: "g1",
      title: "demo",
      createdAt: AT,
      lastSeq: 5,
      branches: { b1: { id: "b1", name: "main", from: null, head: "n2" } },
      nodes: {
        n1: { id: "n1", branchId: "b1", parentIds: [], message: { role: "user", content: "hi" }, turnId: "t1" },
        n2: { id: "n2", branchId: "b1", parentIds: ["n1", "n0"], merge: { strategy: "append", sourceBranchId: "b2" } },
      },
      turns: {
        t1: {
          id: "t1",
          branchId: "b1",
          nodeIds: ["n1"],
          reason: "stop",
          model: { provider: "mock", model: "m1" },
          usage: { outputTokens: 3 },
        },
      },
      refs: [{ id: "r1", from: "n1", to: { graphId: "g2", nodeId: "x" } }],
    };
    expect(GraphStateSchema.parse(state)).toEqual(state);
  });
});

describe("the conflict error code", () => {
  it("is a known code and not retryable", () => {
    expect(ErrorCodeSchema.safeParse("conflict").success).toBe(true);
    expect(isRetryableCode("conflict")).toBe(false);
  });
});
