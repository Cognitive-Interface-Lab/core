import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CoreError,
  CoreErrorShapeSchema,
  ModelRefSchema,
  formatModelRef,
  parseModelRef,
  type GraphState,
  type Message,
  type ModelRef,
  type TurnEvent,
} from "@core/contracts";
import { MemoryGraphStore, ProcessGraph, conversation, type GraphStore } from "@core/graph";
import { SqliteGraphStore } from "@core/graph-sqlite";
import {
  EnvCredentialStore,
  MockProvider,
  ModelRouter,
  OpenAICompatibleProvider,
  PRESETS,
  ProviderRegistry,
} from "@core/models";
import { replayBranch, runBranchTurn } from "@core/runtime";
import { ToolRegistry } from "@core/tools";

const DEFAULT_ROUTE = "mock:echo";
const SYSTEM_PROMPT = "You are a concise assistant.";
const TITLE = "branching-chat demo";
const TREE_PREVIEW_CHARS = 60;

const USAGE = `usage: pnpm --filter @core/example-branching-chat start [--db <file>]
       pnpm --filter @core/example-branching-chat start show <graphId> --db <file>

  --db <file>         keep the graph in this SQLite file (default: in memory, gone at exit)
  show <graphId>      rebuild a graph from the file and print it
  CORE_ROUTE          comma-separated model refs, tried in order (default "${DEFAULT_ROUTE}"),
                      for example "ollama:llama3.2:3b"
  CORE_REPLAY_ROUTE   the route for the replay (default: CORE_ROUTE)
  CORE_TIMEOUT_MS     per-step timeout in ms, a positive integer (default: the router's 30000)
`;

type Writer = { write(s: string): void };

export type BranchingDeps = {
  /** Replaces the providers built from the routes, for tests. */
  providers?: ProviderRegistry;
  /** Replaces the store (`--db` or memory), for tests. The caller closes it. */
  store?: GraphStore;
};

type Args = { mode: "demo"; db: string | undefined } | { mode: "show"; graphId: string; db: string | undefined };

/** The command line, or undefined when it is not one of the two commands. */
function parseArgs(argv: string[]): Args | undefined {
  const [first, ...rest] = argv;
  if (first === "show") {
    const [graphId, ...flags] = rest;
    if (graphId === undefined || graphId.startsWith("-")) return undefined;
    const db = dbFlag(flags);
    return db === null ? undefined : { mode: "show", graphId, db };
  }
  const db = dbFlag(argv);
  return db === null ? undefined : { mode: "demo", db };
}

/** The value of `--db <file>`: undefined when absent, null when the arguments are anything else. */
function dbFlag(args: string[]): string | undefined | null {
  if (args.length === 0) return undefined;
  const [flag, file, ...more] = args;
  return flag === "--db" && file !== undefined && file !== "" && !file.startsWith("-") && more.length === 0 ? file : null;
}

