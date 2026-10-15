import { CoreError, GraphEventRecordSchema, type GraphEvent, type GraphEventRecord } from "@core/contracts";
import type { GraphStore } from "@core/graph";
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import { graphEvents, type GraphDatabase } from "./schema.js";

/**
 * A `GraphStore` on Postgres through Drizzle. The table is the app's to create, with its own
 * migrations or `ensureGraphSchema`; this class never changes the schema.
 */
export class PostgresGraphStore implements GraphStore {
  readonly #db: GraphDatabase;

  constructor(db: GraphDatabase) {
    this.#db = db;
  }

  async append(graphId: string, expectedSeq: number, events: GraphEvent[], at: string): Promise<GraphEventRecord[]> {
    if (events.length === 0) throw new CoreError("bad_request", "append needs at least one event");
    // What `read` would return, so a caller never holds an object that aliases its own input.
    const records = events.map((event, index): GraphEventRecord => ({
      graphId,
      seq: expectedSeq + index + 1,
      at,
      event: JSON.parse(JSON.stringify(event)) as GraphEvent,
    }));
    try {
      await this.#db.transaction(async (tx) => {
        const [row] = await tx.select({ last: max(graphEvents.seq) }).from(graphEvents).where(eq(graphEvents.graphId, graphId));
        const lastSeq = row?.last ?? 0;
        if (lastSeq !== expectedSeq) {
          throw new CoreError("conflict", `graph ${graphId} is at seq ${lastSeq}, not ${expectedSeq}`);
        }
        await tx.insert(graphEvents).values(records.map(({ graphId, seq, at, event }) => ({ graphId, seq, at, event })));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CoreError("conflict", `graph ${graphId} was appended to by another writer`, { cause: error });
      }
      throw error;
    }
    return records;
  }

  async read(graphId: string, afterSeq = 0): Promise<GraphEventRecord[]> {
    const rows = await this.#db
      .select()
      .from(graphEvents)
      .where(and(eq(graphEvents.graphId, graphId), gt(graphEvents.seq, afterSeq)))
      .orderBy(asc(graphEvents.seq));
    return rows.map((row) => {
      const parsed = GraphEventRecordSchema.safeParse(row);
      // Only the graph and seq are named: the row's content may hold user text.
      if (!parsed.success) {
        throw new CoreError("unknown", `stored event of graph ${row.graphId} at seq ${row.seq} is not a valid record`);
      }
      return parsed.data;
    });
  }

  async listGraphs(): Promise<string[]> {
    // COLLATE "C" compares bytes, as the other stores do, whatever collation the database uses.
    const rows = await this.#db
      .select({ graphId: graphEvents.graphId })
      .from(graphEvents)
      .where(eq(graphEvents.seq, 1))
      .orderBy(sql`${graphEvents.at} COLLATE "C"`, sql`${graphEvents.graphId} COLLATE "C"`);
    return rows.map((row) => row.graphId);
  }
}

/** SQLSTATE 23505 on the error or, as Drizzle wraps driver errors, on its cause: another writer took that seq. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 3; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}
