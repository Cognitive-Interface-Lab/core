import { parseArgs } from "node:util";
import {
  CoreError,
  CoreErrorShapeSchema,
  ModelRefSchema,
  formatModelRef,
  type AskResult,
  type CoreErrorShape,
  type FinishReason,
  type Message,
  type ModelRef,
  type TurnEvent,
} from "@core/contracts";
import {
  ModelRouter,
  ProviderRegistry,
  askResultFrom,
  routeAttempts,
  type ModelProvider,
  type RoutedResponse,
  type RouteStep,
} from "@core/models";
import { runTurn } from "@core/runtime";
import { ToolRegistry } from "@core/tools";
import { parseMaxOutputTokens, parseTimeout, readSchemaFile, readSystemFile } from "../ask-input.js";
import { loadConfig, resolveRoute, type Config } from "../config.js";
import { openGateway } from "../setup.js";
import { UsageError, type Command, type Io } from "../run.js";

export type TurnFinish = Extract<TurnEvent, { type: "turn-finish" }>;

type Failure = { attempt: number; model: ModelRef; error: CoreErrorShape };

/** The attempts that failed before a later step answered. The router reports them only when every step fails. */
export type AttemptLog = { readonly failures: Failure[]; reset(): void };

/**
 * A router over the gateway's providers that also records why each failed attempt failed, so a
 * successful fallback can still say what went wrong first. Call `log.reset()` before each turn.
 */
export async function openTurnRouter(io: Io, config: Config): Promise<{ router: ModelRouter; log: AttemptLog }> {
  const { registry } = await openGateway(io, config);
  const failures: Failure[] = [];
  let attempts = 0;
  const log: AttemptLog = {
    failures,
    reset: () => {
      failures.length = 0;
      attempts = 0;
    },
  };

  const observed = new ProviderRegistry();
  for (const id of registry.list()) {
    const provider = registry.get(id);
    const wrapped: ModelProvider = {
      id: provider.id,
      capabilities: (model) => provider.capabilities(model),
      chat: (req, opts) => provider.chat(req, opts),
      async *stream(req, opts) {
        const attempt = (attempts += 1);
        for await (const event of provider.stream(req, opts)) {
          if (event.type === "error") {
            // The router's own timer aborts the request with a TimeoutError; say so rather than "aborted".
            const timedOut = event.error.code === "aborted" && opts?.signal?.reason?.name === "TimeoutError";
            const error: CoreErrorShape = timedOut
              ? { ...event.error, code: "timeout", message: `${formatModelRef(req.model)} timed out` }
              : event.error;
            failures.push({ attempt, model: req.model, error });
          }
          yield event;
        }
      },
    };
    observed.register(wrapped);
  }
  const router = new ModelRouter(observed, config.timeoutMs === undefined ? undefined : { defaultTimeoutMs: config.timeoutMs });
  return { router, log };
}

/** `resolveRoute`, with a missing or bad route reported as a usage error (exit 2). */
export function chooseRoute(flag: string | undefined, env: Io["env"], config: Config): ModelRef[] {
  try {
    return resolveRoute(flag, env, config);
  } catch (error) {
    throw CoreError.is(error) ? new UsageError(error.message) : error;
  }
}

/**
 * Prints a turn as it happens: the answer streams to stdout (ending with a newline); the failed
 * attempts, an error and the model that answered go to stderr. Returns the `turn-finish` event.
 */
export async function printTurn(events: AsyncIterable<TurnEvent>, io: Io, log?: AttemptLog): Promise<TurnFinish> {
  let via: ModelRef | undefined;
  let wroteText = false;
  let lastFinishReason: FinishReason | undefined;
  let failure: { code: string; message: string; attempts: unknown } | undefined;
  let finish: TurnFinish | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "route":
        via = event.model;
        break;
      case "text-delta":
        wroteText = true;
        io.stdout.write(event.text);
        break;
      case "finish":
        lastFinishReason = event.finishReason;
        break;
      case "error":
        failure = { code: event.error.code, message: event.error.message, attempts: event.error.details?.["attempts"] };
        break;
      case "turn-finish":
        finish = event;
        break;
      default:
        break;
    }
  }
  if (!finish) throw new CoreError("unknown", "the turn ended without a result");

  if (wroteText || finish.reason === "stop") io.stdout.write("\n");
  if (finish.reason === "stop") {
    for (const failed of log?.failures ?? []) io.stderr.write(attemptLine(failed.attempt, failed.model, failed.error));
    if (lastFinishReason === "length") io.stderr.write(CUT_OFF_NOTE);
    if (via) io.stderr.write(`[${formatModelRef(via)}]\n`);
  } else if (failure && failure.code !== "aborted") {
    const reported = failedAttemptLines(failure.attempts);
    const lines = reported.length > 0 ? reported : (log?.failures ?? []).map((f) => attemptLine(f.attempt, f.model, f.error));
    for (const line of lines) io.stderr.write(line);
    io.stderr.write(`error: ${failure.code}: ${failure.message}\n`);
  } else if (!failure && finish.reason !== "aborted") {
    io.stderr.write(`error: ${finish.reason}\n`);
  }
  return finish;
}

