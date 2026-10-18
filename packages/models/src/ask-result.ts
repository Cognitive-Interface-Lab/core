import { CoreError, RouteAttemptSchema, type AskResult, type CoreErrorShape, type RouteAttempt } from "@core/contracts";
import type { RoutedResponse } from "./router.js";

type AskFailure = Extract<AskResult, { ok: false }>;

/** The `--json` result of a `router.chat` call: the answer, or the failure with the attempts that led to it. */
export function askResultFrom(
  outcome: { response: RoutedResponse } | { error: unknown },
  opts: { withOutput: boolean },
): AskResult {
  if ("response" in outcome) {
    const { response } = outcome;
    return {
      ok: true,
      model: response.model,
      text: response.message.content,
      ...(opts.withOutput && { output: response.output }),
      usage: response.usage,
      attempts: response.attempts,
    };
  }
  if (CoreError.is(outcome.error)) {
    return {
      ok: false,
      error: resultError(outcome.error.toJSON()),
      attempts: routeAttempts(outcome.error.details?.["attempts"]),
    };
  }
  const message = outcome.error instanceof Error ? outcome.error.message : "unexpected failure";
  return { ok: false, error: { code: "unknown", message, retryable: false }, attempts: [] };
}

/** The failure result's error: the shape without `details`, because the attempts are already top level. */
function resultError(error: CoreErrorShape): AskFailure["error"] {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.provider !== undefined && { provider: error.provider }),
  };
}

/** The router's attempt log when `value` is one, else nothing: a malformed log is not worth failing over. */
export function routeAttempts(value: unknown): RouteAttempt[] {
  const parsed = RouteAttemptSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}
