import { describe, expect, it } from "vitest";
import type { GraphEvent, GraphEventRecord, Message, TurnEvent } from "@core/contracts";
import { conversation, pathNodes, pathTo, project } from "../src/index.js";

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

const add = (nodeId: string, branchId: string, message: Message): GraphEvent => ({ type: "message-added", nodeId, branchId, message });
const branch = (branchId: string, from: string | null): GraphEvent => ({ type: "branch-created", branchId, name: branchId, from });
const contents = (messages: Message[]) => messages.map((message) => message.content);

/** main: q1 a1 q2 a2, with a1 recorded by a turn. */
const trunk: GraphEvent[] = [
  { type: "graph-created" },
  branch("main", null),
  add("q1", "main", user("q1")),
  { type: "turn-recorded", turnId: "t1", branchId: "main", nodeIds: ["a1"], events: turnEvents([assistant("a1")]) },
  add("q2", "main", user("q2")),
  add("a2", "main", assistant("a2")),
];

describe("conversation", () => {
  it("is the messages of a plain branch, in order", () => {
    expect(contents(conversation(project(log(trunk)), "main"))).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("shares the prefix with a branch created from a middle node", () => {
    const state = project(log([...trunk, branch("side", "a1"), add("s1", "side", user("s1"))]));
    expect(contents(conversation(state, "side"))).toEqual(["q1", "a1", "s1"]);
    expect(contents(conversation(state, "main"))).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("continues an append merge with what the source added, without repeating the shared prefix", () => {
    const state = project(
      log([
        ...trunk,
        branch("side", "a1"),
        add("s1", "side", user("s1")),
        add("s2", "side", assistant("s2")),
        { type: "branches-merged", nodeId: "m1", sourceBranchId: "side", targetBranchId: "main", strategy: "append" },
      ]),
    );
    expect(contents(conversation(state, "main"))).toEqual(["q1", "a1", "q2", "a2", "s1", "s2"]);
    expect(pathNodes(state, "main").map((node) => node.id)).not.toContain("m1");
  });

  it("continues a summary merge with the summary message", () => {
    const state = project(
      log([
        ...trunk,
        branch("side", "a1"),
        add("s1", "side", user("s1")),
        { type: "branches-merged", nodeId: "m1", sourceBranchId: "side", targetBranchId: "main", strategy: "summary", message: assistant("summary") },
      ]),
    );
    expect(contents(conversation(state, "main"))).toEqual(["q1", "a1", "q2", "a2", "summary"]);
  });

  it("follows a merge of a branch that itself contains a merge", () => {
    const state = project(
      log([
        ...trunk,
        branch("inner", "q1"),
        add("i1", "inner", user("i1")),
        branch("outer", "a1"),
        add("o1", "outer", user("o1")),
        { type: "branches-merged", nodeId: "m1", sourceBranchId: "inner", targetBranchId: "outer", strategy: "append" },
        add("o2", "outer", user("o2")),
        { type: "branches-merged", nodeId: "m2", sourceBranchId: "outer", targetBranchId: "main", strategy: "append" },
      ]),
    );
    expect(contents(conversation(state, "outer"))).toEqual(["q1", "a1", "o1", "i1", "o2"]);
    expect(contents(conversation(state, "main"))).toEqual(["q1", "a1", "q2", "a2", "o1", "i1", "o2"]);
  });

  it("is empty for a branch whose head is null", () => {
    const state = project(log([...trunk, branch("empty", null)]));
    expect(conversation(state, "empty")).toEqual([]);
    expect(pathNodes(state, "empty")).toEqual([]);
  });

  it("throws not_found for an unknown branch", () => {
    const state = project(log(trunk));
    expect(() => conversation(state, "nope")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => pathNodes(state, "nope")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("pathTo", () => {
  it("is the path up to a middle node", () => {
    expect(pathTo(project(log(trunk)), "a1").map((node) => node.id)).toEqual(["q1", "a1"]);
  });

  it("is empty for null", () => {
    expect(pathTo(project(log(trunk)), null)).toEqual([]);
  });

  it("throws not_found for an unknown node", () => {
    expect(() => pathTo(project(log(trunk)), "nope")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});
