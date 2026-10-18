import {
  BranchCreateSchema,
  BranchTurnCallSchema,
  CoreError,
  CrossReferenceCallSchema,
  ForkCallSchema,
  GraphCreateSchema,
  MergeCallSchema,
  MessageAddSchema,
  TurnRecordSchema,
  type Principal,
} from "@core/contracts";
import { ProcessGraph, type GraphStore } from "@core/graph";
import { runBranchTurn } from "@core/runtime";
import { ToolRegistry } from "@core/tools";
import { jsonResponse } from "../errors.js";
import type { GraphAccess, RouteDeps, RouteModule } from "../handler.js";
import { turnStream } from "./turns.js";

type Graphs = { store: GraphStore; access: GraphAccess };

export const graphs: RouteModule = {
  specs: [
    { method: "GET", path: "/v1/graphs", summary: "The ids of the graphs this principal may read", answer: "GraphList" },
    {
      method: "POST",
      path: "/v1/graphs",
      summary: "A new graph with an empty main branch",
      body: "GraphCreate",
      answer: "GraphWriteResult",
    },
    { method: "GET", path: "/v1/graphs/:id", summary: "The state of a graph", answer: "GraphState" },
    {
      method: "GET",
      path: "/v1/graphs/:id/events",
      summary: "The event records of a graph after a sequence number",
      answer: "GraphEvents",
    },
    {
      method: "POST",
      path: "/v1/graphs/:id/branches",
      summary: "A new branch in a graph",
      body: "BranchCreate",
      answer: "GraphWriteResult",
    },
    {
      method: "POST",
      path: "/v1/graphs/:id/messages",
      summary: "A message added to a branch",
      body: "MessageAdd",
      answer: "GraphWriteResult",
    },
    {
      method: "POST",
      path: "/v1/graphs/:id/merges",
      summary: "A branch merged into another",
      body: "MergeCall",
      answer: "GraphWriteResult",
    },
    {
      method: "POST",
      path: "/v1/graphs/:id/cross-references",
      summary: "A reference from a node to any node",
      body: "CrossReferenceCall",
      answer: "GraphWriteResult",
    },
    {
      method: "POST",
      path: "/v1/graphs/:id/turn-records",
      summary: "A turn recorded on a branch",
      body: "TurnRecord",
      answer: "GraphWriteResult",
    },
    {
      method: "POST",
      path: "/v1/graphs/:id/forks",
      summary: "A new graph holding the conversation up to a node",
      body: "ForkCall",
      answer: "GraphWriteResult",
    },
    {
      method: "POST",
      path: "/v1/graphs/:id/turns",
      summary: "A turn on a branch, streamed as server-sent events",
      body: "BranchTurnCall",
      answer: "TurnEvent stream",
    },
  ],

  register(app, deps) {
    app.get("/v1/graphs", async (c) => {
      const configured = configuredGraphs(deps);
      const ids = await configured.access.list(deps.principal(c));
      return jsonResponse({ graphs: ids });
    });

    app.post("/v1/graphs", async (c) => {
      const configured = configuredGraphs(deps);
      const call = await deps.body(c, GraphCreateSchema);
      const principal = deps.principal(c);
      // Nothing exists yet, so there is no write check to make.
      const graph = await ProcessGraph.create(configured.store, {
        ...(call.title !== undefined && { title: call.title }),
      });
      await configured.access.created(principal, graph.id);
      return written(graph, [graph.id]);
    });

    app.get("/v1/graphs/:id", async (c) => {
      const configured = configuredGraphs(deps);
      const graph = await openFor(configured, deps.principal(c), c.req.param("id"), "canRead");
      return jsonResponse(graph.state);
    });

    app.get("/v1/graphs/:id/events", async (c) => {
      const configured = configuredGraphs(deps);
      const after = afterOf(c.req.query("after"));
      const graph = await openFor(configured, deps.principal(c), c.req.param("id"), "canRead");
      const records = await configured.store.read(graph.id, after);
      return jsonResponse({ records });
    });

    app.post("/v1/graphs/:id/branches", async (c) => {
      const configured = configuredGraphs(deps);
      const call = await deps.body(c, BranchCreateSchema);
      const graph = await openFor(configured, deps.principal(c), c.req.param("id"), "canWrite");
      const branchId = await graph.branch(call.name, call.from, {
        ...(call.replayOf !== undefined && { replayOf: call.replayOf }),
      });
      return written(graph, [branchId]);
    });

    app.post("/v1/graphs/:id/messages", async (c) => {
      const configured = configuredGraphs(deps);
      const call = await deps.body(c, MessageAddSchema);
      const graph = await openFor(configured, deps.principal(c), c.req.param("id"), "canWrite");
      const nodeId = await graph.addMessage(call.branchId, call.message, {
        ...(call.origin !== undefined && { origin: call.origin }),
      });
      return written(graph, [nodeId]);
    });

    app.post("/v1/graphs/:id/merges", async (c) => {
      const configured = configuredGraphs(deps);
      const call = await deps.body(c, MergeCallSchema);
      const graph = await openFor(configured, deps.principal(c), c.req.param("id"), "canWrite");
      const nodeId = await graph.merge(call);
      return written(graph, [nodeId]);
    });

    app.post("/v1/graphs/:id/cross-references", async (c) => {
      const configured = configuredGraphs(deps);
      const call = await deps.body(c, CrossReferenceCallSchema);
      const graph = await openFor(configured, deps.principal(c), c.req.param("id"), "canWrite");
      const refId = await graph.crossReference(call.from, call.to, call.label);
      return written(graph, [refId]);
    });

    app.post("/v1/graphs/:id/turn-records", async (c) => {
      const configured = configuredGraphs(deps);
      // TurnRecordSchema checks every event against TurnEventSchema, so the events need no second check.
      const call = await deps.body(c, TurnRecordSchema);
      const graph = await openFor(configured, deps.principal(c), c.req.param("id"), "canWrite");
      const nodeIds = await graph.recordTurn(call.branchId, call.events);
      return written(graph, nodeIds);
    });

    app.post("/v1/graphs/:id/forks", async (c) => {
      const configured = configuredGraphs(deps);
      const call = await deps.body(c, ForkCallSchema);
      const principal = deps.principal(c);
      // A fork writes only the new graph, so reading the source is what the caller needs.
      const source = await openFor(configured, principal, c.req.param("id"), "canRead");
      const fork = await source.fork(call.nodeId, { ...(call.title !== undefined && { title: call.title }) });
      await configured.access.created(principal, fork.id);
      return written(fork, [fork.id]);
    });

    app.post("/v1/graphs/:id/turns", async (c) => {
      const configured = configuredGraphs(deps);
      const call = await deps.body(c, BranchTurnCallSchema);
      const principal = deps.principal(c);
      const graph = await openFor(configured, principal, c.req.param("id"), "canWrite");
      // Check and resolve before the stream starts, so a bad request still answers as JSON: an
      // unknown branch throws not_found here instead of ending an empty stream.
      graph.conversation(call.branchId);
      const { router, route } = await deps.model(c, call);

      const events = runBranchTurn({
        graph,
        branchId: call.branchId,
        ...(call.input !== undefined && { input: call.input }),
        router,
        route,
        tools: new ToolRegistry(),
        channel: principal.channel,
        ...(call.clientTools !== undefined && { clientTools: call.clientTools }),
        ...(call.budget !== undefined && { budget: call.budget }),
        ...(call.maxOutputTokens !== undefined && { maxOutputTokens: call.maxOutputTokens }),
        ...(call.temperature !== undefined && { temperature: call.temperature }),
        signal: c.req.raw.signal,
      });
      return turnStream(c, events);
    });
  },
};

