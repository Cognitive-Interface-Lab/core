import { CoreError, type GraphNode, type GraphState, type Message } from "@core/contracts";

/**
 * The nodes a conversation ending at `nodeId` consists of, oldest first. A plain node follows its
 * parent's path. An `append` merge is the target's path, then the source's nodes not already in
 * it (the merge node itself carries no message and is left out). A `summary` merge is the
 * target's path, then the merge node, whose message stands for the source. `null` gives `[]`.
 * Throws `not_found` for an unknown node.
 */
export function pathTo(state: GraphState, nodeId: string | null): GraphNode[] {
  // Only merge nodes are memoised: a run of plain nodes is walked once, so the cost stays linear.
  const merges = new Map<string, GraphNode[]>();

  const sequence = (id: string | null): GraphNode[] => {
    const chain: GraphNode[] = [];
    let base: GraphNode[] = [];
    for (let current = id; current !== null; ) {
      const node = lookup(state, current);
      if (node.merge !== undefined) {
        base = merged(node);
        break;
      }
      chain.push(node);
      current = node.parentIds[0] ?? null;
    }
    return base.concat(chain.reverse());
  };

  const merged = (node: GraphNode): GraphNode[] => {
    const known = merges.get(node.id);
    if (known !== undefined) return known;
    const target = sequence(node.parentIds[0] ?? null);
    let result: GraphNode[];
    if (node.merge?.strategy === "summary") {
      result = [...target, node];
    } else {
      const seen = new Set(target.map((each) => each.id));
      result = target.concat(sequence(node.parentIds[1] ?? null).filter((each) => !seen.has(each.id)));
    }
    merges.set(node.id, result);
    return result;
  };

  return sequence(nodeId);
}

/** The path of a branch: `pathTo` its head. Throws `not_found` for an unknown branch. */
export function pathNodes(state: GraphState, branchId: string): GraphNode[] {
  const branch = Object.hasOwn(state.branches, branchId) ? state.branches[branchId] : undefined;
  if (branch === undefined) throw new CoreError("not_found", `unknown branch ${branchId}`);
  return pathTo(state, branch.head);
}

/** The messages a branch stands for, in order: what a model gets as the conversation. */
export function conversation(state: GraphState, branchId: string): Message[] {
  return pathNodes(state, branchId).flatMap((node) => (node.message === undefined ? [] : [node.message]));
}

function lookup(state: GraphState, nodeId: string): GraphNode {
  const node = Object.hasOwn(state.nodes, nodeId) ? state.nodes[nodeId] : undefined;
  if (node === undefined) throw new CoreError("not_found", `unknown node ${nodeId}`);
  return node;
}
