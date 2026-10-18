import { describe, expect, it } from "vitest";
import {
  CoreError,
  GraphStateSchema,
  TurnEventSchema,
  type ApiErrorBody,
  type GraphEvent,
  type GraphEventRecord,
  type GraphState,
  type Message,
  type ModelRef,
  type NodeRef,
  type Principal,
  type TurnEvent,
} from "@core/contracts";
import { MemoryGraphStore } from "@core/graph";
import { MockProvider } from "@core/models";
import { PRINCIPAL, createTestHandler, createTestHandlerWith, get, post, readJson } from "./helpers.js";
import type { GraphAccess } from "../src/index.js";

const MODEL: ModelRef = { provider: "mock", model: "scripted" };
const USER = { role: "user", content: "hello" } as const;
const ANSWER = { role: "assistant", content: "hi back" } as const;

type WriteResult = { ids: string[]; state: GraphState };

/** A GraphAccess that records every call it gets and answers from plain sets and lists. */
class FakeAccess implements GraphAccess {
  readonly calls: { method: string; principal: Principal; graphId?: string }[] = [];
  readonly unreadable = new Set<string>();
  readonly unwritable = new Set<string>();
  listed: string[] = [];

  async canRead(principal: Principal, graphId: string): Promise<boolean> {
    this.calls.push({ method: "canRead", principal, graphId });
    return !this.unreadable.has(graphId);
  }
  async canWrite(principal: Principal, graphId: string): Promise<boolean> {
    this.calls.push({ method: "canWrite", principal, graphId });
    return !this.unwritable.has(graphId);
  }
  async created(principal: Principal, graphId: string): Promise<void> {
    this.calls.push({ method: "created", principal, graphId });
  }
  async list(principal: Principal): Promise<string[]> {
    this.calls.push({ method: "list", principal });
    return this.listed;
  }
  called(method: string): string[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.graphId ?? "");
  }
}

/** A MemoryGraphStore whose `append` can be told to throw, with the error the store contract names. */
class FlakyStore extends MemoryGraphStore {
  failWith: Error | undefined;
  override async append(graphId: string, expectedSeq: number, events: GraphEvent[], at: string): Promise<GraphEventRecord[]> {
    if (this.failWith !== undefined) throw this.failWith;
    return super.append(graphId, expectedSeq, events, at);
  }
}

function setup(store: MemoryGraphStore = new MemoryGraphStore()) {
  const access = new FakeAccess();
  const handler = createTestHandler({ graph: { store, access } });
  return { store, access, handler };
}
type Setup = ReturnType<typeof setup>;

async function createGraph({ handler }: Setup, title?: string): Promise<WriteResult> {
  const response = await handler.fetch(post("/v1/graphs", title === undefined ? {} : { title }));
  expect(response.status).toBe(200);
  return readJson<WriteResult>(response);
}

const mainOf = (state: GraphState) => {
  const main = Object.values(state.branches).find((branch) => branch.name === "main");
  if (main === undefined) throw new Error("no main branch");
  return main;
};

/** POSTs a write, expects 200, and returns the answer after checking that its state is a GraphState. */
async function write({ handler }: Setup, path: string, body: unknown): Promise<WriteResult> {
  const response = await handler.fetch(post(path, body));
  expect(response.status).toBe(200);
  const result = await readJson<WriteResult>(response);
  expect(GraphStateSchema.safeParse(result.state).success).toBe(true);
  return result;
}

async function stateOf({ handler }: Setup, graphId: string): Promise<GraphState> {
  const response = await handler.fetch(get(`/v1/graphs/${graphId}`));
  expect(response.status).toBe(200);
  return GraphStateSchema.parse(await readJson(response));
}

async function recordsOf({ handler }: Setup, graphId: string, query = ""): Promise<GraphEventRecord[]> {
  const response = await handler.fetch(get(`/v1/graphs/${graphId}/events${query}`));
  expect(response.status).toBe(200);
  return (await readJson<{ records: GraphEventRecord[] }>(response)).records;
}

const finish = (messages: Message[]): TurnEvent => ({
  type: "turn-finish",
  reason: "stop",
  rounds: 1,
  usage: { inputTokens: 1, outputTokens: 2 },
  messages,
});

function sseEvents(text: string): { event?: string; data?: string }[] {
  return text
    .split("\n\n")
    .filter((raw) => raw.trim() !== "")
    .map((raw) => {
      const frame: { event?: string; data?: string } = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
      }
      return frame;
    });
}