/**
 * Runs the demo (a conversation that branches twice, merges one branch back and replays another on
 * a second route) or `show`. Returns the process exit code: 0 on success, 1 when a turn does not
 * finish with `stop` or the store or graph fails, 2 for a bad argument or `CORE_TIMEOUT_MS`.
 */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  out: Writer,
  err: Writer,
  deps: BranchingDeps = {},
): Promise<number> {
  const args = parseArgs(argv);
  if (args === undefined) {
    err.write(USAGE);
    return 2;
  }
  if (args.mode === "show" && args.db === undefined && deps.store === undefined) {
    err.write(USAGE);
    return 2;
  }

  if (args.mode === "show") return show(args.graphId, args.db, out, err, deps);

  const rawTimeout = env["CORE_TIMEOUT_MS"];
  let timeoutMs: number | undefined;
  if (rawTimeout !== undefined) {
    timeoutMs = /^[0-9]+$/.test(rawTimeout) ? Number(rawTimeout) : NaN;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      err.write("error: bad_request: CORE_TIMEOUT_MS must be a positive integer\n");
      return 2;
    }
  }

  let route: ModelRef[];
  let replayRoute: ModelRef[];
  try {
    route = routeFrom(env["CORE_ROUTE"], DEFAULT_ROUTE);
    replayRoute = env["CORE_REPLAY_ROUTE"]?.trim() ? routeFrom(env["CORE_REPLAY_ROUTE"], DEFAULT_ROUTE) : route;
  } catch (error) {
    err.write(`error: ${describe(error, "unknown: invalid CORE_ROUTE or CORE_REPLAY_ROUTE")}\n`);
    return 1;
  }

  const router = new ModelRouter(deps.providers ?? buildProviders([...route, ...replayRoute], env));
  const steps = (models: ModelRef[]) => models.map((model) => ({ model, ...(timeoutMs !== undefined && { timeoutMs }) }));
  const turn = { router, tools: new ToolRegistry(), channel: "local" } as const;

  let ownStore: SqliteGraphStore | undefined;
  try {
    if (deps.store === undefined && args.db !== undefined) ownStore = SqliteGraphStore.open(args.db);
    const store = deps.store ?? ownStore ?? new MemoryGraphStore();
    const graph = await ProcessGraph.create(store, { title: TITLE });
    const main = graph.branchId("main");

    /** Adds `input` to a branch, runs the turn and prints both; false after printing why a turn failed. */
    const ask = async (label: string, branchName: string, branchId: string, input: Message): Promise<boolean> => {
      if (input.role === "user") out.write(`[${branchName}] user: ${input.content}\n`);
      const watch = new TurnWatch();
      for await (const event of runBranchTurn({ ...turn, route: steps(route), graph, branchId, input })) {
        watch.observe(event);
        if (event.type === "turn-finish") printAnswers(out, branchName, event.messages);
      }
      return watch.report(label, err);
    };

    // 1. main: a system message, then the first question.
    await graph.addMessage(main, { role: "system", content: SYSTEM_PROMPT });
    if (!(await ask("main", "main", main, { role: "user", content: "What is an event log? Answer in two sentences." }))) return 1;
    const answer = graph.state.branches[main]?.head;
    if (answer === null || answer === undefined) throw new CoreError("unknown", "main has no answer to branch from");

    // 2 and 3. Two branches from the same answer, each with its own follow-up.
    const short = await graph.branch("short", answer);
    if (!(await ask("short", "short", short, { role: "user", content: "Now say it in five words." }))) return 1;
    const analogy = await graph.branch("analogy", answer);
    if (!(await ask("analogy", "analogy", analogy, { role: "user", content: "Explain it with a kitchen analogy." }))) return 1;

    // 4. short joins main.
    await graph.merge({ source: short, target: main, strategy: "append" });

    // 5. analogy again, from the start, on the replay route.
    const watch = new TurnWatch();
    const replayBranchOf = () => Object.values(graph.state.branches).find((branch) => branch.replayOf === analogy);
    const replayed = await replayBranch({
      ...turn,
      route: steps(replayRoute),
      graph,
      branchId: analogy,
      onEvent: (event) => {
        watch.observe(event);
        const target = replayBranchOf();
        if (target === undefined) return;
        if (event.type === "round" && event.round === 1) {
          const last = conversation(graph.state, target.id).at(-1);
          if (last?.role === "user") out.write(`[${target.name}] user: ${last.content}\n`);
        }
        if (event.type === "turn-finish") printAnswers(out, target.name, event.messages);
      },
    });
    if (!replayed.completed) {
      watch.report("replay of analogy", err);
      return 1;
    }

    // 6. What the graph looks like now.
    out.write(tree(graph.state));
    out.write(`graph ${graph.id}: ${graph.state.lastSeq} events in ${args.db ?? "memory"}\n`);
    return 0;
  } catch (error) {
    err.write(`error: ${describe(error, "unknown: the demo failed")}\n`);
    return 1;
  } finally {
    ownStore?.close();
  }
}

/** Rebuilds the graph `graphId` from the file and prints its tree and every branch's conversation. */
async function show(graphId: string, db: string | undefined, out: Writer, err: Writer, deps: BranchingDeps): Promise<number> {
  // Opening a SQLite file creates it; a mistyped path should not leave an empty database behind.
  if (deps.store === undefined && db !== undefined && !existsSync(db)) {
    err.write(`error: not_found: no database at ${db}\n`);
    return 1;
  }
  let ownStore: SqliteGraphStore | undefined;
  try {
    if (deps.store === undefined && db !== undefined) ownStore = SqliteGraphStore.open(db);
    const store = deps.store ?? ownStore;
    if (store === undefined) throw new CoreError("bad_request", "show needs a store");
    const graph = await ProcessGraph.open(store, graphId);
    out.write(tree(graph.state));
    for (const branch of Object.values(graph.state.branches)) {
      out.write(`\n## ${branch.name}\n`);
      for (const message of graph.conversation(branch.id)) {
        out.write(message.role === "tool" ? `tool ${message.toolName}: ${message.content}\n` : `${message.role}: ${message.content}\n`);
      }
    }
    return 0;
  } catch (error) {
    err.write(`error: ${describe(error, "unknown: the graph could not be shown")}\n`);
    return 1;
  } finally {
    ownStore?.close();
  }
}

/**
 * One line per branch, in creation order: name, where it starts, message count, `replay of … via …`
 * for a replay, `merged into …` for a merged branch, and the start of its last message.
 */
