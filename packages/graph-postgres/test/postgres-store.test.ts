import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { ProcessGraph } from "@core/graph";
import { describeGraphStoreContract } from "@core/graph/testing";
import { PostgresGraphStore, ensureGraphSchema } from "../src/index.js";

// PGlite is Postgres compiled to WebAssembly; starting one takes seconds, longer under a loaded gate.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function freshDatabase() {
  const client = new PGlite();
  const db = drizzle(client);
  await ensureGraphSchema(db);
  return { client, db };
}

describeGraphStoreContract("PostgresGraphStore (PGlite)", async () => {
  const { client, db } = await freshDatabase();
  return { store: new PostgresGraphStore(db), close: () => client.close() };
});

describe("PostgresGraphStore on PGlite", () => {
  it("runs ensureGraphSchema twice on the same database", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client);
      await ensureGraphSchema(db);
      await expect(ensureGraphSchema(db)).resolves.toBeUndefined();
      // The table is still usable and empty.
      expect(await new PostgresGraphStore(db).listGraphs()).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("opens a ProcessGraph through a second store on the same client with an equal state", async () => {
    const { client, db } = await freshDatabase();
    try {
      const graph = await ProcessGraph.create(new PostgresGraphStore(db), { title: "kept" });
      const main = graph.branchId("main");
      const n1 = await graph.addMessage(main, { role: "user", content: "naïve — 日本語 ✓" });
      const side = await graph.branch("side", n1);
      await graph.addMessage(side, { role: "assistant", content: "hi" });
      await graph.merge({ source: side, target: main, strategy: "append" });

      const reopened = await ProcessGraph.open(new PostgresGraphStore(db), graph.id);
      expect(reopened.state).toEqual(graph.state);
      expect(reopened.conversation(reopened.branchId("main"))).toEqual(graph.conversation(main));
    } finally {
      await client.close();
    }
  });
});
