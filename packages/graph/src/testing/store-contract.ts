import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreError, type GraphEvent, type TurnEvent } from "@core/contracts";
import type { GraphStore } from "../store.js";

const T1 = "2026-10-14T10:00:00.000Z";
const T2 = "2026-10-14T11:00:00.000Z";
const T3 = "2026-10-14T12:00:00.000Z";

const TEXT = "naïve — 日本語 ✓";

/** A whole turn with a tool call and non-ASCII text, as `runTurn` emits it. */
const FULL_TURN: TurnEvent[] = [
  { type: "round", round: 1 },
  { type: "route", model: { provider: "mock", model: "m1" }, attempt: 1 },
  { type: "text-delta", text: TEXT },
  { type: "tool-call", toolCall: { id: "call-1", name: "lookup", arguments: { query: TEXT, limit: 3 } } },
  { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 4 } },
  { type: "tool-result", result: { toolCallId: "call-1", toolName: "lookup", content: JSON.stringify({ hit: TEXT }), isError: false } },
  { type: "round", round: 2 },
  { type: "route", model: { provider: "mock", model: "m1" }, attempt: 1 },
  { type: "text-delta", text: "done" },
  { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 2 } },
  {
    type: "turn-finish",
    reason: "stop",
    rounds: 2,
    usage: { inputTokens: 32, outputTokens: 6 },
    messages: [
      { role: "assistant", content: TEXT, toolCalls: [{ id: "call-1", name: "lookup", arguments: { query: TEXT, limit: 3 } }] },
      { role: "tool", toolCallId: "call-1", toolName: "lookup", content: JSON.stringify({ hit: TEXT }), isError: false },
      { role: "assistant", content: "done" },
    ],
  },
];

/** One event of every type. Stores do not interpret events, so the log need not be a valid graph. */
const EVERY_EVENT: GraphEvent[] = [
  { type: "graph-created", title: TEXT, forkedFrom: { graphId: "g0", nodeId: "n0" } },
  { type: "branch-created", branchId: "b1", name: "main", from: null, replayOf: "b0" },
  { type: "message-added", nodeId: "n1", branchId: "b1", message: { role: "user", content: TEXT }, origin: { graphId: "g0", nodeId: "n0" } },
  { type: "turn-recorded", turnId: "t1", branchId: "b1", nodeIds: ["n2", "n3", "n4"], events: FULL_TURN },
  {
    type: "branches-merged",
    nodeId: "n5",
    sourceBranchId: "b2",
    targetBranchId: "b1",
    strategy: "summary",
    message: { role: "assistant", content: TEXT },
  },
  { type: "cross-referenced", refId: "r1", from: "n1", to: { graphId: "g9", nodeId: "x" }, label: TEXT },
];

