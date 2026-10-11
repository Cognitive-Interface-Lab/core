import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CoreError, formatModelRef, parseModelRef, type ModelRef } from "@core/contracts";
import {
  EnvCredentialStore,
  MockProvider,
  ModelRouter,
  OpenAICompatibleProvider,
  PRESETS,
  ProviderRegistry,
} from "@core/models";

const DEFAULT_ROUTE = "mock:echo";

const USAGE = `usage: pnpm --filter @core/example-hello-gateway start <prompt>

  CORE_ROUTE   comma-separated model refs, tried in order (default "${DEFAULT_ROUTE}"),
               for example "openai:gpt-4.1-mini,ollama:llama3.2:3b,mock:echo"
`;

type Writer = { write(s: string): void };

/**
 * Streams one answer through the gateway. Returns the process exit code:
 * 0 on success, 1 when the route fails, 2 for a missing prompt.
 */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  out: Writer,
  err: Writer,
): Promise<number> {
  const prompt = argv.join(" ");
  if (prompt.trim() === "") {
    err.write(USAGE);
    return 2;
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

  // Providers for ids we do not know stay unregistered: the router falls back past them.
  const registry = new ProviderRegistry().register(new MockProvider({ id: "mock" }));
  const credentials = new EnvCredentialStore(env);
  for (const id of new Set(route.map((ref) => ref.provider))) {
    const preset = PRESETS[id];
    if (preset && !registry.has(id)) {
      registry.register(new OpenAICompatibleProvider({ id, preset, credentials }));
    }
  }

  const router = new ModelRouter(registry);
  const started = performance.now();
  let attempts = 0;
  let via: ModelRef | undefined;
  let wroteText = false;

  const events = router.stream(
    { messages: [{ role: "user", content: prompt }] },
    route.map((model) => ({ model })),
  );
  for await (const event of events) {
    switch (event.type) {
      case "route":
        attempts = event.attempt;
        via = event.model;
        break;
      case "text-delta":
        wroteText = true;
        out.write(event.text);
        break;
      case "error":
        if (wroteText) out.write("\n");
        err.write(`error: ${event.error.code}: ${event.error.message}\n`);
        return 1;
      default:
        break;
    }
  }

  out.write("\n");
  const ms = Math.round(performance.now() - started);
  err.write(`[via ${via ? formatModelRef(via) : "?"} · ${ms} ms · ${attempts} attempt(s)]\n`);
  return 0;
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href;
}

if (isEntryModule()) {
  process.exitCode = await run(process.argv.slice(2), process.env, process.stdout, process.stderr);
}
