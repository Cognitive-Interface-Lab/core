import { DatabaseSync } from "node:sqlite";
import { CoreError, GraphEventRecordSchema, type GraphEvent, type GraphEventRecord } from "@core/contracts";
import type { GraphStore } from "@core/graph";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS core_graph_events (
  graph_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (graph_id, seq)
)`;

type Row = { graph_id: string; seq: number; at: string; event: string };

/**
 * A `GraphStore` in one SQLite file, on Node's built-in `node:sqlite` (no native build). Every
 * statement is prepared and takes its values as parameters.
 */
export class SqliteGraphStore implements GraphStore {
  readonly #db: DatabaseSync;
  readonly #lastSeq;
  readonly #insert;
  readonly #select;
  readonly #graphs;

  /** Uses `db` and creates the table when it is missing. The store closes `db` on `close()`. */
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(CREATE_TABLE);
    this.#lastSeq = db.prepare("SELECT MAX(seq) AS last FROM core_graph_events WHERE graph_id = ?");
    this.#insert = db.prepare("INSERT INTO core_graph_events (graph_id, seq, at, event) VALUES (?, ?, ?, ?)");
    this.#select = db.prepare(
      "SELECT graph_id, seq, at, event FROM core_graph_events WHERE graph_id = ? AND seq > ? ORDER BY seq",
    );
    this.#graphs = db.prepare("SELECT graph_id FROM core_graph_events WHERE seq = 1 ORDER BY at, graph_id");
  }

  /** Opens the database file at `path` (created when missing), or an in-memory one for `":memory:"`. */
  static open(path: string): SqliteGraphStore {
    const db = new DatabaseSync(path);
    // Another process holding the write lock is waited for, not reported as a raw SQLite error.
    db.exec("PRAGMA busy_timeout = 5000");
    return new SqliteGraphStore(db);
  }

  /** Closes the database. */
  close(): void {
    this.#db.close();
  }

  async append(graphId: string, expectedSeq: number, events: GraphEvent[], at: string): Promise<GraphEventRecord[]> {
    if (events.length === 0) throw new CoreError("bad_request", "append needs at least one event");
    const json = events.map((event) => JSON.stringify(event));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const lastSeq = (this.#lastSeq.get(graphId) as { last: number | null } | undefined)?.last ?? 0;
      if (lastSeq !== expectedSeq) {
        throw new CoreError("conflict", `graph ${graphId} is at seq ${lastSeq}, not ${expectedSeq}`);
      }
      json.forEach((text, index) => this.#insert.run(graphId, expectedSeq + index + 1, at, text));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      if (isUniqueViolation(error)) {
        throw new CoreError("conflict", `graph ${graphId} was appended to by another writer`, { cause: error });
      }
      throw error;
    }
    // What `read` would return, so a caller never holds an object that aliases its own input.
    return json.map((text, index) => ({ graphId, seq: expectedSeq + index + 1, at, event: JSON.parse(text) as GraphEvent }));
  }

  async read(graphId: string, afterSeq = 0): Promise<GraphEventRecord[]> {
    return (this.#select.all(graphId, afterSeq) as Row[]).map(parseRow);
  }

  async listGraphs(): Promise<string[]> {
    return (this.#graphs.all() as { graph_id: string }[]).map((row) => row.graph_id);
  }
}

function parseRow(row: Row): GraphEventRecord {
  let parsed: ReturnType<typeof GraphEventRecordSchema.safeParse> | undefined;
  try {
    parsed = GraphEventRecordSchema.safeParse({
      graphId: row.graph_id,
      seq: row.seq,
      at: row.at,
      event: JSON.parse(row.event),
    });
  } catch {
    parsed = undefined;
  }
  // Only the graph and seq are named: the row's content may hold user text.
  if (parsed?.success !== true) {
    throw new CoreError("unknown", `stored event of graph ${row.graph_id} at seq ${row.seq} is not a valid record`);
  }
  return parsed.data;
}

/** A duplicate (graph_id, seq): another writer took that seq between our check and our insert. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}
