import { CoreError, type GraphNode, type Message, type TurnEvent, type TurnFinishReason } from "@core/contracts";
import type { ProcessGraph } from "@core/graph";
import { runBranchTurn } from "./branch-turn.js";
import type { RunTurnOptions } from "./turn.js";

export type ReplayOptions = Omit<RunTurnOptions, "messages"> & {
  graph: ProcessGraph;
  /** The branch to replay. */
  branchId: string;
  /** A node on the branch's path: the replay shares the path up to it and re-runs what follows. */
  from?: string;
  /** The new branch's name. Default: "<source name> replay", then "<source name> replay 2", 3, … until unused. */
  name?: string;
  onEvent?: (event: TurnEvent) => void;
};

export type ReplayResult = {
  /** The new branch. */
  branchId: string;
  /** How many turns were run. */
  turns: number;
  /** False when a turn ended for any reason but `stop`; the replay stopped there. */
  completed: boolean;
  /** The reason of the turn that stopped the replay. */
  reason?: TurnFinishReason;
};

/**
 * Re-runs what a branch did on a new branch (`replayOf` the source), with this call's router,
 * route and tools. Inputs are copied with their origin; each turn of the source, a run of
 * consecutive nodes sharing a `turnId`, is run again with `runBranchTurn`, so its result lands in
 * the graph next to the original. Stops after the first turn that does not end with `stop`.
 * `from` must be a node on the source's path (`bad_request` otherwise), and the replay then
 * starts there; if `from` falls inside a turn, the rest of that turn is re-run as one turn.
 */
export async function replayBranch(opts: ReplayOptions): Promise<ReplayResult> {
  const { graph, branchId: sourceId, from, name, onEvent, ...turnOptions } = opts;
  const path = graph.pathNodes(sourceId);
  let start = 0;
  if (from !== undefined) {
    const index = path.findIndex((node) => node.id === from);
    if (index < 0) throw new CoreError("bad_request", `node ${from} is not on the path of branch ${sourceId}`);
    start = index + 1;
  }

  const branchId = await graph.branch(name ?? unusedName(graph, sourceId), from ?? null, { replayOf: sourceId });
  const result: ReplayResult = { branchId, turns: 0, completed: true };

  for (const step of steps(path.slice(start))) {
    if (step.kind === "input") {
      await graph.addMessage(branchId, step.message, { origin: { graphId: graph.id, nodeId: step.node.id } });
      continue;
    }
    let reason: TurnFinishReason | undefined;
    for await (const event of runBranchTurn({ ...turnOptions, graph, branchId })) {
      if (event.type === "turn-finish") reason = event.reason;
      onEvent?.(event);
    }
    result.turns++;
    if (reason !== "stop") {
      result.completed = false;
      if (reason !== undefined) result.reason = reason;
      break;
    }
  }
  return result;
}

type Step = { kind: "input"; node: GraphNode; message: Message } | { kind: "turn" };

/** Inputs in order, with each run of nodes sharing a `turnId` as one turn; nodes without a message are skipped. */
function steps(nodes: GraphNode[]): Step[] {
  const result: Step[] = [];
  let turnId: string | undefined;
  for (const node of nodes) {
    if (node.turnId !== undefined) {
      if (node.turnId !== turnId) result.push({ kind: "turn" });
      turnId = node.turnId;
    } else {
      turnId = undefined;
      if (node.message !== undefined) result.push({ kind: "input", node, message: node.message });
    }
  }
  return result;
}

function unusedName(graph: ProcessGraph, sourceId: string): string {
  const base = `${graph.state.branches[sourceId]?.name ?? sourceId} replay`;
  const taken = new Set(Object.values(graph.state.branches).map((branch) => branch.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}
