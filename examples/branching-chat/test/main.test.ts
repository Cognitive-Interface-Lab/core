import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryGraphStore, ProcessGraph } from "@core/graph";
import { MockProvider, ProviderRegistry, type MockTurn } from "@core/models";
import { run, type BranchingDeps } from "../src/main.js";

// Two models on one scripted provider: the route names differ, the answers come from the script in order.
const ENV = { CORE_ROUTE: "mock:alpha", CORE_REPLAY_ROUTE: "mock:beta" };

/** The five answers of a full demo, in the order the script asks: main, short, analogy, then the replay's two turns. */
const ANSWERS: MockTurn[] = ["A-main", "A-short", "A-analogy", "A-replay-1", "A-replay-2"].map((text) => ({
  text,
  finishReason: "stop",
}));
const FAILURE: MockTurn = { error: { code: "unavailable", message: "model is down", retryable: false } };

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "branching-chat-"));
  dirs.push(dir);
  return join(dir, "graphs.db");
}

function capture() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

/** Runs the example with a scripted provider and returns what it printed. Nothing may reach the network. */
async function go(argv: string[], script: MockTurn[], deps: BranchingDeps = {}, env: Record<string, string | undefined> = ENV) {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network call attempted");
  }));
  const providers = new ProviderRegistry().register(new MockProvider({ script, echo: false }));
  const out = capture();
  const err = capture();
  const code = await run(argv, env, out, err, { providers, ...deps });
  return { code, out: out.text, err: err.text, lines: out.text.split("\n") };
}

const graphIdOf = (stdout: string): string => /^graph (\S+): \d+ events in /m.exec(stdout)?.[1] ?? "";
const treeOf = (stdout: string): string[] => stdout.split("\n").filter((line) => line.includes(" · from "));

describe("branching-chat demo", () => {
  it("exits 0 and prints every step, the tree and the events line", async () => {
    const { code, out, err, lines } = await go([], ANSWERS);

    expect(code).toBe(0);
    expect(err).toBe("");
    // Each step's user and assistant lines, in script order (the system message is not printed).
    const spoken = lines.filter((line) => /^\[[^\]]+\] (user|assistant): /.test(line));
    expect(spoken).toEqual([
      "[main] user: What is an event log? Answer in two sentences.",
      "[main] assistant: A-main",
      "[short] user: Now say it in five words.",
      "[short] assistant: A-short",
      "[analogy] user: Explain it with a kitchen analogy.",
      "[analogy] assistant: A-analogy",
      "[analogy replay] user: What is an event log? Answer in two sentences.",
      "[analogy replay] assistant: A-replay-1",
      "[analogy replay] user: Explain it with a kitchen analogy.",
      "[analogy replay] assistant: A-replay-2",
    ]);

    const tree = treeOf(out);
    expect(tree.map((line) => line.split(" · ")[0])).toEqual(["main", "short", "analogy", "analogy replay"]);
    expect(tree[0]).toContain("from root");
    expect(tree[1]).toContain("merged into main");
    expect(tree[2]).not.toContain("merged");
    expect(tree[3]).toContain("from root");
    expect(tree[3]).toContain("replay of analogy via mock:beta");
    expect(tree[0]).toContain('"A-short"'); // main now ends with short's answer
    expect(tree[1]).toMatch(/from [0-9a-f]{8} · 5 messages/);

    expect(lines.at(-2)).toMatch(/^graph [0-9a-f-]{36}: 18 events in memory$/);
  });

  it("logs the expected events and leaves main ending with short's messages after the merge", async () => {
    const store = new MemoryGraphStore();
    const { code, out } = await go([], ANSWERS, { store });
    expect(code).toBe(0);

    const graphIds = await store.listGraphs();
    expect(graphIds).toEqual([graphIdOf(out)]);
    const records = await store.read(graphIds[0] as string);
    expect(records.map((record) => record.event.type)).toEqual([
      "graph-created",
      "branch-created", // main
      "message-added", // system
      "message-added", // user
      "turn-recorded",
      "branch-created", // short
      "message-added",
      "turn-recorded",
      "branch-created", // analogy
      "message-added",
      "turn-recorded",
      "branches-merged",
      "branch-created", // analogy replay
      "message-added", // system, copied
      "message-added", // first question, copied
      "turn-recorded", // the first answer, asked again
      "message-added", // kitchen question, copied
      "turn-recorded",
    ]);
    expect(records[0]?.event).toMatchObject({ type: "graph-created", title: "branching-chat demo" });
    expect(records.filter((record) => record.event.type === "branches-merged")).toHaveLength(1);

    const graph = await ProcessGraph.open(store, graphIds[0] as string);
    const main = graph.branchId("main");
    expect(graph.conversation(main).map((message) => [message.role, message.content])).toEqual([
      ["system", "You are a concise assistant."],
      ["user", "What is an event log? Answer in two sentences."],
      ["assistant", "A-main"],
      ["user", "Now say it in five words."],
      ["assistant", "A-short"],
    ]);

    // The replay's turns name the replay model; every original turn names the main one.
    const replay = graph.state.branches[graph.branchId("analogy replay")];
    expect(replay).toMatchObject({ replayOf: graph.branchId("analogy"), from: null });
    const modelsOf = (branchId: string | undefined) =>
      Object.values(graph.state.turns)
        .filter((turn) => turn.branchId === branchId)
        .map((turn) => `${turn.model?.provider}:${turn.model?.model}`);
    expect(modelsOf(replay?.id)).toEqual(["mock:beta", "mock:beta"]);
    expect(modelsOf(main)).toEqual(["mock:alpha"]);
    expect(modelsOf(graph.branchId("short"))).toEqual(["mock:alpha"]);
    expect(modelsOf(graph.branchId("analogy"))).toEqual(["mock:alpha"]);
  });

  it("replays on the main route when CORE_REPLAY_ROUTE is not set", async () => {
    const { code, out } = await go([], ANSWERS, {}, { CORE_ROUTE: "mock:alpha" });
    expect(code).toBe(0);
    expect(treeOf(out)[3]).toContain("replay of analogy via mock:alpha");
  });
});

