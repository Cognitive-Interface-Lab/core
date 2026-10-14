import {
  CoreError,
  type Branch,
  type GraphEvent,
  type GraphEventRecord,
  type GraphNode,
  type GraphState,
  type ModelRef,
  type TurnEvent,
} from "@core/contracts";

/** The state before seq 1. `createdAt` is a placeholder until `graph-created` sets it. */
export function emptyState(graphId: string): GraphState {
  return { graphId, createdAt: "", lastSeq: 0, branches: {}, nodes: {}, turns: {}, refs: [] };
}

/** Rebuilds a graph's state from its whole log. */
export function project(records: GraphEventRecord[]): GraphState {
  const first = records[0];
  if (first === undefined) throw new CoreError("not_found", "a graph needs at least one event");
  return records.reduce(applyEvent, emptyState(first.graphId));
}

/**
 * Applies one record to a state and returns the new state; `state` itself is never changed.
 * Throws `bad_request`, naming the broken rule, for a record that would corrupt the graph.
 */
export function applyEvent(state: GraphState, record: GraphEventRecord): GraphState {
  if (record.graphId !== state.graphId) {
    fail(`record of graph ${record.graphId} applied to graph ${state.graphId}`);
  }
  if (record.seq !== state.lastSeq + 1) {
    fail(`seq ${record.seq} does not follow seq ${state.lastSeq}`);
  }
  // A private copy, so later changes to the record cannot reach the state.
  const event = structuredClone(record.event);
  if ((event.type === "graph-created") !== (record.seq === 1)) {
    fail(record.seq === 1 ? `seq 1 must be graph-created, not ${event.type}` : `graph-created at seq ${record.seq}`);
  }
  const next = { ...state, lastSeq: record.seq };
  apply(next, event, record);
  return next;
}

/** Applies `event` to `next`, a shallow copy of the previous state; every changed collection is replaced, never mutated. */
function apply(next: GraphState, event: GraphEvent, record: GraphEventRecord): void {
  switch (event.type) {
    case "graph-created": {
      if (event.title !== undefined) next.title = event.title;
      if (event.forkedFrom !== undefined) next.forkedFrom = event.forkedFrom;
      next.createdAt = record.at;
      return;
    }
    case "branch-created": {
      if (Object.hasOwn(next.branches, event.branchId)) fail(`branch ${event.branchId} already exists`);
      if (Object.values(next.branches).some((branch) => branch.name === event.name)) {
        fail(`a branch named "${event.name}" already exists`);
      }
      if (event.from !== null && !Object.hasOwn(next.nodes, event.from)) fail(`branch from unknown node ${event.from}`);
      const branch: Branch = { id: event.branchId, name: event.name, from: event.from, head: event.from };
      if (event.replayOf !== undefined) branch.replayOf = event.replayOf;
      next.branches = { ...next.branches, [branch.id]: branch };
      return;
    }
    case "message-added": {
      const branch = knownBranch(next, event.branchId);
      if (Object.hasOwn(next.nodes, event.nodeId)) fail(`node ${event.nodeId} already exists`);
      const node: GraphNode = { id: event.nodeId, branchId: branch.id, parentIds: parents(branch), message: event.message };
      if (event.origin !== undefined) node.origin = event.origin;
      next.nodes = { ...next.nodes, [node.id]: node };
      next.branches = { ...next.branches, [branch.id]: { ...branch, head: node.id } };
      return;
    }
    case "turn-recorded": {
      const branch = knownBranch(next, event.branchId);
      if (Object.hasOwn(next.turns, event.turnId)) fail(`turn ${event.turnId} already exists`);
      const finish = event.events.at(-1);
      if (finish?.type !== "turn-finish") fail(`turn ${event.turnId} does not end with turn-finish`);
      if (event.nodeIds.length !== finish.messages.length) {
        fail(`turn ${event.turnId} has ${event.nodeIds.length} node ids for ${finish.messages.length} messages`);
      }
      const seen = new Set<string>();
      for (const id of event.nodeIds) {
        if (Object.hasOwn(next.nodes, id) || seen.has(id)) fail(`node ${id} already exists`);
        seen.add(id);
      }

      const nodes = { ...next.nodes };
      let head = branch.head;
      finish.messages.forEach((message, index) => {
        const id = event.nodeIds[index] as string;
        nodes[id] = { id, branchId: branch.id, parentIds: head === null ? [] : [head], message, turnId: event.turnId };
        head = id;
      });
      next.nodes = nodes;
      next.branches = { ...next.branches, [branch.id]: { ...branch, head } };

      const model = lastRoute(event.events);
      next.turns = {
        ...next.turns,
        [event.turnId]: {
          id: event.turnId,
          branchId: branch.id,
          nodeIds: [...event.nodeIds],
          reason: finish.reason,
          ...(model !== undefined && { model }),
          usage: finish.usage,
        },
      };
      return;
    }
    case "branches-merged": {
      const source = knownBranch(next, event.sourceBranchId);
      const target = knownBranch(next, event.targetBranchId);
      if (source.id === target.id) fail(`branch ${source.id} cannot be merged into itself`);
      if (source.head === null) fail(`source branch ${source.id} is empty`);
      if (target.head === null) fail(`target branch ${target.id} is empty`);
      if (Object.hasOwn(next.nodes, event.nodeId)) fail(`node ${event.nodeId} already exists`);
      if (event.strategy === "summary" && event.message === undefined) fail("a summary merge needs a message");
      if (event.strategy === "append" && event.message !== undefined) fail("an append merge carries no message");

      const node: GraphNode = {
        id: event.nodeId,
        branchId: target.id,
        parentIds: [target.head, source.head],
        merge: { strategy: event.strategy, sourceBranchId: source.id },
      };
      if (event.message !== undefined) node.message = event.message;
      next.nodes = { ...next.nodes, [node.id]: node };
      next.branches = { ...next.branches, [target.id]: { ...target, head: node.id } };
      return;
    }
    case "cross-referenced": {
      if (next.refs.some((ref) => ref.id === event.refId)) fail(`reference ${event.refId} already exists`);
      if (!Object.hasOwn(next.nodes, event.from)) fail(`reference from unknown node ${event.from}`);
      if (event.to.graphId === next.graphId && !Object.hasOwn(next.nodes, event.to.nodeId)) {
        fail(`reference to unknown node ${event.to.nodeId}`);
      }
      next.refs = [
        ...next.refs,
        { id: event.refId, from: event.from, to: event.to, ...(event.label !== undefined && { label: event.label }) },
      ];
      return;
    }
  }
}

function knownBranch(state: GraphState, branchId: string): Branch {
  const branch = Object.hasOwn(state.branches, branchId) ? state.branches[branchId] : undefined;
  if (branch === undefined) fail(`unknown branch ${branchId}`);
  return branch;
}

function parents(branch: Branch): string[] {
  return branch.head === null ? [] : [branch.head];
}

function lastRoute(events: TurnEvent[]): ModelRef | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "route") return event.model;
  }
  return undefined;
}

function fail(message: string): never {
  throw new CoreError("bad_request", message);
}
