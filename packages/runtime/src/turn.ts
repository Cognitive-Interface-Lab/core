import {
  CoreError,
  type Channel,
  type Message,
  type ToolCall,
  type ToolDefinition,
  type TurnBudget,
  type TurnEvent,
  type TurnFinishReason,
  type Usage,
} from "@core/contracts";
import type { ModelRouter, RouteStep } from "@core/models";
import type { ConfirmFn, ToolRegistry } from "@core/tools";

const DEFAULT_MAX_ROUNDS = 8;
/** `setTimeout` treats a longer delay as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export type RunTurnOptions = {
  router: ModelRouter;
  route: RouteStep[];
  tools: ToolRegistry;
  channel: Channel;
  /** The conversation so far, ending with the message to answer. */
  messages: Message[];
  budget?: TurnBudget;
  signal?: AbortSignal;
  confirm?: ConfirmFn;
  temperature?: number;
  /** The output-token limit of each model request; unlike `budget.maxOutputTokens`, which caps the whole turn. */
  maxOutputTokens?: number;
  /** Tools offered to the model that the caller runs; a round that calls one ends the turn with `client-tools`. */
  clientTools?: ToolDefinition[];
};

/**
 * Runs one turn: model, then the tool calls it asked for, then the model again with the results,
 * until it answers without calling a tool or a limit ends the turn. Tools run one at a time, in
 * the order the model gave them. Never throws: every failure is an `error` event, and
 * `turn-finish` is always the last event, emitted exactly once, with the messages this turn added.
 *
 * Client tools (`clientTools`) are offered after the registry's tools and never run here. A round
 * that calls one runs the registry calls of that round, then ends the turn with `client-tools`; the
 * caller runs the client calls and starts a new turn. A client tool named like a registry tool on
 * the channel is an error before any model call.
 *
 * Limits: `maxRounds` (default 8) ends the turn with `max-rounds`. `maxOutputTokens` ends it with
 * `budget` after a round's tool results once the output tokens used reach the limit and another
 * round would follow. `maxWallMs` is one timer for the whole turn: when it fires the model call and
 * the running tool get an aborted signal and the turn ends with `budget`, without forwarding the
 * `aborted` error that causes. An abort by the caller's own signal still ends with `aborted`.
 */
export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<TurnEvent, void, undefined> {
  const maxRounds = opts.budget?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const added: Message[] = [];
  const usage: Usage = {};
  let rounds = 0;

  // One signal for the model and the tools: the caller's, plus the wall-time timer. `cause`
  // remembers which of the two fired first.
  const turn = new AbortController();
  const signal = turn.signal;
  let cause: "aborted" | "budget" | undefined;
  const onCallerAbort = () => {
    cause ??= "aborted";
    turn.abort(opts.signal?.reason);
  };
  if (opts.signal?.aborted) onCallerAbort();
  else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const wallMs = opts.budget?.maxWallMs;
  const timer =
    wallMs === undefined
      ? undefined
      : setTimeout(() => {
          cause ??= "budget";
          turn.abort(new DOMException(`the turn used its ${wallMs} ms budget`, "TimeoutError"));
        }, Math.min(wallMs, MAX_TIMER_MS));

  const finish = (reason: TurnFinishReason): TurnEvent => ({
    type: "turn-finish",
    reason,
    rounds,
    usage: { ...usage },
    messages: added,
  });

  try {
    const clientTools = opts.clientTools ?? [];
    const clientNames = new Set(clientTools.map((tool) => tool.name));
    if (clientTools.length > 0) {
      // A name on both lists would make the model's call ambiguous: refuse before any model call.
      const registryNames = new Set(opts.tools.listFor(opts.channel).map((tool) => tool.name));
      const clash = clientTools.find((tool) => registryNames.has(tool.name));
      if (clash !== undefined) {
        const message = `client tool "${clash.name}" is also a registry tool on channel "${opts.channel}"`;
        yield { type: "error", error: new CoreError("bad_request", message).toJSON() };
        yield finish("error");
        return;
      }
    }

    for (let round = 1; round <= maxRounds; round++) {
      if (signal.aborted) {
        yield finish(cause ?? "aborted");
        return;
      }
      rounds = round;
      yield { type: "round", round };

      const definitions = opts.tools.listFor(opts.channel);
      const offered = clientTools.length > 0 ? [...definitions, ...clientTools] : definitions;
      const request = {
        messages: [...opts.messages, ...added],
        ...(offered.length > 0 && { tools: offered }),
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.maxOutputTokens !== undefined && { maxOutputTokens: opts.maxOutputTokens }),
      };

      let text = "";
      const toolCalls: ToolCall[] = [];
      let finished = false;
      for await (const event of opts.router.stream(request, opts.route, { signal })) {
        if (event.type === "error") {
          if (cause === "budget" && event.error.code === "aborted") {
            // The abort came from the wall-time budget: report the budget, not the cancellation.
            yield finish("budget");
            return;
          }
          yield event;
          yield finish(event.error.code === "aborted" ? "aborted" : "error");
          return;
        }
        yield event;
        if (event.type === "text-delta") {
          text += event.text;
        } else if (event.type === "tool-call") {
          toolCalls.push(event.toolCall);
        } else if (event.type === "finish") {
          finished = true;
          addTokens(usage, event.usage);
        }
      }
      if (!finished) {
        if (cause === "budget") {
          yield finish("budget");
          return;
        }
        yield { type: "error", error: new CoreError("unknown", "the model stream ended without a finish event").toJSON() };
        yield finish("error");
        return;
      }

      added.push({ role: "assistant", content: text, ...(toolCalls.length > 0 && { toolCalls }) });
      if (toolCalls.length === 0) {
        yield finish("stop");
        return;
      }

      // A client call is the caller's to run: it gets no result here, and the turn ends below.
      const awaitsClient = toolCalls.some((call) => clientNames.has(call.name));
      for (const call of toolCalls) {
        if (clientNames.has(call.name)) continue;
        // After an abort the registry answers each remaining call with an error result, so every
        // tool call in the history still has its result.
        const result = await opts.tools.call(call, {
          channel: opts.channel,
          signal,
          ...(opts.confirm !== undefined && { confirm: opts.confirm }),
        });
        yield { type: "tool-result", result };
        added.push({
          role: "tool",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          content: result.content,
          isError: result.isError,
        });
      }

      if (signal.aborted) {
        yield finish(cause ?? "aborted");
        return;
      }
      if (awaitsClient) {
        // No round limit or budget check follows: the caller decides whether to continue.
        yield finish("client-tools");
        return;
      }
      if (round === maxRounds) {
        yield finish("max-rounds");
        return;
      }
      const maxOutputTokens = opts.budget?.maxOutputTokens;
      if (maxOutputTokens !== undefined && (usage.outputTokens ?? 0) >= maxOutputTokens) {
        yield finish("budget");
        return;
      }
    }
    yield finish("max-rounds");
  } catch (error) {
    const failure = CoreError.is(error)
      ? error
      : new CoreError("unknown", error instanceof Error && error.message !== "" ? error.message : "the turn failed");
    yield { type: "error", error: failure.toJSON() };
    yield finish("error");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Adds the token counts that are defined; a count nobody reported stays undefined. */
function addTokens(total: Usage, step: Usage): void {
  if (step.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + step.inputTokens;
  if (step.outputTokens !== undefined) total.outputTokens = (total.outputTokens ?? 0) + step.outputTokens;
}
