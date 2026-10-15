import type { Message, TurnEvent } from "@core/contracts";
import type { ProcessGraph } from "@core/graph";
import { runTurn, type RunTurnOptions } from "./turn.js";

export type BranchTurnOptions = Omit<RunTurnOptions, "messages"> & {
  graph: ProcessGraph;
  branchId: string;
  /** The user's message for this turn; added to the branch before the turn runs. */
  input?: Message;
};

/**
 * Runs one turn on a graph branch and records it. The conversation is the branch's own; `input`,
 * when given, is added to the branch first. Every event of `runTurn` is yielded as it arrives, and
 * the whole turn is recorded with `graph.recordTurn` before `turn-finish` is yielded, so a consumer
 * that sees `turn-finish` can rely on the graph holding the turn. A turn that ends with `error`,
 * `aborted` or a budget is recorded too; its failures stay events, as in `runTurn`.
 *
 * Throws only when the graph refuses a write (for example `conflict` or `not_found`), and then
 * nothing of that turn is recorded. A consumer that stops iterating early records nothing: end a
 * turn properly with `signal`.
 */
export async function* runBranchTurn(opts: BranchTurnOptions): AsyncGenerator<TurnEvent, void, undefined> {
  const { graph, branchId, input, ...turnOptions } = opts;
  if (input !== undefined) await graph.addMessage(branchId, input);

  const events: TurnEvent[] = [];
  for await (const event of runTurn({ ...turnOptions, messages: graph.conversation(branchId) })) {
    events.push(event);
    if (event.type === "turn-finish") await graph.recordTurn(branchId, events);
    yield event;
  }
}
