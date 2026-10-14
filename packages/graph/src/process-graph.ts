import {
  CoreError,
  type GraphEvent,
  type GraphEventRecord,
  type GraphNode,
  type GraphState,
  type Message,
  type NodeRef,
  type TurnEvent,
} from "@core/contracts";
import { conversation, pathNodes, pathTo } from "./conversation.js";
import { applyEvent, project } from "./project.js";
import type { GraphStore } from "./store.js";

export type GraphOptions = {
  /** The time stamped on each write. Default: `() => new Date()`. */
  clock?: () => Date;
  /** Makes the ids of graphs, branches, nodes, turns and references. Default: `crypto.randomUUID`. */
  newId?: () => string;
};

export type MergeOptions = { source: string; target: string } & (
  | { strategy: "append" }
  | { strategy: "summary"; message: Message }
);

/**
 * One graph, read and written through a store. Every write builds its events with fresh ids,
 * checks them against the current state (a bad event throws before anything is stored), appends
 * them with optimistic concurrency and then publishes a new `state`. A failed append, such as
 * `conflict`, leaves `state` as it was; `refresh()` and retry.
 */
export class ProcessGraph {
  readonly id: string;
  readonly store: GraphStore;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  #state: GraphState;

  private constructor(store: GraphStore, state: GraphState, opts: GraphOptions) {
    this.id = state.graphId;
    this.store = store;
    this.#state = state;
    this.#clock = opts.clock ?? (() => new Date());
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
  }

  /** A new graph with one empty branch, `main`. */
  static async create(store: GraphStore, opts: GraphOptions & { title?: string } = {}): Promise<ProcessGraph> {
    const newId = opts.newId ?? (() => crypto.randomUUID());
    const events: GraphEvent[] = [
      { type: "graph-created", ...(opts.title !== undefined && { title: opts.title }) },
      { type: "branch-created", branchId: newId(), name: "main", from: null },
    ];
    return ProcessGraph.#start(store, newId(), events, opts);
  }

  /** An existing graph, rebuilt from its log. Throws `not_found` when the store has no records for it. */
  static async open(store: GraphStore, graphId: string, opts: GraphOptions = {}): Promise<ProcessGraph> {
    const records = await store.read(graphId);
    if (records.length === 0) throw new CoreError("not_found", `unknown graph ${graphId}`);
    return new ProcessGraph(store, project(records), opts);
  }

  /** Checks a new graph's first events, appends them and opens the graph on the state they produce. */
  static async #start(store: GraphStore, graphId: string, events: GraphEvent[], opts: GraphOptions): Promise<ProcessGraph> {
    const at = (opts.clock ?? (() => new Date()))().toISOString();
    const records: GraphEventRecord[] = events.map((event, index) => ({ graphId, seq: index + 1, at, event }));
    const state = project(records);
    await store.append(graphId, 0, events, at);
    return new ProcessGraph(store, state, opts);
  }

  /** The current state. A published state is never changed later; each write publishes a new one. */
  get state(): GraphState {
    return this.#state;
  }

  /** The id of the branch called `name`. Throws `not_found` for an unknown name. */
  branchId(name: string): string {
    const branch = Object.values(this.#state.branches).find((each) => each.name === name);
    if (branch === undefined) throw new CoreError("not_found", `unknown branch "${name}"`);
    return branch.id;
  }

  /** Adds `message` at the head of a branch and returns its node id. */
  async addMessage(branchId: string, message: Message, opts: { origin?: NodeRef } = {}): Promise<string> {
    const nodeId = this.#newId();
    await this.#write([
      {
        type: "message-added",
        nodeId,
        branchId,
        message,
        ...(opts.origin !== undefined && { origin: opts.origin }),
      },
    ]);
    return nodeId;
  }

  /** Records a whole turn on a branch; returns one node id per message the turn added. */
  async recordTurn(branchId: string, events: TurnEvent[]): Promise<string[]> {
    const finish = events.at(-1);
    const nodeIds = finish?.type === "turn-finish" ? finish.messages.map(() => this.#newId()) : [];
    await this.#write([{ type: "turn-recorded", turnId: this.#newId(), branchId, nodeIds, events }]);
    return nodeIds;
  }

  /** Starts a branch at node `from` (or at nothing) and returns its id. */
  async branch(name: string, from: string | null, opts: { replayOf?: string } = {}): Promise<string> {
    const branchId = this.#newId();
    await this.#write([
      {
        type: "branch-created",
        branchId,
        name,
        from,
        ...(opts.replayOf !== undefined && { replayOf: opts.replayOf }),
      },
    ]);
    return branchId;
  }

  /** Merges `source` into `target` and returns the merge node's id. */
  async merge(opts: MergeOptions): Promise<string> {
    const nodeId = this.#newId();
    await this.#write([
      {
        type: "branches-merged",
        nodeId,
        sourceBranchId: opts.source,
        targetBranchId: opts.target,
        strategy: opts.strategy,
        ...("message" in opts && { message: opts.message }),
      },
    ]);
    return nodeId;
  }

  /** Links node `from` of this graph to any node `to`, and returns the reference id. */
  async crossReference(from: string, to: NodeRef, label?: string): Promise<string> {
    const refId = this.#newId();
    await this.#write([{ type: "cross-referenced", refId, from, to, ...(label !== undefined && { label }) }]);
    return refId;
  }

  /**
   * A new graph in the same store holding a copy of the conversation up to `nodeId`: one message
   * per message-carrying node of its path (a summary merge counts), each with `origin` naming the
   * node it came from. This graph gets no event.
   */
  async fork(nodeId: string, opts: { title?: string } = {}): Promise<ProcessGraph> {
    const path = pathTo(this.#state, nodeId);
    const newId = this.#newId;
    const mainId = newId();
    const events: GraphEvent[] = [
      {
        type: "graph-created",
        ...(opts.title !== undefined && { title: opts.title }),
        forkedFrom: { graphId: this.id, nodeId },
      },
      { type: "branch-created", branchId: mainId, name: "main", from: null },
    ];
    for (const node of path) {
      if (node.message === undefined) continue;
      events.push({
        type: "message-added",
        nodeId: newId(),
        branchId: mainId,
        message: node.message,
        origin: { graphId: this.id, nodeId: node.id },
      });
    }
    return ProcessGraph.#start(this.store, newId(), events, { clock: this.#clock, newId });
  }

  /** The messages of a branch, in order. */
  conversation(branchId: string): Message[] {
    return conversation(this.#state, branchId);
  }

  /** The nodes of a branch's conversation, oldest first. */
  pathNodes(branchId: string): GraphNode[] {
    return pathNodes(this.#state, branchId);
  }

  /** Applies the records other writers appended since `state`. */
  async refresh(): Promise<void> {
    const records = await this.store.read(this.id, this.#state.lastSeq);
    this.#publish(records.reduce(applyEvent, this.#state));
  }

  async #write(events: GraphEvent[]): Promise<void> {
    const base = this.#state;
    const at = this.#clock().toISOString();
    const next = events.reduce(
      (state, event) => applyEvent(state, { graphId: this.id, seq: state.lastSeq + 1, at, event }),
      base,
    );
    await this.store.append(this.id, base.lastSeq, events, at);
    this.#publish(next);
  }

  /** Publishes `next` unless a refresh that ran meanwhile already got further. */
  #publish(next: GraphState): void {
    if (next.lastSeq > this.#state.lastSeq) this.#state = next;
  }
}
