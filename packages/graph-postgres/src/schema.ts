import type { GraphEvent } from "@core/contracts";
import { integer, jsonb, pgTable, primaryKey, text, type PgDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The event log of every graph, one row per event. Add this to an app's own Drizzle schema to get
 * the table through its migrations. `at` is text so the ISO string comes back exactly as written.
 */
export const graphEvents = pgTable(
  "core_graph_events",
  {
    graphId: text("graph_id").notNull(),
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    event: jsonb("event").$type<GraphEvent>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.graphId, table.seq] })],
);

/** Any Drizzle Postgres database: node-postgres, postgres-js or PGlite. */
export type GraphDatabase = PgDatabase<PgQueryResultHKT>;

/** Creates `core_graph_events` when it is missing, for apps without migrations. Safe to run twice. */
export async function ensureGraphSchema(db: GraphDatabase): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS core_graph_events (
    graph_id text NOT NULL,
    seq integer NOT NULL,
    at text NOT NULL,
    event jsonb NOT NULL,
    PRIMARY KEY (graph_id, seq)
  )`);
}