describe("branching-chat with --db and show", () => {
  it("rebuilds the same tree and every conversation from the file alone", async () => {
    const file = tempFile();
    const demo = await go(["--db", file], ANSWERS);
    expect(demo.code).toBe(0);
    expect(demo.lines.at(-2)).toBe(`graph ${graphIdOf(demo.out)}: 18 events in ${file}`);

    // A second run, with no scripted model at all: everything shown comes from the file.
    const shown = await go(["show", graphIdOf(demo.out), "--db", file], []);

    expect(shown.code).toBe(0);
    expect(shown.err).toBe("");
    expect(treeOf(shown.out)).toEqual(treeOf(demo.out));
    const sections = shown.out.split("\n## ").slice(1);
    expect(sections.map((section) => section.split("\n")[0])).toEqual(["main", "short", "analogy", "analogy replay"]);
    expect(shown.out).toContain("## main\nsystem: You are a concise assistant.\nuser: What is an event log? Answer in two sentences.\nassistant: A-main\nuser: Now say it in five words.\nassistant: A-short\n");
    expect(shown.out).toContain("## short\n");
    expect(shown.out).toContain("## analogy\nsystem: You are a concise assistant.\nuser: What is an event log? Answer in two sentences.\nassistant: A-main\nuser: Explain it with a kitchen analogy.\nassistant: A-analogy\n");
    expect(shown.out).toContain("## analogy replay\nsystem: You are a concise assistant.\nuser: What is an event log? Answer in two sentences.\nassistant: A-replay-1\nuser: Explain it with a kitchen analogy.\nassistant: A-replay-2");
  });

  it("exits 1 with not_found for an unknown graph id, and for a file that does not exist", async () => {
    const file = tempFile();
    await go(["--db", file], ANSWERS);

    const unknown = await go(["show", "no-such-graph", "--db", file], []);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/^error: not_found: /);
    expect(unknown.out).toBe("");

    const missing = await go(["show", "g", "--db", tempFile()], []);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^error: not_found: /);
  });

  it("shows a graph from deps.store without --db", async () => {
    const store = new MemoryGraphStore();
    const demo = await go([], ANSWERS, { store });
    const shown = await go(["show", graphIdOf(demo.out)], [], { store });
    expect(shown.code).toBe(0);
    expect(treeOf(shown.out)).toEqual(treeOf(demo.out));
  });
});

describe("branching-chat failures", () => {
  it("exits 1 naming the step when step 2 fails, and keeps the failed turn in the log", async () => {
    const store = new MemoryGraphStore();
    const { code, out, err } = await go([], [ANSWERS[0] as MockTurn, FAILURE], { store });

    expect(code).toBe(1);
    expect(err).toContain("step short failed");
    expect(err).toContain("error: unavailable: ");
    expect(out).toContain("[main] assistant: A-main");
    expect(out).toContain("[short] user: Now say it in five words.");
    expect(out).not.toContain("[analogy]");
    expect(out).not.toMatch(/^graph /m);

    const [graphId] = await store.listGraphs();
    const graph = await ProcessGraph.open(store, graphId as string);
    const failed = Object.values(graph.state.turns).filter((turn) => turn.reason === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ branchId: graph.branchId("short"), nodeIds: [] });
    expect(Object.values(graph.state.branches).map((branch) => branch.name)).toEqual(["main", "short"]);
    const types = (await store.read(graph.id)).map((record) => record.event.type);
    expect(types.at(-1)).toBe("turn-recorded");
  });

  it("exits 1 naming the replay when the replay's turn fails", async () => {
    const { code, err, out } = await go([], [...ANSWERS.slice(0, 3), FAILURE]);

    expect(code).toBe(1);
    expect(err).toContain("step replay of analogy failed");
    expect(err).toContain("error: unavailable: ");
    expect(out).not.toMatch(/^graph /m);
  });

  it("exits 1 for an invalid route", async () => {
    const { code, err } = await go([], ANSWERS, {}, { CORE_ROUTE: "not-a-ref" });
    expect(code).toBe(1);
    expect(err).toMatch(/^error: bad_request: /);
  });
});

describe("branching-chat arguments", () => {
  it.each([
    ["an unknown flag", ["--bogus"]],
    ["--db without a file", ["--db"]],
    ["--db followed by another flag", ["--db", "--other"]],
    ["a stray word", ["hello"]],
    ["show without an id", ["show"]],
    ["show with a flag for an id", ["show", "--db", "x.db"]],
    ["show without --db", ["show", "some-graph"]],
    ["show with extra words", ["show", "g", "--db", "x.db", "more"]],
  ])("exits 2 with the usage for %s", async (_name, argv) => {
    const { code, out, err } = await go(argv, ANSWERS);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/^usage: /);
  });

  it.each(["abc", "0", "-5", "1.5", ""])("exits 2 for CORE_TIMEOUT_MS=%j", async (value) => {
    const { code, out, err } = await go([], ANSWERS, {}, { ...ENV, CORE_TIMEOUT_MS: value });
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("error: bad_request: CORE_TIMEOUT_MS must be a positive integer\n");
  });
});