describe("graph routes: create and list", () => {
  it("creates a graph with a main branch, answers its id and calls access.created for it", async () => {
    const ctx = setup();
    const result = await write(ctx, "/v1/graphs", { title: "Plan" });
    expect(result.ids).toHaveLength(1);
    expect(result.state.graphId).toBe(result.ids[0]);
    expect(result.state.title).toBe("Plan");
    expect(mainOf(result.state).head).toBeNull();
    expect(ctx.access.calls.filter((call) => call.method === "created")).toEqual([
      { method: "created", principal: PRINCIPAL, graphId: result.ids[0] },
    ]);
  });

  it("lists exactly what access.list returns for the principal", async () => {
    const ctx = setup();
    ctx.access.listed = ["g-b", "g-a"];
    const response = await ctx.handler.fetch(get("/v1/graphs"));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ graphs: ["g-b", "g-a"] });
    expect(ctx.access.calls).toEqual([{ method: "list", principal: PRINCIPAL }]);
  });
});

describe("graph routes: access", () => {
  it("answers a graph the principal may not read exactly as a missing graph (404, byte-identical body)", async () => {
    const ctx = setup();
    const { ids } = await createGraph(ctx);
    const id = ids[0]!;
    ctx.access.unreadable.add(id);

    const denied = await ctx.handler.fetch(get(`/v1/graphs/${id}`));
    const missing = await ctx.handler.fetch(get("/v1/graphs/no-such-graph"));
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    const deniedText = await denied.text();
    expect(deniedText).toBe(await missing.text());
    const body = JSON.parse(deniedText) as ApiErrorBody;
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("graph not found");

    // The events route is a read as well.
    const deniedEvents = await ctx.handler.fetch(get(`/v1/graphs/${id}/events`));
    const missingEvents = await ctx.handler.fetch(get("/v1/graphs/no-such-graph/events"));
    expect(deniedEvents.status).toBe(404);
    expect(await deniedEvents.text()).toBe(await missingEvents.text());
  });

  it("answers a write the principal may not make exactly as a missing graph, and writes nothing", async () => {
    const ctx = setup();
    const { ids } = await createGraph(ctx);
    const id = ids[0]!;
    ctx.access.unwritable.add(id);
    const before = await recordsOf(ctx, id);

    const denied = await ctx.handler.fetch(post(`/v1/graphs/${id}/branches`, { name: "x", from: null }));
    const missing = await ctx.handler.fetch(post("/v1/graphs/no-such-graph/branches", { name: "x", from: null }));
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
    expect(await recordsOf(ctx, id)).toEqual(before);
    expect(ctx.access.called("canWrite")).toContain(id);

    // Reading is still allowed: canWrite and canRead are asked separately.
    expect((await ctx.handler.fetch(get(`/v1/graphs/${id}`))).status).toBe(200);
  });

  it("needs canRead, not canWrite, for GETs", async () => {
    const ctx = setup();
    const { ids } = await createGraph(ctx);
    const id = ids[0]!;
    ctx.access.unwritable.add(id);
    expect((await ctx.handler.fetch(get(`/v1/graphs/${id}`))).status).toBe(200);
    expect(ctx.access.called("canRead")).toContain(id);
    expect(ctx.access.called("canWrite")).not.toContain(id);
  });

  it("answers 404 not_found for every /v1/graphs path when options.graph is absent", async () => {
    const handler = createTestHandler();
    for (const request of [
      get("/v1/graphs"),
      post("/v1/graphs", {}),
      get("/v1/graphs/g1"),
      get("/v1/graphs/g1/events"),
      post("/v1/graphs/g1/branches", { name: "x", from: null }),
    ]) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(404);
      expect((await readJson<ApiErrorBody>(response)).error.code).toBe("not_found");
    }
  });
});