const created = (title: string): GraphEvent => ({ type: "graph-created", title });
const message = (nodeId: string): GraphEvent => ({
  type: "message-added",
  nodeId,
  branchId: "b1",
  message: { role: "user", content: nodeId },
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(CoreError.is(error), "expected a CoreError").toBe(true);
  expect((error as CoreError).code).toBe(code);
}

/**
 * Registers a vitest `describe(name, …)` that checks a `GraphStore` against the contract every
 * store must meet. Each test gets a fresh store from `makeStore`, closed afterwards when `close` is given.
 */
export function describeGraphStoreContract(
  name: string,
  makeStore: () => Promise<{ store: GraphStore; close?: () => Promise<void> }>,
): void {
  describe(name, () => {
    let store: GraphStore;
    let close: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const made = await makeStore();
      store = made.store;
      close = made.close;
    });

    afterEach(async () => {
      await close?.();
      close = undefined;
    });

    it("reads an unknown graph as [] and lists no graphs when empty", async () => {
      expect(await store.read("nope")).toEqual([]);
      expect(await store.listGraphs()).toEqual([]);
    });

    it("numbers a new graph's records from 1 and reads them back in order", async () => {
      const events = [created("one"), message("n1"), message("n2")];
      const records = await store.append("g1", 0, events, T1);
      expect(records).toEqual(events.map((event, index) => ({ graphId: "g1", seq: index + 1, at: T1, event })));
      expect(await store.read("g1")).toEqual(records);
      expect(await store.read("g1", 1)).toEqual(records.slice(1));
      expect(await store.read("g1", 3)).toEqual([]);
    });

    it("continues the seq on a later append", async () => {
      await store.append("g1", 0, [created("one")], T1);
      const later = await store.append("g1", 1, [message("n1")], T2);
      expect(later).toEqual([{ graphId: "g1", seq: 2, at: T2, event: message("n1") }]);
      expect((await store.read("g1")).map((record) => record.seq)).toEqual([1, 2]);
    });

    it("rejects a stale expectedSeq with conflict and writes nothing", async () => {
      await store.append("g1", 0, [created("one"), message("n1")], T1);
      const before = await store.read("g1");
      await expectCode(store.append("g1", 1, [message("n2")], T2), "conflict");
      await expectCode(store.append("g1", 0, [message("n2")], T2), "conflict");
      expect(await store.read("g1")).toEqual(before);
    });

    it("rejects an expectedSeq ahead of the log with conflict and writes nothing", async () => {
      await expectCode(store.append("g1", 1, [created("one")], T1), "conflict");
      expect(await store.read("g1")).toEqual([]);
      await store.append("g1", 0, [created("one")], T1);
      await expectCode(store.append("g1", 5, [message("n1")], T2), "conflict");
      expect(await store.read("g1")).toHaveLength(1);
    });

    it("lets exactly one of two racing appends win", async () => {
      await store.append("g1", 0, [created("one")], T1);
      const results = await Promise.allSettled([
        store.append("g1", 1, [message("a1"), message("a2")], T2),
        store.append("g1", 1, [message("b1")], T2),
      ]);
      const won = results.filter((result) => result.status === "fulfilled");
      const lost = results.filter((result) => result.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const reason = (lost[0] as PromiseRejectedResult).reason as unknown;
      expect(CoreError.is(reason) && reason.code).toBe("conflict");
      const log = await store.read("g1");
      expect(log.slice(1)).toEqual((won[0] as PromiseFulfilledResult<unknown>).value);
      expect(log.map((record) => record.seq)).toEqual(log.map((_, index) => index + 1));
    });

    it("rejects an empty append with bad_request", async () => {
      await expectCode(store.append("g1", 0, [], T1), "bad_request");
      expect(await store.read("g1")).toEqual([]);
      expect(await store.listGraphs()).toEqual([]);
    });

    it("keeps graphs independent, each with its own seq from 1", async () => {
      await store.append("g1", 0, [created("one"), message("n1")], T1);
      await store.append("g2", 0, [created("two")], T2);
      await store.append("g2", 1, [message("n1")], T2);
      expect((await store.read("g1")).map((record) => [record.graphId, record.seq])).toEqual([
        ["g1", 1],
        ["g1", 2],
      ]);
      expect((await store.read("g2")).map((record) => [record.graphId, record.seq])).toEqual([
        ["g2", 1],
        ["g2", 2],
      ]);
    });

    it("lists graphs oldest first, then by id", async () => {
      await store.append("c", 0, [created("c")], T3);
      await store.append("b", 0, [created("b")], T1);
      await store.append("d", 0, [created("d")], T2);
      await store.append("a", 0, [created("a")], T3);
      await store.append("b", 1, [message("late")], "2026-10-15T00:00:00.000Z");
      expect(await store.listGraphs()).toEqual(["b", "d", "a", "c"]);
    });

    it("round-trips one record of every event type deep-equal", async () => {
      const records = await store.append("g1", 0, EVERY_EVENT, T1);
      const read = await store.read("g1");
      expect(read).toEqual(records);
      expect(read.map((record) => record.event)).toEqual(EVERY_EVENT);
    });
  });
}
