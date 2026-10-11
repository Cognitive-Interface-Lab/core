import {
  CoreError,
  formatModelRef,
  type ChatRequest,
  type ChatResponse,
  type CoreErrorShape,
  type ErrorCode,
  type ModelRef,
  type StreamEvent,
} from "@core/contracts";
import type { ChatOptions } from "./provider.js";
import type { ProviderRegistry } from "./registry.js";

export type RouteStep = { model: ModelRef; timeoutMs?: number };
export type Attempt = { model: ModelRef; ok: boolean; ms: number; error?: CoreErrorShape };
export type RoutedResponse = ChatResponse & { attempts: Attempt[] };

const DEFAULT_TIMEOUT_MS = 30_000;

/** Errors that say the request itself is wrong or was cancelled: another provider would not help. */
const NO_FALLBACK: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["bad_request", "content_filter", "aborted"]);

type AttemptContext = {
  step: RouteStep;
  timeoutMs: number;
  callerSignal: AbortSignal | undefined;
  timeoutSignal: AbortSignal;
  signal: AbortSignal;
};

/**
 * Tries an ordered list of models until one answers. Each attempt runs under its own timeout
 * combined with the caller's signal, so providers must honour `ChatOptions.signal`.
 */
export class ModelRouter {
  readonly #registry: ProviderRegistry;
  readonly #defaultTimeoutMs: number;

  constructor(registry: ProviderRegistry, opts?: { defaultTimeoutMs?: number }) {
    this.#registry = registry;
    this.#defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(
    req: Omit<ChatRequest, "model">,
    route: RouteStep[],
    opts?: ChatOptions,
  ): Promise<RoutedResponse> {
    assertRoute(route);
    const attempts: Attempt[] = [];
    let last: CoreError | undefined;

    for (const step of route) {
      if (opts?.signal?.aborted) throw abortedError();
      const context = this.#context(step, opts?.signal);
      const started = performance.now();
      try {
        const response = await this.#registry
          .get(step.model.provider)
          .chat({ ...req, model: step.model }, { signal: context.signal });
        attempts.push({ model: step.model, ok: true, ms: elapsed(started) });
        return { ...response, attempts };
      } catch (error) {
        const failure = classify(error, context);
        attempts.push({ model: step.model, ok: false, ms: elapsed(started), error: failure.toJSON() });
        if (NO_FALLBACK.has(failure.code)) throw failure;
        last = failure;
      }
    }
    throw allFailed(route.length, attempts, last);
  }

  async *stream(
    req: Omit<ChatRequest, "model">,
    route: RouteStep[],
    opts?: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    if (route.length === 0) {
      yield { type: "error", error: emptyRouteError().toJSON() };
      return;
    }
    const attempts: Attempt[] = [];
    let last: CoreError | undefined;

    for (const [index, step] of route.entries()) {
      if (opts?.signal?.aborted) {
        yield { type: "error", error: abortedError().toJSON() };
        return;
      }
      yield { type: "route", model: step.model, attempt: index + 1 };

      const context = this.#context(step, opts?.signal);
      const started = performance.now();
      let contentStarted = false;
      let finished = false;
      let failure: unknown;
      try {
        const events = this.#registry
          .get(step.model.provider)
          .stream({ ...req, model: step.model }, { signal: context.signal });
        for await (const event of events) {
          // Only the router emits `route`.
          if (event.type === "route") continue;
          if (event.type === "error") {
            failure = CoreError.fromShape(event.error);
            break;
          }
          if (event.type === "text-delta" || event.type === "tool-call") contentStarted = true;
          yield event;
          if (event.type === "finish") {
            finished = true;
            break;
          }
        }
        if (!finished && !failure) {
          failure = new CoreError("unavailable", `${formatModelRef(step.model)}: stream ended without a finish event`, {
            provider: step.model.provider,
          });
        }
      } catch (error) {
        failure = error;
      }

      if (finished) {
        attempts.push({ model: step.model, ok: true, ms: elapsed(started) });
        return;
      }
      const classified = classify(failure, context);
      attempts.push({ model: step.model, ok: false, ms: elapsed(started), error: classified.toJSON() });
      // Once content has reached the caller, switching provider would splice two answers together.
      if (contentStarted || NO_FALLBACK.has(classified.code)) {
        yield { type: "error", error: classified.toJSON() };
        return;
      }
      last = classified;
    }
    yield { type: "error", error: allFailed(route.length, attempts, last).toJSON() };
  }

  #context(step: RouteStep, callerSignal: AbortSignal | undefined): AttemptContext {
    const timeoutMs = step.timeoutMs ?? this.#defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any(callerSignal ? [callerSignal, timeoutSignal] : [timeoutSignal]);
    return { step, timeoutMs, callerSignal, timeoutSignal, signal };
  }
}

function assertRoute(route: RouteStep[]): void {
  if (route.length === 0) throw emptyRouteError();
}

function emptyRouteError(): CoreError {
  return new CoreError("bad_request", "route is empty: at least one model step is required");
}

function abortedError(): CoreError {
  return new CoreError("aborted", "request aborted");
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function allFailed(count: number, attempts: Attempt[], last: CoreError | undefined): CoreError {
  return new CoreError(last?.code ?? "unknown", `all ${count} route steps failed`, {
    ...(last?.provider !== undefined && { provider: last.provider }),
    details: { attempts },
  });
}

/**
 * Turns whatever an attempt threw into a `CoreError`. A cancellation is reported by who caused
 * it: the caller's signal is `aborted`, the router's own timer is `timeout`.
 */
function classify(error: unknown, context: AttemptContext): CoreError {
  const { step, callerSignal, timeoutSignal, timeoutMs } = context;
  const failure = CoreError.is(error)
    ? error
    : new CoreError("unknown", `${formatModelRef(step.model)}: unexpected failure`, {
        provider: step.model.provider,
        cause: error,
      });
  if (failure.code !== "aborted" && failure.code !== "timeout") return failure;
  if (callerSignal?.aborted) {
    return failure.code === "aborted" ? failure : abortedError();
  }
  if (timeoutSignal.aborted) {
    return new CoreError("timeout", `${formatModelRef(step.model)} timed out after ${timeoutMs} ms`, {
      provider: step.model.provider,
    });
  }
  return failure;
}