/** The configured stores. Without `options.graph` every graph route answers the 404 of an unknown route. */
function configuredGraphs(deps: RouteDeps): Graphs {
  const configured = deps.options.graph;
  if (configured === undefined) throw new CoreError("not_found", "no such route");
  return configured;
}

/**
 * The graph, opened, when the principal may use it. A denied graph and a missing graph answer the
 * same 404, so the answer does not reveal which graphs exist.
 */
async function openFor(
  configured: Graphs,
  principal: Principal,
  graphId: string,
  need: "canRead" | "canWrite",
): Promise<ProcessGraph> {
  if (!(await configured.access[need](principal, graphId))) throw graphNotFound();
  try {
    return await ProcessGraph.open(configured.store, graphId);
  } catch (error) {
    if (CoreError.is(error) && error.code === "not_found") throw graphNotFound();
    throw error;
  }
}

function graphNotFound(): CoreError {
  return new CoreError("not_found", "graph not found");
}

/** The `after` query: absent is 0, otherwise a whole number of decimal digits. */
function afterOf(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new CoreError("bad_request", "after must be a whole number ≥ 0");
  return Number(value);
}

/** A write's answer: the ids it made and the state of the graph written to. */
function written(graph: ProcessGraph, ids: string[]): Response {
  return jsonResponse({ ids, state: graph.state });
}