describe("graph routes: writes", () => {
  it("branch: answers the branch id and the state shows the branch", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const result = await write(ctx, `/v1/graphs/${created.graphId}/branches`, { name: "idea", from: null });
    expect(result.ids).toHaveLength(1);
    expect(result.state.branches[result.ids[0]!]).toMatchObject({ name: "idea", from: null, head: null });
    expect(Object.keys(result.state.branches)).toHaveLength(2);
    expect(result.state).toEqual(await stateOf(ctx, created.graphId));
  });

  it("message: answers the node id and the state shows the node as the branch head", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const main = mainOf(created);
    const result = await write(ctx, `/v1/graphs/${created.graphId}/messages`, { branchId: main.id, message: USER });
    const nodeId = result.ids[0]!;
    expect(result.ids).toHaveLength(1);
    expect(result.state.nodes[nodeId]).toMatchObject({ branchId: main.id, parentIds: [], message: USER });
    expect(result.state.branches[main.id]?.head).toBe(nodeId);
  });

  it("merge: summary and append answer the merge node id and the state shows the merge", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const gid = created.graphId;
    const main = mainOf(created);
    const root = (await write(ctx, `/v1/graphs/${gid}/messages`, { branchId: main.id, message: USER })).ids[0]!;
    const side = (await write(ctx, `/v1/graphs/${gid}/branches`, { name: "side", from: root })).ids[0]!;
    const other = (await write(ctx, `/v1/graphs/${gid}/branches`, { name: "other", from: root })).ids[0]!;
    const sideNode = (await write(ctx, `/v1/graphs/${gid}/messages`, { branchId: side, message: ANSWER })).ids[0]!;

    const summary = await write(ctx, `/v1/graphs/${gid}/merges`, {
      source: side,
      target: main.id,
      strategy: "summary",
      message: { role: "assistant", content: "side in short" },
    });
    expect(summary.ids).toHaveLength(1);
    const summaryNode = summary.state.nodes[summary.ids[0]!];
    expect(summaryNode).toMatchObject({
      branchId: main.id,
      parentIds: [root, sideNode],
      merge: { strategy: "summary", sourceBranchId: side },
      message: { role: "assistant", content: "side in short" },
    });
    expect(summary.state.branches[main.id]?.head).toBe(summary.ids[0]);

    const append = await write(ctx, `/v1/graphs/${gid}/merges`, { source: side, target: other, strategy: "append" });
    expect(append.ids).toHaveLength(1);
    const appendNode = append.state.nodes[append.ids[0]!];
    expect(appendNode?.merge).toEqual({ strategy: "append", sourceBranchId: side });
    expect(appendNode?.message).toBeUndefined();
    expect(append.state.branches[other]?.head).toBe(append.ids[0]);
  });

  it("cross-reference: answers the ref id and the state lists the reference with its label", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const gid = created.graphId;
    const node = (await write(ctx, `/v1/graphs/${gid}/messages`, { branchId: mainOf(created).id, message: USER })).ids[0]!;
    const to: NodeRef = { graphId: "other-graph", nodeId: "other-node" };

    const result = await write(ctx, `/v1/graphs/${gid}/cross-references`, { from: node, to, label: "see also" });
    expect(result.ids).toHaveLength(1);
    expect(result.state.refs).toEqual([{ id: result.ids[0], from: node, to, label: "see also" }]);
  });

  it("turn-records: answers one node id per message the turn added and the state shows the turn", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const gid = created.graphId;
    const main = mainOf(created);
    const events: TurnEvent[] = [{ type: "round", round: 1 }, finish([ANSWER])];

    const result = await write(ctx, `/v1/graphs/${gid}/turn-records`, { branchId: main.id, events });
    expect(result.ids).toHaveLength(1);
    expect(result.state.nodes[result.ids[0]!]).toMatchObject({ branchId: main.id, message: ANSWER });
    const turns = Object.values(result.state.turns);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ branchId: main.id, nodeIds: result.ids, reason: "stop", usage: { inputTokens: 1, outputTokens: 2 } });
    expect(result.state.branches[main.id]?.head).toBe(result.ids[0]);
  });

  it("answers 400 and appends nothing when one event of a turn-record is invalid", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const gid = created.graphId;
    const main = mainOf(created);
    const before = await recordsOf(ctx, gid);

    const events = [{ type: "round", round: 1 }, { type: "round", round: 0 }, finish([ANSWER])];
    const response = await ctx.handler.fetch(post(`/v1/graphs/${gid}/turn-records`, { branchId: main.id, events }));
    expect(response.status).toBe(400);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("bad_request");
    expect(await recordsOf(ctx, gid)).toEqual(before);
    expect(Object.keys((await stateOf(ctx, gid)).turns)).toHaveLength(0);
  });
});

describe("graph routes: engine errors", () => {
  it("keeps the engine's bad_request: a message on an unknown branch answers 400", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const response = await ctx.handler.fetch(post(`/v1/graphs/${created.graphId}/messages`, { branchId: "nope", message: USER }));
    expect(response.status).toBe(400);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("bad_request");
  });

  it("answers 400 bad_request for a body that is not the contract's shape", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const response = await ctx.handler.fetch(post(`/v1/graphs/${created.graphId}/branches`, { from: null }));
    expect(response.status).toBe(400);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("bad_request");
  });

  it("answers 409 conflict when the store's append throws conflict", async () => {
    const store = new FlakyStore();
    const ctx = setup(store);
    const { state: created } = await createGraph(ctx);
    store.failWith = new CoreError("conflict", "graph moved");

    const response = await ctx.handler.fetch(
      post(`/v1/graphs/${created.graphId}/messages`, { branchId: mainOf(created).id, message: USER }),
    );
    expect(response.status).toBe(409);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("conflict");
  });
});

