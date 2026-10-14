import type { GraphEvent, GraphEventRecord } from "@core/contracts";

/**
 * Where a graph's event log lives. Stores keep records as given and never interpret events: the
 * projection decides what they mean.
 */
export interface GraphStore {
  /**
   * Stores `events` as seq expectedSeq+1 … expectedSeq+n, all with `at`, all or nothing, and returns
   * the records. Throws `conflict` when the graph's last stored seq is not `expectedSeq` (0 for a
   * graph with no records), and `bad_request` for an empty `events`; either way nothing is written.
   */
  append(graphId: string, expectedSeq: number, events: GraphEvent[], at: string): Promise<GraphEventRecord[]>;
  /** The graph's records with seq > afterSeq (default 0), ascending. An unknown graph yields []. */
  read(graphId: string, afterSeq?: number): Promise<GraphEventRecord[]>;
  /** Every graph id, oldest first (by the `at` of seq 1, then by id). */
  listGraphs(): Promise<string[]>;
}