function tree(state: GraphState): string {
  const nodes = Object.values(state.nodes);
  const nameOf = (branchId: string) => state.branches[branchId]?.name ?? branchId;
  return Object.values(state.branches)
    .map((branch) => {
      const messages = conversation(state, branch.id);
      const parts = [branch.name, `from ${branch.from === null ? "root" : branch.from.slice(0, 8)}`, `${messages.length} messages`];
      if (branch.replayOf !== undefined) parts.push(`replay of ${nameOf(branch.replayOf)} via ${lastModel(state, branch.id)}`);
      const merge = nodes.find((node) => node.merge?.sourceBranchId === branch.id);
      if (merge !== undefined) parts.push(`merged into ${nameOf(merge.branchId)}`);
      const last = (messages.at(-1)?.content ?? "").replace(/[\r\n]+/g, " ").slice(0, TREE_PREVIEW_CHARS);
      parts.push(`"${last}"`);
      return `${parts.join(" · ")}\n`;
    })
    .join("");
}

/** The model of the last turn on a branch's path, as `provider:model`. */
function lastModel(state: GraphState, branchId: string): string {
  const head = state.branches[branchId]?.head ?? null;
  for (let id = head; id !== null; ) {
    const node = state.nodes[id];
    if (node === undefined) break;
    const model = node.turnId === undefined ? undefined : state.turns[node.turnId]?.model;
    if (model !== undefined) return formatModelRef(model);
    id = node.parentIds[0] ?? null;
  }
  return "?";
}

/**
 * Watches the events of turns for what a failed turn needs to say: the router's failed attempts
 * and error, and the reason the turn ended.
 */
class TurnWatch {
  #reason = "error";
  #modelError: { code: string; message: string; attempts: unknown } | undefined;

  observe(event: TurnEvent): void {
    if (event.type === "error") {
      this.#modelError = { code: event.error.code, message: event.error.message, attempts: event.error.details?.["attempts"] };
    } else if (event.type === "turn-finish") {
      this.#reason = event.reason;
      if (event.reason === "stop") this.#modelError = undefined;
    }
  }

  /** True when the turn stopped on its own; otherwise prints which step failed and why, and returns false. */
  report(label: string, err: Writer): boolean {
    if (this.#reason === "stop") return true;
    err.write(`step ${label} failed\n`);
    if (this.#modelError) {
      for (const line of failedAttemptLines(this.#modelError.attempts)) err.write(line);
      err.write(`error: ${this.#modelError.code}: ${this.#modelError.message}\n`);
    } else {
      err.write(`error: ${this.#reason}\n`);
    }
    return false;
  }
}

function printAnswers(out: Writer, branchName: string, messages: Message[]): void {
  for (const message of messages) {
    if (message.role === "assistant" && message.content !== "") out.write(`[${branchName}] assistant: ${message.content}\n`);
  }
}

/**
 * One line per failed step of the router's `Attempt` log (`ok: false` with an `error`), in order.
 * Entries of any other shape are skipped. The position is 1-based within the log.
 */
function failedAttemptLines(attempts: unknown): string[] {
  if (!Array.isArray(attempts)) return [];
  const lines: string[] = [];
  attempts.forEach((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const { ok, model, error } = entry as Record<string, unknown>;
    if (ok !== false) return;
    const ref = ModelRefSchema.safeParse(model);
    const failure = CoreErrorShapeSchema.safeParse(error);
    if (!ref.success || !failure.success) return;
    lines.push(`attempt ${index + 1} ${formatModelRef(ref.data)}: ${failure.data.code}: ${failure.data.message}\n`);
  });
  return lines;
}

function routeFrom(raw: string | undefined, fallback: string): ModelRef[] {
  return (raw?.trim() || fallback)
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "")
    .map(parseModelRef);
}

function describe(error: unknown, otherwise: string): string {
  return CoreError.is(error) ? `${error.code}: ${error.message}` : otherwise;
}

/** Providers for the ids in the routes; ids we do not know stay unregistered, so the router falls back past them. */
function buildProviders(route: ModelRef[], env: Record<string, string | undefined>): ProviderRegistry {
  const registry = new ProviderRegistry().register(new MockProvider({ id: "mock" }));
  const credentials = new EnvCredentialStore(env);
  for (const id of new Set(route.map((ref) => ref.provider))) {
    const preset = PRESETS[id];
    if (preset && !registry.has(id)) {
      registry.register(new OpenAICompatibleProvider({ id, preset, credentials }));
    }
  }
  return registry;
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isEntryModule()) {
  process.exitCode = await run(process.argv.slice(2), process.env, process.stdout, process.stderr);
}
