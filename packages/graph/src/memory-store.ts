import { CoreError, type GraphEvent, type GraphEventRecord } from "@core/contracts";
import type { GraphStore } from "./store.js";

/** A `GraphStore` in memory, for tests and short-lived processes. Records are deep-copied in and out. */
export class MemoryGraphStore implements GraphStore {
  readonly #logs = new Map<string, GraphEventRecord[]>();

  async append(graphId: string, expectedSeq: number, events: GraphEvent[], at: string): Promise<GraphEventRecord[]> {
    if (events.length === 0) throw new CoreError("bad_request", "append needs at least one event");
    const log = this.#logs.get(graphId) ?? [];
    const lastSeq = log.length;
    if (lastSeq !== expectedSeq) {
      throw new CoreError("conflict", `graph ${graphId} is at seq ${lastSeq}, not ${expectedSeq}`);
    }
    const records = events.map((event, index) => ({ graphId, seq: expectedSeq + index + 1, at, event }));
    this.#logs.set(graphId, [...log, ...structuredClone(records)]);
    return structuredClone(records);
  }

  async read(graphId: string, afterSeq = 0): Promise<GraphEventRecord[]> {
    const log = this.#logs.get(graphId) ?? [];
    return structuredClone(log.filter((record) => record.seq > afterSeq));
  }

  async listGraphs(): Promise<string[]> {
    return [...this.#logs.entries()]
      .map(([graphId, log]) => ({ graphId, at: log[0]?.at ?? "" }))
      .sort((a, b) => compare(a.at, b.at) || compare(a.graphId, b.graphId))
      .map((entry) => entry.graphId);
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
