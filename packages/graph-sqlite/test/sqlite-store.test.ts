import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CoreError } from "@core/contracts";
import { ProcessGraph } from "@core/graph";
import { describeGraphStoreContract } from "@core/graph/testing";
import { SqliteGraphStore } from "../src/index.js";

describeGraphStoreContract("SqliteGraphStore (:memory:)", async () => {
  const store = SqliteGraphStore.open(":memory:");
  return { store, close: async () => store.close() };
});

describeGraphStoreContract("SqliteGraphStore (file)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "core-graph-sqlite-"));
  const store = SqliteGraphStore.open(join(dir, "graphs.db"));
  return {
    store,
    close: async () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe("SqliteGraphStore persistence", () => {
  /** Runs `test` in a fresh directory that is removed afterwards, even when `test` throws. */
  async function inTempDir(test: (path: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "core-graph-sqlite-"));
    try {
      await test(join(dir, "graphs.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reads the same records after closing and reopening the file", () =>
    inTempDir(async (path) => {
      const first = SqliteGraphStore.open(path);
      const written = await first.append(
        "g1",
        0,
        [
          { type: "graph-created", title: "naïve — 日本語 ✓" },
          { type: "branch-created", branchId: "b1", name: "main", from: null },
        ],
        "2026-10-14T10:00:00.000Z",
      );
      first.close();

      const second = SqliteGraphStore.open(path);
      try {
        expect(await second.read("g1")).toEqual(written);
        expect(await second.listGraphs()).toEqual(["g1"]);
        // The reopened store continues the same log.
        await second.append("g1", 2, [{ type: "cross-referenced", refId: "r1", from: "n1", to: { graphId: "g2", nodeId: "n2" } }], "2026-10-14T11:00:00.000Z");
        expect((await second.read("g1")).map((record) => record.seq)).toEqual([1, 2, 3]);
      } finally {
        second.close();
      }
    }));

  it("opens a ProcessGraph on the reopened file with an equal state", () =>
    inTempDir(async (path) => {
      const first = SqliteGraphStore.open(path);
      const graph = await ProcessGraph.create(first, { title: "kept" });
      const main = graph.branchId("main");
      const n1 = await graph.addMessage(main, { role: "user", content: "hello" });
      const side = await graph.branch("side", n1);
      await graph.addMessage(side, { role: "assistant", content: "hi" });
      await graph.merge({ source: side, target: main, strategy: "append" });
      first.close();

      const second = SqliteGraphStore.open(path);
      try {
        const reopened = await ProcessGraph.open(second, graph.id);
        expect(reopened.state).toEqual(graph.state);
        expect(reopened.conversation(reopened.branchId("main"))).toEqual(graph.conversation(main));
      } finally {
        second.close();
      }
    }));

  it("throws CoreError unknown naming the graph and seq of a row that is not valid JSON", () =>
    inTempDir(async (path) => {
      const store = SqliteGraphStore.open(path);
      const other = new DatabaseSync(path);
      try {
        await store.append("g1", 0, [{ type: "graph-created" }], "2026-10-14T10:00:00.000Z");
        other
          .prepare("INSERT INTO core_graph_events (graph_id, seq, at, event) VALUES (?, ?, ?, ?)")
          .run("g1", 2, "2026-10-14T10:00:00.000Z", "{not json");

        const error = await store.read("g1").then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(CoreError);
        expect(error).toMatchObject({ code: "unknown" });
        expect((error as CoreError).message).toContain("g1");
        expect((error as CoreError).message).toContain("seq 2");
        expect((error as CoreError).message).not.toContain("not json");
      } finally {
        other.close();
        store.close();
      }
    }));

  it("also rejects a row whose JSON is not a valid event", () =>
    inTempDir(async (path) => {
      const store = SqliteGraphStore.open(path);
      const other = new DatabaseSync(path);
      try {
        other
          .prepare("INSERT INTO core_graph_events (graph_id, seq, at, event) VALUES (?, ?, ?, ?)")
          .run("g1", 1, "2026-10-14T10:00:00.000Z", JSON.stringify({ type: "nope" }));
        await expect(store.read("g1")).rejects.toMatchObject({ code: "unknown" });
      } finally {
        other.close();
        store.close();
      }
    }));
});