const CUT_OFF_NOTE = 'note: the answer was cut off at the output-token limit (finish reason "length")\n';
const CUT_OFF_HINT = "hint: raise --max-output-tokens\n";

function attemptLine(attempt: number, model: ModelRef, error: CoreErrorShape): string {
  return `attempt ${attempt} ${formatModelRef(model)}: ${error.code}: ${error.message}\n`;
}

/** One line per failed step of the router's attempt log, in order; the position is 1-based. */
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
    lines.push(attemptLine(index + 1, ref.data, failure.data));
  });
  return lines;
}

/** Whether a failed attempt in the router's log ended because the reply hit the output-token limit. */
function cutOffAttempt(attempts: unknown): boolean {
  return routeAttempts(attempts).some((attempt) => !attempt.ok && attempt.error?.details?.["finishReason"] === "length");
}

/** How a call through `router.chat` ended. */
type ChatOutcome =
  | { kind: "answered"; response: RoutedResponse }
  | { kind: "failed"; error: CoreError }
  | { kind: "interrupted" };

/** One non-streaming call through the route. Ctrl+C wins over whatever the router reports. */
async function chatOnce(
  router: ModelRouter,
  steps: RouteStep[],
  messages: Message[],
  request: { outputSchema: Record<string, unknown> | undefined; maxOutputTokens: number | undefined },
  signal: AbortSignal,
): Promise<ChatOutcome> {
  const { outputSchema, maxOutputTokens } = request;
  try {
    const response = await router.chat(
      {
        messages,
        ...(outputSchema !== undefined && { outputSchema }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      },
      steps,
      { signal },
    );
    return signal.aborted ? { kind: "interrupted" } : { kind: "answered", response };
  } catch (error) {
    if (signal.aborted) return { kind: "interrupted" };
    if (CoreError.is(error)) return { kind: "failed", error };
    throw error;
  }
}

/** The `--json` result for how a `router.chat` call ended. `output` is only there when a schema was given. */
function askResult(outcome: ChatOutcome, withOutput: boolean): AskResult {
  switch (outcome.kind) {
    case "answered":
      return askResultFrom({ response: outcome.response }, { withOutput });
    case "failed":
      return askResultFrom({ error: outcome.error }, { withOutput });
    case "interrupted":
      return { ok: false, error: { code: "aborted", message: "request aborted", retryable: false }, attempts: [] };
  }
}

/**
 * The `--json` result for a failure that did not come from the route: a usage error is
 * `bad_request`, a `CoreError` keeps its code, anything else is `unknown`. The message is the one
 * `run.ts` prints to stderr.
 */
function failureResult(error: unknown): AskResult {
  const message = error instanceof Error ? error.message : "unexpected failure";
  if (error instanceof UsageError) {
    return { ok: false, error: { code: "bad_request", message, retryable: false }, attempts: [] };
  }
  const code = CoreError.is(error) ? error.code : "unknown";
  const retryable = CoreError.is(error) ? error.retryable : false;
  return { ok: false, error: { code, message, retryable }, attempts: [] };
}

/**
 * Prints the end of a `router.chat` call and returns the exit code. stdout carries the answer: the
 * validated object as one line of JSON when a schema was given, the reply text otherwise; with
 * `--json` it carries the `AskResult` instead, on every outcome. Failed attempts, the model that
 * answered and an error go to stderr, in the same lines as the streaming path, with or without `--json`.
 */
function reportChat(outcome: ChatOutcome, io: Io, mode: { json: boolean; schema: boolean }): number {
  if (mode.json) io.stdout.write(`${JSON.stringify(askResult(outcome, mode.schema))}\n`);
  switch (outcome.kind) {
    case "interrupted":
      return 130;
    case "failed": {
      for (const line of failedAttemptLines(outcome.error.details?.["attempts"])) io.stderr.write(line);
      io.stderr.write(`error: ${outcome.error.code}: ${outcome.error.message}\n`);
      if (cutOffAttempt(outcome.error.details?.["attempts"])) io.stderr.write(CUT_OFF_HINT);
      return 1;
    }
    case "answered": {
      const { response } = outcome;
      if (!mode.json) io.stdout.write(`${mode.schema ? JSON.stringify(response.output) : response.message.content}\n`);
      response.attempts.forEach((attempt, index) => {
        if (!attempt.ok && attempt.error) io.stderr.write(attemptLine(index + 1, attempt.model, attempt.error));
      });
      if (!mode.schema && response.finishReason === "length") io.stderr.write(CUT_OFF_NOTE);
      io.stderr.write(`[${formatModelRef(response.model)}]\n`);
      return 0;
    }
  }
}

const OPTIONS = {
  model: { type: "string" },
  "system-file": { type: "string" },
  schema: { type: "string" },
  json: { type: "boolean" },
  timeout: { type: "string" },
  "max-output-tokens": { type: "string" },
} as const;

function parseAskArgs(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

export const askCommand: Command = {
  summary: "ask one question and print the answer",
  usage: `[--model <provider:model,...>] [--system-file <file>] [--schema <file>] [--json] [--timeout <ms>] [--max-output-tokens <n>] <prompt...>

The prompt is the remaining arguments, or standard input when piped and no arguments are given.
Models are tried in order until one answers; without --model the route is CORE_ROUTE, then
"core config set route ...".

--system-file sends the file's contents as a system message before the prompt. A file that is
missing or empty is a usage error (exit 2).

--schema takes a file holding a JSON Schema object. core validates the answer against it and prints
the validated object as one line of JSON. A reply that is not valid JSON or does not match exits 1
with "unknown"; a route with no structured-output support exits 1 with "bad_request". A file that is
missing, not JSON or not an object is a usage error (exit 2), reported before any model is called.
The answer is not streamed.

--json prints one line of JSON on stdout instead of the answer text. On success it is
{ ok: true, model, text, output, usage, attempts }, where output is there only with --schema. On
failure it is { ok: false, error: { code, message, retryable }, attempts }. Every failure after the
arguments are parsed prints a result, usage errors included (code "bad_request", exit 2); stderr and
the exit codes do not change. The answer is not streamed.

--timeout sets the time limit in milliseconds for each model in the route, in place of timeoutMs
from the config. It must be a positive whole number, otherwise it is a usage error (exit 2).

--max-output-tokens limits the output tokens of each model request, for every step of the route.
Without it no limit is sent and the provider's default applies (some providers, such as
Cloudflare, stop a reply early). It must be a positive whole number, otherwise it is a usage
error (exit 2).`,
  async run(args: string[], io: Io): Promise<number> {
    // A failure to parse the arguments prints no result: `--json` is not known yet.
    const parsed = parseAskArgs(args);
    try {
      return await ask(parsed, io);
    } catch (error) {
      // What a program reads is stdout, so a failure that did not come from the route still prints
      // a result; the error then goes on to `run.ts`, which reports it on stderr and picks the exit code.
      if (parsed.values.json === true) io.stdout.write(`${JSON.stringify(failureResult(error))}\n`);
      throw error;
    }
  },
};

type AskArgs = ReturnType<typeof parseAskArgs>;

async function ask(parsed: AskArgs, io: Io): Promise<number> {
  const { model: modelFlag, "system-file": systemFile, schema: schemaFile, json, timeout, "max-output-tokens": maxOutputTokensFlag } = parsed.values;

  const config = await loadConfig(io.configDir);
  const route = chooseRoute(modelFlag, io.env, config);

  let prompt = parsed.positionals.join(" ").trim();
  if (prompt === "" && !io.interactive) prompt = (await io.readAll()).trim();
  if (prompt === "") throw new UsageError("no prompt given; pass it as arguments or pipe it in");

  const system = systemFile === undefined ? undefined : await readSystemFile(systemFile);
  const outputSchema = schemaFile === undefined ? undefined : await readSchemaFile(schemaFile);
  const timeoutMs = timeout === undefined ? undefined : parseTimeout(timeout);
  const maxOutputTokens = maxOutputTokensFlag === undefined ? undefined : parseMaxOutputTokens(maxOutputTokensFlag);

  const messages: Message[] = [
    ...(system === undefined ? [] : [{ role: "system" as const, content: system }]),
    { role: "user", content: prompt },
  ];
  const steps: RouteStep[] = route.map((model) => ({ model, ...(timeoutMs !== undefined && { timeoutMs }) }));

  const { router, log } = await openTurnRouter(io, config);
  const interrupted = new AbortController();
  const unsubscribe = io.onInterrupt(() => interrupted.abort());
  try {
    if (outputSchema !== undefined || json === true) {
      const outcome = await chatOnce(router, steps, messages, { outputSchema, maxOutputTokens }, interrupted.signal);
      return reportChat(outcome, io, { json: json === true, schema: outputSchema !== undefined });
    }
    const events = runTurn({
      router,
      route: steps,
      tools: new ToolRegistry(),
      channel: "local",
      messages,
      signal: interrupted.signal,
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    });
    const finish = await printTurn(events, io, log);
    if (interrupted.signal.aborted) return 130;
    return finish.reason === "stop" ? 0 : 1;
  } finally {
    unsubscribe();
  }
}