describe("GET /v1/graphs/:id/events", () => {
  async function graphWithThreeRecords(ctx: Setup): Promise<string> {
    const { state } = await createGraph(ctx); // seq 1 graph-created, seq 2 branch-created main
    await write(ctx, `/v1/graphs/${state.graphId}/messages`, { branchId: mainOf(state).id, message: USER }); // seq 3
    return state.graphId;
  }

  it("returns every record by default and those after the given seq with ?after=", async () => {
    const ctx = setup();
    const gid = await graphWithThreeRecords(ctx);
    expect((await recordsOf(ctx, gid)).map((record) => record.seq)).toEqual([1, 2, 3]);
    const after = await recordsOf(ctx, gid, "?after=2");
    expect(after.map((record) => record.seq)).toEqual([3]);
    expect(after[0]?.event.type).toBe("message-added");
    expect(await recordsOf(ctx, gid, "?after=3")).toEqual([]);
    expect((await recordsOf(ctx, gid, "?after=0")).map((record) => record.seq)).toEqual([1, 2, 3]);
  });

  it("answers 400 bad_request for after=-1 and after=x", async () => {
    const ctx = setup();
    const gid = await graphWithThreeRecords(ctx);
    for (const after of ["-1", "x", "1.5"]) {
      const response = await ctx.handler.fetch(get(`/v1/graphs/${gid}/events?after=${after}`));
      expect(response.status, `after=${after}`).toBe(400);
      expect((await readJson<ApiErrorBody>(response)).error.code).toBe("bad_request");
    }
  });
});

describe("POST /v1/graphs/:id/forks", () => {
  it("answers a new graph id with the copied conversation and calls access.created for it", async () => {
    const ctx = setup();
    const { state: created } = await createGraph(ctx);
    const gid = created.graphId;
    const first = (await write(ctx, `/v1/graphs/${gid}/messages`, { branchId: mainOf(created).id, message: USER })).ids[0]!;

    const result = await write(ctx, `/v1/graphs/${gid}/forks`, { nodeId: first, title: "Branch off" });
    expect(result.ids).toHaveLength(1);
    const forkId = result.ids[0]!;
    expect(forkId).not.toBe(gid);
    expect(result.state).toMatchObject({ graphId: forkId, title: "Branch off", forkedFrom: { graphId: gid, nodeId: first } });
    const copied = Object.values(result.state.nodes);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ message: USER, origin: { graphId: gid, nodeId: first } });

    expect(ctx.access.called("created")).toEqual([gid, forkId]);
    expect(await stateOf(ctx, forkId)).toEqual(result.state);
    // The source graph got no event from the fork.
    expect(await recordsOf(ctx, gid)).toHaveLength(3);
  });
});

describe("POST /v1/graphs/:id/turns", () => {
  it("streams the turn's events as event: turn frames, ends with turn-finish, and records the turn on the branch", async () => {
    const provider = new MockProvider({ id: "mock", script: [{ text: "hi back", chunkSize: 3 }], echo: false });
    const access = new FakeAccess();
    const store = new MemoryGraphStore();
    const handler = createTestHandlerWith([provider], { graph: { store, access } });
    const ctx = { store, access, handler };
    const { state: created } = await createGraph(ctx);
    const gid = created.graphId;
    const main = mainOf(created);

    const response = await handler.fetch(post(`/v1/graphs/${gid}/turns`, { branchId: main.id, input: USER, route: [MODEL] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = sseEvents(await response.text());
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.event === "turn")).toBe(true);
    const events = frames.map((frame) => TurnEventSchema.parse(JSON.parse(frame.data ?? "null")));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "turn-finish", reason: "stop" });
    expect(events.filter((event) => event.type === "turn-finish")).toHaveLength(1);

    const state = await stateOf(ctx, gid);
    const turns = Object.values(state.turns);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ branchId: main.id, reason: "stop" });
    // The input and the answer are both on the branch.
    const messages = turns[0]!.nodeIds.map((id) => state.nodes[id]?.message);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "hi back" });
    expect(state.branches[main.id]?.head).toBe(turns[0]!.nodeIds.at(-1));
    expect(access.called("canWrite")).toContain(gid);
  });

  it("answers an unknown branch as a JSON error before any stream starts", async () => {
    const provider = new MockProvider({ id: "mock", script: [{ text: "unused" }], echo: false });
    const store = new MemoryGraphStore();
    const handler = createTestHandlerWith([provider], { graph: { store, access: new FakeAccess() } });
    const { state } = await createGraph({ store, access: new FakeAccess(), handler });
    const response = await handler.fetch(post(`/v1/graphs/${state.graphId}/turns`, { branchId: "nope", input: USER, route: [MODEL] }));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.status).toBe(404);
    expect((await readJson<ApiErrorBody>(response)).error.code).toBe("not_found");
  });
});
