import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CoreError,
  CoreErrorShapeSchema,
  ModelRefSchema,
  formatModelRef,
  parseModelRef,
  type Message,
  type ModelRef,
} from "@core/contracts";
import {
  EnvCredentialStore,
  MockProvider,
  ModelRouter,
  OpenAICompatibleProvider,
  PRESETS,
  ProviderRegistry,
} from "@core/models";
import { runTurn } from "@core/runtime";
import {
  ToolRegistry,
  calculateTool,
  connectMcpServer,
  type McpConnection,
  type McpServerSpec,
} from "@core/tools";

const DEFAULT_ROUTE = "mock:echo";
const SYSTEM_PROMPT = "You are a concise assistant. Use the tools when they help. Answer in one or two sentences.";
const MAX_RESULT_CHARS = 200;

const USAGE = `usage: pnpm --filter @core/example-hello-agent start [--yes] <prompt>

  --yes            allow tools that have side effects (without it they are declined)
  CORE_ROUTE       comma-separated model refs, tried in order (default "${DEFAULT_ROUTE}"),
                   for example "ollama:llama3.2:3b"
  CORE_TIMEOUT_MS  per-step timeout in ms, a positive integer (default: the router's 30000)
  CORE_MCP_FS      a directory to expose through the reference filesystem MCP server
`;

type Writer = { write(s: string): void };

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

export type AgentDeps = {
  /** Replaces the providers built from the route, for tests. */
  providers?: ProviderRegistry;
  /** Replaces the MCP servers taken from `CORE_MCP_FS`, for tests. */
  mcp?: McpServerSpec[];
};

/**
 * Runs one agent turn: the model may call `calculate` and the tools of MCP servers. Returns the
 * process exit code: 0 when the model stops on its own, 1 when the turn or the setup fails, 2 for
 * a missing prompt or a bad `CORE_TIMEOUT_MS`.
 */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  out: Writer,
  err: Writer,
  deps: AgentDeps = {},
): Promise<number> {
  const yes = argv.includes("--yes");
  const prompt = argv.filter((arg) => arg !== "--yes").join(" ");
  if (prompt.trim() === "") {
    err.write(USAGE);
    return 2;
  }

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
  try {
    route = (env["CORE_ROUTE"]?.trim() || DEFAULT_ROUTE)
      .split(",")
      .map((ref) => ref.trim())
      .filter((ref) => ref !== "")
      .map(parseModelRef);
  } catch (error) {
    err.write(`error: ${CoreError.is(error) ? `${error.code}: ${error.message}` : "unknown: invalid CORE_ROUTE"}\n`);
    return 1;
  }

  const providers = deps.providers ?? buildProviders(route, env);
  const router = new ModelRouter(providers);
  const tools = new ToolRegistry().register(calculateTool);
  const connections: McpConnection[] = [];

  try {
    for (const spec of deps.mcp ?? mcpServersFrom(env)) {
      const connection = await connectMcpServer(spec);
      connections.push(connection);
      for (const tool of connection.tools()) tools.register(tool);
      err.write(`[mcp ${connection.name}: ${connection.tools().length} tools]\n`);
    }

    const started = performance.now();
    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];
    let via: ModelRef | undefined;
    let modelError: { code: string; message: string; attempts: unknown } | undefined;
    let wroteText = false;
    let reason = "error";
    let rounds = 0;

    const events = runTurn({
      router,
      route: route.map((model) => ({ model, ...(timeoutMs !== undefined && { timeoutMs }) })),
      tools,
      channel: "local",
      messages,
      confirm: async (call) => {
        if (yes) return true;
        err.write(`[declined ${call.name}: run with --yes to allow]\n`);
        return false;
      },
    });
    for await (const event of events) {
      switch (event.type) {
        case "route":
          via = event.model;
          break;
        case "text-delta":
          wroteText = true;
          out.write(event.text);
          break;
        case "tool-call":
          err.write(`[tool ${event.toolCall.name} ${JSON.stringify(event.toolCall.arguments)}]\n`);
          break;
        case "tool-result": {
          const { toolName, content, isError } = event.result;
          err.write(`[${isError ? "error" : "result"} ${toolName} ${content.slice(0, MAX_RESULT_CHARS)}]\n`);
          break;
        }
        case "error":
          modelError = {
            code: event.error.code,
            message: event.error.message,
            attempts: event.error.details?.["attempts"],
          };
          break;
        case "turn-finish":
          reason = event.reason;
          rounds = event.rounds;
          break;
        default:
          break;
      }
    }

    if (reason === "stop") {
      out.write("\n");
      const ms = Math.round(performance.now() - started);
      err.write(`[via ${via ? formatModelRef(via) : "?"} · ${rounds} round(s) · ${ms} ms]\n`);
      return 0;
    }
    if (wroteText) out.write("\n");
    if (modelError) {
      for (const line of failedAttemptLines(modelError.attempts)) err.write(line);
      err.write(`error: ${modelError.code}: ${modelError.message}\n`);
    } else {
      err.write(`error: ${reason}\n`);
    }
    return 1;
  } catch (error) {
    err.write(`error: ${CoreError.is(error) ? `${error.code}: ${error.message}` : "unknown: the agent failed"}\n`);
    return 1;
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }
}

/** Providers for the ids in the route; ids we do not know stay unregistered, so the router falls back past them. */
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

function mcpServersFrom(env: Record<string, string | undefined>): McpServerSpec[] {
  const dir = env["CORE_MCP_FS"];
  if (dir === undefined || dir === "") return [];
  return [{ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@1", dir] }];
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isEntryModule()) {
  process.exitCode = await run(process.argv.slice(2), process.env, process.stdout, process.stderr);
}
